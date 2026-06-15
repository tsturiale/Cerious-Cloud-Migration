"""
broadcast.py — Batched WebSocket push system.

Collects updates for 100-200ms then fans out in one go.
Reduces per-connection send overhead under high market count.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Dict, List


class BroadcastBatcher:
    """Batches WS messages per asset before sending."""

    def __init__(self, batch_window_ms: int = 150):
        self.batch_window_ms = batch_window_ms
        self._pending: Dict[str, List[dict]] = {}  # asset -> list of messages
        self._last_flush: Dict[str, float] = {}

    async def queue(self, asset: str, msg: dict, connections: set):
        if asset not in self._pending:
            self._pending[asset] = []
        self._pending[asset].append(msg)

        now = time.time() * 1000
        if now - self._last_flush.get(asset, 0) > self.batch_window_ms:
            await self._flush(asset, connections)

    async def _flush(self, asset: str, connections: set):
        if not self._pending.get(asset):
            return

        msgs = self._pending.pop(asset, [])
        self._last_flush[asset] = time.time() * 1000

        if not connections:
            return

        dead = []
        for ws in list(connections):
            try:
                for m in msgs:
                    await ws.send_text(json.dumps(m))
            except Exception:
                dead.append(ws)

        for ws in dead:
            connections.discard(ws)


broadcast_batcher = BroadcastBatcher()