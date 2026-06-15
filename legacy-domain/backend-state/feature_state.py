"""
FeatureState — Per-asset / per-market FeatureEngine and TriEngine instances with LRU eviction.

Prevents unbounded memory growth when running 28+ markets.
"""

from __future__ import annotations

import time
from typing import Optional

# Import the actual engines (adjust paths if needed)
try:
    from shared.features import FeatureEngine
    from shared.tri_engine_system import TriEngineSystem
except ImportError:
    FeatureEngine = None
    TriEngineSystem = None


class FeatureState:
    """Lazy creation + TTL eviction for heavy quant objects."""

    def __init__(self, ttl_seconds: int = 7200):
        self._engines: dict[str, dict] = {}  # key -> {"fe": FeatureEngine, "tri": TriEngineSystem, "last_used": ts}
        self.ttl = ttl_seconds

    def get_feature_engine(self, key: str) -> Optional[Any]:
        self._touch(key)
        if key not in self._engines:
            if FeatureEngine is None:
                return None
            self._engines[key] = {
                "fe": FeatureEngine(key) if FeatureEngine else None,
                "tri": TriEngineSystem() if TriEngineSystem else None,
                "last_used": time.time()
            }
        return self._engines[key]["fe"]

    def get_tri_engine(self, key: str) -> Optional[Any]:
        self._touch(key)
        entry = self._engines.get(key)
        return entry["tri"] if entry else None

    def _touch(self, key: str) -> None:
        if key in self._engines:
            self._engines[key]["last_used"] = time.time()
        self._evict()

    def _evict(self) -> None:
        now = time.time()
        to_remove = [k for k, v in self._engines.items() if now - v["last_used"] > self.ttl]
        for k in to_remove:
            self._engines.pop(k, None)

    def clear(self, key: str) -> None:
        self._engines.pop(key, None)


feature_state = FeatureState()