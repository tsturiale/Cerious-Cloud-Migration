"""
MarketRegistry — Encapsulates active, staged, and Kalshi market state.

Replaces direct access to:
- _active_markets
- _staged_markets  
- _kal_active_markets

All mutation goes through this class. Provides safe promotion, expiry checks,
and snapshot access for broadcast.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class MarketRegistry:
    """Central registry for all market slots across providers."""

    # Primary Polymarket slots
    active: dict[str, dict] = field(default_factory=dict)
    staged: dict[str, dict] = field(default_factory=dict)

    # Kalshi parallel provider
    kal_active: dict[str, dict] = field(default_factory=dict)

    # Optional: track last rotation timestamp per key
    last_rotation_ms: dict[str, int] = field(default_factory=dict)

    def get_active(self, key: str, provider: str = "polymarket") -> Optional[dict]:
        if provider == "kalshi":
            return self.kal_active.get(key)
        return self.active.get(key)

    def get_staged(self, key: str) -> Optional[dict]:
        return self.staged.get(key)

    def set_active(self, key: str, market: dict, provider: str = "polymarket") -> None:
        if provider == "kalshi":
            self.kal_active[key] = market
        else:
            self.active[key] = market

    def set_staged(self, key: str, market: Optional[dict]) -> None:
        if market is None:
            self.staged.pop(key, None)
        else:
            self.staged[key] = market

    def promote_staged(self, key: str, now_ms: int) -> bool:
        """Promote staged market to active. Returns True if promotion happened."""
        staged = self.staged.get(key)
        if not staged or not staged.get("live"):
            return False

        # Guard against stale staged markets
        staged_expiry = int(staged.get("expiry_ts", 0))
        if staged_expiry <= now_ms:
            self.staged.pop(key, None)
            return False

        # Record rotation
        self.last_rotation_ms[key] = now_ms
        self.active[key] = staged
        self.staged[key] = None
        return True

    def record_rotation(self, key: str, now_ms: int) -> None:
        self.last_rotation_ms[key] = now_ms

    def get_all_active_keys(self, provider: str = "polymarket") -> list[str]:
        if provider == "kalshi":
            return list(self.kal_active.keys())
        return list(self.active.keys())

    def get_all_active(self, provider: str = "polymarket") -> dict[str, dict]:
        if provider == "kalshi":
            return dict(self.kal_active)
        return dict(self.active)

    def get_all_staged(self) -> dict[str, dict]:
        return {k: v for k, v in self.staged.items() if v}

    def clear_staged(self, key: str) -> None:
        self.staged.pop(key, None)

    def remove_inactive(self, key: str, provider: str = "polymarket") -> None:
        if provider == "kalshi":
            self.kal_active.pop(key, None)
        else:
            self.active.pop(key, None)

    def snapshot(self) -> dict[str, Any]:
        """Return a safe snapshot for broadcasting."""
        return {
            "active_count": len(self.active),
            "staged_count": len([v for v in self.staged.values() if v]),
            "kal_active_count": len(self.kal_active),
            "last_rotations": dict(self.last_rotation_ms),
        }


# Global singleton for gradual migration
registry = MarketRegistry()