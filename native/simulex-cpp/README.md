# Cerious Simulex

Simulex is the native local simulation exchange destination. It is a clean C++ product built beside the existing native price feed and FIX engine.

Current status:

- standalone C++20 validation harness
- deterministic FIFO book rules
- order cancel and replace/modify semantics
- outright execution against live DOM snapshots
- synthetic spread execution with atomic leg fill details
- trigger-send price vs actual-fill price latency accounting

It starts as an isolated native target. The terminal will point to it only after contract parity tests prove the native bridge can publish the same order, fill, position, PnL, and audit events consumed by Cerious.

## Build

Windows:

```powershell
.\build-win.ps1
```

Linux:

```bash
./build-linux.sh
```

Manual:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build build --parallel
```
