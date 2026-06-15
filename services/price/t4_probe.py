from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import asdict

from services.price.t4_adapter import T4Adapter


async def run(count: int, timeout: float) -> int:
    adapter = T4Adapter()
    print(json.dumps({"event": "starting", "status": adapter.status}, indent=2))
    received = 0

    async def collect() -> None:
        nonlocal received
        async for quote in adapter.stream():
            print(json.dumps({"event": "quote", "quote": asdict(quote)}, sort_keys=True))
            received += 1
            if received >= count:
                break

    try:
        await asyncio.wait_for(collect(), timeout=timeout)
    except TimeoutError:
        print(json.dumps({"event": "timeout", "received": received, "status": adapter.status}, indent=2))
        return 1 if received == 0 else 0
    except Exception as exc:
        print(json.dumps({"event": "error", "error": str(exc), "status": adapter.status}, indent=2))
        return 1
    print(json.dumps({"event": "complete", "received": received, "status": adapter.status}, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe T4 WebSocket market data ingress.")
    parser.add_argument("--count", type=int, default=3, help="Number of normalized quotes to print.")
    parser.add_argument("--timeout", type=float, default=45, help="Maximum seconds to wait.")
    args = parser.parse_args()
    return asyncio.run(run(max(1, args.count), max(5, args.timeout)))


if __name__ == "__main__":
    raise SystemExit(main())
