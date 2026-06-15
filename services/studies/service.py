from __future__ import annotations

import math
import time
from statistics import mean
from typing import Any

from services.common.bus import market_bus
from services.common.contracts import CME_INSTRUMENTS, SYNTHETIC_SPREADS
from services.common.historical import (
    aggregate_bars,
    bar_timestamp_ms,
    cached_historical_backfill,
    historical_backfill,
    interval_ms,
    merge_bars,
)


class StudiesService:
    """Single source for chart bars and technical study values."""

    def _number(self, value: Any) -> float | None:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return None
        return parsed if math.isfinite(parsed) else None

    def live_bars(self, asset: str, interval: str, limit: int, include_forming: bool = True) -> list[dict[str, Any]]:
        key = asset.upper()
        requested_limit = max(1, min(int(limit), 4500))
        rolling = market_bus.rolling_ohlcv(key, interval, requested_limit, include_forming=include_forming)
        if rolling:
            return rolling
        rows = list(market_bus.bars.get(key, []))
        return aggregate_bars(rows, interval, requested_limit) if rows else []

    def bars(self, asset: str, interval: str, limit: int, include_forming: bool = True) -> list[dict[str, Any]]:
        key = asset.upper()
        requested_limit = max(1, min(int(limit), 4500))
        historical = historical_backfill(key, interval, requested_limit)
        live = self.live_bars(key, interval, requested_limit, include_forming=include_forming)
        return merge_bars(live, historical, requested_limit) if historical else live

    def cached_bars(self, asset: str, interval: str, limit: int, include_forming: bool = True) -> list[dict[str, Any]]:
        key = asset.upper()
        requested_limit = max(1, min(int(limit), 4500))
        historical = cached_historical_backfill(key, interval, requested_limit)
        live = self.live_bars(key, interval, requested_limit, include_forming=include_forming)
        return merge_bars(live, historical, requested_limit) if historical else live

    def completed_bars(self, rows: list[dict[str, Any]], interval: str) -> list[dict[str, Any]]:
        bucket_ms = interval_ms(interval)
        now_ms = int(time.time() * 1000)
        return [
            row
            for row in rows
            if bar_timestamp_ms(row) and bar_timestamp_ms(row) + bucket_ms <= now_ms
        ]

    def linear_regression_band(self, values: list[float], period: int = 27, deviations: float = 2.0) -> dict[str, float]:
        sample = [value for value in values[-period:] if math.isfinite(value)]
        if len(sample) < period:
            raise ValueError(f"linear regression needs {period} values; received {len(sample)}")
        n = len(sample)
        x_mean = (n - 1) / 2
        y_mean = mean(sample)
        numerator = 0.0
        denominator = 0.0
        for index, value in enumerate(sample):
            numerator += (index - x_mean) * (value - y_mean)
            denominator += (index - x_mean) ** 2
        slope = numerator / denominator if denominator else 0.0
        intercept = y_mean - slope * x_mean
        residuals = [value - (intercept + slope * index) for index, value in enumerate(sample)]
        sigma = math.sqrt(mean([value**2 for value in residuals])) if residuals else 0.0
        latest_mean = intercept + slope * (n - 1)
        std = max(0.0, float(deviations))
        return {
            "mean": latest_mean,
            "upper": latest_mean + std * sigma,
            "lower": latest_mean - std * sigma,
            "sigma": sigma,
            "slope": slope,
        }

    def _lr27_payload(self, asset: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
        key = asset.upper()
        interval = "30m"
        limit = 80
        completed = self.completed_bars(rows, interval)[-limit:]
        forming_bar = next(
            (
                row
                for row in reversed(rows)
                if bar_timestamp_ms(row) and bar_timestamp_ms(row) + interval_ms(interval) > int(time.time() * 1000)
            ),
            None,
        )
        closes = [
            close
            for row in completed
            for close in [self._number(row.get("close"))]
            if close is not None
        ]
        if len(closes) < 27:
            raise ValueError(f"LR27 for {key} has {len(closes)} completed 30m bars; needs 27")
        band = self.linear_regression_band(closes, 27, 2.0)
        quote = market_bus.quotes.get(key)
        forming_update_ms = int(float((forming_bar or {}).get("lastUpdateMs") or bar_timestamp_ms(forming_bar or {}))) if forming_bar else 0
        return {
            "symbol": key,
            "label": SYNTHETIC_SPREADS.get(key, CME_INSTRUMENTS.get(key, {})).get("label", key),
            "interval": interval,
            "period": 27,
            "bars": len(closes[-27:]),
            "updatedAt": bar_timestamp_ms(completed[-1]),
            "isForming": False,
            "activeBarLive": bool(forming_bar),
            "formingBar": forming_bar,
            "formingUpdatedAt": forming_update_ms,
            "mean": band["mean"],
            "upper2": band["upper"],
            "lower2": band["lower"],
            "sigma": band["sigma"],
            "slope": band["slope"],
            "lastTraded": quote.last if quote else closes[-1],
            "live": quote is not None,
            "source": "studies.databento-rest-baseline-plus-live-rolling-30m",
        }

    def lr27(self, asset: str) -> dict[str, Any]:
        key = asset.upper()
        if key not in SYNTHETIC_SPREADS and key not in CME_INSTRUMENTS:
            raise KeyError(key)
        rows = self.bars(key, "30m", 80, include_forming=True)
        return self._lr27_payload(key, rows)

    def lr27_cached(self, asset: str) -> dict[str, Any]:
        key = asset.upper()
        if key not in SYNTHETIC_SPREADS and key not in CME_INSTRUMENTS:
            raise KeyError(key)
        rows = self.cached_bars(key, "30m", 80, include_forming=True)
        return self._lr27_payload(key, rows)


studies_service = StudiesService()
