# Cerious Systems Architecture

## Direction

Cerious keeps the learned Acme terminal workflow while replacing the monolith with service boundaries.

```mermaid
flowchart LR
  CME["CME / Databento MBP-1"] --> Price["Price Service"]
  Price --> Gateway["Terminal Gateway / UI Read API"]
  Gateway --> WS["/ws/{asset}"]
  Gateway --> REST["/api/* compatibility endpoints"]
  WS --> React["React terminal"]
  REST --> React
  Price --> Algo["C++ Algo Engine"]
  Price --> Sim["C++ Simulex Exchange"]
  Algo --> Order["C++ Order Router"]
  Order --> Fill["C++ Ledger / Fill Service"]
  Fill --> Alert["Alert Service"]
```

## Current Local Mode

The trading critical path is native C++:

- price feed and normalized market state
- study snapshots used by charts and algos
- algo deployment state
- order routing
- Simulex local exchange matching
- live FIX routing
- fills, positions, and PnL ledger

The gateway and UI may expose read/control surfaces, but they must not own authoritative price, order, fill, position, PnL, or algo state.

## Constraint

CME is the only live ingress in this build. Legacy venue providers are copied only as preserved domain/reference material or removed from active service wiring.
