#pragma once

#ifdef _WIN32

#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

namespace cerious_host {

namespace fs = std::filesystem;

inline std::wstring to_wide(const std::string& value) {
    if (value.empty()) return {};
    const int count = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
    std::wstring out(static_cast<std::size_t>(count - 1), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, out.data(), count);
    return out;
}

inline std::string to_utf8(const std::wstring& value) {
    if (value.empty()) return {};
    const int count = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string out(static_cast<std::size_t>(count - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, out.data(), count, nullptr, nullptr);
    return out;
}

inline std::wstring quote_arg(const std::wstring& value) {
    std::wstring out = L"\"";
    for (wchar_t ch : value) {
        if (ch == L'"') out += L"\\\"";
        else out += ch;
    }
    out += L"\"";
    return out;
}

inline std::wstring arg_value(int argc, wchar_t** argv, std::wstring_view name) {
    for (int i = 1; i + 1 < argc; ++i) {
        if (argv[i] == name) return argv[i + 1];
    }
    return {};
}

inline bool has_arg(int argc, wchar_t** argv, std::wstring_view name) {
    for (int i = 1; i < argc; ++i) {
        if (argv[i] == name) return true;
    }
    return false;
}

inline std::wstring env_w(const wchar_t* key) {
    wchar_t buffer[32767]{};
    const DWORD length = GetEnvironmentVariableW(key, buffer, static_cast<DWORD>(std::size(buffer)));
    return length == 0 || length >= std::size(buffer) ? L"" : std::wstring(buffer, length);
}

inline fs::path exe_path() {
    std::wstring buffer(32768, L'\0');
    const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    buffer.resize(length);
    return fs::path(buffer);
}

inline bool looks_like_root(const fs::path& candidate) {
    std::error_code ec;
    return fs::exists(candidate / L"native" / L"gateway-cpp", ec)
        && fs::exists(candidate / L"native" / L"cerious-exchange-cpp", ec)
        && fs::exists(candidate / L"apps" / L"terminal", ec);
}

inline fs::path find_root(const std::wstring& explicit_root = {}) {
    if (!explicit_root.empty() && looks_like_root(explicit_root)) return fs::path(explicit_root);
    const auto env_root = env_w(L"CERIOUS_APP_ROOT");
    if (!env_root.empty() && looks_like_root(env_root)) return fs::path(env_root);
    const auto env_root2 = env_w(L"CERIOUS_SYSTEMS_ROOT");
    if (!env_root2.empty() && looks_like_root(env_root2)) return fs::path(env_root2);

    auto current = exe_path().parent_path();
    for (int i = 0; i < 8 && !current.empty(); ++i) {
        if (looks_like_root(current)) return current;
        current = current.parent_path();
    }

    const auto user_profile = env_w(L"USERPROFILE");
    if (!user_profile.empty()) {
        const std::vector<fs::path> candidates{
            fs::path(user_profile) / L"Documents" / L"Codex" / L"Cerious Systems" / L"Cerious local",
            fs::path(user_profile) / L"OneDrive" / L"Documents" / L"Codex" / L"Cerious Systems" / L"Cerious local",
        };
        for (const auto& candidate : candidates) {
            if (looks_like_root(candidate)) return candidate;
        }
    }
    return {};
}

inline std::string trim_copy(std::string value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return {};
    const auto last = value.find_last_not_of(" \t\r\n");
    return value.substr(first, last - first + 1);
}

inline std::optional<std::string> dotenv_value(const fs::path& root, const std::string& key) {
    std::ifstream in(root / L".env", std::ios::binary);
    if (!in) return std::nullopt;
    std::string line;
    while (std::getline(in, line)) {
        line = trim_copy(line);
        if (line.empty() || line[0] == '#') continue;
        const auto eq = line.find('=');
        if (eq == std::string::npos) continue;
        auto name = trim_copy(line.substr(0, eq));
        if (name != key) continue;
        auto value = trim_copy(line.substr(eq + 1));
        if (value.size() >= 2 && ((value.front() == '"' && value.back() == '"') ||
                                  (value.front() == '\'' && value.back() == '\''))) {
            value = value.substr(1, value.size() - 2);
        }
        return value;
    }
    return std::nullopt;
}

inline int dotenv_int(const fs::path& root, const std::string& key, int fallback) {
    const auto raw = dotenv_value(root, key);
    if (!raw || raw->empty()) return fallback;
    try {
        return std::stoi(*raw);
    } catch (...) {
        return fallback;
    }
}

inline void append_log(const fs::path& path, const std::string& message) {
    std::error_code ec;
    fs::create_directories(path.parent_path(), ec);
    std::ofstream out(path, std::ios::binary | std::ios::app);
    if (!out) return;
    const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    std::tm tm{};
    localtime_s(&tm, &now);
    char stamp[32]{};
    std::strftime(stamp, sizeof(stamp), "%Y-%m-%d %H:%M:%S", &tm);
    out << '[' << stamp << "] " << message << "\r\n";
}

struct HttpResult {
    bool ok = false;
    DWORD status = 0;
    std::string body;
};

inline HttpResult http_get(const std::wstring& host, INTERNET_PORT port, const std::wstring& path, DWORD timeout_ms = 1500) {
    HttpResult result;
    HINTERNET session = WinHttpOpen(L"CeriousHost/1.0", WINHTTP_ACCESS_TYPE_NO_PROXY,
                                    WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) return result;
    WinHttpSetTimeouts(session, timeout_ms, timeout_ms, timeout_ms, timeout_ms);
    HINTERNET connect = WinHttpConnect(session, host.c_str(), port, 0);
    if (!connect) {
        WinHttpCloseHandle(session);
        return result;
    }
    HINTERNET request = WinHttpOpenRequest(connect, L"GET", path.c_str(), nullptr,
                                           WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
    if (!request) {
        WinHttpCloseHandle(connect);
        WinHttpCloseHandle(session);
        return result;
    }
    if (WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                           WINHTTP_NO_REQUEST_DATA, 0, 0, 0) && WinHttpReceiveResponse(request, nullptr)) {
        DWORD status = 0;
        DWORD status_size = sizeof(status);
        if (WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size, WINHTTP_NO_HEADER_INDEX)) {
            result.status = status;
            result.ok = status >= 200 && status < 300;
        }
        DWORD available = 0;
        while (WinHttpQueryDataAvailable(request, &available) && available > 0) {
            std::string chunk(available, '\0');
            DWORD read = 0;
            if (!WinHttpReadData(request, chunk.data(), available, &read) || read == 0) break;
            chunk.resize(read);
            result.body += chunk;
        }
    }
    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);
    return result;
}

