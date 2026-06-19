# Simulex Product Specification

## Purpose

Simulex is a new dedicated local exchange destination. The rest of Cerious must treat it like any other execution gateway: strategy code, the UI, positions, fills, PnL, and the audit trail talk through a native execution abstraction, not through React state or one-off simulator helpers.

The target design is:

```text
Algo Manager / Manual Order Ticket / Depth Ladder
        |
        v
IExecutionGateway
        |
        +-- Live FIX Gateway, later TT FIX or other live venue route
        |
        +-- Simulex Exchange, local deterministic simulation destination
```

## Source Of Truth

Simulex owns execution state for simulation:

- resting orders
- order acknowledgements
- cancels and replace/modify results
- fills
- leg fill details
- trigger send price
- actual fill price
- open and closed execution events

The UI only renders the state published by the execution/order services. It must not invent fills, positions, order states, or marketability rules.

## Common Execution Contract

The C++ execution layer uses shared primitives:

- `OrderRequest`
- `ExecutionReport`
- `LegFillDetail`
- `IExecutionListener`
- `IExecutionGateway`

`ExecutionReport.leg_details` is required for synthetic spreads. Portfolio and PnL services should consume the leg detail array instead of reconstructing spread legs from UI labels or custom side tables.

## Exchange Semantics

Simulex must model an exchange, not a chart overlay.

Accepted order families:

- Native exchange-style: `LIMIT`, `MARKET`
- Synthetic system-held: `SNIPER`, future `OCO`, system-held stops where needed

Simulation is an execution destination. It is not an order type. A limit order sent to Simulex is still a limit order; Simulex is the venue.

## CME-Style FIFO Rules

The added simulator details define the queue semantics that Simulex should use for local resting orders.

Book priority:

- bids sort by price descending, then sequence ascending
- asks sort by price ascending, then sequence ascending

Matching loop:

- buy order crosses when `buy_price >= best_ask`
- sell order crosses when `sell_price <= best_bid`
- fill quantity is `min(aggressor_remaining, resting_remaining)`
- fully filled resting orders are removed from the price queue and direct lookup index
- leftover aggressor quantity rests at its limit price

Modification priority:

- quantity reduction keeps original FIFO priority
- quantity increase loses FIFO priority and moves to the back of the price level
- price change loses FIFO priority and must be modeled as cancel/reinsert at the new price

Implementation note: do not fake priority with arbitrary sequence penalties in production. Use a monotonic exchange sequence for reinsertion.

## Deterministic Sequencing

For deterministic simulation and replay, do not use local wall-clock time for queue priority.

Priority should use the normalized feed sequence when available:

- CME packet `msg_seq_num`
- CME entry `rpt_seq`
- Databento sequence or equivalent normalized ordering field
- local Simulex monotonic sequence only when a locally created order has no exchange/feed sequence

Wall-clock timestamps remain useful for audit display and latency measurement, but not for FIFO causality.

## Market Data Adaptation

Simulex consumes normalized market data snapshots/events from the price service.

Current local source:

- Databento CME `GLBX.MDP3`
- MBP-1/top-of-book and trade events for the UI and synthetic spreads
- REST backfill for charts/studies
- live stream for current book, last trade, and rolling bars

Future direct CME feed support:

- CME MDP 3.0 SBE/UDP packet parser
- packed wire structs with explicit offset parsing
- no allocation in hot parsing paths
- bounds checks before each message/group read
- `memcpy` into packed wire structs or direct decode; avoid unsafe assumptions about compiler padding

Important: the SBE parser from the pasted material is a future low-level feed adaptor. It should not create a second product direction. The immediate Simulex integration should consume the same normalized market data state as charts, ladders, and studies.

## Price Indexing And Book Memory

Price lookup should be fast and deterministic:

- use fixed tick size from product definitions
- map price to an integer tick index
- avoid heap allocation in the hot matching loop
- use contiguous book-side arrays where possible

The UI must not encode tick math. Product definitions feed the service layer, and the service layer publishes display-ready prices/book levels.

## Synthetic Spread Execution

Synthetic spread definitions are registered by the native Simulex service at startup. The current C++ source of truth is `native/simulex-cpp/src/server.cpp`, and product-definition ownership should remain in native service code or native-readable data files.

Current active spreads:

| Spread | Ratio | Price expression | Tick | Multiplier | Tick value |
| --- | --- | --- | ---: | ---: | ---: |
| `ES_NQ` | `3 ES / -2 NQ` | `ES - 0.2666667 * NQ` | `0.25` | `150.0` | `37.50` |
| `YM_ES` | `3 YM / -2 ES` | `YM - 6.6666667 * ES` | `1.0` | `15.0` | `15.00` |
| `RTY_ES` | `7 RTY / -3 ES` | `RTY - 0.4285714 * ES` | `0.1` | `350.0` | `35.00` |

Synthetic fills must report:

- parent synthetic order id
- synthetic fill price
- trigger send price
- actual fill price after simulated flight latency
- individual atomic leg fills
- leg symbol
- leg side
- leg price
- leg quantity
- source algo/manual marker
- `ALGO ENTRY` or `ALGO COVER` where applicable

## Flight Latency And Slippage

Simulex tracks two prices:

- `trigger_send_price`: marketable level at T0 when the strategy/order crosses
- `actual_fill_price`: execution after configured latency, using the book at T0 plus latency

The initial target latency is 25 microseconds. This must be configurable and recorded on every execution report.

## Build Plan

1. Add `native/simulex-cpp` as a native module beside `native/price-feed-cpp` and `native/fix-engine-cpp`.
2. Implement clean C++ headers from the supplied Simulex source, normalizing formatting and removing pasted-text artifacts.
3. Fold the FIFO rules into the Simulex book/matching component.
4. Add a validation harness that proves:
   - outright limit fill
   - outright partial fill
   - cancel
   - reduce quantity preserves priority
   - increase quantity loses priority
   - price change loses priority
   - synthetic spread fill generates atomic leg details
   - latency slippage records both trigger and actual fill prices
5. Build on Windows with Visual Studio/CMake.
6. Build on Linux-compatible CMake settings for future server deployment.
7. Add a native C++ bridge only after the C++ validation harness passes.
8. Wire UI subscriptions to the single backend order/fill/position source.
9. Retire the old simulator only after Simulex publishes the required state through the gateway contract.

## Cutover Guardrails

- Do not wire Simulex into live terminal execution until it produces fills, positions, order book rows, and PnL through the same backend API shape.
- Do not allow React/Zustand to create authoritative fills or positions.
- Do not let algo deployment cancel working orders before validating the new deployment plan.
- Do not add UI-side marketability rules.
- Do not create a second independent study or price calculation path for algos.
- Every failed send/modify/cancel must write an audit trail event.

## Redundant Or Deferred Material From The Pasted Notes

The pasted CME SBE parser and standalone FIFO engine are useful, but they are not a new architecture. They become implementation details inside the Simulex/price-service boundary.

Deferred until direct CME feed work:

- direct UDP/SBE packet parser
- CME template-specific binary decoder coverage
- historical binary-log replay into raw network tick buffers

Immediate work:

- native Simulex module
- deterministic FIFO engine
- synthetic leg fill reporting
- bridge contract to the existing Cerious backend
