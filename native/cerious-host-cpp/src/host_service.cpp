#ifdef _WIN32

#include "cerious_host_common.hpp"

#include <shellapi.h>

#include <atomic>
#include <iostream>
#include <memory>

namespace {

using namespace cerious_host;

constexpr wchar_t kServiceName[] = L"CeriousHostService";
constexpr wchar_t kDisplayName[] = L"Cerious Systems Host Service";
constexpr wchar_t kDescription[] = L"Starts and supervises Cerious Systems C++ trading services.";

SERVICE_STATUS_HANDLE g_status_handle = nullptr;
SERVICE_STATUS g_status{};
HANDLE g_stop_event = nullptr;
std::unique_ptr<class Supervisor> g_supervisor;
fs::path g_root;

void set_service_status(DWORD state, DWORD win32_exit_code = NO_ERROR, DWORD wait_hint = 0) {
    g_status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
    g_status.dwCurrentState = state;
    g_status.dwControlsAccepted = (state == SERVICE_START_PENDING) ? 0 : SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN;
    g_status.dwWin32ExitCode = win32_exit_code;
    g_status.dwWaitHint = wait_hint;
    static DWORD checkpoint = 1;
    g_status.dwCheckPoint = (state == SERVICE_RUNNING || state == SERVICE_STOPPED) ? 0 : checkpoint++;
    if (g_status_handle) SetServiceStatus(g_status_handle, &g_status);
}

class Supervisor {
public:
    explicit Supervisor(fs::path root)
        : root_(std::move(root)),
          log_(root_ / L"cerious-host-service.log"),
          backend_port_(dotenv_int(root_, "CERIOUS_BACKEND_PORT", 8000)),
          sim_port_(dotenv_int(root_, "SIMULEX_HTTP_PORT", 8011)) {}

    void request_stop() {
        stop_.store(true);
    }

    void run() {
        append_log(log_, "host supervisor starting root=" + root_.string());
        int gateway_failures = 0;
        int sim_failures = 0;

        while (!stop_.load()) {
            const bool sim_ok = simulex_healthy();
            const bool gateway_ok = gateway_healthy();

            if (!sim_ok) {
                ++sim_failures;
                if (!process_running(sim_) || sim_failures >= 3) {
                    restart_simulex();
                    sim_failures = 0;
                }
            } else {
                sim_failures = 0;
            }

            if (!gateway_ok) {
                ++gateway_failures;
                if (!process_running(gateway_) || gateway_failures >= 3) {
                    restart_gateway();
                    gateway_failures = 0;
                }
            } else {
                gateway_failures = 0;
            }

            const auto md = http_get(L"127.0.0.1", static_cast<INTERNET_PORT>(backend_port_), L"/api/market-data/status", 900);
            if (md.ok && md.body.find("\"ok\":true") != std::string::npos) {
                last_market_status_ = md.body;
            }

            for (int i = 0; i < 10 && !stop_.load(); ++i) {
                Sleep(500);
            }
        }

        append_log(log_, "host supervisor stopping");
        terminate_child(gateway_);
        terminate_child(sim_);
        append_log(log_, "host supervisor stopped");
    }

private:
    bool gateway_healthy() const {
        const auto health = http_get(L"127.0.0.1", static_cast<INTERNET_PORT>(backend_port_), L"/api/health");
        return health.ok && health.body.find("\"runtime\":\"cpp\"") != std::string::npos;
    }

    bool simulex_healthy() const {
        const auto health = http_get(L"127.0.0.1", static_cast<INTERNET_PORT>(sim_port_), L"/health");
        return health.ok && health.body.find("simulex.exchange") != std::string::npos;
    }

    std::optional<fs::path> gateway_exe() const {
        const std::vector<fs::path> candidates{
            root_ / L"native" / L"gateway-cpp" / L"build" / L"Release" / L"cerious_gateway.exe",
            root_ / L"native" / L"gateway-cpp" / L"build" / L"cerious_gateway.exe",
        };
        for (const auto& candidate : candidates) {
            std::error_code ec;
            if (fs::exists(candidate, ec)) return candidate;
        }
        return std::nullopt;
    }

