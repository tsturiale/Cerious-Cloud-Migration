"""
Wrapper around the standalone Titanium V5 probability engine.

Primary source:
  titanium_v5_distribution_package/titanium_v5_engine.py
"""

from __future__ import annotations

from typing import Any, Dict

try:
    # Production implementation (Merton + Student-t + vanna gating).
    from titanium_v5_distribution_package.titanium_v5_engine import evaluate_v5_signal as _evaluate_v5_signal
except Exception:
    def _evaluate_v5_signal(**kwargs: Any) -> Dict[str, Any]:
        """
        Conservative fallback when the standalone package is unavailable.
        """
        return {
            "triggered": False,
            "side": None,
            "prob": 0.0,
            "vanna": 0.0,
            "reason": "V5 engine unavailable",
        }


def evaluate_v5_signal(**kwargs: Any) -> Dict[str, Any]:
    return _evaluate_v5_signal(**kwargs)
