"""
ProbHistory — Per-slot probability history with bounded deques.

Replaces direct access to _prob_history and _truth_history.
"""

from __future__ import annotations

from collections import deque
from typing import Any


class ProbHistory:
    """Manages probability history per market key with fixed maxlen."""

    def __init__(self, maxlen: int = 4320):
        self._history: dict[str, deque] = {}
        self.maxlen = maxlen

    def append(self, key: str, ts: int, up_pct: float) -> None:
        if key not in self._history:
            self._history[key] = deque(maxlen=self.maxlen)
        self._history[key].append({"ts": ts, "up_pct": up_pct})

    def get(self, key: str, n: int = None) -> list[dict]:
        if key not in self._history:
            return []
        data = list(self._history[key])
        if n is not None:
            return data[-n:]
        return data

    def clear(self, key: str) -> None:
        self._history.pop(key, None)

    def keys(self) -> list[str]:
        return list(self._history.keys())


# Global instances for migration
prob_history = ProbHistory()
truth_history = ProbHistory()