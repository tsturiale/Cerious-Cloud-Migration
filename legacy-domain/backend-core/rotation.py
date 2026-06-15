"""
rotation.py — Supervised market rotation loop.

Wraps _market_rotation_cron with asyncio.TaskGroup and circuit breaker.
"""

from __future__ import annotations

import asyncio
import time
from typing import Callable


class RotationSupervisor:
    """Runs the rotation cron with supervision and backpressure."""

    def __init__(self, rotation_coro: Callable):
        self.rotation_coro = rotation_coro
        self.running = False
        self.fail_count = 0
        self.max_fails = 5

    async def run(self):
        self.running = True
        while self.running:
            try:
                await self.rotation_coro()
            except Exception as exc:
                self.fail_count += 1
                print(f"[rotation_supervisor] error: {exc} (fail {self.fail_count})")
                if self.fail_count >= self.max_fails:
                    print("[rotation_supervisor] too many failures — pausing 60s")
                    await asyncio.sleep(60)
                    self.fail_count = 0
                await asyncio.sleep(5)


# Placeholder — in real use, pass the original _market_rotation_cron
async def _supervised_rotation():
    print("[rotation] supervised loop placeholder")
    await asyncio.sleep(1)