inline bool process_running(const PROCESS_INFORMATION& pi) {
    if (!pi.hProcess) return false;
    DWORD exit_code = 0;
    return GetExitCodeProcess(pi.hProcess, &exit_code) && exit_code == STILL_ACTIVE;
}

inline void close_process_handles(PROCESS_INFORMATION& pi) {
    if (pi.hThread) CloseHandle(pi.hThread);
    if (pi.hProcess) CloseHandle(pi.hProcess);
    pi = {};
}

inline void terminate_child(PROCESS_INFORMATION& pi) {
    if (process_running(pi)) {
        TerminateProcess(pi.hProcess, 0);
        WaitForSingleObject(pi.hProcess, 5000);
    }
    close_process_handles(pi);
}

inline std::optional<PROCESS_INFORMATION> start_hidden_process(const fs::path& exe, const std::wstring& args, const fs::path& cwd) {
    std::wstring command = quote_arg(exe.wstring());
    if (!args.empty()) {
        command += L" ";
        command += args;
    }

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi{};
    std::wstring mutable_command = command;
    std::wstring mutable_cwd = cwd.wstring();
    const BOOL ok = CreateProcessW(
        nullptr,
        mutable_command.data(),
        nullptr,
        nullptr,
        FALSE,
        CREATE_NO_WINDOW,
        nullptr,
        mutable_cwd.empty() ? nullptr : mutable_cwd.c_str(),
        &si,
        &pi);
    if (!ok) return std::nullopt;
    return pi;
}

inline bool set_hkcu_run(const std::wstring& name, const std::wstring& command) {
    HKEY key{};
    const auto rc = RegCreateKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", 0, nullptr,
                                    REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, nullptr, &key, nullptr);
    if (rc != ERROR_SUCCESS) return false;
    const auto bytes = static_cast<DWORD>((command.size() + 1) * sizeof(wchar_t));
    const auto set_rc = RegSetValueExW(key, name.c_str(), 0, REG_SZ,
                                       reinterpret_cast<const BYTE*>(command.c_str()), bytes);
    RegCloseKey(key);
    return set_rc == ERROR_SUCCESS;
}

inline bool remove_hkcu_run(const std::wstring& name) {
    HKEY key{};
    const auto rc = RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", 0, KEY_SET_VALUE, &key);
    if (rc != ERROR_SUCCESS) return false;
    const auto del_rc = RegDeleteValueW(key, name.c_str());
    RegCloseKey(key);
    return del_rc == ERROR_SUCCESS || del_rc == ERROR_FILE_NOT_FOUND;
}

} // namespace cerious_host

#endif
