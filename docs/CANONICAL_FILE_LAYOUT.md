# Cerious Systems Canonical File Layout

Canonical local root:

`C:\Users\tstur\Documents\Codex\Cerious Systems`

## Folders

`Cerious local`

The complete local application build. This folder contains the gateway, market data/studies/order services, React terminal, preserved Acme intelligence/assets, workspace state, local `.env`, `.venv`, `apps/terminal/node_modules`, and `.tools`.

`Cerious Desktop`

The Windows thin-client launcher package. It resolves the sibling `Cerious local` folder and starts `Start-CeriousTerminal.ps1 -DesktopClient`.

## Launch Safety

Browser/local portal launch loads Ted S as saved and does not minimize windows.

Desktop-client launch opens the Cerious Desktop toolbar. The toolbar can open individual floating widget windows outside the canvas, open the full floating workspace, save the workspace, or reopen the canvas when needed.

Desktop-client first launch can minimize windows one time as an order-safety measure. Once the trader arranges/floats windows and saves the workspace, that saved layout becomes the default for future desktop launches.

## Dependency Rule

Runtime code should not depend on old Arbitek, QuantSwarmTerminal, dated Codex worktrees, or desktop crypto-data folders. If a local file dependency is needed, put it under `data` or `.tools` in `Cerious local`, or use an explicit environment variable documented in `.env`.
