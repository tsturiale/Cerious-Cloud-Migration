# Cerious Systems

Native trading terminal package for the Cerious CME workspace.

## Runtime Architecture

Cerious local now starts as a native service stack:

```text
Tauri desktop client / local portal
        |
        v
native/gateway-cpp/cerious_gateway.exe       port 8000
        |
        +--> native/simulex-cpp/cerious_simulex_server.exe   port 8011
        +--> native/price-feed-cpp/cerious_price_feed.exe
        +--> native/price-feed-cpp/cerious_price_history.exe
        +--> native/fix-engine-cpp/cerious_fix_engine.exe
```

The frontend renders state. Trading state, matching, fills, positions, PnL, price ownership, and order routing belong to native C++ services.

## Canonical Startup

Use:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-CeriousApp.ps1 -HostOnly
```

The launcher starts:

- `cerious_simulex_server.exe` on `127.0.0.1:8011`
- `cerious_gateway.exe` on `127.0.0.1:8000`

The portal URL is:

[http://127.0.0.1:8000/](http://127.0.0.1:8000/)

For Windows login startup and tray health, use:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-CeriousStartupService.ps1 -RunNow
```

The Cerious Startup Service monitors one contract:

- gateway health: `/api/health`
- market-data session health: `/api/market-data/status`
- execution-session health: `/api/execution/status`

Market-data connection/subscription health and price-book readiness are separate. A connected Databento session can be healthy while waiting for the next MBP-1 price event.

## Native Modules

`native/gateway-cpp`

Native local gateway. Owns the local HTTP contract used by the Tauri client and proxies order state to Simulex.

`native/simulex-cpp`

Deterministic local simulation exchange. Owns accepted orders, cancel/replace, matching, fills, positions, and PnL for simulation mode.

`native/price-feed-cpp`

Databento C++ live and historical market data clients.

`native/fix-engine-cpp`

C++ FIX 4.4 order-routing engine and local command/status API.

## Data

`data/algo-definitions`

Saved algorithm definitions. The native gateway publishes these to the client through `/api/algo-manager/state`.

`data/workspace-store/tsturiale`

Saved workspace layouts and latest default workspace.

`data/fills`

Fill journals and backups.

`data/runtime`

Runtime state snapshots used by local testing.

## Build

Visual Studio and CMake are expected on Windows. If `cmake` is not on PATH, use the Visual Studio bundled CMake:

```powershell
& 'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe' -S native\gateway-cpp -B native\gateway-cpp\build
& 'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe' --build native\gateway-cpp\build --config Release --parallel
```

Repeat for `native\simulex-cpp`, `native\price-feed-cpp`, and `native\fix-engine-cpp` as needed.

## Health Checks

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
Invoke-RestMethod http://127.0.0.1:8011/health
```

Expected gateway response includes:

```json
{
  "ok": true,
  "app": "cerious-systems",
  "runtime": "cpp",
  "backend": "native-cpp",
  "simulex": true
}
```

## Deployment Rule

Do not add trading-critical state or order-routing logic to the UI. If the UI needs a value, the native service layer must publish it.
