# BizOS — Developer Reference

**Root:** `C:\bizos\`  
**Status:** All 4 phases complete — 125/125 tests passing  
**Last updated:** 2026-04-14

---

## Architecture Overview

```
Claude Desktop
    │  (MCP tool call — stdio)
    ▼
┌─────────────────────────────────────────────────┐
│  Hermes  (C:\bizos\hermes\server.py)            │
│  5-layer pipeline: INGEST→GATES→FILTERS→        │
│  AGENTS→EXECUTE                                 │
│  Writes TaskMessage to Supabase, returns        │
│  TaskReceipt immediately (fire-and-forget)      │
└─────────────────────┬───────────────────────────┘
                      │  Supabase tasks table
          ┌───────────┴───────────┐
          ▼                       ▼
┌─────────────────┐   ┌─────────────────────────┐
│  OpenClaw       │   │  NullClaw               │
│  openclaw/      │   │  nullclaw/              │
│  worker.py      │   │  worker.py              │
│  Polls every 5s │   │  Polls every 5s         │
│  Market ops     │   │  Process watchdog       │
└────────┬────────┘   └──────────┬──────────────┘
         │                       │
         ▼                       ▼
   handler runs          handler runs
   updates Supabase      updates Supabase
   writes vault note     writes vault note

BizOS Core (C:\bizos\core\cli.py start)
    — manages OpenClaw + NullClaw subprocesses
    — auto-restarts on crash (max 3 restarts)
    — health monitor via Supabase counts

Hermes — managed by Claude Desktop (MCP stdio)
    — NOT managed by Core orchestrator
```

---

## Supabase Schema

Table: `tasks`

| Column | Type | Notes |
|---|---|---|
| task_id | UUID | Primary key, auto-generated |
| source | TEXT | Who sent the task (e.g., "hermes") |
| target | TEXT | Which agent handles it ("openclaw", "nullclaw") |
| action | TEXT | What to do ("fetch_btc_signal", "kill_process", etc.) |
| payload | JSONB | Action-specific parameters |
| priority | INT | 1 = urgent, higher = lower priority |
| status | TEXT | queued → running → done / failed / cancelled |
| result | JSONB | Handler output, written on completion |
| created_at | TIMESTAMPTZ | Auto |
| updated_at | TIMESTAMPTZ | Auto |

---

## Agent Map

### Phase 1 — Hermes (MCP Router)
**Path:** `C:\bizos\hermes\`  
**Role:** FastMCP server, registered with Claude Desktop  
**Tests:** 55/55

| File | Purpose |
|---|---|
| `server.py` | FastMCP stdio server — 6 MCP tools registered |
| `router.py` | 5-layer pipeline (INGEST/GATES/FILTERS/AGENTS/EXECUTE) |
| `schema.py` | `TaskMessage` + `TaskReceipt` Pydantic models |
| `config.py` | AGENT_REGISTRY, AGENT_ACTION_MAP, URGENT_ACTIONS |
| `db_supabase.py` | Async Supabase client (insert, poll, update) |
| `db_honcho.py` | Honcho memory client |
| `vault.py` | Obsidian .md writer — shared by all agents |

**MCP tools exposed to Claude:**
- `dispatch_task` — route action to openclaw or nullclaw
- `get_task_status` — check task result by task_id
- `list_pending` — queue depth by agent
- `health_check` — ping all agents
- `broadcast` — fanout message to all agents
- `relay_report` — write summary note to vault

**Claude Desktop config** (`%APPDATA%\Claude\claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "hermes": {
      "command": "python",
      "args": ["C:/bizos/hermes/server.py"]
    }
  }
}
```

---

### Phase 2 — OpenClaw (Execution Worker)
**Path:** `C:\bizos\openclaw\`  
**Role:** Market data + trade execution  
**Tests:** 22/22

| Action | File | Status |
|---|---|---|
| `fetch_btc_signal` | `actions/btc.py` | Live — calls HMM_Adaptive_v2 |
| `run_nfl_sync` | `actions/nfl.py` | Live — calls The Odds API |
| `execute_trade` | `actions/trade.py` | **Stub** — dry_run=True hardcoded |
| `scrape_odds` | `actions/odds.py` | **Stub** — returns mock structure |
| `pull_polymarket` | `actions/polymarket.py` | **Stub** — returns mock Gamma format |
| `notify` | `actions/notify.py` | Live — logs + vault note |

**Config** (`oc_config.py`):
```python
POLL_INTERVAL = 5               # seconds between queue polls
MAX_TASKS_PER_SESSION = 50      # runaway guard
ODDS_API_KEY = env              # The Odds API key
HMM_SRC_PATH = env              # path to HMM_Adaptive_v2 source
```

**BTC Signal output:**
```json
{
  "regime_id": 1,
  "regime_label": "HighVolBull",
  "signal": "long",
  "confidence": 0.82,
  "z_score": 1.43
}
```

---

### Phase 3 — NullClaw (Process Watchdog)
**Path:** `C:\bizos\nullclaw\`  
**Role:** System health, process management, audit logging  
**Tests:** 23/23

| Action | File | Notes |
|---|---|---|
| `kill_process` | `actions/kill_process.py` | psutil kill by PID or name. dry_run gate. |
| `purge_cache` | `actions/purge_cache.py` | shutil.rmtree + recreate. dry_run gate. |
| `health_check` | `actions/health_check.py` | disk + Supabase ping + vault exists |
| `clear_stale_state` | `actions/clear_stale_state.py` | Cancel queued tasks older than N hours |
| `write_audit_log` | `actions/write_audit_log.py` | Structured .md to vault/audit/ |
| `notify` | (same pattern as openclaw) | Logs + vault note |

**Config** (`nc_config.py`):
```python
POLL_INTERVAL = 5
MAX_TASKS_PER_SESSION = 50
VAULT_PATH = "C:/bizos/vault"
AUDIT_LOG_PATH = "C:/bizos/vault/audit"
CACHE_DIRS = [...]              # list of dirs purge_cache clears
DRY_RUN = True                  # default True — requires explicit False to act
STALE_TASK_AGE_HOURS = 24       # tasks older than this get cancelled
```

**Health check output:**
```json
{
  "overall": "ok",
  "checks": {
    "disk": {"status": "ok", "free_gb": 42.3},
    "supabase": {"status": "ok"},
    "vault": {"status": "ok", "path": "C:/bizos/vault"}
  }
}
```

---

### Phase 4 — BizOS Core (Orchestrator + CLI)
**Path:** `C:\bizos\core\`  
**Role:** Process manager for OpenClaw + NullClaw  
**Tests:** 25/25

| File | Purpose |
|---|---|
| `bc_config.py` | AGENT_MANIFEST (scripts, env files, restart limits) |
| `orchestrator.py` | AgentRunner dataclass + Orchestrator class |
| `monitor.py` | Supabase health queries + table formatter |
| `cli.py` | argparse CLI: start / status / agents |

**Start workers:**
```bash
python C:/bizos/core/cli.py start    # blocking — Ctrl+C for graceful shutdown
python C:/bizos/core/cli.py status   # one-shot health table from Supabase
python C:/bizos/core/cli.py agents   # list configured agents + scripts
```

**Orchestrator behavior:**
- Loads each agent's `.env` file into subprocess environment
- Monitors process exit and auto-restarts up to `max_restarts` (default 3)
- After max_restarts, marks agent "failed" (requires manual intervention)
- SIGINT triggers graceful shutdown (terminate → 10s wait → kill)

---

## Shared Modules (in `hermes/`, used by all agents)

All agents add `C:\bizos\hermes` to `sys.path` at startup via their worker.py.

| Module | Provides |
|---|---|
| `schema.py` | `TaskMessage`, `TaskReceipt` Pydantic models |
| `db_supabase.py` | `insert_task`, `get_queue`, `update_status`, `update_result`, `get_agent_counts` |
| `db_honcho.py` | `log_task`, `get_agent_summary` |
| `vault.py` | `write_task_note`, `update_agent_note` |

---

## Action Routing (AGENT_ACTION_MAP in hermes/config.py)

```python
"openclaw": {
    "fetch_btc_signal", "run_nfl_sync", "execute_trade",
    "scrape_odds", "pull_polymarket", "notify"
}
"nullclaw": {
    "kill_process", "purge_cache", "health_check",
    "clear_stale_state", "write_audit_log", "notify"
}
"hermes": {
    "broadcast", "relay_report", "notify"
}
```

Hermes reads this map to determine which agent gets a given action. Unknown actions are rejected at the GATES layer.

---

## Environment Files

Each agent has its own `.env` (gitignored). Pattern:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key
HONCHO_API_KEY=your-honcho-key
HERMES_PATH=C:/bizos/hermes
VAULT_PATH=C:/bizos/vault
DRY_RUN=true
```

