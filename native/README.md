# Cerious Native Services

This folder is the migration lane for native service code.

The current production-safe rule is simple: native services may be added beside the Python services, but they do not replace Python services until contract parity tests pass.

## Folders

- `price-feed-cpp`: Databento C++ feed handler — live CME MBP-1 and historical OHLCV.
- `fix-engine-cpp`: FIX 4.4 order sending daemon — standalone C++ service with embedded REST API, Aeron IPC, and sim/loopback mode.

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
