# Cerious Systems Cloud Migration Audit

Last updated: 2026-06-21

## Canonical Package

The active package is rooted at:

`C:\Users\tstur\Documents\Codex\Cerious Systems`

The deployable local/cloud application is:

`C:\Users\tstur\Documents\Codex\Cerious Systems\Cerious local`

The active UI is the React/Vite terminal in:

`C:\Users\tstur\Documents\Codex\Cerious Systems\Cerious local\apps\terminal`

It is served by the C++ gateway at the local/cloud browser entrypoint.

## Runtime Data Kept Under Cerious Local

- `data/algo-definitions` contains the active saved algo definitions and portable definition registry.
- `data/workspace-storage`, `data/workspace-store`, and `data/workspaces` contain saved workspace layouts and workspace registry data.
- `data/fills`, `data/runtime`, `data/session-backups`, and `data/recovered-workspaces` contain local trading-session state and recovery material.
- `data/downloads` contains packaged client artifacts served by the local/cloud portal.
- `data/credentials` is the expected local location for service-account files. Do not commit secrets.
- `data/acme-imports` contains copied Acme/RVEX/Joule source artifacts needed to reconstruct legacy intelligence, rules, and research content.
- `data/window-payloads/acme` contains generated Cerious-native JSON payloads served by `/api/acme/...` widget endpoints. Runtime widgets must use these local payloads or service read models, not old workspace paths.
- `.env` is local-only and ignored by git. `.env.example` documents the variables required by cloud secrets.

## Preserved Legacy Source

The Acme/RVEX/Joule materials that may still matter for intelligence, rules, widgets, definitions, research, and reconstruction are copied into:

`data/acme-imports`

Captured source material is stored as Cerious-local archive files under `data/acme-imports`; no runtime service should read from the original source folders.

Generated dependency folders and browser caches were excluded or pruned from the preserved copy. The preserved set is source/history material only; runtime code should import from the active Cerious folders or from documented package-local data paths.

Generated runtime JSON for the current terminal lives in `data/window-payloads/acme`. That folder is Cerious-native and may be deployed with the app. The UI and gateway should never read directly from old RevX/Joule folders outside this project root.

## Endpoint Configuration

Runtime endpoints are now environment-driven:

- Browser WebSocket defaults to same-origin `/ws` unless `VITE_CERIOUS_WS_BASE` is set.
- Vite dev proxy uses `CERIOUS_GATEWAY_HTTP` and `CERIOUS_GATEWAY_WS`.
- Gateway CORS uses `CERIOUS_ALLOWED_ORIGINS`.
- Launcher host/ports use `CERIOUS_BACKEND_HOST`, `CERIOUS_BACKEND_PORT`, `CERIOUS_FRONTEND_HOST`, and `CERIOUS_FRONTEND_PORT`.
- Legacy algo clients use `CERIOUS_BACKEND_BASE_URL` or `market_data.backend_base_url`. They no longer silently post to an old local process when that value is blank.

Localhost values that remain in `.env.example`, Vite dev defaults, tests, and launcher defaults are local development defaults only. Cloud deployment must supply production endpoint values as environment variables or cloud secrets.

## Market Data And Product Definitions

Databento CME settings are environment-driven through:

- `DATABENTO_API_KEY`
- `CERIOUS_CME_DATASET`
- `CERIOUS_CME_SCHEMA`
- `CERIOUS_CME_SYMBOLS`

Do not hard-code exchange-specific price math or product definitions in UI widgets. Product definitions, tick size, multipliers, book state, last trade, top of book, positions, fills, and PnL must come from service-layer subscriptions or documented package-local data files.

## Browser UI

The active client workflow is the React web terminal. Tauri desktop packaging was removed from this active branch. Startup should bring up the C++ gateway and native services, then the browser/Chrome launcher should open the React terminal.

## Cloud Migration Rules

1. Move the whole `Cerious Systems` folder as a unit.
2. Provide `.env.example` values as cloud secrets or environment variables.
3. Do not upload the real `.env` or private credentials.
4. Do not depend on old `ACME`, `RVEX`, `Joule`, dated Codex worktrees, desktop paths, or browser cache folders.
5. If a future service needs a file, put it under `Cerious local\data` or document the environment variable that points to it.
6. If migrating through GitHub, include `data/acme-imports`, `data/window-payloads/acme`, and `.env.example`; keep `.env` and `data/credentials/*` out of source control.
