# QuantSwarm — Dev Team Handover

**Owner:** QuantSwarm (trade)  
**Date:** 2026-04-14  
**Branch:** `feature/titanium-v5-update`  
**Main systems:** QuantSwarm Terminal + BizOS

---

## Two Systems, One Ecosystem

| System | Location | Purpose | Status |
|---|---|---|---|
| **QuantSwarm Terminal** | `C:\Users\trade\OneDrive\Desktop\QuantSwarmTerminal\` | React/TypeScript trading workstation (Polymarket, crypto, options) | Live, actively developed |
| **BizOS** | `C:\bizos\` | Sovereign agentic OS — AI agents that trade, monitor, and self-manage | Phase 4 complete, 125/125 tests |

These two systems are separate codebases but share a purpose: systematic, AI-driven quantitative trading.

---

## Quick Links

- [BIZOS.md](BIZOS.md) — Full BizOS architecture, agents, setup, and run instructions
- [TERMINAL.md](TERMINAL.md) — QuantSwarm Terminal stack, components, and dev server
- [SETUP.md](SETUP.md) — Step-by-step environment setup for a new developer
- [ROADMAP.md](ROADMAP.md) — What's built, what's stubbed, what's next

---

## The Big Picture

### QuantSwarm Terminal
A React workstation for Polymarket prediction market trading. Displays live prices, probability charts, order books, order panels, and P&L. Connects to Polymarket's Gamma API and CLOB API.

Key capabilities:
- Multi-asset chart view (BTC, ETH, SOL, XRP, sports markets)
- Probability chart with live signal overlays
- Paper trade mode with position tracking
- Analytics, performance calendar, edge copy panel

### BizOS
An AI-orchestrated backend OS where Claude Desktop dispatches tasks via MCP tools, which route through Hermes (router) into a Supabase queue, and get executed by specialized worker agents (OpenClaw for market ops, NullClaw for process management).

Key capabilities:
- `fetch_btc_signal` — 6-state HMM regime detection via QuantSwarm engine
- `run_nfl_sync` — Odds API sports data pull
- `execute_trade` — Trade execution stub (dry_run=True, ready to wire)
- `kill_process`, `purge_cache`, `health_check` — System watchdog ops
- `write_audit_log` — Structured audit trail to Obsidian vault

---

## Repository Layout

```
QuantSwarmTerminal/
├── terminal/              # React app (Vite + TypeScript + Tailwind)
│   ├── src/
│   │   ├── components/    # All UI components
│   │   ├── hooks/         # Custom React hooks
│   │   ├── lib/           # API clients, utilities
│   │   └── store/         # Zustand state stores
│   └── package.json
├── docs/
│   ├── superpowers/
│   │   ├── plans/         # Implementation plans
│   │   └── specs/         # Design specifications
│   └── team/              # This folder — dev team handover docs
└── .github/

C:\bizos\                  # BizOS — lives outside QuantSwarmTerminal repo
├── hermes/                # Phase 1 — MCP router (55 tests)
├── openclaw/              # Phase 2 — Execution worker (22 tests)
├── nullclaw/              # Phase 3 — Process watchdog (23 tests)
├── core/                  # Phase 4 — Orchestrator + CLI (25 tests)
└── vault/                 # Obsidian knowledge graph
```

---

## Tech Stack Summary

| Layer | Technology |
|---|---|
| Terminal UI | React 18, TypeScript, Vite, Tailwind CSS, Radix UI |
| Terminal state | Zustand |
| Terminal charts | Recharts |
| BizOS MCP | FastMCP (stdio, Claude Desktop) |
| BizOS workers | Python 3.11+, asyncio |
| BizOS queue | Supabase (PostgreSQL) |
| BizOS memory | Honcho |
| BizOS vault | Obsidian .md files |
| HMM engine | hmmlearn, scikit-learn, pandas |
| Testing | pytest, pytest-asyncio, unittest.mock |

---

## Critical Rules (Do Not Break)

1. **dry_run=True is the default for all trade execution** — never flip this without explicit owner sign-off
2. **MAX_DRAWDOWN = 2%** — system halts and requires manual restart if hit
3. **All parameters in config.py** — never hardcode thresholds in strategy files
4. **HMM always: n_components=6, n_iter=100, random_state=42** — do not deviate
5. **Chop regimes (IDs 2, 3) are excluded from trading** — always
6. **No re-fitting models on live data** — parameters lock when live trading starts
