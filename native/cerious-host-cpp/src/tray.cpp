#ifdef _WIN32

#include "cerious_host_common.hpp"

#include <shellapi.h>

#include <memory>

namespace {

using namespace cerious_host;

constexpr wchar_t kClassName[] = L"CeriousSystemsTrayWindow";
constexpr wchar_t kServiceName[] = L"CeriousHostService";
constexpr UINT kTrayMessage = WM_APP + 41;
constexpr UINT_PTR kTimerId = 7;
constexpr UINT kMenuOpen = 1001;
constexpr UINT kMenuStart = 1002;
constexpr UINT kMenuStop = 1003;
constexpr UINT kMenuRestart = 1004;
constexpr UINT kMenuExit = 1005;

fs::path g_root;
fs::path g_log;
NOTIFYICONDATAW g_nid{};
HICON g_icon_green = nullptr;
HICON g_icon_yellow = nullptr;
HICON g_icon_red = nullptr;
PROCESS_INFORMATION g_agent{};

HICON make_status_icon(COLORREF color) {
    HDC screen = GetDC(nullptr);
    HDC dc = CreateCompatibleDC(screen);
    HBITMAP bitmap = CreateCompatibleBitmap(screen, 32, 32);
    HBITMAP old = static_cast<HBITMAP>(SelectObject(dc, bitmap));
    HBRUSH bg = CreateSolidBrush(RGB(5, 9, 17));
    RECT full{0, 0, 32, 32};
    FillRect(dc, &full, bg);
    DeleteObject(bg);
    HBRUSH brush = CreateSolidBrush(color);
    HPEN pen = CreatePen(PS_SOLID, 1, RGB(255, 255, 255));
    HGDIOBJ old_brush = SelectObject(dc, brush);
    HGDIOBJ old_pen = SelectObject(dc, pen);
    Ellipse(dc, 4, 4, 28, 28);
    SelectObject(dc, old_pen);
    SelectObject(dc, old_brush);
    DeleteObject(pen);
    DeleteObject(brush);
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, RGB(255, 255, 255));
    HFONT font = CreateFontW(19, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                             OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                             DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
    HGDIOBJ old_font = SelectObject(dc, font);
    DrawTextW(dc, L"C", 1, &full, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    SelectObject(dc, old_font);
    DeleteObject(font);
    SelectObject(dc, old);

    ICONINFO info{};
    info.fIcon = TRUE;
    info.hbmColor = bitmap;
    info.hbmMask = bitmap;
    HICON icon = CreateIconIndirect(&info);
    DeleteObject(bitmap);
    DeleteDC(dc);
    ReleaseDC(nullptr, screen);
    return icon;
}

bool service_installed() {
    SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
    if (!scm) return false;
    SC_HANDLE service = OpenServiceW(scm, kServiceName, SERVICE_QUERY_STATUS);
    const bool ok = service != nullptr;
    if (service) CloseServiceHandle(service);
    CloseServiceHandle(scm);
    return ok;
}

bool query_service_running() {
    SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
    if (!scm) return false;
    SC_HANDLE service = OpenServiceW(scm, kServiceName, SERVICE_QUERY_STATUS);
    if (!service) {
        CloseServiceHandle(scm);
        return false;
    }
    SERVICE_STATUS_PROCESS status{};
    DWORD needed = 0;
    const bool ok = QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO,
                                         reinterpret_cast<LPBYTE>(&status), sizeof(status), &needed)
        && status.dwCurrentState == SERVICE_RUNNING;
    CloseServiceHandle(service);
    CloseServiceHandle(scm);
    return ok;
}

void start_service() {
    SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
    if (!scm) return;
    SC_HANDLE service = OpenServiceW(scm, kServiceName, SERVICE_START | SERVICE_QUERY_STATUS);
    if (service) {
        StartServiceW(service, 0, nullptr);
        CloseServiceHandle(service);
    }
    CloseServiceHandle(scm);
}

void stop_service() {
    SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
    if (!scm) return;
    SC_HANDLE service = OpenServiceW(scm, kServiceName, SERVICE_STOP | SERVICE_QUERY_STATUS);
    if (service) {
        SERVICE_STATUS status{};
        ControlService(service, SERVICE_CONTROL_STOP, &status);
        CloseServiceHandle(service);
    }
    CloseServiceHandle(scm);
}

void ensure_user_agent() {
    if (query_service_running()) return;
    if (process_running(g_agent)) return;
    const auto agent = exe_path().parent_path() / L"cerious_host_service.exe";
    std::error_code ec;
    if (!fs::exists(agent, ec)) return;
    auto pi = start_hidden_process(agent, L"--run --root " + quote_arg(g_root.wstring()), g_root);
    if (pi) {
        g_agent = *pi;
        append_log(g_log, "started user-mode host agent pid=" + std::to_string(g_agent.dwProcessId));
    }
}

void open_terminal() {
    ShellExecuteW(nullptr, L"open", L"http://127.0.0.1:8000/?cerious_view=canvas", nullptr, nullptr, SW_SHOWNORMAL);
}

void update_icon(HWND hwnd) {
    const bool gateway_ok = http_get(L"127.0.0.1", 8000, L"/api/health", 900).ok;
    const bool sim_ok = http_get(L"127.0.0.1", 8011, L"/health", 900).ok;
    const bool running = query_service_running() || process_running(g_agent);

    HICON icon = g_icon_red;
    std::wstring tip = L"Cerious Systems: offline";
    if (gateway_ok && sim_ok) {
        icon = g_icon_green;
        tip = L"Cerious Systems: ready";
    } else if (running) {
        icon = g_icon_yellow;
        tip = L"Cerious Systems: starting";
    }

    g_nid.cbSize = sizeof(g_nid);
    g_nid.hWnd = hwnd;
    g_nid.uID = 1;
    g_nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    g_nid.uCallbackMessage = kTrayMessage;
    g_nid.hIcon = icon;
    wcsncpy_s(g_nid.szTip, tip.c_str(), _TRUNCATE);
    Shell_NotifyIconW(NIM_MODIFY, &g_nid);
}

void show_menu(HWND hwnd) {
    HMENU menu = CreatePopupMenu();
    AppendMenuW(menu, MF_STRING, kMenuOpen, L"Open Cerious Terminal");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING, kMenuStart, L"Start Host Service");
    AppendMenuW(menu, MF_STRING, kMenuStop, L"Stop Host Service");
    AppendMenuW(menu, MF_STRING, kMenuRestart, L"Restart Host Service");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING, kMenuExit, L"Exit Tray");
    POINT pt{};
    GetCursorPos(&pt);
    SetForegroundWindow(hwnd);
    TrackPopupMenu(menu, TPM_RIGHTBUTTON, pt.x, pt.y, 0, hwnd, nullptr);
    DestroyMenu(menu);
}

