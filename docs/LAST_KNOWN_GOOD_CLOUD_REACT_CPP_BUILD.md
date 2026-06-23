# Last Known Good Build - Cloud React + Modular C++ Backend

Date: 2026-06-23

This checkpoint backs up the current Cerious Systems local/cloud-native build as
the active stable baseline.

## Product Shape

Cerious is a browser-launched EMS/OMS terminal for futures and future
multi-exchange products. The active UI is the React Script browser terminal. The
removed Tauri/desktop-client workflow is not part of this baseline.

The UI is intentionally thin:

- render server state
- submit typed user commands
- preserve workspace layout and chart state
- avoid owning trading-critical logic

The backend is the point of truth:

- C++ gateway service
- C++ Databento price service for CME live MBP-1, top of book, last trade, and
  historical chart backfill
- C++ deterministic FIFO CLOB simulation exchange
- C++ FIX/order-routing lane with Aeron IPC support where enabled
- server-owned algo definitions, state, deploy lifecycle, audit trail,
  positions, fills, and PnL

## Active Services

- `native/gateway-cpp`: client-facing HTTP boundary on `127.0.0.1:8000`
- `native/price-feed-cpp`: Databento CME live/historical market data
- `native/cerious-exchange-cpp`: active local deterministic simulation exchange
  on `127.0.0.1:8011`
- `native/fix-engine-cpp`: FIX 4.4 routing service and Aeron IPC integration

## Current Data/Workspace Ownership

- `data/algo-definitions`: saved algo definitions
- `data/workspace-store/tsturiale`: saved workspace layouts and latest default
- `data/window-payloads`: native Cerious advisory/research widget payloads
- `data/fills`: fill journals and backups
- `data/runtime`: runtime snapshots used by local testing

## Trading-Critical Rules

- Market data is owned by backend services, not React widgets.
- Studies are published from server-side calculation services and consumed by
  charts and algos by request shape, including user-defined lookback.
- Manual and algo orders route through backend services.
- Simulation is an exchange destination, not an order type.
- The depth ladder, order book, fills, positions, and Algo Manager must all
  consume the same authoritative order/fill/position stream.
- REST/chart backfill and live MBP-1 market data must remain independent enough
  that chart work does not disturb live depth-ladder updates.

## Validation Notes

Recent stability work confirmed:

- browser terminal loads without the prior null `toFixed` render crash
- legacy browser `/ws` clients are disabled unless explicitly opted in
- C++ health endpoint reports gateway, Databento price service, and execution
  service health
- fill/position UI ignores temporary exchange-unavailable placeholder snapshots
  instead of blinking or wiping good state

## Backup Intent

This backup captures the local Cerious build as the baseline for continued
chart, market-data, algo, and simulator hardening without reintroducing the
desktop-client/Tauri path.