    std::optional<fs::path> simulex_exe() const {
        const std::vector<fs::path> candidates{
            root_ / L"native" / L"simulex-cpp" / L"build" / L"Release" / L"cerious_simulex_server.exe",
            root_ / L"native" / L"simulex-cpp" / L"build" / L"cerious_simulex_server.exe",
        };
        for (const auto& candidate : candidates) {
            std::error_code ec;
            if (fs::exists(candidate, ec)) return candidate;
        }
        return std::nullopt;
    }

    void restart_gateway() {
        terminate_child(gateway_);
        const auto exe = gateway_exe();
        if (!exe) {
            append_log(log_, "gateway executable missing");
            return;
        }
        std::wstring args = L"--host 127.0.0.1 --port " + std::to_wstring(backend_port_)
            + L" --sim-host 127.0.0.1 --sim-port " + std::to_wstring(sim_port_)
            + L" --root " + quote_arg(root_.wstring());
        auto pi = start_hidden_process(*exe, args, root_);
        if (!pi) {
            append_log(log_, "failed to start gateway");
            return;
        }
        gateway_ = *pi;
        append_log(log_, "started gateway pid=" + std::to_string(gateway_.dwProcessId));
    }

    void restart_simulex() {
        terminate_child(sim_);
        const auto exe = simulex_exe();
        if (!exe) {
            append_log(log_, "simulex executable missing");
            return;
        }
        std::wstring args = L"--host 127.0.0.1 --port " + std::to_wstring(sim_port_);
        auto pi = start_hidden_process(*exe, args, exe->parent_path());
        if (!pi) {
            append_log(log_, "failed to start simulex");
            return;
        }
        sim_ = *pi;
        append_log(log_, "started simulex pid=" + std::to_string(sim_.dwProcessId));
    }

    fs::path root_;
    fs::path log_;
    int backend_port_ = 8000;
    int sim_port_ = 8011;
    PROCESS_INFORMATION gateway_{};
    PROCESS_INFORMATION sim_{};
    std::atomic_bool stop_{false};
    std::string last_market_status_;
};

DWORD WINAPI service_control_handler(DWORD control, DWORD, LPVOID, LPVOID) {
    if (control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN) {
        set_service_status(SERVICE_STOP_PENDING, NO_ERROR, 10000);
        if (g_supervisor) g_supervisor->request_stop();
        if (g_stop_event) SetEvent(g_stop_event);
        return NO_ERROR;
    }
    return ERROR_CALL_NOT_IMPLEMENTED;
}

void WINAPI service_main(DWORD, wchar_t**) {
    g_status_handle = RegisterServiceCtrlHandlerExW(kServiceName, service_control_handler, nullptr);
    if (!g_status_handle) return;
    set_service_status(SERVICE_START_PENDING, NO_ERROR, 10000);
    g_stop_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!g_stop_event) {
        set_service_status(SERVICE_STOPPED, GetLastError());
        return;
    }
    if (g_root.empty()) g_root = find_root();
    if (g_root.empty()) {
        set_service_status(SERVICE_STOPPED, ERROR_PATH_NOT_FOUND);
        return;
    }
    g_supervisor = std::make_unique<Supervisor>(g_root);
    set_service_status(SERVICE_RUNNING);
    g_supervisor->run();
    g_supervisor.reset();
    CloseHandle(g_stop_event);
    g_stop_event = nullptr;
    set_service_status(SERVICE_STOPPED);
}

std::wstring installed_image_path(const fs::path& root) {
    return quote_arg(exe_path().wstring()) + L" --service --root " + quote_arg(root.wstring());
}