LRESULT CALLBACK wnd_proc(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam) {
    switch (msg) {
        case WM_CREATE:
            g_nid.cbSize = sizeof(g_nid);
            g_nid.hWnd = hwnd;
            g_nid.uID = 1;
            g_nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
            g_nid.uCallbackMessage = kTrayMessage;
            g_nid.hIcon = g_icon_yellow;
            wcsncpy_s(g_nid.szTip, L"Cerious Systems: starting", _TRUNCATE);
            Shell_NotifyIconW(NIM_ADD, &g_nid);
            SetTimer(hwnd, kTimerId, 3000, nullptr);
            ensure_user_agent();
            update_icon(hwnd);
            return 0;
        case WM_TIMER:
            ensure_user_agent();
            update_icon(hwnd);
            return 0;
        case kTrayMessage:
            if (LOWORD(lparam) == WM_LBUTTONDBLCLK) open_terminal();
            if (LOWORD(lparam) == WM_RBUTTONUP) show_menu(hwnd);
            return 0;
        case WM_COMMAND:
            switch (LOWORD(wparam)) {
                case kMenuOpen: open_terminal(); break;
                case kMenuStart:
                    if (service_installed()) start_service();
                    else ensure_user_agent();
                    break;
                case kMenuStop:
                    stop_service();
                    terminate_child(g_agent);
                    break;
                case kMenuRestart:
                    stop_service();
                    terminate_child(g_agent);
                    Sleep(1000);
                    if (service_installed()) start_service();
                    else ensure_user_agent();
                    break;
                case kMenuExit:
                    DestroyWindow(hwnd);
                    break;
            }
            update_icon(hwnd);
            return 0;
        case WM_DESTROY:
            Shell_NotifyIconW(NIM_DELETE, &g_nid);
            KillTimer(hwnd, kTimerId);
            PostQuitMessage(0);
            return 0;
        default:
            return DefWindowProcW(hwnd, msg, wparam, lparam);
    }
}

int install_startup(const fs::path& root) {
    const auto command = quote_arg(exe_path().wstring()) + L" --root " + quote_arg(root.wstring());
    return set_hkcu_run(L"Cerious Systems Tray", command) ? 0 : 1;
}

int remove_startup() {
    return remove_hkcu_run(L"Cerious Systems Tray") ? 0 : 1;
}

} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
    int argc = 0;
    wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    g_root = find_root(argv ? arg_value(argc, argv, L"--root") : L"");
    if (argv && has_arg(argc, argv, L"--remove-startup")) {
        const int rc = remove_startup();
        LocalFree(argv);
        return rc;
    }
    if (g_root.empty()) {
        if (argv) LocalFree(argv);
        MessageBoxW(nullptr, L"Cerious root was not found. Reinstall the terminal startup package from the Cerious project root.",
                    L"Cerious Systems", MB_ICONERROR | MB_OK);
        return 2;
    }
    g_log = g_root / L"cerious-tray.log";
    if (argv && has_arg(argc, argv, L"--install-startup")) {
        const int rc = install_startup(g_root);
        LocalFree(argv);
        return rc;
    }
    if (argv) LocalFree(argv);

    g_icon_green = make_status_icon(RGB(21, 210, 96));
    g_icon_yellow = make_status_icon(RGB(255, 225, 64));
    g_icon_red = make_status_icon(RGB(238, 64, 64));

    WNDCLASSW wc{};
    wc.lpfnWndProc = wnd_proc;
    wc.hInstance = instance;
    wc.lpszClassName = kClassName;
    RegisterClassW(&wc);
    HWND hwnd = CreateWindowExW(0, kClassName, L"Cerious Systems Tray", 0,
                                0, 0, 0, 0, HWND_MESSAGE, nullptr, instance, nullptr);
    if (!hwnd) return 1;

    MSG msg{};
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    DestroyIcon(g_icon_green);
    DestroyIcon(g_icon_yellow);
    DestroyIcon(g_icon_red);
    return static_cast<int>(msg.wParam);
}

#else

int main() {
    return 1;
}

#endif
