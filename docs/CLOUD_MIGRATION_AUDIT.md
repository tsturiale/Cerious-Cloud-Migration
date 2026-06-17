# Cerious Systems Cloud Migration Audit

Last updated: 2026-06-17

## Canonical Package

The active package is rooted at:

`C:\Users\tstur\Documents\Codex\Cerious Systems`

The deployable local/cloud application is:

`C:\Users\tstur\Documents\Codex\Cerious Systems\Cerious local`

The Windows thin-client package is:

`C:\Users\tstur\Documents\Codex\Cerious Systems\Cerious Desktop`

## Runtime Data Kept Under Cerious Local

- `data/algo-definitions` contains the active saved algo definitions and portable definition registry.
- `data/workspace-storage`, `data/workspace-store`, and `data/workspaces` contain saved workspace layouts and workspace registry data.
- `data/fills`, `data/runtime`, `data/session-backups`, and `data/recovered-workspaces` contain local trading-session state and recovery material.
- `data/downloads` contains packaged client artifacts served by the local/cloud portal.
- `data/credentials` is the expected local location for service-account files. Do not commit secrets.
- `.env` is local-only and ignored by git. `.env.example` documents the variables required by cloud secrets.

## Preserved Legacy Source

The Acme/RVEX/Joule materials that may still matter for intelligence, rules, widgets, definitions, research, and reconstruction are copied into:

`data/legacy-source`

Captured source roots:

- `ACME`
- `Joule`
- `RVEX`
- `Stable Build Backup`

Generated dependency folders and browser caches were excluded or pruned from the preserved copy. The preserved set is source/history material only; runtime code should import from the active Cerious folders or from documented package-local data paths.

Nested `.gitignore` files from copied legacy repositories were removed from `data/legacy-source` so a Git-based migration does not silently skip preserved exports or research data.

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

T4 SIM settings are environment-driven through:

- `T4_AUTH_MODE`
- `T4_API_KEY`
- `T4_WS_URL`
- `T4_API_URL`
- `T4_FIRM`
- `T4_USERNAME`
- `T4_APP_LICENSE`
- `T4_CONTRACTS`
- `T4_MARKETS`
- `T4_MARKET_IDS`

Do not hard-code exchange-specific price math or product definitions in UI widgets. Product definitions, tick size, multipliers, book state, last trade, top of book, positions, fills, and PnL must come from service-layer subscriptions or documented package-local data files.

## Desktop Client

The current thin-client scripts were synced into `Cerious Desktop` and the zip was refreshed:

`Cerious Desktop\CeriousSystems-Win64-ThinClient.zip`

The thin client resolves the application by:

1. `CERIOUS_SYSTEMS_ROOT`
2. sibling `Cerious local`
3. package-relative fallback

This keeps the desktop package relocatable with the Cerious Systems folder.

## Cloud Migration Rules

1. Move the whole `Cerious Systems` folder as a unit.
2. Provide `.env.example` values as cloud secrets or environment variables.
3. Do not upload the real `.env` or private credentials.
4. Do not depend on old `ACME`, `RVEX`, `Joule`, dated Codex worktrees, desktop paths, or browser cache folders.
5. If a future service needs a file, put it under `Cerious local\data` or document the environment variable that points to it.
6. If migrating through GitHub, include the untracked `data/legacy-source` tree and `.env.example`; keep `.env` and `data/credentials/*.json` out of source control.
