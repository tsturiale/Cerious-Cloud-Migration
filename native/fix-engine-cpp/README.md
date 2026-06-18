# Cerious FIX Engine — C++ Native Daemon

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                  LINUX BACKEND                       │
│                                                      │
│  ┌─────────────────┐      Aeron IPC       ┌────────┐│
│  │  C++ Price Feed  │ ──────────────────→ │  C++   ││
│  │  (databento-cpp) │                     │  FIX   ││
│  └─────────────────┘                     │ Engine ││
│                                           │        ││
│                                           │ :8010  ││
│                                           └───┬────┘│
│                                               │TCP   │
│                                               ↓      │
│                                          TT FIX GW   │
└──────────────────────────────────────────────────────┘
            ↑ HTTP (UI only)
┌──────────────────────────────────────────────────────┐
│                  WINDOWS CLIENT                      │
│                                                      │
│  ┌─────────────────┐      REST/WS       ┌──────────┐│
│  │ Cerious Terminal │ ←───────────────→ │  Python   ││
│  │    (Browser)     │                   │  Gateway  ││
│  │                  │                   │  (UI only)││
│  │  FIX Monitor ◄───┼───────────────────┤  :8000   ││
│  └─────────────────┘                   └──────────┘│
└──────────────────────────────────────────────────────┘
```

**No Python in the critical path.** Python only serves the browser UI.

## What This Is

A standalone C++ FIX 4.4 order sending daemon that:

- Runs as its own process (NOT a Python subprocess)
- Exposes a local REST API on `127.0.0.1:8010` for the UI layer
- Communicates with other C++ services via **Aeron IPC** (sub-microsecond)
- Handles all FIX session management, message construction, TCP I/O in native C++
- Supports sim/loopback mode (no real TCP) and live mode (TT FIX gateway)

## Build

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\native\fix-engine-cpp\build-win.ps1
```

### Linux (Production Backend)

```bash
chmod +x native/fix-engine-cpp/build-linux.sh
./native/fix-engine-cpp/build-linux.sh
```

### Prerequisites

- C++20 compiler (MSVC 19.30+ / GCC 12+ / Clang 14+)
- CMake 3.24+
- Ninja
- OpenSSL 3 (for TT TLS connection)
- vcpkg (auto-bootstrapped by build scripts)

## Run

### Sim Mode (default — safe, no real connections)

```bash
./native/fix-engine-cpp/build/cerious_fix_engine --mode sim --http-port 8010
```

### Live Mode (TT FIX Gateway)

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

| Method | Path       | Description |
|--------|------------|-------------|
| GET    | /status    | Session state, seq nums, uptime |
| GET    | /journal   | Recent FIX messages (journal ring buffer) |
| POST   | /send      | Send NewOrderSingle |
| POST   | /cancel    | Send OrderCancelRequest |
| POST   | /replace   | Send OrderCancelReplaceRequest |
| GET    | /stats     | Aggregate message counts |
| POST   | /shutdown  | Graceful shutdown |

The Python gateway proxies `/api/fix/*` to these endpoints. That's the ONLY Python involvement.

## Aeron IPC Channels

| Stream | ID   | Direction | Description |
|--------|------|-----------|-------------|
| Market Data  | 1001 | price-feed → fix-engine | Live CME market data |
| Order Events | 2001 | fix-engine → gateway    | Order/fill events |
| FIX Journal  | 3001 | fix-engine → gateway    | Journal for FIX Monitor UI |

For cross-host deployment (Linux backend → Windows client), Aeron falls back to UDP multicast:
- `aeron:udp?endpoint=239.255.1.1:40001` (market data)
- `aeron:udp?endpoint=239.255.1.1:40002` (order events)
- `aeron:udp?endpoint=239.255.1.1:40003` (FIX journal)

## Contract Rule

Per `native/README.md`, this service publishes the same logical event contracts:
- order event
- fill event
- position snapshot
- audit event
