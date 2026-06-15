# Cerious Systems Architecture

## Direction

Cerious keeps the learned Acme terminal workflow while replacing the monolith with service boundaries.

```mermaid
flowchart LR
  CME["CME / Databento MBP-1"] --> Price["Price Service"]
  Price --> Gateway["Terminal Gateway"]
  Gateway --> WS["/ws/{asset}"]
  Gateway --> REST["/api/* compatibility endpoints"]
  WS --> React["React terminal"]
  REST --> React
  Price --> Algo["Algo Engine"]
  Price --> Sim["Sim Exchange"]
  Algo --> Order["Order Service"]
  Order --> Fill["Fill Service"]
  Fill --> Alert["Alert Service"]
```

## Current Local Mode

The gateway runs all services in one Python process for local development, but the code is organized by service boundary. That makes the first build easy to test from this machine and easier to split into cloud deployables later.

## Constraint

CME is the only live ingress in this build. Legacy venue providers are copied only as preserved domain/reference material or removed from active service wiring.

