# Preserved Assets

Cerious Systems was created as a clean root from the local Arbitek/Acme build.

## Preserved

- React terminal UI from `Arbitek v1/QuantSwarmTerminal/terminal/src`.
- Vite, TypeScript, Tailwind, Playwright, and package manifests from the terminal app.
- Shared trading/domain modules from `Arbitek v1/QuantSwarmTerminal/shared`.
- FF Systematica algo definitions and agents from `terminal/FF Systematica`.
- Backend model/engine/state reference code from `terminal/backend/core`, `terminal/backend/state`, and `terminal/backend/ingest`.
- Acme workspace JSON from `Acme-Stable-GitHub-Backup-2026-06-10/Acme/runtime/workspaces/polyman`.
- Team/setup docs from the Arbitek root.

## Intentionally Not Preserved

- Old `node_modules`, generated `dist`, runtime logs, temp state, backup folders, and monolithic `terminal/backend/main.py` as an active service.
- Non-CME provider adapters as active ingress.
- Legacy localhost storage keys; Cerious uses its own `cerious.*` browser storage namespace.

## Active Runtime

The active runtime is the new service boundary under `services`:

- `services/price` owns CME-only ingress.
- `services/gateway` owns browser-facing REST and WebSocket compatibility.
- Order, fill, sim exchange, alert, and algo engine folders are present as explicit service boundaries for the next extraction steps.

