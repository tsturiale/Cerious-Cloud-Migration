# Dev Environment Setup

**Platform:** Windows 11  
**Last updated:** 2026-04-14

This guide sets up both QuantSwarm Terminal (React) and BizOS (Python agents) from scratch.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | 18+ | https://nodejs.org |
| Python | 3.11+ | https://python.org |
| Git | any | https://git-scm.com |
| Claude Desktop | latest | https://claude.ai/download |

---

## 1. QuantSwarm Terminal (React App)

```bash
# Clone the repo
git clone <repo-url> C:\Users\trade\OneDrive\Desktop\QuantSwarmTerminal
cd C:\Users\trade\OneDrive\Desktop\QuantSwarmTerminal\terminal

# Install dependencies
npm install

# Start dev server
npm run dev
# → http://localhost:5173
```

No environment variables are required for the terminal to start in paper/demo mode.

If connecting to live Polymarket data, add environment variables to `terminal/.env.local`:
```env
VITE_GAMMA_API_URL=https://gamma-api.polymarket.com
VITE_CLOB_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
```

---

## 2. BizOS Python Agents

### 2a. Create the BizOS directory structure

```bash
mkdir C:\bizos
mkdir C:\bizos\vault
mkdir C:\bizos\vault\agents
mkdir C:\bizos\vault\tasks
mkdir C:\bizos\vault\audit
```

### 2b. Clone or copy agent code

Each agent directory (`hermes`, `openclaw`, `nullclaw`, `core`) should exist under `C:\bizos\`.

### 2c. Install Python dependencies

Run these from their respective directories:

```bash
# Hermes
cd C:\bizos\hermes
pip install -r requirements.txt

# OpenClaw
cd C:\bizos\openclaw
pip install -r requirements.txt

# NullClaw
cd C:\bizos\nullclaw
pip install -r requirements.txt
# Note: psutil is a required system dependency
pip install psutil

# Core
cd C:\bizos\core
pip install -r requirements.txt
```

Key packages across all agents:
- `fastmcp` — MCP server (Hermes only)
- `supabase` — async Supabase client
- `pydantic` — data models
- `python-dotenv` — env file loading
- `psutil` — process management (NullClaw)
- `pytest`, `pytest-asyncio` — testing

### 2d. Set up environment files

Create a `.env` in each agent directory. Copy the template below and fill in real credentials:

**`C:\bizos\hermes\.env`**
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key
HONCHO_API_KEY=your-honcho-key
HERMES_PATH=C:/bizos/hermes
VAULT_PATH=C:/bizos/vault
```

**`C:\bizos\openclaw\.env`**
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key
HONCHO_API_KEY=your-honcho-key
HERMES_PATH=C:/bizos/hermes
VAULT_PATH=C:/bizos/vault
ODDS_API_KEY=your-odds-api-key
HMM_SRC_PATH=C:/path/to/HMM_Adaptive_v2/src
DRY_RUN=true
```

**`C:\bizos\nullclaw\.env`**
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key
HONCHO_API_KEY=your-honcho-key
HERMES_PATH=C:/bizos/hermes
VAULT_PATH=C:/bizos/vault
AUDIT_LOG_PATH=C:/bizos/vault/audit
DRY_RUN=true
STALE_TASK_AGE_HOURS=24
```

**`C:\bizos\core\.env`** (if needed)
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key
HERMES_PATH=C:/bizos/hermes
```

### 2e. Set up Supabase

Create a Supabase project and run this SQL to create the tasks table:

```sql
create table if not exists tasks (
  task_id   uuid primary key default gen_random_uuid(),
  source    text not null,
  target    text not null,
  action    text not null,
  payload   jsonb default '{}'::jsonb,
  priority  int default 5,
  status    text default 'queued',
  result    jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Index for worker polling
create index if not exists tasks_target_status_idx on tasks (target, status, priority, created_at);
```

### 2f. Register Hermes with Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

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

Restart Claude Desktop. Hermes will auto-start as an MCP server.

---

## 3. Verify Everything Works

### Run all BizOS tests
```bash
cd C:\bizos\hermes  && python -m pytest tests/ -q   # expect 55 passed
cd C:\bizos\openclaw && python -m pytest tests/ -q  # expect 22 passed
cd C:\bizos\nullclaw && python -m pytest tests/ -q  # expect 23 passed
cd C:\bizos\core     && python -m pytest tests/ -q  # expect 25 passed
```

### Start workers
```bash
python C:/bizos/core/cli.py start   # blocking — starts openclaw + nullclaw
```

In a second terminal:
```bash
python C:/bizos/core/cli.py status  # shows health table from Supabase
```

### Start terminal
```bash
cd C:\Users\trade\OneDrive\Desktop\QuantSwarmTerminal\terminal
npm run dev
```

Navigate to `http://localhost:5173`.

---

## Common Issues

| Problem | Fix |
|---|---|
| `ModuleNotFoundError: psutil` | `pip install psutil` |
| `ModuleNotFoundError: fastmcp` | `pip install fastmcp` |
| Supabase connection refused in tests | Tests mock Supabase — check you're running from the agent's own directory (so `.env` is found) |
| Hermes not showing in Claude Desktop | Check `claude_desktop_config.json` path is correct; restart Claude Desktop |
| Port 5173 in use | `npm run dev -- --port 5174` |
| `patch.object` AttributeError on actions module | Use `importlib.import_module("actions.action_name")` — see BIZOS.md gotcha section |
