"""
agents/atr_engine.py
Shared ATR computation pool — 5-minute and 15-minute parallel streams.
Uses incremental Wilder smoothing (O(1) per update) with pre-allocated state.
Classify ATR ratio into 5 regime levels per the FF Systematica spec.
"""

import numpy as np
import pandas as pd
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Deque
from collections import deque

from core.state_store import StateStore, ATRState


# ─── Regime classification ────────────────────────────────────────────────────

def classify_atr_regime(ratio: float, cfg: dict) -> str:
    rc = cfg.get("atr", {}).get("ratio_extreme_low", 0.30)
    rm = cfg.get("atr", {}).get("ratio_mod_low", 0.60)
    rb = cfg.get("atr", {}).get("ratio_balanced_high", 1.00)
    rh = cfg.get("atr", {}).get("ratio_mod_high", 1.50)
    if ratio < rc:
        return "extreme_compression"
    elif ratio < rm:
        return "moderate_compression"
    elif ratio < rb:
        return "balanced"
    elif ratio < rh:
        return "moderate_expansion"
    else:
        return "extreme_expansion"


def get_atr_size_modifier(regime: str, cfg: dict) -> float:
    mods = cfg.get("atr", {}).get("size_modifier", {})
    return mods.get(regime, 1.0)


# ─── Per-symbol ATR state ─────────────────────────────────────────────────────

class SymbolATR:
    """
    Maintains rolling 1-minute true range values and computes
    5-minute ATR and 15-minute ATR via Wilder smoothing.
    """

    def __init__(self, symbol: str, period: int = 14, cfg: dict = None):
        self.symbol = symbol
        self.period = period
        self.cfg = cfg or {}

        # 1-minute true range circular buffer
        self._tr_buf: Deque[float] = deque(maxlen=500)

        # Last close for TR calculation
        self._last_close: Optional[float] = None

        # Wilder ATR state — 5-minute (14 synthetic 5m periods = 70 1m bars)
        self._atr5_state: Optional[float] = None
        self._atr5_bar_count: int = 0           # 1m bars accumulated
        self._atr5_window: List[float] = []     # buffer for initial seeding

        # Wilder ATR state — 15-minute
        self._atr15_state: Optional[float] = None
        self._atr15_bar_count: int = 0
        self._atr15_window: List[float] = []

        # Published state
        self.current: ATRState = ATRState()

    def update_1m_bar(self, high: float, low: float, close: float) -> ATRState:
        """Feed a new 1-minute OHLC bar. Returns updated ATRState."""
        # True range
        if self._last_close is None:
            tr = high - low
        else:
            tr = max(high - low, abs(high - self._last_close), abs(low - self._last_close))
        self._last_close = close
        self._tr_buf.append(tr)

        # 5-minute ATR: N=14, period = 70 1m bars for seeding, then incremental
        n5 = self.period * 5  # 70 bars for warm-up
        self._atr5_bar_count += 1
        if self._atr5_state is None:
            self._atr5_window.append(tr)
            if len(self._atr5_window) >= n5:
                self._atr5_state = float(np.mean(self._atr5_window))
        else:
            self._atr5_state = (self._atr5_state * (self.period - 1) + tr) / self.period

        # 15-minute ATR: N=14, period = 210 1m bars for seeding
        n15 = self.period * 15  # 210 bars for warm-up
        self._atr15_bar_count += 1
        if self._atr15_state is None:
            self._atr15_window.append(tr)
            if len(self._atr15_window) >= n15:
                self._atr15_state = float(np.mean(self._atr15_window))
        else:
            self._atr15_state = (self._atr15_state * (self.period - 1) + tr) / self.period

        # Compute ratio and regime
        atr5 = self._atr5_state or 0.0
        atr15 = self._atr15_state or 1e-8
        ratio = atr5 / max(atr15, 1e-8)
        regime = classify_atr_regime(ratio, self.cfg)

        self.current = ATRState(
            atr_5m=atr5,
            atr_15m=atr15,
            ratio=ratio,
            regime=regime,
            updated_at=time.time()
        )
        return self.current

    def is_warm(self) -> bool:
        """True once both ATR streams have enough bars."""
        return (self._atr5_state is not None) and (self._atr15_state is not None)

    def get_tr_series(self, n: int = 100) -> np.ndarray:
        return np.array(list(self._tr_buf)[-n:])


