"""
truth.py — Supervised truth engine loops (fast + slow).

Adaptive cadence with circuit breaker.
"""

from __future__ import annotations

import asyncio


class TruthSupervisor:
    """Runs truth loops with supervision."""

    def __init__(self, fast_coro, slow_coro):
        self.fast_coro = fast_coro
        self.slow_coro = slow_coro
        self.running = False

    async def run(self):
        self.running = True
        tasks = [
            asyncio.create_task(self._run_with_supervision(self.fast_coro, "fast")),
            asyncio.create_task(self._run_with_supervision(self.slow_coro, "slow")),
        ]
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _run_with_supervision(self, coro, name: str):
        fails = 0
        while self.running:
            try:
                await coro()
            except Exception as exc:
                fails += 1
                print(f"[truth_{name}] error: {exc}")
                if fails > 3:
                    await asyncio.sleep(30)
                    fails = 0
                await asyncio.sleep(5)