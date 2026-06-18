# Cerious Systems — Trading Terminal Platform

> **Native C++ order execution • Databento CME data • React terminal • Python gateway**

Cerious Systems is a professional-grade trading terminal for CME equity index futures (ES, NQ, YM, RTY) and synthetic inter-market spreads (ES/NQ, YM/ES, RTY/ES). It combines a native C++ FIX 4.4 order engine with a browser-based terminal UI, designed for low-latency order execution and real-time spread analysis.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Browser Terminal (React)                   │
│  Vite + TypeScript │ Charts │ Order Entry │ Spread Analysis     │
│  http://127.0.0.1:5173                                         │
└──────────────┬──────────────────────────┬───────────────────────┘
               │ HTTP / WebSocket         │
               ▼                          ▼
┌──────────────────────────────┐  ┌──────────────────────────────┐
│  Python Gateway (FastAPI)    │  │  WebSocket /ws/{symbol}      │
│  Uvicorn :8000               │  │  Live tick streaming         │
│                              │  │  Quote + OHLCV push          │
│  ┌────────────────────────┐  │  └──────────────────────────────┘
│  │ REST Endpoints         │  │
│  │  /api/bars/{symbol}    │  │
│  │  /api/acme/intelligence│  │
│  │  /api/acme/lr27/{sym}  │  │
│  │  /api/acme/spreads     │  │
│  │  /api/auth/*           │  │
│  │  /api/orders/*         │  │
│  └────────────────────────┘  │
└──────────────┬───────────────┘
               │ Aeron IPC (Streams 1001–3001)
               ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Native C++ Layer                              │
│                                                                  │
│  ┌──────────────────────┐    ┌─────────────────────────────────┐ │
│  │  FIX 4.4 Engine      │    │  Price Feed (Databento C++)     │ │
│  │  cerious_fix_engine  │    │  cerious_price_feed             │ │
│  │                      │    │  cerious_price_history           │ │
│  │  • FIX message codec │    │                                 │ │
│  │  • Session state     │    │  • LiveThreaded MBP-1 stream   │ │
│  │  • 2000-entry journal│    │  • Historical REST backfill    │ │
│  │  • Order router      │    │  • Zero-copy DBN decoding     │ │
│  │  • Sim/loopback mode │    │  • OHLCV aggregation          │ │
│  │  • Embedded REST API │    │  • Aeron IPC publish          │ │
│  └──────────────────────┘    └─────────────────────────────────┘ │
│                                                                  │
│  Transport: Aeron IPC (lock-free, kernel-bypass shared memory)   │
└──────────────────────────────────────────────────────────────────┘
```

### Design Principles

| Principle | Implementation |
|-----------|----------------|
| **C++ for all critical modules** | FIX engine, price feed, order router — no Python on the hot path |
| **Python for UI boundary only** | FastAPI gateway serves HTTP/WS to the browser; no order routing |
| **Unified Databento data path** | Both live (TCP) and historical (REST) produce identical `db::Mbp1Msg` / `db::OhlcvMsg` structs — one parser, zero-copy |
| **Aeron IPC** | All service-to-service communication uses lock-free shared-memory channels |
| **Fail-closed algo deployment** | LR27 study freshness is validated before any algo order is placed |

---

## Directory Structure

```
Cerious-Cloud-Migration/
├── apps/
│   └── terminal/                # React + Vite + TypeScript browser UI
│       ├── src/components/
│       │   ├── WorkspaceDesktop.tsx   # Main trading workspace (9800+ lines)
│       │   └── PortalGate.tsx         # Auth gate with auto-login
│       └── vite.config.ts
│
├── native/                      # C++ performance-critical modules
│   ├── fix-engine-cpp/          # FIX 4.4 order engine
│   │   ├── CMakeLists.txt
│   │   ├── build-linux.sh       # Linux datacenter build
│   │   ├── build-win.ps1        # Windows dev build
│   │   └── src/
│   │       ├── main.cpp              # Entry point + REST API
│   │       ├── fix_message.hpp       # FIX 4.4 message builder/parser
│   │       ├── fix_session.hpp       # Session state machine
│   │       ├── fix_journal.hpp       # 2000-entry persistent journal
│   │       ├── fix_tcp.hpp           # TCP transport for FIX gateway
│   │       ├── fix_sim.hpp           # Simulator/loopback exchange
│   │       ├── fix_http_server.hpp   # Embedded REST API (cpp-httplib)
│   │       ├── order_router.hpp      # Order routing + management
│   │       └── aeron_transport.hpp   # Aeron IPC publish/subscribe
│   │
│   └── price-feed-cpp/          # Databento C++ market data
│       └── src/
│           ├── main.cpp              # Live MBP-1 streaming
│           └── history.cpp           # Historical REST + OHLCV queries
│
├── services/                    # Python services (UI boundary only)
│   ├── gateway/main.py          # FastAPI gateway — REST + WebSocket
│   ├── intelligence/service.py  # Spread RV, LR27 studies, Goose algo
│   ├── studies/service.py       # Bar aggregation, LR27 computation
│   ├── common/
│   │   ├── historical.py        # Databento REST backfill (Python)
│   │   ├── bus.py               # Market data bus (quotes, bars)
│   │   └── contracts.py         # CME product definitions
│   ├── order/service.py         # Order state management
│   ├── fill/service.py          # Fill journal
│   ├── algo_engine/service.py   # Algo definitions and guard events
│   ├── price/service.py         # Price provider abstraction
│   └── sim_exchange/service.py  # Simulated exchange for dry-run
│
├── data/
│   ├── algo-definitions/        # Algo JSON configs
│   ├── product-definitions/     # CME product specs
│   ├── workspace-store/         # Saved workspace layouts
│   └── runtime/                 # Runtime state (algo orders, fills)
│
├── .env                         # Local credentials (not committed)
├── .env.example                 # Template with all env vars
├── Launch-Cerious.bat           # One-click desktop launcher
├── Create-DesktopShortcut.ps1   # Creates desktop shortcut
└── requirements.txt             # Python dependencies
```

---

## Local Development

### Prerequisites

- **Python 3.12+** with `pip`
- **Node.js 18+** with `npm`
- **CMake 3.20+** (for C++ builds)
- **Databento API key** (for live/historical CME data)

### Quick Start

**Option 1 — Desktop Launcher (recommended):**

Double-click `Launch-Cerious.bat` or run `Create-DesktopShortcut.ps1` to add a desktop icon.

**Option 2 — Manual:**

```powershell
# 1. Configure credentials
copy .env.example .env
# Edit .env with your DATABENTO_API_KEY and portal password

# 2. Start backend
python -m uvicorn services.gateway.main:app --host 127.0.0.1 --port 8000

# 3. Start frontend (separate terminal)
cd apps/terminal
npm install
npm run dev
```

**Open**: http://127.0.0.1:5173

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABENTO_API_KEY` | Yes | Databento API key for CME data |
| `CERIOUS_PORTAL_USERNAME` | Yes | Terminal login username |
| `CERIOUS_PORTAL_PASSWORD` | Yes | Terminal login password |
| `CERIOUS_AUTH_SECRET` | No | HMAC secret for session tokens (defaults to dev secret) |
| `CERIOUS_DRY_RUN` | No | `1` = simulated orders (default), `0` = live orders |
| `CERIOUS_PRICE_PROVIDER` | No | `databento` (default) or `t4` |

---

## C++ Native Layer

### FIX 4.4 Engine (`native/fix-engine-cpp/`)

A standalone C++ FIX 4.4 engine with:

- **Message codec** — zero-copy FIX tag-value builder/parser with SOH delimiters and checksum validation
- **Session state machine** — Logon → Active → Heartbeat/TestRequest → Logout with MsgSeqNum tracking
- **2000-entry journal** — ring-buffer persistence for audit trail and replay
- **Order router** — NewOrderSingle (D), CancelRequest (F), CancelReplaceRequest (G) with ClOrdID management
- **Sim/loopback mode** — synthetic fill generation for testing without a live FIX gateway
- **Embedded REST API** — `cpp-httplib` server on `:9100` exposing order state via JSON

```powershell
# Build on Windows
.\native\fix-engine-cpp\build-win.ps1

# Build on Linux (datacenter deployment)
./native/fix-engine-cpp/build-linux.sh
```

### Price Feed (`native/price-feed-cpp/`)

Databento C++ client using the unified DBN (Databento Binary Encoding) data path:

- **Live streaming** — `db::LiveThreaded::Builder()` with MBP-1 schema for real-time BBO + trades
- **Historical backfill** — `db::Historical::Builder()` with `TimeseriesGetRange()` for chart history
- **Zero-copy decoding** — `db::Mbp1Msg` structs are binary-compatible across live and historical APIs
- **Fixed-point conversion** — `bid_px / 1e9` for Databento's int64 fixed-point prices
- **Trade detection** — `mbp->flags & db::RecordFlags::F_LAST` identifies last-trade records
- **OHLCV aggregation** — subscribes to `ohlcv-1s` or aggregates from MBP-1 for custom intervals
- **Aeron IPC publish** — pushes decoded prices to shared-memory channels for sub-microsecond delivery

### Aeron IPC Transport

All C++ services communicate via [Aeron](https://github.com/real-logic/aeron) shared-memory IPC:

| Stream | Channel | Purpose |
|--------|---------|---------|
| 1001 | `aeron:ipc` | Live price quotes (BBO + last trade) |
| 2001 | `aeron:ipc` | Order events (new, cancel, fill) |
| 3001 | `aeron:ipc` | System heartbeat + status |

---

## Databento Integration (Best Practices)

The platform follows Databento's unified architecture:

1. **Unified DBN parsing** — Both live TCP and historical REST return identical binary `Mbp1Msg` / `OhlcvMsg` structs. One parser handles both.
2. **Live snapshot** — `SubscribeWithSnapshot()` or intraday replay provides immediate state on connect
3. **Historical backfill** — `db::Historical::TimeseriesGetRange()` fills chart history before live stream begins
4. **Zero-copy** — DBN allows direct `reinterpret_cast` from read buffer to record struct
5. **UI subsampling** — Charts consume OHLCV bars (not raw MBP-1 ticks) to prevent terminal overload

---

## Studies & Algo Engine

### 27-Period Linear Regression (LR27)

The LR27 study computes a linear regression channel from the last 27 completed 30-minute bars:

- **Endpoint**: `GET /api/acme/lr27/{symbol}?fresh=true`
- **Computation**: Least-squares regression → mean, ±2σ bands, slope
- **Data source**: Databento REST historical bars merged with live rolling OHLCV
- **Algo pegging**: Buy-side orders peg to LR27 -2σ, sell-side to LR27 +2σ

### Spread Relative Value (RV)

Daily RV analysis for synthetic inter-market spreads:

- **z-score**: `(last - 30D_mean) / blended_ATR`
- **Signals**: Buy setup (z ≤ -1.5), Sell setup (z ≥ 1.5), Neutral (|z| < 0.5)
- **Goose algorithm**: Automatically selects the strongest spread signal and tracks regime changes

---

## Changes Made (2026-06-17)

### Critical Bug Fixes

1. **Empty charts resolved** — Added `DATABENTO_API_KEY` to `.env`. Historical backfill was returning `[]` because the key was missing.

2. **LR27 algo peg mismatch fixed** — The algo engine computed LR27 from a different bar set than the chart. Root cause: `_lr_peg_bars()` called `cached_bars()` (cache-only, returns `[]` on cold start) instead of `bars()` (fetches from Databento on cache miss). Orders were pegging to regression values computed from 1-2 live bars instead of 27 historical bars.

3. **Auth persistence fixed** — Sessions were cleared on backend restart because the frontend immediately dropped stored tokens on any network error. Now retries 3x with 2s delays, and falls back to auto-login via `POST /api/auth/auto` (mints a fresh token from `.env` credentials).

### Architecture Changes

4. **`POST /api/auth/auto` endpoint** — Server-side auto-login using `.env` credentials. Prevents lockouts during development when the backend restarts.

5. **`_lr_peg_bars()` wired to `bars()`** — Intelligence service now uses the same historical backfill path as the chart, ensuring LR27 values are identical between the chart overlay and the algo peg engine.

6. **`_daily_rv_bars()` needs same fix** — Identified that the daily RV bars for spread charts also use `cached_bars()`, causing "Need more bars" on ES/NQ at startup. Same pattern as the LR27 bug.

---

## Roadmap: Localhost → Datacenter

### Phase 1: Local Development (Current)
- [x] C++ FIX 4.4 engine with sim/loopback
- [x] Databento live + historical data
- [x] Browser terminal with chart + order entry
- [x] LR27 + spread RV studies
- [x] Desktop launcher

### Phase 2: Unified C++ Price Service
- [ ] Single C++ daemon merging live streaming + historical backfill
- [ ] `db::LiveThreaded` for real-time MBP-1
- [ ] `db::Historical::TimeseriesGetRange` for chart history
- [ ] Intraday replay for gap filling between history and live
- [ ] Aeron IPC publish for all downstream consumers

### Phase 3: Linux Backend Deployment
- [ ] Build and deploy `cerious_fix_engine` on Linux
- [ ] Build and deploy unified price service on Linux
- [ ] Aeron media driver tuning (pinned cores, huge pages)
- [ ] Python gateway runs as thin HTTP proxy to C++ backends

### Phase 4: TT FIX Gateway Integration
- [ ] Configure FIX session with TT (Trading Technologies) order gateway
- [ ] Map Cerious order model → TT FIX 4.4 tags
- [ ] `fix_tcp.hpp` connects to TT FIX endpoint (production)
- [ ] `fix_sim.hpp` remains for paper trading / QA
- [ ] Drop-copy session for fill reconciliation
- [ ] Risk checks: max position, max order rate, price collar

### Phase 5: Production Hardening
- [ ] Dual-redundant FIX sessions (primary + backup)
- [ ] Persisted journal replay on restart
- [ ] SMS/webhook alerts for session disconnects
- [ ] Latency monitoring (Aeron → FIX gateway round-trip)
- [ ] Deployment automation (Docker or systemd services)

---

## License

Proprietary — Cerious Systems. All rights reserved.
