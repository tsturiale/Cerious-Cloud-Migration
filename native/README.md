# Cerious Native Services

This folder is the native backend lane for Cerious service code.

The current production-safe rule is simple: native services must pass contract parity tests before they become active execution paths.

## Folders

- `price-feed-cpp`: Databento C++ feed handler — live CME MBP-1 and historical OHLCV.
- `fix-engine-cpp`: FIX 4.4 order sending daemon — standalone C++ service with embedded REST API, Aeron IPC, and sim/loopback mode.

- `simulex-cpp`: clean native local simulation exchange destination - deterministic FIFO matching, latency/slippage accounting, and synthetic leg-fill reporting.

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