Test suites use `SUPABASE_URL=https://test.supabase.co` with all Supabase calls mocked.

---

## Key Python Gotcha — Module Alias in tests

`actions/__init__.py` aliases handler functions:
```python
from .health_check import handle as health_check
```

This means `from actions import health_check` returns the **function** `handle`, not the module. If you need to `patch.object()` attributes of `actions.health_check` module, use:

```python
import importlib
hc = importlib.import_module("actions.health_check")
with patch.object(hc, "get_queue", ...):
    ...
```

This pattern is used in `nullclaw/tests/test_health.py` and `nullclaw/tests/test_clear_stale.py`.

---

## Running All Tests

```bash
# Each agent's tests run from its own directory
cd C:/bizos/hermes && python -m pytest tests/ -q      # 55 tests
cd C:/bizos/openclaw && python -m pytest tests/ -q    # 22 tests
cd C:/bizos/nullclaw && python -m pytest tests/ -q    # 23 tests
cd C:/bizos/core && python -m pytest tests/ -q        # 25 tests
```

All suites use `pytest-asyncio` with `asyncio_mode = auto` (set in each `pytest.ini`).

---

## Vault Structure (Obsidian)

```
C:\bizos\vault\
├── agents\
│   ├── openclaw.md      # agent status notes
│   ├── nullclaw.md
│   └── hermes.md
├── tasks\
│   └── <task_id>.md     # one note per completed task
└── audit\
    └── YYYY-MM-DD\
        └── <task_id>.md # NullClaw audit logs
```

Notes use Obsidian wikilink format: `[[agent/openclaw]]`, `[[tasks/<id>]]`.
