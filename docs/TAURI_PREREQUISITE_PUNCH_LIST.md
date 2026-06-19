# Tauri Prerequisite Punch List

Purpose: move Cerious from the temporary Chrome app-mode shell into a real Tauri desktop client without breaking the current local trading workflow.

## Already Installed / Verified

- Visual Studio is installed under `C:\Program Files\Microsoft Visual Studio`.
- Rustup was installed with `winget` on this machine.
- Rust tools are present at `C:\Users\tstur\.cargo\bin`.
- Node and npm are installed under `C:\Program Files\nodejs`.
- Chrome is installed at `C:\Program Files\Google\Chrome\Application\chrome.exe`.
- Current Tauri CLI package version checked from npm: `@tauri-apps/cli 2.11.2`.

## Still Needed Before Building Tauri

1. Open a fresh terminal or add this to PATH for the current shell:
   `C:\Users\tstur\.cargo\bin`

2. Verify Rust:
   `rustc --version`
   `cargo --version`

3. Verify Visual Studio C++ workload:
   Visual Studio Installer should include `Desktop development with C++`.

4. Verify WebView2 runtime:
   Tauri on Windows uses Microsoft WebView2. Edge usually provides it, but production installers should check/bundle the WebView2 runtime.

5. Verify CMake path if native C++ services are built from the desktop package:
   `cmake --version`

6. Add Tauri dependencies to the terminal package:
   `@tauri-apps/cli`
   `tauri`
   `tauri-build`

7. Build target workflow:
   Frontend build: `npm --prefix apps/terminal run build`
   Tauri build: `npm --prefix apps/terminal run tauri build`

## Target Tauri Design

- One native Cerious executable.
- Native process starts/stops local services.
- No visible backend/service consoles.
- One Cerious desktop window.
- Closing the desktop window shuts down owned local services.
- Same React UI and workspace persistence.
- Later server mode connects to cloud/exchange-data-center native services instead of starting local services.

## Current Temporary Launch Mode

Until the Tauri executable is built, the desktop shortcut launches Chrome app-mode:

- Chrome app window, not a normal browser tab.
- Backend starts hidden.
- No Vite/dev server.
- No service console windows.
- Closing the app window shuts down the local backend.
