# Simulex Native Bridge Contract

## Position

Simulex is not a Python service and not a React feature. It is a native C++ execution destination inside the Cerious backend.

The critical path is C++:

```text
C++ Price Feed
  -> C++ Market State
  -> C++ Study / Algo State
  -> C++ Order Router
  -> Simulex or Live FIX Gateway
  -> C++ Execution Journal / Position Ledger
  -> UI Read Model
```

No Python component is allowed to own price state, order state, matching, fills, positions, PnL, algo decisions, or order routing.

## Service Roles

`price-feed-cpp`

- Owns Databento live feed handling.
- Publishes normalized market data events.
- Publishes product definitions.
- Publishes sequence-bearing book/trade updates.

`simulex-cpp`

- Owns local simulation exchange state.
- Accepts order, cancel, and replace commands.
- Consumes normalized market data snapshots.
- Emits order acknowledgements, fills, cancels, rejects, and replace reports.
- Emits atomic synthetic leg details.
- Records trigger price, actual fill price, latency, and slippage.

`fix-engine-cpp`

- Owns live order routing.
- Sends live exchange orders through the configured FIX gateway.
- Emits execution reports using the same logical event contract as Simulex.

`algo-engine-cpp`

- Owns strategy state and deployment decisions.
- Subscribes to market data, study values, order state, fills, and position state.
- Sends explicit `OrderCommand` messages to the selected execution destination.

`ledger-cpp`

- Owns fills, open positions, realized PnL, open PnL, and daily/session reset rules.
- Consumes execution reports from Simulex and FIX.
- Publishes canonical state snapshots for every UI or downstream consumer.

## Transport

Preferred native transport:

- Aeron IPC for local service-to-service messaging.
- HTTP only as a non-critical control/read API where useful.
- JSON only at process boundaries where human inspection matters.

The bridge contract is defined as C++ message structs first. Any wire encoding must preserve these fields exactly.

## Message Streams

Market data stream:

- `ProductDefinitionEvent`
- `MarketDataEvent`

Order command stream:

- `OrderCommand`
- `CancelCommand`
- `ReplaceCommand`

Execution event stream:

- `ExecutionEvent`
- `LegFillDetail`

Ledger stream:

- `PositionSnapshot`
- `PnlSnapshot`

Audit stream:

- `AuditEvent`

## Failure Rules

- If product definition is missing: reject order, publish `AuditEvent`.
- If market data is stale: reject or hold according to order policy, publish `AuditEvent`.
- If study/send price is unavailable: reject/pause algo order, publish `AuditEvent`.
- If destination is unavailable: reject order, publish `AuditEvent`.
- Do not silently cancel existing working orders before a new deployment validates.

## Cutover Requirement

The old simulator can be removed only after the native stack proves:

- manual limit order accepted and resting
- manual market order filled
- cancel removes one working order
- replace follows FIFO modification rules
- synthetic spread entry fills with leg details
- algo entry orders appear in the same book as manual orders
- fills update ledger and PnL
- depth ladder, order book, fill window, position window, and algo manager all read the same native state
