# Cerious Systems Canonical File Layout

Canonical local root:

`C:\Users\tstur\Documents\Codex\Cerious Systems`

## Folders

`Cerious local`

The complete local application build. This folder contains the native C++ gateway, native market data/studies/order services, browser terminal assets, preserved Cerious intelligence/assets, workspace state, local `.env`, `apps/terminal/node_modules`, and `.tools`.

## Launch Safety

Browser/local portal launch loads Ted S as saved and does not minimize windows.

## Dependency Rule

Runtime code should not depend on old external worktrees, dated Codex worktrees, or desktop-client data folders. If a local file dependency is needed, put it under `data` or `.tools` in `Cerious local`, or use an explicit environment variable documented in `.env`.
