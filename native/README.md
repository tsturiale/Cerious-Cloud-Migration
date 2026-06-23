# Cerious Native Services

This folder is the native backend lane for Cerious service code.

The current production-safe rule is simple: native services must pass contract parity tests before they become active execution paths.

## Folders

- `price-feed-cpp`: Databento C++ feed handler — live CME MBP-1 and historical OHLCV.
- `fix-engine-cpp`: FIX 4.4 order sending daemon — standalone C++ service with embedded REST API, Aeron IPC, and sim/loopback mode.

- `cerious-exchange-cpp`: active local simulation exchange destination - deterministic FIFO CLOB, product-registered symbol universe, gateway-style execution events, and market-data-triggered resting limit fills.

- `simulex-cpp`: legacy simulation exchange retained in the tree for rollback and cleanup review. It is no longer the active local execution destination.

## Contract Rule

Every native service must publish the same logical event contract consumed by the terminal gateway:

- market snapshot
- book update
- trade update
- product definition
- order event
- fill event
- position snapshot
- study snapshot
- audit event

The UI remains insulated from exchange and transport details.
