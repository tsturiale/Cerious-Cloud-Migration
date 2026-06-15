"""
shared/features.py — Feature calculation library.

Ported from the poly.md backtesting harness into a clean, stateless module.
All functions are pure (no side effects) and operate on numpy arrays or
lists of Bar/TradeTick objects from shared.types.

Models rely on:
  - Keltner Channels  (20-EMA, 2.5× ATR bands)
  - Z-score of price deviation from EMA
  - ATR-based volatility regime classification
  - Order Flow Imbalance (OFI)
  - VPIN (Volume-Synchronized Probability of Informed Trading)
  - Order book depth metrics
"""

from __future__ import annotations

import math
import statistics
from collections import deque
from typing import Literal, Sequence

from shared.types import Bar, Features, OrderBook, Regime, TradeTick


# ---------------------------------------------------------------------------
# Low-level math helpers
# ---------------------------------------------------------------------------

def _ema(values: Sequence[float], period: int) -> list[float]:
    """Exponential moving average.  Returns same-length list (NaN-padded prefix)."""
    result: list[float] = []
    k = 2.0 / (period + 1)
    prev: float | None = None
    for i, v in enumerate(values):
        if i < period - 1:
            result.append(float("nan"))
        elif i == period - 1:
            # Seed with simple average of first `period` values
            seed = sum(values[: period]) / period
            result.append(seed)
            prev = seed
        else:
            assert prev is not None
            ema_val = v * k + prev * (1 - k)
            result.append(ema_val)
            prev = ema_val
    return result


def _true_range(bars: Sequence[Bar]) -> list[float]:
    """True Range for each bar (first bar uses high-low only)."""
    tr: list[float] = []
    for i, bar in enumerate(bars):
        if i == 0:
            tr.append(bar.high - bar.low)
        else:
            prev_close = bars[i - 1].close
            tr.append(
                max(
                    bar.high - bar.low,
                    abs(bar.high - prev_close),
                    abs(bar.low - prev_close),
                )
            )
    return tr


def _atr(bars: Sequence[Bar], period: int = 14) -> list[float]:
    """Average True Range via EMA of True Range."""
    tr = _true_range(bars)
    return _ema(tr, period)


def _rolling_std(values: Sequence[float], period: int) -> list[float]:
    """Rolling standard deviation (sample). NaN-padded prefix."""
    result: list[float] = []
    window: deque[float] = deque(maxlen=period)
    for i, v in enumerate(values):
        window.append(v)
        if i < period - 1:
            result.append(float("nan"))
        else:
            result.append(statistics.stdev(window))
    return result


def _percentile_rank(value: float, series: Sequence[float]) -> float:
    """Fraction of elements in series strictly less than value.  Returns 0–1."""
    finite = [x for x in series if not math.isnan(x)]
    if not finite:
        return 0.5
    return sum(1 for x in finite if x < value) / len(finite)


# ---------------------------------------------------------------------------
# Keltner Channels
# ---------------------------------------------------------------------------

def calc_keltner(
    bars: Sequence[Bar],
    ema_period: int = 20,
    atr_mult: float = 2.5,
    atr_period: int = 14,
) -> tuple[list[float], list[float], list[float]]:
    """
    Returns (upper, mid, lower) as parallel lists aligned with `bars`.

    upper = EMA + atr_mult * ATR
    mid   = EMA
    lower = EMA - atr_mult * ATR
    """
    closes = [b.close for b in bars]
    ema = _ema(closes, ema_period)
    atr = _atr(bars, atr_period)

    upper, lower = [], []
    for e, a in zip(ema, atr):
        if math.isnan(e) or math.isnan(a):
            upper.append(float("nan"))
            lower.append(float("nan"))
        else:
            upper.append(e + atr_mult * a)
            lower.append(e - atr_mult * a)
    return upper, ema, lower


# ---------------------------------------------------------------------------
# Z-Score
# ---------------------------------------------------------------------------

def calc_zscore(price: float, ema: float, std: float) -> float:
    """Standardised distance of price from EMA.  Returns 0 if std ≈ 0."""
    if std < 1e-12:
        return 0.0
    return (price - ema) / std


def zscore_bucket(z: float) -> int:
    """
    Map z-score to one of 5 Markov state buckets:
      0 → z < -2
      1 → -2 ≤ z < -1
      2 → -1 ≤ z < 1
      3 →  1 ≤ z < 2
      4 →  z ≥ 2
    """
    if z < -2:
        return 0
    if z < -1:
        return 1
    if z < 1:
        return 2
    if z < 2:
        return 3
    return 4


# ---------------------------------------------------------------------------
# Volatility Regime
# ---------------------------------------------------------------------------

