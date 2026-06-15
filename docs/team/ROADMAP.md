# Roadmap — What's Built, What's Next

**Last updated:** 2026-04-14  
**Current status:** BizOS Phase 4 complete (125/125 tests), Terminal Titanium V5

---

## What's Complete

### BizOS

| Phase | What | Tests | Notes |
|---|---|---|---|
| 1 — Hermes | FastMCP router, 5-layer pipeline, Supabase queue, Honcho memory, Obsidian vault | 55/55 | Registered in Claude Desktop |
| 2 — OpenClaw | Execution worker, BTC signal, NFL sync | 22/22 | execute_trade/odds/polymarket are stubs |
| 3 — NullClaw | Process watchdog, health check, audit log | 23/23 | All ops behind dry_run=True gate |
| 4 — Core | Orchestrator, health monitor, CLI | 25/25 | Manages openclaw + nullclaw as subprocesses |

### QuantSwarm Terminal

| Feature | Status | Notes |
|---|---|---|
| Multi-panel resizable layout | Complete | Titanium V5 — col splits + row wheel-drag |
| Chart (single + multi) | Complete | lightweight-charts |
| PolyPriceChart | Complete | Gamma API |
| ProbChart with signal overlay | Complete | |
| TapeIndicator | Complete | |
| MarketNav | Complete | |
| SignalPanel | Complete | HMM regime display |
| OrderBook | Complete | |
| OrderPanel (paper mode) | Complete | |
| PositionMonitor | Complete | |
| RiskBar | Complete | drawdown tracking |
| Analytics + Performance | Complete | |
| PerformanceCalendar | Complete | |
| EdgeCopyPanel | Complete | |
| JournalNotes | Complete | |
| Settings | Complete | |
| Row resize minHeight constraints | Complete | commit 8bb91e0 |
| Fuchsia drag bar styling | Complete | commit 8bb91e0 |

---

## What's Stubbed (Needs Implementation)

### OpenClaw Action Stubs

These handlers exist, pass tests, but return mock data and don't call real APIs:

| Action | File | What to wire |
|---|---|---|
| `execute_trade` | `openclaw/actions/trade.py` | Polymarket CLOB order submission — `dry_run=True` hardcoded, must stay True until owner explicitly authorizes |
| `scrape_odds` | `openclaw/actions/odds.py` | Full The Odds API response parsing + storage |
| `pull_polymarket` | `openclaw/actions/polymarket.py` | Real Gamma API call + market data normalization |

**Important:** `execute_trade` must remain `dry_run=True` until the owner explicitly signs off. Do not wire live orders without written authorization.

---

## Planned Work (Not Started)

### High Priority

**1. Wire live Supabase credentials**
- All agents use test credentials (`https://test.supabase.co`)
- Replace with production project URL + anon key in each `.env`
- Run `core/cli.py status` to verify end-to-end health

**2. HubPage — Multi-Provider Integration**
- Spec exists: `docs/superpowers/specs/2026-03-25-hub-page-multi-provider-design.md`
- `HubPage.tsx` and `ProviderGrid.tsx` components exist but are not fully wired
- Goal: unified view across Polymarket, Kalshi, sportsbooks (FanDuel, DraftKings, Caesars, MGM)

**3. Promote OpenClaw stubs to live**
- `pull_polymarket` → real Gamma API
- `scrape_odds` → full Odds API parsing
- `execute_trade` → Polymarket CLOB (owner sign-off required before enabling)

### Medium Priority

**4. Windows Services for BizOS workers**
- Goal: OpenClaw + NullClaw survive reboots without manual restart
- Options: `pywin32` Windows service wrapper, or NSSM (Non-Sucking Service Manager)
- Hermes is already managed by Claude Desktop — just the workers need this

**5. NullClaw → Hermes health_check relay**
- Wire Hermes `health_check` MCP action to dispatch a NullClaw `health_check` task and return the result
- Currently Hermes pings Supabase directly; NullClaw's richer checks (disk, vault) aren't surfaced

**6. Kalshi integration**
- Kalshi prediction market API
- Add to MarketNav + OrderBook + OrderPanel

### Lower Priority

**7. Honcho memory surfacing**
- Per-agent peer sessions exist in `db_honcho.py`
- Nothing surfaces this data in the Terminal UI yet
- Could show "agent reasoning history" in a panel

**8. Alert system**
- NullClaw's `notify` action logs to vault but doesn't push external notifications
- Wire to email, Slack, or Discord via webhook when health degrades or stale tasks pile up

**9. Backtesting integration**
- OpenClaw's HMM signal currently returns live regime only
- Expose a `run_backtest` action that calls the full backtest pipeline and writes results to vault

---

## Known Technical Debt

| Item | Location | Notes |
|---|---|---|
| No integration tests against real Supabase | All agents | All tests fully mocked — safe for CI but doesn't catch schema drift |
| execute_trade is a stub | `openclaw/actions/trade.py` | Intentional — do not wire live without authorization |
| NullClaw CACHE_DIRS list | `nc_config.py` | May need tuning for actual cache paths on the target machine |
| HubPage not wired | `terminal/src/components/HubPage.tsx` | Component exists, needs provider integrations |
| No auth layer on Terminal | `terminal/` | Single-user app — no auth needed for solo trader, but note this if deploying shared |

---

## Live Trading Rules (Non-Negotiable)

Before touching anything related to order execution:

1. `dry_run=True` is the default — explicit flip requires owner sign-off
2. `MAX_DRAWDOWN = 2%` — system halts if hit, manual restart required
3. `MAX_STAKE = $500` per trade — hard coded, do not raise without instruction
4. Chop regimes (IDs 2, 3) always excluded from signal generation
5. HMM parameters lock when live — no re-fitting on live data
6. Paper trade minimum 30 days before committing capital to any new strategy
