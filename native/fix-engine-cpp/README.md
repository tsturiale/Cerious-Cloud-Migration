# Cerious FIX Engine - C++ Native Daemon

## Architecture

```text
Linux / local backend

  C++ Price Feed
    -> Aeron IPC / native event bus
    -> C++ Order Router / FIX Engine
    -> TT FIX Gateway or configured execution gateway

UI clients

  Cerious Terminal / Desktop Client
    -> REST/WebSocket control and read API
    -> native backend state snapshots
```

The FIX engine is a standalone C++ order sending daemon. It is not a UI component and it does not rely on any scripting runtime for order flow.

## What This Is

A standalone C++ FIX 4.4 order sending daemon that:

- runs as its own process
- exposes a local REST API on `127.0.0.1:8010` for non-critical UI/control reads
- communicates with other C++ services through Aeron IPC where enabled
- handles FIX session management, message construction, TCP I/O, and journaling in native C++
- supports sim/loopback mode and live mode

## Build

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\native\fix-engine-cpp\build-win.ps1
```

### Linux

```bash
chmod +x native/fix-engine-cpp/build-linux.sh
./native/fix-engine-cpp/build-linux.sh
```

### Prerequisites

- C++20 compiler, MSVC 19.30+ / GCC 12+ / Clang 14+
- CMake 3.24+
- Ninja
- OpenSSL 3
- vcpkg, auto-bootstrapped by build scripts

## Run

### Sim Mode

```bash
./native/fix-engine-cpp/build/cerious_fix_engine --mode sim --http-port 8010
```

### Live Mode

```bash
FIX_SENDER_COMP_ID=CERIOUS \
FIX_TARGET_COMP_ID=TT \
FIX_TARGET_HOST=fix.tradingtechnologies.com \
FIX_TARGET_PORT=10000 \
FIX_ACCOUNT=YOUR_ACCOUNT \
FIX_PASSWORD=YOUR_PASSWORD \
./native/fix-engine-cpp/build/cerious_fix_engine --mode live --http-port 8010
```

## Embedded REST API

The daemon exposes these endpoints on `127.0.0.1:8010`:

| Method | Path | Description |
| --- | --- | --- |
| GET | `/status` | Session state, sequence numbers, uptime |
| GET | `/journal` | Recent FIX messages |
| POST | `/send` | Send `NewOrderSingle` |
| POST | `/cancel` | Send `OrderCancelRequest` |
| POST | `/replace` | Send `OrderCancelReplaceRequest` |
| GET | `/stats` | Aggregate message counts |
| POST | `/shutdown` | Graceful shutdown |

The REST API is a control/read surface. Authoritative order state, fills, positions, and PnL must come from the native event contract.

## Aeron IPC Channels

| Stream | ID | Direction | Description |
| --- | ---: | --- | --- |
| Market Data | 1001 | price-feed -> fix-engine | Live normalized market data |
| Order Events | 2001 | fix-engine -> native consumers | Order/fill events |
| FIX Journal | 3001 | fix-engine -> native/UI consumers | FIX journal events |

For cross-host deployment, Aeron can use UDP channels:

- `aeron:udp?endpoint=239.255.1.1:40001`
- `aeron:udp?endpoint=239.255.1.1:40002`
- `aeron:udp?endpoint=239.255.1.1:40003`

## Contract Rule

Per `native/README.md`, this service publishes the same logical event contracts:

- order event
- fill event
- position snapshot
- audit event
