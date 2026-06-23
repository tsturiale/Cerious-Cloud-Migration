# Cerious Databento C++ Feed Handler

This service is the native price-service component for CME Databento ingress.

## Goal

Subscribe to CME Databento `GLBX.MDP3` MBP-1 with the official C++ live client and publish normalized Cerious market events.
Fetch historical Databento OHLCV/trade backfill and publish normalized Cerious bar/trade events.

## Current State

This builds and runs on Windows with Visual Studio Build Tools, CMake, and vcpkg.

Built binaries:

- `cerious_price_feed.exe`: live MBP-1 stream
- `cerious_price_history.exe`: historical REST/backfill

The live executable follows the production Cerious Databento rule:

- C++ only in the backend path
- `LiveBlocking::Builder()`
- `SetKeyFromEnv()`
- `SetDataset(GLBX.MDP3)`
- `PitSymbolMap`
- `Subscribe(..., Schema::Definition, ...)`
- `Subscribe(..., Schema::Mbp1, ...)`
- `Start()`
- `NextRecord(timeout)` inside an outer reconnect loop
- stale-feed watchdog that calls `Stop()` and rebuilds the Databento session
- exponential reconnect backoff for hard gateway/network failures
- explicit JSON status events for `subscription_requested`, `subscription_ack`, `symbol_mapping`, `heartbeat`, `record`, `stale_reconnect`, and `reconnecting`

## Build Prerequisites

- C++17 compiler
- CMake 3.24+
- OpenSSL 3
- zstd
- `DATABENTO_API_KEY` environment variable

## Build

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\native\price-feed-cpp\build-win.ps1
```

### Linux Server

```bash
sudo apt-get update
sudo apt-get install -y build-essential cmake ninja-build git pkg-config curl zip unzip tar
git clone https://github.com/microsoft/vcpkg.git .tools/vcpkg
.tools/vcpkg/bootstrap-vcpkg.sh -disableMetrics
.tools/vcpkg/vcpkg install openssl:x64-linux zstd:x64-linux
cmake -S native/price-feed-cpp -B native/price-feed-cpp/build -G Ninja \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DCMAKE_TOOLCHAIN_FILE="$PWD/.tools/vcpkg/scripts/buildsystems/vcpkg.cmake" \
  -DVCPKG_TARGET_TRIPLET=x64-linux
cmake --build native/price-feed-cpp/build --config RelWithDebInfo
```

## Runtime Direction

Live MBP-1 smoke:

```powershell
$env:DATABENTO_API_KEY="..."
.\native\price-feed-cpp\build\cerious_price_feed.exe --symbols ES.v.0,MES.v.0,NQ.v.0,MNQ.v.0,YM.v.0,MYM.v.0,RTY.v.0,M2K.v.0,CL.v.0,GC.v.0,ZM.v.0,ZS.v.0 --stype continuous --max-records 3
```

Optional watchdog controls:

```powershell
.\native\price-feed-cpp\build\cerious_price_feed.exe --symbols ES.v.0,MES.v.0,NQ.v.0,MNQ.v.0 --stype continuous --stale-ms 30000 --reconnect-ms 5000 --max-reconnect-ms 60000
```

The gateway passes `CERIOUS_PRICE_FEED_STALE_MS`, `CERIOUS_PRICE_FEED_RECONNECT_MS`, and `CERIOUS_PRICE_FEED_MAX_RECONNECT_MS` through to this process. Defaults are 30 seconds stale threshold, 5 seconds normal reconnect delay, and 60 seconds max backoff.

The installed Databento C++ headers used by this project do not expose `SetReconnectPolicy(true)`. The production equivalent here is the explicit C++ supervision loop: subscribe, start, process records with a timeout, stop on staleness, sleep with backoff, rebuild the client, and resubscribe.

Intraday recovery is handled by the native `cerious_price_history` executable. On reboot or chart startup, the gateway can request Databento historical OHLCV/trade ranges to bridge missed bars before the live MBP-1 stream resumes. Exact tick-gap replay for order-book reconstruction should be implemented as a dedicated C++ recovery step before production exchange routing.

Expected output is normalized market data, currently emitted as JSON lines for inspection:

```json
{"type":"market.mbp1","dataset":"GLBX.MDP3","schema":"mbp-1","symbol":"ESM6","instrumentId":42140864,"action":"C","bid":7525.0,"ask":7525.25}
```

Historical OHLCV smoke:

```powershell
$env:DATABENTO_API_KEY="..."
.\native\price-feed-cpp\build\cerious_price_history.exe --symbols ES.v.0 --stype continuous --schema ohlcv-1m --start 2026-06-16T18:30 --end 2026-06-16T18:40 --limit 3
```

Expected output:

```json
{"type":"market.ohlcv","dataset":"GLBX.MDP3","schema":"ohlcv-1m","symbol":"ES.v.0","open":7537.25,"high":7538.25,"low":7534.25,"close":7535.25,"volume":212}
```

## Production Publisher

The production path is native event publication:

- Aeron IPC/UDP publication
- Aeron Archive recording for replay
- normalized product definitions, quote updates, trade updates, synthetic spread marks, OHLCV bars, and study-ready state

The UI should consume read models derived from these events. It must not own pricing, synthetic spread marks, or study inputs.