def classify_regime(
    atr_value: float,
    atr_history: Sequence[float],
    low_threshold: float = 0.30,
    high_threshold: float = 0.70,
) -> Regime:
    """
    Classify current ATR into LOW / MEDIUM / HIGH regime using percentile rank
    within `atr_history` (rolling lookback window, typically 100 bars).
    """
    pct = _percentile_rank(atr_value, atr_history)
    if pct < low_threshold:
        return Regime.LOW
    if pct > high_threshold:
        return Regime.HIGH
    return Regime.MEDIUM


# ---------------------------------------------------------------------------
# Order Flow Imbalance (OFI)
# ---------------------------------------------------------------------------

def calc_ofi(ticks: Sequence[TradeTick]) -> float:
    """
    OFI = (buy_volume - sell_volume) / total_volume.
    Range: -1.0 (all sells) to +1.0 (all buys).
    Returns 0.0 if no ticks.
    """
    buy_vol = sum(t.size for t in ticks if t.side == "buy")
    sell_vol = sum(t.size for t in ticks if t.side == "sell")
    total = buy_vol + sell_vol
    if total < 1e-12:
        return 0.0
    return (buy_vol - sell_vol) / total


def calc_ofi_zscore(ofi: float, ofi_history: Sequence[float]) -> float:
    """Standardise OFI against its recent history."""
    finite = [x for x in ofi_history if not math.isnan(x)]
    if len(finite) < 2:
        return 0.0
    mu = statistics.mean(finite)
    sigma = statistics.stdev(finite)
    if sigma < 1e-12:
        return 0.0
    return (ofi - mu) / sigma


# ---------------------------------------------------------------------------
# VPIN  (Volume-Synchronized Probability of Informed Trading)
# ---------------------------------------------------------------------------

def calc_vpin(
    ticks: Sequence[TradeTick],
    volume_buckets: int = 50,
) -> float:
    """
    Simplified VPIN estimator.

    Splits tick flow into equal-volume buckets, computes |buy% - sell%|
    per bucket, and averages across buckets.  Range: 0 (no toxicity) – 1.

    Returns 0.5 as a neutral prior when there is insufficient data.
    """
    total_vol = sum(t.size for t in ticks)
    if total_vol < 1e-12 or len(ticks) == 0:
        return 0.5

    bucket_size = total_vol / volume_buckets
    buckets: list[float] = []   # |buy_frac - sell_frac| per bucket

    bucket_buy = 0.0
    bucket_sell = 0.0
    bucket_total = 0.0

    for tick in ticks:
        remaining = tick.size
        while remaining > 1e-12:
            capacity = bucket_size - bucket_total
            fill = min(remaining, capacity)
            if tick.side == "buy":
                bucket_buy += fill
            else:
                bucket_sell += fill
            bucket_total += fill
            remaining -= fill

            if bucket_total >= bucket_size - 1e-9:
                bt = bucket_buy + bucket_sell
                if bt > 1e-12:
                    buckets.append(abs(bucket_buy - bucket_sell) / bt)
                bucket_buy = bucket_sell = bucket_total = 0.0

    # Flush partial last bucket
    bt = bucket_buy + bucket_sell
    if bt > 1e-12:
        buckets.append(abs(bucket_buy - bucket_sell) / bt)

    if not buckets:
        return 0.5
    return statistics.mean(buckets)


# ---------------------------------------------------------------------------
# Order Book Depth Metrics
# ---------------------------------------------------------------------------

def calc_bid_ask_imbalance(book: OrderBook) -> float:
    """(bid_depth - ask_depth) / (bid_depth + ask_depth).  Range: -1 to +1."""
    total = book.bid_depth + book.ask_depth
    if total < 1e-12:
        return 0.0
    return (book.bid_depth - book.ask_depth) / total


# ---------------------------------------------------------------------------
# Kelly Criterion
# ---------------------------------------------------------------------------

def kelly_size(
    win_rate: float,
    avg_win: float,
    avg_loss: float,
    fraction: float = 0.25,
    account_balance: float = 10_000.0,
    max_size: float = 500.0,
) -> float:
    """
    Fractional Kelly position size in USD.

    f* = (p * b - q) / b     where b = avg_win/avg_loss, p = win_rate, q = 1-p
    size = f* * fraction * account_balance  (capped at max_size)
    """
    if avg_loss < 1e-12 or win_rate <= 0 or win_rate >= 1:
        return 0.0
    b = avg_win / avg_loss
    p = win_rate
    q = 1.0 - p
    f_star = (p * b - q) / b
    if f_star <= 0:
        return 0.0
    size = f_star * fraction * account_balance
    return min(size, max_size)


# ---------------------------------------------------------------------------
# Feature Vector Builder  (stateful — wraps rolling windows)
# ---------------------------------------------------------------------------

