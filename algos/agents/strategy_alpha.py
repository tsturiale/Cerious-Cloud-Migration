"""
agents/strategy_alpha.py
Strategy Alpha: ATR Regime Momentum Capture (2s execution cycle)

Thesis: Volatility expansion (5m ATR > 1.3× 15m ATR) + directional
momentum alignment → binary market direction bias.

Allocation: 35% of capital
"""

import numpy as np
import pandas as pd
import logging
import time
import uuid
from typing import Any, Optional

from core.state_store import StateStore, BarState, Position
from agents.atr_engine import ATREngine, get_atr_size_modifier

logger = logging.getLogger("StrategyAlpha")


class StrategyAlpha:
    """
    ATR momentum breakout strategy.
    Fires when:
      1. ATR_5m > threshold × ATR_15m  (volatility expansion)
      2. 3 of last 5 1m bars in same direction (momentum alignment)
      3. 15m stochastic RSI in strong bull/bear state (directional filter)
    """

    def __init__(self, symbols: list, cfg: dict, store: StateStore, 
                 atr_engine: ATREngine, execution_agent: Any):
        self.symbols = symbols
        self.cfg = cfg
        self.store = store
        self.atr_engine = atr_engine
        self.execution_agent = execution_agent

        acfg = cfg.get("alpha", {})
        self.enabled = acfg.get("enabled", True)
        self.allocation = acfg.get("allocation", 0.35)
        self.atr_trigger = acfg.get("atr_expansion_trigger", 1.3)
        self.momentum_bars = acfg.get("momentum_bars_required", 3)
        self.fractional_kelly = acfg.get("fractional_kelly", 0.25)
        self.stoch_rsi_period = acfg.get("stoch_rsi_period", 14)
        self.stoch_period = acfg.get("stoch_period", 14)
        self.stoch_smooth_k = acfg.get("stoch_smooth_k", 3)
        self.strong_bull = acfg.get("stoch_strong_bull", 60)
        self.strong_bear = acfg.get("stoch_strong_bear", 40)
        self.cooldown_bars = acfg.get("cooldown_bars", 2)

        self.max_exposure_15m = cfg.get("capital", {}).get("max_exposure_per_15m_window", 0.10)
        self.max_exposure_5m = cfg.get("capital", {}).get("max_exposure_per_5m_market", 0.05)

        # Cooldown tracking per symbol
        self._cooldown: dict = {sym: 0 for sym in symbols}
        # Bar count for cooldown
        self._bar_count: dict = {sym: 0 for sym in symbols}

    # ─── Main callback ────────────────────────────────────────────────────────

    def on_bar(self, symbol: str, bar: BarState):
        """Called by scheduler on every new 1m bar."""
        if not self.enabled:
            return
        if self.store.is_kill_switch_active():
            return

        self._bar_count[symbol] = self._bar_count.get(symbol, 0) + 1

        # Cooldown check
        if self._cooldown.get(symbol, 0) > 0:
            self._cooldown[symbol] -= 1
            return

        atr_state = self.store.get_atr(symbol)
        if atr_state.atr_5m == 0.0 or not self.atr_engine.is_warm(symbol):
            return

        # ── Signal 1: ATR expansion ──────────────────────────────────────────
        if atr_state.ratio < self.atr_trigger:
            return  # Not in expansion

        # ── Signal 2: Momentum alignment (3/5 bars same direction) ──────────
        direction = self._check_momentum(symbol)
        if direction == 0:
            return

        # ── Signal 3: 15m Stochastic RSI directional filter ─────────────────
        stoch_bias = self._get_stoch_bias(symbol)
        if stoch_bias == 0:
            return  # Neutral — no trade

        # Alpha only trades aligned signals
        if direction != stoch_bias:
            return

        # ── Compute Kelly-adjusted position size ─────────────────────────────
        size = self._compute_size(atr_state, bar)
        if size <= 0:
            return

        # ── Compute Kelly-adjusted position size ─────────────────────────────
        size = self._compute_size(atr_state, bar)
        if size <= 0:
            return

        # ── Define Risk Management Plan ───────────────────────────────────────
        # Base stop dist (e.g. 2.5 * ATR)
        sl_dist = atr_state.atr_5m * 2.5
        stop_loss = bar.close - sl_dist if direction == 1 else bar.close + sl_dist

        # ── Enter position ────────────────────────────────────────────────────
        side = "LONG" if direction == 1 else "SHORT"
        
        self.execution_agent.place_order(
            symbol=symbol,
            side=side,
            size=size,
            entry_price=bar.close,
            strategy="alpha",
            stop_loss=stop_loss,
            trailing_stop_dist=sl_dist * 0.6  # Tighter trailing stop than initial SL
        )
        self._cooldown[symbol] = self.cooldown_bars

    # ─── Signal helpers ───────────────────────────────────────────────────────

    def _check_momentum(self, symbol: str) -> int:
        """
        Returns 1 (bullish), -1 (bearish), or 0 (no clear direction).
        Checks last 5 1m bars: need 3+ closing in same direction.
        """
        bars = self.store.get_bar_history(symbol, "1m", n=6)
        if len(bars) < 6:
            return 0
        closes = [b.close for b in bars]
        directions = [1 if closes[i] > closes[i - 1] else -1 for i in range(1, 6)]
        up = sum(1 for d in directions if d == 1)
        dn = sum(1 for d in directions if d == -1)
        if up >= self.momentum_bars and closes[-1] > closes[-2]:
            return 1
        if dn >= self.momentum_bars and closes[-1] < closes[-2]:
            return -1
        return 0

    def _get_stoch_bias(self, symbol: str) -> int:
        """
        Returns 1 (bull), -1 (bear), or 0 (neutral) from 15m stochastic RSI.
        Uses last 60 1m closes resampled to approximate 15m closes.
        """
        bars = self.store.get_bar_history(symbol, "1m", n=80)
        if len(bars) < 50:
            return 0
        closes = np.array([b.close for b in bars])

        k, d = self.atr_engine.compute_stoch_rsi(
            closes, self.stoch_rsi_period, self.stoch_period, self.stoch_smooth_k
        )
        if k is None:
            return 0

        # Strong bull: %K > %D and %K > strong_bull threshold
        if k > d and k > self.strong_bull:
            return 1
        # Weak bull: allow with 0.7× size (handled in sizing)
        if k > d and k > 40:
            return 1  # will reduce size in _compute_size
        # Strong bear
        if k < d and k < self.strong_bear:
            return -1
        # Weak bear
        if k < d and k < 60:
            return -1

        return 0  # Neutral

    def _compute_size(self, atr_state, bar: BarState) -> float:
        """
        Kelly-adjusted position size with ATR regime modifier.
        Binary payoff assumption: win probability p estimated from ATR regime WR data.
        """
        portfolio = self.store.portfolio
        if portfolio.kill_switch_active:
            return 0.0

        capital = portfolio.bankroll
        max_position = capital * self.max_exposure_5m * self.allocation

        # Estimate win probability from ATR regime (from backtest results)
        win_prob_by_regime = {
            "extreme_compression": 0.55,
            "moderate_compression": 0.535,
            "balanced": 0.53,
            "moderate_expansion": 0.515,
            "extreme_expansion":  0.50,
        }
        p = win_prob_by_regime.get(atr_state.regime, 0.52)
        entry_cost = 0.50  # Binary at ~$0.50 mid

        # Kelly for binary: (p - c) / (1 - c)
        kelly = max(0.0, (p - entry_cost) / (1 - entry_cost))
        kelly_size = kelly * self.fractional_kelly * capital * self.allocation

        # ATR regime modifier
        atr_mod = get_atr_size_modifier(atr_state.regime, {"atr": {"size_modifier": {
            "extreme_compression": 1.5, "moderate_compression": 1.2,
            "balanced": 1.0, "moderate_expansion": 0.8, "extreme_expansion": 0.5
        }}})
        final_size = kelly_size * atr_mod

        # Cap
        return min(final_size, max_position)

    # ─── Settlement / exit ────────────────────────────────────────────────────

    def settle_positions(self, symbol: str, current_price: float, current_time: float):
        """
        Close any open Alpha positions for a symbol at current price.
        In live mode, called at binary market settlement. In backtest, called each bar.
        """
        positions = self.store.get_open_positions("alpha")
        for pos in positions:
            if pos.symbol != symbol:
                continue
            pos_id = self._find_pos_id(pos)
            if pos_id:
                closed = self.store.close_position(pos_id, current_price, current_time)
                if closed:
                    outcome = "WIN" if closed.pnl > 0 else "LOSS"
                    logger.debug(
                        f"[ALPHA] SETTLE {symbol} @ {current_price:.4f} | "
                        f"PnL=${closed.pnl:.2f} | {outcome}"
                    )

    def _find_pos_id(self, pos: Position) -> Optional[str]:
        with self.store._lock:
            for pid, p in self.store.positions.items():
                if p is pos:
                    return pid
        return None
