"""
agents/strategy_gamma.py
Strategy Gamma: Multi-Timeframe ATR Arbitrage (2s coordinated execution)

Thesis: Structural 5m/15m ATR ratio extremes + stable correlation →
synthetic cross-timeframe positions that profit from ratio convergence.

Allocation: 30% of capital — market-neutral, highest capital efficiency.
"""

import numpy as np
import pandas as pd
import logging
import time
import uuid
from typing import Any, Optional, Dict, List, Tuple
from collections import deque

from core.state_store import StateStore, BarState, Position

logger = logging.getLogger("StrategyGamma")


class StrategyGamma:
    """
    Cross-timeframe ATR arbitrage.

    Structure:
      - ATR ratio < 0.25 (extreme low): 5m vol suppressed → long 5m direction, short 15m
      - ATR ratio > 1.00 (extreme high): 5m vol elevated → fade 5m direction
    
    Hedge ratio β calibrated from rolling correlation of 5m/15m returns.
    """

    def __init__(self, symbols: list, cfg: dict, store: StateStore, execution_agent: Any = None):
        self.symbols = symbols
        self.cfg = cfg
        self.store = store
        self.execution_agent = execution_agent

        gcfg = cfg.get("gamma", {})
        self.enabled = gcfg.get("enabled", True)
        self.allocation = gcfg.get("allocation", 0.30)
        self.ratio_extreme_low = gcfg.get("ratio_extreme_low", 0.25)
        self.ratio_extreme_high = gcfg.get("ratio_extreme_high", 1.00)
        self.min_correlation = gcfg.get("min_correlation", 0.40)
        self.max_corr_std_err = gcfg.get("max_correlation_std_err", 0.15)
        self.beta_default = gcfg.get("beta_hedge_ratio", 0.70)
        self.rebalance_minor = gcfg.get("rebalance_threshold_minor", 0.15)
        self.rebalance_major = gcfg.get("rebalance_threshold_major", 0.25)
        self.max_pos_dd = gcfg.get("max_drawdown_per_position", 0.02)
        self.max_strat_dd = gcfg.get("max_strategy_drawdown", 0.05)
        self.cooldown_hours = gcfg.get("cooldown_hours", 24)
        self.time_stop_cycles = gcfg.get("time_stop_cycles", 3)  # ×5m cycles

        self.max_exposure_5m = cfg.get("capital", {}).get("max_exposure_per_5m_market", 0.05)

        # Rolling return history for correlation (60 bars = ~1h at 1m)
        self._return_history: Dict[str, deque] = {sym: deque(maxlen=120) for sym in symbols}
        self._prev_close: Dict[str, Optional[float]] = {sym: None for sym in symbols}
        self._bar_count: Dict[str, int] = {sym: 0 for sym in symbols}

        # Track entry ATR ratios for rebalancing
        self._entry_ratios: Dict[str, float] = {}
        # Track entry times for time stop
        self._entry_times: Dict[str, float] = {}

    # ─── Main callback ────────────────────────────────────────────────────────

    def on_bar(self, symbol: str, bar: BarState):
        if not self.enabled:
            return
        if self.store.is_kill_switch_active():
            return

        # Check global Gamma suspension
        if time.time() < self.store.gamma_suspended_until:
            return

        self._bar_count[symbol] = self._bar_count.get(symbol, 0) + 1

        # Update rolling return
        if self._prev_close[symbol] is not None and self._prev_close[symbol] > 0:
            ret = (bar.close - self._prev_close[symbol]) / self._prev_close[symbol]
            self._return_history[symbol].append(ret)
        self._prev_close[symbol] = bar.close

        atr_state = self.store.get_atr(symbol)
        if atr_state.atr_5m == 0.0:
            return

        # Monitor existing positions
        self._monitor_positions(symbol, bar, atr_state)

        # Check for new entry
        self._check_entry(symbol, bar, atr_state)

    def _monitor_positions(self, symbol: str, bar: BarState, atr_state):
        """Monitor open Gamma positions for rebalancing, time stop, and correlation break."""
        positions = [p for p in self.store.get_open_positions("gamma") if p.symbol == symbol]
        for pos in positions:
            pos_id = self._find_pos_id(pos)
            if not pos_id:
                continue

            entry_ratio = self._entry_ratios.get(pos_id, atr_state.ratio)
            ratio_drift = abs(atr_state.ratio - entry_ratio)

            # Correlation check — only every 15 bars for speed
            if self._bar_count[symbol] % 15 == 0:
                corr = self._estimate_correlation(symbol)
                if corr is not None and abs(corr) > 0.9:
                    self.store.close_position(pos_id, bar.close, bar.timestamp)
                    logger.debug(f"[GAMMA] CORRELATION SPIKE close {symbol}: |p|={abs(corr):.3f}")
                    self._trigger_suspension()
                    continue
            else:
                corr = self.store.gamma_correlations.get(symbol, 0.5)

            # Time stop: 3 × 5-min cycles = 15 bars
            time_held = self._bar_count[symbol] - self._entry_times.get(pos_id, 0)
            if time_held > self.time_stop_cycles * 5:
                self.store.close_position(pos_id, bar.close, bar.timestamp)
                logger.info(f"[GAMMA] TIME STOP {symbol} after {time_held} bars")
                continue

            # Major rebalance threshold → 50% size reduction or close
            if ratio_drift > self.rebalance_major:
                self.store.close_position(pos_id, bar.close, bar.timestamp)
                logger.info(f"[GAMMA] MAJOR REBALANCE close {symbol}: ratio drift={ratio_drift:.3f}")
                continue

            # Max per-position drawdown check
            multiplier = 1 if pos.side == "LONG" else -1
            unrealized_pnl = multiplier * (bar.close - pos.entry_price) * pos.size
            capital = self.store.portfolio.bankroll
            if unrealized_pnl < -(capital * self.max_pos_dd):
                self.store.close_position(pos_id, bar.close, bar.timestamp)
                logger.info(f"[GAMMA] MAX DD close {symbol}")
                self._check_strategy_drawdown()

    def _check_entry(self, symbol: str, bar: BarState, atr_state):
        """Check ATR ratio extremes and correlation for new Gamma entry."""
        
        # Prevent spamming: only 1 open position per symbol concurrently
        if any(p.symbol == symbol for p in self.store.get_open_positions("gamma")):
            return
            
        ratio = atr_state.ratio

        # Only trade at extremes
        if self.ratio_extreme_low < ratio < self.ratio_extreme_high:
            return

        # Estimate correlation and hedge ratio — only every 15 bars
        if self._bar_count[symbol] % 15 == 0:
            corr = self._estimate_correlation(symbol)
            beta = self._estimate_beta(symbol) or self.beta_default
        else:
            corr = self.store.gamma_correlations.get(symbol, 0.5)
            beta = self.beta_default

        if corr is None or abs(corr) < self.min_correlation:
            return

        # Determine structure:
        # Ratio extreme LOW (< 0.25): 5m vol suppressed → expect expansion
        #   → take directional 5m position in trend direction
        # Ratio extreme HIGH (> 1.00): 5m vol elevated → expect contraction
        #   → fade the 5m direction
        if ratio <= self.ratio_extreme_low:
            # Follow higher-TF trend: look at HMM regime for bias
            regime_name = self.store.get_regime(symbol).hmm_regime_name.lower()
            if "bull" in regime_name or "accum" in regime_name:
                side = "LONG"
            elif "bear" in regime_name:
                side = "SHORT"
            else:
                return  # No clear HMM bias, skip
            structure = "long_vol"
        else:  # ratio >= self.ratio_extreme_high
            # Fade current direction: inverse of last close change
            bars = self.store.get_bar_history(symbol, "1m", n=3)
            if len(bars) < 2:
                return
            if bars[-1].close > bars[-2].close:
                side = "SHORT"  # Fade the up move
            else:
                side = "LONG"   # Fade the down move
            structure = "short_vol"

        size = self._compute_size(beta)
        if size <= 0:
            return

        pos_id = f"gamma_{symbol}_{uuid.uuid4().hex[:8]}"
        pos = Position(
            symbol=symbol,
            strategy="gamma",
            side=side,
            size=size,
            entry_price=bar.close,
            entry_time=bar.timestamp,
        )
        self.store.open_position(pos_id, pos)
        self._entry_ratios[pos_id] = ratio
        self._entry_times[pos_id] = self._bar_count[symbol]

        logger.info(
            f"[GAMMA] {side} {symbol} @ {bar.close:.4f} | "
            f"ratio={ratio:.3f} ({structure}) | β={beta:.2f} | size=${size:.2f} | "
            f"ρ={corr:.3f}"
        )

    # ─── Correlation / beta estimation ────────────────────────────────────────

    def _estimate_correlation(self, symbol: str) -> Optional[float]:
        """Rolling Pearson correlation of 5m vs 15m returns approximated from 1m history."""
        rets = list(self._return_history[symbol])
        if len(rets) < 30:
            return None

        # Aggregate: 5m returns from 5-bar sums, 15m from 15-bar sums
        arr = np.array(rets)
        n5 = (len(arr) // 5) * 5
        if n5 < 10:
            return None
        r5 = arr[:n5].reshape(-1, 5).sum(axis=1)
        n15 = (len(arr) // 15) * 15
        if n15 < 15:
            return None
        r15 = arr[:n15].reshape(-1, 15).sum(axis=1)

        # Align lengths
        min_len = min(len(r5), len(r15))
        if min_len < 3:
            return None
        corr = float(np.corrcoef(r5[-min_len:], r15[-min_len:])[0, 1])
        self.store.gamma_correlations[symbol] = corr
        return corr

    def _estimate_beta(self, symbol: str) -> Optional[float]:
        """OLS beta of 5m returns on 15m returns."""
        rets = list(self._return_history[symbol])
        if len(rets) < 30:
            return None
        arr = np.array(rets)
        n = (len(arr) // 15) * 15
        r15 = arr[:n].reshape(-1, 15).sum(axis=1)
        n5 = (len(arr) // 5) * 5
        r5 = arr[:n5].reshape(-1, 5).sum(axis=1)
        min_len = min(len(r5), len(r15))
        if min_len < 4:
            return None
        x = r15[-min_len:]
        y = r5[-min_len:]
        cov = np.cov(y, x)
        beta = cov[0, 1] / max(cov[1, 1], 1e-10)
        return float(np.clip(beta, 0.3, 1.5))

    def _compute_size(self, beta: float) -> float:
        """Position size based on allocation and capital limits."""
        capital = self.store.portfolio.bankroll
        max_size = capital * self.max_exposure_5m * self.allocation
        base = capital * self.allocation * 0.02  # 2% base per trade
        return min(base, max_size)

    # ─── Risk helpers ─────────────────────────────────────────────────────────

    def _trigger_suspension(self):
        self.store.gamma_suspended_until = time.time() + self.cooldown_hours * 3600
        logger.warning(f"[GAMMA] Suspended for {self.cooldown_hours}h due to correlation spike.")

    def _check_strategy_drawdown(self):
        strategy_pnl = self.store.strategy_pnl.get("gamma", 0.0)
        capital = self.store.portfolio.bankroll
        if strategy_pnl < -(capital * self.max_strat_dd):
            self._trigger_suspension()

    def settle_positions(self, symbol: str, current_price: float, current_time: float):
        """Settle all open Gamma positions at current price."""
        positions = [p for p in self.store.get_open_positions("gamma") if p.symbol == symbol]
        for pos in positions:
            pos_id = self._find_pos_id(pos)
            if pos_id:
                closed = self.store.close_position(pos_id, current_price, current_time)
                if closed:
                    outcome = "WIN" if closed.pnl > 0 else "LOSS"
                    logger.info(f"[GAMMA] SETTLE {symbol} PnL=${closed.pnl:.2f} | {outcome}")

    def _find_pos_id(self, pos: Position) -> Optional[str]:
        with self.store._lock:
            for pid, p in self.store.positions.items():
                if p is pos:
                    return pid
        return None
