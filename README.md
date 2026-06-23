# Cerious Systems

Cloud-native browser trading terminal with a React Script UI and modular C++
backend services for futures execution, market data, studies, algorithms,
state management, and deterministic local simulation.

## Last Known Good Backup

This build is marked as the current stable local/cloud-native baseline for the
Cerious futures EMS/OMS workspace.

- Active client: browser terminal at `http://127.0.0.1:8000/`
- UI role: render server-published state and submit typed user commands
- Backend role: own market data, study values, orders, fills, positions, PnL,
  algorithm lifecycle, audit trail, and exchange/simulation routing
- Current market-data path: Databento C++ CME MBP-1/top-of-book/last-trade
  feed plus historical chart backfill
- Current simulation path: `cerious-exchange-cpp`, a C++ deterministic FIFO
  CLOB simulation exchange
- Service transport direction: C++ service boundaries first, with Aeron IPC
  available for low-latency service-to-service messaging where enabled
- Desktop/Tauri workflow: removed from the active product path

## Runtime Architecture

Cerious local now starts as a native service stack:

```text
Chrome or Edge app-mode terminal / local portal
        |
        v
native/gateway-cpp/cerious_gateway.exe       port 8000
        |
        +--> native/cerious-exchange-cpp/cerious_exchange_server.exe   port 8011
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

- `cerious_exchange_server.exe` on `127.0.0.1:8011`
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

Native local gateway. Owns the local HTTP contract used by the browser terminal
and proxies order state to the active execution destination.

`native/cerious-exchange-cpp`

Active deterministic local simulation exchange. Owns accepted orders,
cancel/replace, FIFO CLOB matching, market-data-triggered resting limit fills,
positions, and PnL for simulation mode.

`native/simulex-cpp`

Legacy simulation exchange retained for rollback and cleanup review. It is not
the active local execution destination.

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

Repeat for `native\cerious-exchange-cpp`, `native\price-feed-cpp`, and
`native\fix-engine-cpp` as needed.

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
  "executionDestination": "cerious-exchange"
}
```

## Deployment Rule

Do not add trading-critical state or order-routing logic to the UI. If the UI needs a value, the native service layer must publish it.