class FeatureEngine:
    """
    Stateful engine that consumes bars + tick/book snapshots and emits
    a Features object for each new bar.

    Usage:
        engine = FeatureEngine(asset="BTC")
        for bar in historical_bars:
            feats = engine.update(bar, ticks=[], book=None)
            if feats:
                # use feats
    """

    def __init__(
        self,
        asset: str,
        ema_period: int = 20,
        atr_period: int = 14,
        atr_mult: float = 2.5,
        regime_lookback: int = 100,
        ofi_lookback: int = 20,
        momentum_bars: int = 5,
    ) -> None:
        self.asset = asset
        self.ema_period = ema_period
        self.atr_period = atr_period
        self.atr_mult = atr_mult

        self.momentum_bars = momentum_bars

        self._bars: list[Bar] = []
        self._atr_history: deque[float] = deque(maxlen=regime_lookback)
        self._ofi_history: deque[float] = deque(maxlen=ofi_lookback)
        self._std_history: deque[float] = deque(maxlen=ema_period)

    def update(
        self,
        bar: Bar,
        ticks: Sequence[TradeTick] = (),
        book: OrderBook | None = None,
    ) -> Features | None:
        """
        Ingest one new bar.  Returns a Features object once enough history
        has accumulated (>= ema_period bars), otherwise returns None.
        """
        self._bars.append(bar)
        need = max(self.ema_period, self.atr_period) + 1
        if len(self._bars) < need:
            return None

        closes = [b.close for b in self._bars]
        ema_series = _ema(closes, self.ema_period)
        atr_series = _atr(self._bars, self.atr_period)
        std_series = _rolling_std(closes, self.ema_period)

        kc_upper_s, kc_mid_s, kc_lower_s = calc_keltner(
            self._bars, self.ema_period, self.atr_mult, self.atr_period
        )

        kc_upper = kc_upper_s[-1]
        kc_mid = kc_mid_s[-1]
        kc_lower = kc_lower_s[-1]
        cur_atr = atr_series[-1]
        cur_std = std_series[-1]

        self._atr_history.append(cur_atr)

        zscore = calc_zscore(bar.close, kc_mid, cur_std) if not math.isnan(cur_std) else 0.0
        regime = classify_regime(cur_atr, list(self._atr_history))

        # Order flow
        ofi = calc_ofi(ticks)
        self._ofi_history.append(ofi)
        ofi_z = calc_ofi_zscore(ofi, list(self._ofi_history))
        vpin = calc_vpin(ticks)

        # Order book depth
        depth_ratio = book.depth_ratio if book and book.depth_ratio is not None else 1.0
        bid_ask_imb = calc_bid_ask_imbalance(book) if book else 0.0

        # 5-bar momentum (in % terms)
        if len(self._bars) >= self.momentum_bars + 1:
            prev_close = self._bars[-(self.momentum_bars + 1)].close
            price_change_5m = (bar.close - prev_close) / prev_close * 100.0
        else:
            price_change_5m = 0.0

        # HTF Trend Approximation (using 60 and 240 bars internally for 1m base timeframe)
        # Assuming base bar timeframe is 1m based on the 5-bar momentum. 
        # If the timeframe is 15m, these periods become larger HTF representations.
        htf_trend = 0
        if len(self._bars) >= 60: # proxy for 1h on 1m chart, or 15h on 15m chart
            ema_60 = _ema(closes, 60)
            if not math.isnan(ema_60[-1]) and not math.isnan(ema_60[-2]):
                slope_60 = ema_60[-1] - ema_60[-2]
                if slope_60 > 0.0001:
                    htf_trend += 1
                elif slope_60 < -0.0001:
                    htf_trend -= 1
        
        if len(self._bars) >= 240:
            ema_240 = _ema(closes, 240)
            if not math.isnan(ema_240[-1]) and not math.isnan(ema_240[-2]):
                slope_240 = ema_240[-1] - ema_240[-2]
                if slope_240 > 0.0001:
                    htf_trend += 1
                elif slope_240 < -0.0001:
                    htf_trend -= 1
        
        # Clamp between -1 and 1
        htf_trend_norm = min(max(htf_trend, -1), 1)

        return Features(
            timestamp=bar.timestamp,
            asset=self.asset,
            kc_upper=kc_upper,
            kc_mid=kc_mid,
            kc_lower=kc_lower,
            close=bar.close,
            zscore=zscore,
            atr=cur_atr,
            atr_percentile=_percentile_rank(cur_atr, list(self._atr_history)),
            regime=regime,
            ofi=ofi,
            ofi_zscore=ofi_z,
            vpin=vpin,
            depth_ratio=depth_ratio,
            bid_ask_imbalance=bid_ask_imb,
            price_change_5m=price_change_5m,
            htf_trend=htf_trend_norm,
            volatility=cur_std,
        )
