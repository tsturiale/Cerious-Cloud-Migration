"""
WS Subscription Manager — Handles Dome 5-WS hard limit + priority queue.

Prevents over-subscription during rotation and eager discovery.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Set


@dataclass
class SubscriptionManager:
    """Manages limited WS subscriptions with priority."""

    max_dome_ws: int = 5
    active: Set[str] = field(default_factory=set)
    # key -> priority (higher = more important)
    priorities: dict[str, int] = field(default_factory=dict)

    def request_subscription(self, key: str, priority: int = 0) -> bool:
        """Request subscription. Returns True if granted (or already active)."""
        if key in self.active:
            self.priorities[key] = max(self.priorities.get(key, 0), priority)
            return True

        if len(self.active) < self.max_dome_ws:
            self.active.add(key)
            self.priorities[key] = priority
            return True

        # Evict lowest priority if new request has higher priority
        if self.active:
            lowest = min(self.priorities, key=self.priorities.get)
            if priority > self.priorities.get(lowest, 0):
                self.active.remove(lowest)
                self.priorities.pop(lowest, None)
                self.active.add(key)
                self.priorities[key] = priority
                return True

        return False

    def release(self, key: str) -> None:
        self.active.discard(key)
        self.priorities.pop(key, None)

    def get_active_count(self) -> int:
        return len(self.active)

    def is_at_limit(self) -> bool:
        return len(self.active) >= self.max_dome_ws


ws_manager = SubscriptionManager()
