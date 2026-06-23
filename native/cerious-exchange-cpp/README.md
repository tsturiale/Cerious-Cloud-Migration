# Cerious Exchange C++

Active local deterministic simulation exchange for Cerious.

## Purpose

- Run a clean C++ FIFO central limit order book.
- Support the initial Cerious universe: `ES`, `NQ`, `RTY`, `YM`, `ES_NQ`, `YM_ES`, `RTY_ES`.
- Remain product/exchange agnostic through registered `ProductSpec` records.
- Fill resting limit orders when external market data trades through or crosses them.
- Publish normalized execution reports, explicit book deltas, and book snapshots for gateway/UI integration.
- Return gateway-style event batches with `orders`, `fills`, and `BOOK_DELTA` packets so the UI renders exchange facts instead of inferring state.

## Determinism Rules

- Prices are stored as integer tick indexes, not floating point book keys.
- Matching uses price/time priority.
- Same-millisecond FIFO is resolved by a monotonic sequence number.
- Incoming orders execute at the resting order price.
- External market-data-triggered fills execute at the resting order price.
- Duplicate order IDs are rejected.

## Current Binaries

- `cerious_exchange_sandbox`: standalone deterministic tests.
- `cerious_exchange_server`: local HTTP exchange service on port `8011` by default.

## Test Service Endpoints

- `GET /health`
- `GET /products`
- `POST /send`
- `POST /cancel`
- `POST /replace`
- `POST /market`
- `GET /book/{symbol}?levels=20`
- `GET /orders`
- `POST /reset`

Mutating endpoints return a `gateway_event_batch` payload. It keeps a compatibility `reports` array and
adds `event_packet.orders`, `event_packet.fills`, and `event_packet.deltas`. The UI bridge should consume
those packets as server-owned truth; matching and order state remain in C++.

Simulex remains in the repository for rollback and cleanup review, but the launcher, host service, and gateway now route local simulation execution to `cerious_exchange_server`.