# ─── ATR Engine (multi-symbol) ────────────────────────────────────────────────

class ATREngine:
    """
    Shared ATR computation resource. One instance, all strategies read from it.
    Call update(symbol, high, low, close) on every new 1-minute bar.
    """

    def __init__(self, cfg: dict, store: StateStore):
        self.cfg = cfg
        self.store = store
        self.period = cfg.get("atr", {}).get("period", 14)
        self._symbols: Dict[str, SymbolATR] = {}

    def _get_or_create(self, symbol: str) -> SymbolATR:
        if symbol not in self._symbols:
            self._symbols[symbol] = SymbolATR(symbol, self.period, self.cfg)
        return self._symbols[symbol]

    def update(self, symbol: str, high: float, low: float, close: float) -> ATRState:
        """Feed one new 1-minute bar. Returns ATRState; publishes to StateStore."""
        sym_atr = self._get_or_create(symbol)
        state = sym_atr.update_1m_bar(high, low, close)
        self.store.update_atr(symbol, state)
        return state

    def get(self, symbol: str) -> ATRState:
        return self.store.get_atr(symbol)

    def is_warm(self, symbol: str) -> bool:
        sym = self._symbols.get(symbol)
        return sym.is_warm() if sym else False

    # ─── Bulk backtest initialisation ─────────────────────────────────────────

    def seed_from_df(self, symbol: str, df_1m: pd.DataFrame):
        """
        Seed ATR engine from a 1-minute OHLCV DataFrame (backtest warm-up).
        df_1m must have columns: high, low, close.
        """
        for _, row in df_1m.iterrows():
            self.update(symbol, row["high"], row["low"], row["close"])

    # ─── Stochastic RSI helper (used by Alpha + Beta) ─────────────────────────

    @staticmethod
    def compute_stoch_rsi(prices: np.ndarray, rsi_period: int = 14,
                          stoch_period: int = 14, k_smooth: int = 3) -> tuple:
        """
        Returns (K, D) stochastic RSI values from a 1D price array.
        Returns (None, None) if insufficient data.
        """
        min_len = rsi_period + stoch_period + k_smooth + 5
        if len(prices) < min_len:
            return None, None

        # RSI
        deltas = np.diff(prices)
        gains = np.where(deltas > 0, deltas, 0.0)
        losses = np.where(deltas < 0, -deltas, 0.0)
        avg_gain = np.mean(gains[:rsi_period])
        avg_loss = np.mean(losses[:rsi_period])
        rsi_vals = []
        for i in range(rsi_period, len(deltas)):
            avg_gain = (avg_gain * (rsi_period - 1) + gains[i]) / rsi_period
            avg_loss = (avg_loss * (rsi_period - 1) + losses[i]) / rsi_period
            rs = avg_gain / max(avg_loss, 1e-10)
            rsi_vals.append(100 - 100 / (1 + rs))

        rsi_arr = np.array(rsi_vals)
        if len(rsi_arr) < stoch_period:
            return None, None

        # Stochastic on RSI
        k_raw = []
        for i in range(stoch_period - 1, len(rsi_arr)):
            window = rsi_arr[i - stoch_period + 1: i + 1]
            low_r, high_r = window.min(), window.max()
            denom = max(high_r - low_r, 1e-10)
            k_raw.append((rsi_arr[i] - low_r) / denom * 100)

        k_arr = np.array(k_raw)
        if len(k_arr) < k_smooth:
            return None, None

        # Smooth K → %K
        k_smooth_arr = np.convolve(k_arr, np.ones(k_smooth) / k_smooth, mode='valid')

        # D = 3-period MA of %K
        if len(k_smooth_arr) < 3:
            return None, None
        d_val = np.mean(k_smooth_arr[-3:])
        k_val = k_smooth_arr[-1]

        return float(k_val), float(d_val)
