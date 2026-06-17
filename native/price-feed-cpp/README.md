# Cerious Databento C++ Feed Handler

This service is the first native price-service component.

## Goal

Subscribe to CME Databento `GLBX.MDP3` MBP-1 with the official threaded live client and publish normalized Cerious market events.
Fetch historical Databento OHLCV/trade backfill and publish normalized Cerious bar/trade events.

## Current State

This builds and runs on Windows with Visual Studio Build Tools, CMake, and vcpkg.

Built binaries:

- `cerious_price_feed.exe`: live MBP-1 stream.
- `cerious_price_history.exe`: historical REST/backfill.

The live executable follows Databento's C++ live quickstart pattern:

- `LiveThreaded::Builder()`
- `SetKeyFromEnv()`
- `SetDataset(GLBX.MDP3)`
- `PitSymbolMap`
- `Subscribe(..., Schema::Mbp1, ...)`
- `Start(metadata_handler, record_handler, exception_handler)`

The Python price service can consume this handler with:

```powershell
$env:CERIOUS_PRICE_PROVIDER="databento_cpp"
```

Leave the default provider as `databento` until parity checks pass.

## Build Prerequisites

- C++17 compiler
- CMake 3.24+
- OpenSSL 3
- zstd
- `DATABENTO_API_KEY` environment variable

## First Build Target

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
.\native\price-feed-cpp\build\cerious_price_feed.exe --symbols ES.v.0,NQ.v.0,YM.v.0,RTY.v.0,CL.v.0,GC.v.0,ZM.v.0,ZS.v.0 --stype continuous --max-records 3
```

Expected output is JSON lines like:

```json
{"type":"market.mbp1","dataset":"GLBX.MDP3","schema":"mbp-1","symbol":"ESM6","instrumentId":42140864,"action":"C","bid":7525.0,"ask":7525.25}
```

Historical OHLCV smoke:

```powershell
$env:DATABENTO_API_KEY="..."
.\native\price-feed-cpp\build\cerious_price_history.exe --symbols ES.v.0 --stype continuous --schema ohlcv-1m --start 2026-06-16T18:30 --end 2026-06-16T18:40 --limit 3
```

Expected output is JSON lines like:

```json
{"type":"market.ohlcv","dataset":"GLBX.MDP3","schema":"ohlcv-1m","symbol":"ES.v.0","open":7537.25,"high":7538.25,"low":7534.25,"close":7535.25,"volume":212}
```

Production publisher:

- Aeron IPC/UDP publication.
- Aeron Archive recording for replay.
- Gateway subscriber bridge.

## Price Service Bridge

The current bridge is `services/price/native_databento_adapter.py`.

It starts this executable, reads stdout JSON lines, and converts them into the same `Quote` contract used by the existing Python Databento adapter.

This lets the terminal opt into native CME ingress without rewriting the gateway or UI.

Enable live native ingress for local testing:

```powershell
$env:CERIOUS_PRICE_PROVIDER="databento_cpp"
.\Start-CeriousTerminal.ps1
```

Do not make this the default until live, historical, synthetic spread, chart, study, and algo send-price parity are verified.