int install_service(const fs::path& root) {
    SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CREATE_SERVICE);
    if (!scm) {
        std::wcerr << L"OpenSCManager failed. Run elevated to install the Windows service. error=" << GetLastError() << L"\n";
        return 5;
    }
    const auto image = installed_image_path(root);
    SC_HANDLE service = CreateServiceW(
        scm,
        kServiceName,
        kDisplayName,
        SERVICE_ALL_ACCESS,
        SERVICE_WIN32_OWN_PROCESS,
        SERVICE_AUTO_START,
        SERVICE_ERROR_NORMAL,
        image.c_str(),
        nullptr,
        nullptr,
        nullptr,
        nullptr,
        nullptr);

    if (!service && GetLastError() == ERROR_SERVICE_EXISTS) {
        service = OpenServiceW(scm, kServiceName, SERVICE_ALL_ACCESS);
        if (service) {
            ChangeServiceConfigW(service, SERVICE_NO_CHANGE, SERVICE_AUTO_START, SERVICE_NO_CHANGE,
                                 image.c_str(), nullptr, nullptr, nullptr, nullptr, nullptr, kDisplayName);
        }
    }

    if (!service) {
        const auto error = GetLastError();
        CloseServiceHandle(scm);
        std::wcerr << L"CreateService failed error=" << error << L"\n";
        return static_cast<int>(error);
    }

    SERVICE_DESCRIPTIONW description{};
    description.lpDescription = const_cast<wchar_t*>(kDescription);
    ChangeServiceConfig2W(service, SERVICE_CONFIG_DESCRIPTION, &description);

    SC_ACTION actions[3]{};
    actions[0] = {SC_ACTION_RESTART, 5000};
    actions[1] = {SC_ACTION_RESTART, 10000};
    actions[2] = {SC_ACTION_RESTART, 30000};
    SERVICE_FAILURE_ACTIONSW failure{};
    failure.dwResetPeriod = 60;
    failure.cActions = 3;
    failure.lpsaActions = actions;
    ChangeServiceConfig2W(service, SERVICE_CONFIG_FAILURE_ACTIONS, &failure);

    StartServiceW(service, 0, nullptr);
    CloseServiceHandle(service);
    CloseServiceHandle(scm);
    std::wcout << L"Installed " << kDisplayName << L" root=" << root.wstring() << L"\n";
    return 0;
}

int uninstall_service() {
    SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
    if (!scm) return static_cast<int>(GetLastError());
    SC_HANDLE service = OpenServiceW(scm, kServiceName, SERVICE_STOP | DELETE | SERVICE_QUERY_STATUS);
    if (!service) {
        CloseServiceHandle(scm);
        return static_cast<int>(GetLastError());
    }
    SERVICE_STATUS status{};
    ControlService(service, SERVICE_CONTROL_STOP, &status);
    DeleteService(service);
    CloseServiceHandle(service);
    CloseServiceHandle(scm);
    return 0;
}

int install_tray_startup(const fs::path& root) {
    const auto tray = exe_path().parent_path() / L"cerious_tray.exe";
    const auto command = quote_arg(tray.wstring()) + L" --root " + quote_arg(root.wstring());
    if (!set_hkcu_run(L"Cerious Systems Tray", command)) return 1;
    std::wcout << L"Installed Cerious Systems Tray startup.\n";
    return 0;
}

int run_console(const fs::path& root) {
    Supervisor supervisor(root);
    g_supervisor = std::make_unique<Supervisor>(root);
    g_supervisor->run();
    return 0;
}

} // namespace

int wmain(int argc, wchar_t** argv) {
    g_root = find_root(arg_value(argc, argv, L"--root"));
    if (has_arg(argc, argv, L"--uninstall")) return uninstall_service();
    if (g_root.empty()) {
        std::wcerr << L"Cerious root not found. Pass --root \"C:\\...\\Cerious local\".\n";
        return 2;
    }
    if (has_arg(argc, argv, L"--install")) return install_service(g_root);
    if (has_arg(argc, argv, L"--install-tray-startup")) return install_tray_startup(g_root);
    if (has_arg(argc, argv, L"--remove-tray-startup")) return remove_hkcu_run(L"Cerious Systems Tray") ? 0 : 1;
    if (has_arg(argc, argv, L"--run")) return run_console(g_root);

    SERVICE_TABLE_ENTRYW table[] = {
        {const_cast<wchar_t*>(kServiceName), service_main},
        {nullptr, nullptr},
    };
    if (!StartServiceCtrlDispatcherW(table)) {
        const auto error = GetLastError();
        if (error == ERROR_FAILED_SERVICE_CONTROLLER_CONNECT) {
            return run_console(g_root);
        }
        return static_cast<int>(error);
    }
    return 0;
}

#else

#include <iostream>

int main() {
    std::cerr << "Cerious Windows host service is only available on Windows.\n";
    return 1;
}

#endif
