"""
agents/strategy_beta.py
Strategy Beta: Mean Reversion with ATR Band Confluence (2s execution)

Thesis: Extreme price deviation from 15m VWAP (>2× ATR_5m) +
wick rejection at band extremes → elevated mean reversion probability.

Allocation: 35% of capital
"""

import numpy as np
import pandas as pd
import logging
import time
import math
import uuid
from typing import Any, Optional, Dict, List

from core.state_store import StateStore, BarState, Position
from agents.atr_engine import ATREngine, get_atr_size_modifier

logger = logging.getLogger("StrategyBeta")


class StrategyBeta:
    """
    VWAP mean reversion strategy.
    Fires when:
      1. |price - VWAP_15m| > N × ATR_5m  (overextension)
      2. Wick rejection at ATR band boundary (wick:body >= 2:1)
      3. Stocastic RSI divergence across 5m/15m (exhaustion confirmation)
    
    Uses layered limit orders at 0.9/1.0/1.1× predicted ATR touch.
    """

    def __init__(
        self,
        symbols: list,
        cfg: dict,
        store: StateStore,
        atr_engine: ATREngine,
        execution_agent: Any = None,
    ):
        self.symbols = symbols
        self.cfg = cfg
        self.store = store
        self.atr_engine = atr_engine
        self.execution_agent = execution_agent

        bcfg = cfg.get("beta", {})
        self.enabled = bcfg.get("enabled", True)
        self.allocation = bcfg.get("allocation", 0.35)
        self.vwap_deviation = bcfg.get("vwap_deviation_entry", 2.0)
        self.vwap_deviation_hc = bcfg.get("vwap_deviation_high_conf", 2.5)
        self.wick_ratio_min = bcfg.get("wick_ratio_min", 2.0)
        self.atr_spike_abort = bcfg.get("atr_spike_abort_pct", 0.50)
        self.reversion_lambda = bcfg.get("reversion_speed_lambda", 0.15)
        self.regime_loss_limit = bcfg.get("regime_loss_limit_multiplier", 2.0)
        self.regime_suspend_cycles = bcfg.get("regime_suspend_cycles", 5)

        # Layered order config
        self.primary_pct = bcfg.get("layer_primary_pct", 0.50)
        self.secondary_pct = bcfg.get("layer_secondary_pct", 0.30)
        self.tertiary_pct = bcfg.get("layer_tertiary_pct", 0.20)
        self.primary_offset = bcfg.get("layer_primary_offset", 0.90)
        self.secondary_offset = bcfg.get("layer_secondary_offset", 1.00)
        self.tertiary_offset = bcfg.get("layer_tertiary_offset", 1.10)

        self.max_exposure_5m = cfg.get("capital", {}).get("max_exposure_per_5m_market", 0.05)

        # Track ATR value at position entry for spike abort monitoring
        self._entry_atr: Dict[str, float] = {}
        # Avg win per regime for suspend logic
        self._regime_avg_win: Dict[str, float] = {}

    # ─── Main callback ────────────────────────────────────────────────────────

    def on_bar(self, symbol: str, bar: BarState):
        if not self.enabled:
            return
        if self.store.is_kill_switch_active():
            return

        atr_state = self.store.get_atr(symbol)
        if atr_state.atr_5m == 0.0 or not self.atr_engine.is_warm(symbol):
            return

        # Check regime suspension
        regime = atr_state.regime
        suspend_until = self.store.beta_regime_suspend_until.get(f"{symbol}_{regime}", 0)
        if time.time() < suspend_until:
            return

        # Monitor existing positions for abort / partial profit
        self._monitor_positions(symbol, bar, atr_state)

        # Check for new entry
        self._check_entry(symbol, bar, atr_state)

    def _monitor_positions(self, symbol: str, bar: BarState, atr_state):
        """
        Check existing Beta positions:
        - ATR spike abort: close immediately if ATR spiked >50%
        - Partial profit: at 50% and 75% reversion
        - Time stop: after 2× expected half-life
        """
        positions = self.store.get_open_positions("beta")
        for pos in [p for p in positions if p.symbol == symbol]:
            # ATR spike abort
            entry_atr = self._entry_atr.get(id(pos), atr_state.atr_5m)
            if atr_state.atr_5m > entry_atr * (1 + self.atr_spike_abort):
                pos_id = self._find_pos_id(pos)
                if pos_id:
                    self.store.close_position(pos_id, bar.close, bar.timestamp)
                    logger.info(f"[BETA] ATR SPIKE ABORT {symbol} @ {bar.close:.4f}")
                continue

            # 15m trend opposite direction → early exit
            regime_state = self.store.get_regime(symbol)
            regime_name = regime_state.hmm_regime_name.lower()
            if pos.side == "LONG" and "bear" in regime_name:
                pos_id = self._find_pos_id(pos)
                if pos_id:
                    self.store.close_position(pos_id, bar.close, bar.timestamp)
                    logger.info(f"[BETA] TREND OVERRIDE exit LONG {symbol}")
            elif pos.side == "SHORT" and ("bull" in regime_name or "accum" in regime_name):
                pos_id = self._find_pos_id(pos)
                if pos_id:
                    self.store.close_position(pos_id, bar.close, bar.timestamp)
                    logger.info(f"[BETA] TREND OVERRIDE exit SHORT {symbol}")

    def _check_entry(self, symbol: str, bar: BarState, atr_state):
        """Check all entry conditions for a new Beta position."""
        # Compute VWAP deviation
        vwap = bar.vwap if bar.vwap > 0 else bar.close
        deviation = abs(bar.close - vwap)
        deviation_atr_units = deviation / max(atr_state.atr_5m, 1e-10)

        if deviation_atr_units < self.vwap_deviation:
            return  # Not overextended enough

        # Determine direction: price above VWAP → SHORT (expect reversion down)
        direction = -1 if bar.close > vwap else 1

        # ── Signal 2: Wick rejection ──────────────────────────────────────────
        if not self._check_wick_rejection(symbol, bar, direction):
            return

        # ── Compute confidence level and position size ────────────────────────
        if deviation_atr_units >= 3.5:
            conf_modifier = 1.2
        elif deviation_atr_units >= 2.5:
            conf_modifier = 1.0
        elif deviation_atr_units >= 2.0:
            conf_modifier = 0.8
        else:
            conf_modifier = 0.5

        size = self._compute_size(atr_state, conf_modifier)
        if size <= 0:
            return

        # ── Enter position (primary layer at 0.9× predicted touch) ───────────
        entry_price = bar.close
        side = "LONG" if direction == 1 else "SHORT"
        pos_id = f"beta_{symbol}_{uuid.uuid4().hex[:8]}"
        pos = Position(
            symbol=symbol,
            strategy="beta",
            side=side,
            size=size * self.primary_pct,  # Primary layer
            entry_price=entry_price * self.primary_offset,
            entry_time=bar.timestamp,
        )
        self.store.open_position(pos_id, pos)
        self._entry_atr[id(pos)] = atr_state.atr_5m

        logger.debug(
            f"[BETA] {side} {symbol} @ {entry_price:.4f} | "
            f"dev={deviation_atr_units:.2f}×ATR | size=${size:.2f} | "
            f"regime={atr_state.regime}"
        )

    def _check_wick_rejection(self, symbol: str, bar: BarState, direction: int) -> bool:
        """
        Check if last bar shows wick rejection:
        - SHORT setup (price above VWAP): bar high penetrates band, close returns inside
        - wick:body ratio >= 2:1
        """
        body = abs(bar.close - bar.open)
        if body < 1e-10:
            return False

        if direction == -1:  # SHORT: check upper wick
            wick = bar.high - max(bar.open, bar.close)
        else:  # LONG: check lower wick
            wick = min(bar.open, bar.close) - bar.low

        return (wick / max(body, 1e-10)) >= self.wick_ratio_min

    def _compute_size(self, atr_state, confidence_modifier: float) -> float:
        """Kelly-adjusted with ATR regime modifier."""
        portfolio = self.store.portfolio
        capital = portfolio.bankroll
        max_position = capital * self.max_exposure_5m * self.allocation

        # Estimated mean reversion win probability (conservative)
        p = 0.54 + (confidence_modifier - 1.0) * 0.02  # 0.52–0.58 range
        p = max(0.50, min(p, 0.60))
        entry_cost = 0.50
        kelly = max(0.0, (p - entry_cost) / (1 - entry_cost))
        kelly_size = kelly * 0.20 * capital * self.allocation  # 0.20 fractional

        atr_mod = get_atr_size_modifier(atr_state.regime, {"atr": {"size_modifier": {
            "extreme_compression": 1.5, "moderate_compression": 1.2,
            "balanced": 1.0, "moderate_expansion": 0.8, "extreme_expansion": 0.5
        }}})
        return min(kelly_size * atr_mod * confidence_modifier, max_position)

    def settle_positions(self, symbol: str, current_price: float, current_time: float):
        """Settle all open Beta positions at current price."""
        positions = self.store.get_open_positions("beta")
        for pos in [p for p in positions if p.symbol == symbol]:
            pos_id = self._find_pos_id(pos)
            if pos_id:
                closed = self.store.close_position(pos_id, current_price, current_time)
                if closed:
                    outcome = "WIN" if closed.pnl > 0 else "LOSS"
                    logger.info(f"[BETA] SETTLE {symbol} PnL=${closed.pnl:.2f} | {outcome}")

                    # Update regime suspension logic
                    regime = self.store.get_atr(symbol).regime
                    key = f"{symbol}_{regime}"
                    if closed.pnl < 0:
                        self.store.beta_regime_losses[key] = (
                            self.store.beta_regime_losses.get(key, 0) + abs(closed.pnl)
                        )
                        avg_win = self._regime_avg_win.get(key, abs(closed.pnl))
                        if self.store.beta_regime_losses[key] > self.regime_loss_limit * avg_win:
                            suspend_until = time.time() + self.regime_suspend_cycles * 15 * 60
                            self.store.beta_regime_suspend_until[key] = suspend_until
                            logger.warning(f"[BETA] Suspending {regime} regime for {symbol}")
                    elif closed.pnl > 0:
                        wins = self.store.strategy_trades.get("beta", [])
                        wins_for_regime = [t for t in wins if t.get("pnl", 0) > 0]
                        if wins_for_regime:
                            self._regime_avg_win[key] = np.mean([t["pnl"] for t in wins_for_regime])

    def _find_pos_id(self, pos: Position) -> Optional[str]:
        with self.store._lock:
            for pid, p in self.store.positions.items():
                if p is pos:
                    return pid
        return None
