# QuantSwarm Terminal

Real-time prediction market trading workstation for Polymarket, Kalshi, and Dome. Combines live CLOB data, multi-model signals, regime detection, paper trading, copy trading, and truth probability engine in a single dark terminal interface.

## Overview

QuantSwarm Terminal is a full-stack system that rotates through 28 market slots (7 crypto assets × 4 timeframes), streams real-time probability and order flow, runs quantitative models, enforces hard risk limits, and supports live/paper execution. Backend serves both REST and WebSocket at a single port in production.

## Core Features

### Market Rotation & Discovery
- 28-slot rotation system (BTC/ETH/SOL/XRP/HYPE/BNB/DOGE × 5m/15m/1h/4h)
- Automatic staged market promotion with 30s grace window
- Eager + scheduled discovery via Dome REST + Polymarket Gamma
- Synthetic market fallback when no live market exists
- Kalshi 15m markets as parallel provider (switchable in UI)

### Live Data Stack
- Dome WS: real-time poly_tick order flow (top 5 markets prioritized)
- Polymarket RTDS: crypto_prices + chainlink_prices topics via aiohttp
- Coinbase Advanced Trade WS: OHLCV bars (no key required)
- CLOB WebSocket pool with 6-layer guard system (warmup, dedup, stale tick, anti-jitter)
- Dome REST poller: authoritative price_to_beat, final_price, expiry_ts, winning_side

### Signal & Feature Engine
- FeatureEngine: ATR, OFI, z-score, Keltner Channels, VPIN
- 6 pure-function signal models in shared/models.py
- TriEngineSystem: 6-state HMM + PCA + JSD regime detection
- Real-time regime labels and model outputs broadcast via WS

### Truth Engine
- Merton Jump-Diffusion probability model with optional Student-t tails
- Outputs: p_up, p_down, gamma, theta, vega, vanna, charm, jump_risk, edge_up/down
- Runs every 10s on active markets; results attached to market dicts

### Risk & Execution
- RiskGate: pre-trade hard limit enforcement (position size, daily loss, drawdown, open count)
- Paper trading with full P&L, journal, and settlement recording
- EdgeCopy: copy-trading bot that follows master wallets (dry_run support)
- config.toml driven risk/model parameters with env var overrides

### Frontend (React 19 + TS)
- Single WS connection per active asset (AssetConnector)
- Auto-rotate mode (MarketRotator)
- 3-panel resizable layout (MarketNav/SignalPanel | Charts | Book/Tape/AGR/Orders)
- PolyPriceChart (canvas) + lightweight-charts v5 for OHLCV
- ProbChart, TapeIndicator, AGRFlow (cumulative order flow)
- 4 live CSS-variable themes (dark-navy, gunmetal, abyss, terminal-green)
- Pop-out tabs into floating windows

### Additional Systems
- Journal + Settlements history
- live_poly_agent.py: standalone CCXT + TriEngine + Google Sheets runner
- Binary_Bot: separate Titanium V3 binary options runner
- Analysis scripts in scripts/ (vol diagnostics, path audits, regime audits)
- Full test suite (pytest features + risk_gate)

## Tech Stack

- Backend: FastAPI, Uvicorn, aiohttp, ccxt
- Frontend: React 19, TypeScript, Vite, Zustand, lightweight-charts, react-resizable-panels
- Quant: numpy, pandas, scipy, scikit-learn, hmmlearn
- Data: Polymarket Gamma/CLOB/RTDS, Dome API, Coinbase, Kalshi (optional)
- Config: config.toml + .env

## Quick Start

```bash
pip install -e .
cd terminal && npm install
# Dev
.\start.ps1 -Dev
# Prod (single port)
.\start.ps1
```

See CLAUDE.md for full commands, architecture details, and dev rules.

## Project Layout

```
QuantSwarmTerminal/
├── terminal/
│   ├── backend/main.py          # ~130 KB FastAPI core
│   ├── backend/rtds_client.py   # Polymarket RTDS WS
│   ├── backend/ws_pool.py       # Guarded CLOB WS lifecycle
│   └── src/                     # React frontend
├── shared/                      # Quant library (features, models, risk, tri_engine)
├── edgecopy/                    # Copy-trading bot
├── live_poly_agent.py
├── config.toml
└── CLAUDE.md                    # Full dev guide
```

## Status

Active development. Production serving via single-port FastAPI + static. All core data paths (Dome, RTDS, CLOB, rotation, truth) live and tested.