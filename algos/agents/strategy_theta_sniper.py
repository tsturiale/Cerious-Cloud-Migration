"""
agents/strategy_theta_sniper.py
FF SYSTEMATICA: LATE-STAGE THETA SNIPER EXECUTION AGENT (V18.0)

Integrated from standalone BinaryThetaSniperAgentV18.
- Blended Volatility: Uses local 1m EWMA and foundational 15m ATR.
- Minute 8-14 Timing Window: Optimal liquidity/theta capture curve.
- 60c Entry Guard: High-conviction trigger matched to audited win-rates.
- Iceberg Execution: Multi-layered Limit orders for stealth deployment.
"""

import numpy as np
import scipy.stats as stats
import logging
import uuid
import math
from typing import Any, Dict

from core.state_store import StateStore, BarState, Position
from agents.atr_engine import ATREngine

logger = logging.getLogger("StrategyThetaSniper")


class StrategyThetaSniper:
    def __init__(self, symbols: list, cfg: dict, store: StateStore, 
                 atr_engine: ATREngine, execution_agent: Any):
        self.symbols = symbols
        self.cfg = cfg
        self.store = store
        self.atr_engine = atr_engine
        self.execution_agent = execution_agent

        # Configuration
        tcfg = cfg.get("theta_sniper", {})
        self.enabled = tcfg.get("enabled", True)
        self.allocation = tcfg.get("allocation", 0.20)
        self.entry_cent = tcfg.get("trigger_cent_value", 0.60)
        
        timing = tcfg.get("timing_gate", {})
        self.scan_start = timing.get("scan_start_seconds", 480)
        self.scan_end = timing.get("scan_end_seconds", 840)
        
        self.iceberg_layers = tcfg.get("iceberg_layers", 5)

        # State tracking per symbol
        self._period_start_price: Dict[str, float] = {}
        self._current_period_start: Dict[str, int] = {}
        
        # We track historical ATRs to compute the MA400
        self._atr_history: Dict[str, list] = {sym: [] for sym in symbols}
        
        # To avoid firing multiple icebergs in the same cycle for the same symbol
        self._fired_this_cycle: Dict[str, bool] = {sym: False for sym in symbols}

    def on_bar(self, symbol: str, bar: BarState):
        """Called by scheduler on every new 1m bar."""
        if not self.enabled:
            return
        if self.store.is_kill_switch_active():
            return

        atr_state = self.store.get_atr(symbol)
        if atr_state.atr_15m == 0.0 or not self.atr_engine.is_warm(symbol):
            return

        # 1. Timing alignment (15m cycles base 0)
        # Using bar timestamp (Unix seconds). 15 mins = 900 seconds.
        cycle_start_time = int(bar.timestamp - (bar.timestamp % 900))
        elapsed_seconds = int(bar.timestamp % 900)

        # Reset state on new cycle
        if self._current_period_start.get(symbol) != cycle_start_time:
            self._current_period_start[symbol] = cycle_start_time
            self._period_start_price[symbol] = bar.open  # Approximation of period start
            self._fired_this_cycle[symbol] = False
            
            # Store ATR for MA400 tracking (approximate at the start of each 15m cycle)
            self._atr_history[symbol].append(atr_state.atr_15m)
            if len(self._atr_history[symbol]) > 400:
                self._atr_history[symbol].pop(0)

        # Removed the early return if already fired to allow continuous signal tracking
        # We need to run _run_15m_cycle to calculate p_yes for UI broadcast!
        # Need enough history for MA400
        # In a real environment, we'd preload 400 15m bars, but we can gracefully degrade to an MA of available history
        atr_history = self._atr_history[symbol]
        atr_ma = sum(atr_history) / len(atr_history) if atr_history else atr_state.atr_15m

        # Compute 1m EWMA using recent bar history
        recent_bars = self.store.get_bar_history(symbol, "1m", n=15)
        if len(recent_bars) < 2:
            return
            
        closes = [b.close for b in recent_bars]
        returns = np.diff(closes) / closes[:-1]
        ewma_1m = self._calculate_ewma_vol(returns)

        # Run Sniper Cycle
        status, p_yes = self._run_15m_cycle(
            symbol=symbol,
            period_start_price=self._period_start_price[symbol],
            current_price=bar.close,
            elapsed_seconds=elapsed_seconds,
            atr_15m=atr_state.atr_15m,
            atr_ma=atr_ma,
            ewma_1m=ewma_1m
        )
        
        # Log the status every cycle to provide visual proof the agent is scanning
        logger.info(f"[THETA-SNIPER] {symbol}: {status}")
        if "EXECUTED" in status:
            self._fired_this_cycle[symbol] = True

        # Broadcast signal to UI
        try:
            import requests
            zscore = (p_yes - 50.0) / 16.0
            zscore = max(-3.0, min(3.0, zscore))
            asset = symbol.split('/')[0] if '/' in symbol else symbol
            payload = {
                "asset": asset,
                "model": "theta_sniper",
                "direction": "UP" if zscore > 0 else "DOWN",
                "strength": float(abs(zscore)),
                "regime": "high" if atr_state.atr_15m > atr_ma else "low",
                "zscore": float(zscore),
            }
            requests.post("http://127.0.0.1:8000/api/signal", json=payload, timeout=1)
        except Exception:
            pass

    def _calculate_ewma_vol(self, returns, span=10):
        """Calculate EWMA standard deviation (volatility) of returns."""
        if len(returns) == 0:
            return 0.001
        alpha = 2 / (span + 1)
        ewma_var = returns[0]**2
        for r in returns[1:]:
            ewma_var = (1 - alpha) * ewma_var + alpha * (r**2)
        return math.sqrt(ewma_var)

    def _check_global_conditions(self, atr_15m, atr_ma_400):
        """
        GATE 1: Volatility Expansion Gate
        - Current 15m ATR must exceed the 400-period ATR Moving Average.
        - Ensures we only trade in regimes with sufficient edge.
        """
        return atr_15m > atr_ma_400

    def _calculate_blended_prob(self, current_price, strike, ewma_vol_1m, atr_15m, seconds_remaining):
        """
        GATE 2: The "v18 Blended" Theta CDF
        - Prices the option by blending local localized variance (1m) with foundational ATR (15m).
        """
        minutes_remaining = max(0.1, seconds_remaining / 60.0) 
        
        # Volatility remaining scales with square root of time
        vol_remaining_usd = (ewma_vol_1m * np.sqrt(minutes_remaining)) * strike
        
        # V18 ENHANCEMENT: Blended Volatility Calculation
        blended_vol = (vol_remaining_usd + atr_15m) / 2.0
        
        if blended_vol <= 0: return 50.0
        
        z_score = (current_price - strike) / (blended_vol + 0.0001)
        # Using normal distribution survival function/CDF approximations
        prob_yes = stats.norm.cdf(z_score) * 100.0
        return prob_yes

    def _execute_iceberg_limit_order(self, symbol, side, target_price_cents):
        """
        EXECUTION: Multi-Layer Stealth Limit Slices
        """
        # We need size. Use capital allocation.
        portfolio = self.store.portfolio
        capital = portfolio.bankroll
        # Max exposure per trade
        max_exposure = capital * self.allocation
        layer_size = max_exposure / self.iceberg_layers
        
        # The probability trigger is in c/100 scale (e.g. 0.60)
        limit_price = target_price_cents

        logger.info(f"[SNIPER V18] Dispatched {side} Snipe @ ${limit_price:.2f} | Total Risk: ${max_exposure:,.2f}")
        
        # Instead of placing real native Icebergs (which Polymarket API may not support natively),
        # we layer standard Limit Orders slightly scaled or grouped, or just push them as discrete chunks.
        # For simulation, we push them into the execution agent.
        for layer in range(1, self.iceberg_layers + 1):
            # In an iceberg, the price is generally identical, just hidden. 
            # We simulate breaking it up into chunked limit orders.
            self.execution_agent.place_limit_order(
                symbol=symbol,
                side=side,
                price=limit_price,
                size=layer_size,
                strategy="theta_sniper"
            )
            
        logger.info(f"[ICEBERG] Fully deployed {self.iceberg_layers} layers for {symbol}.")

    def _run_15m_cycle(self, symbol, period_start_price, current_price, elapsed_seconds, atr_15m, atr_ma, ewma_1m):
        """
        THE V18 THETA SNIPER CYCLE:
        1. Verify Vol expansion (ATR > MA400).
        2. Strictly monitor the 'Snipe Window'
        3. Trigger at exact threshold using Blended Volatility CDF.
        """
        # Condition 1: Expansion regime gate
        if not self._check_global_conditions(atr_15m, atr_ma):
            return "FILTERED: Underlying volatility regime too low (ATR <= MA).", 50.0
            
        # Condition 2: Timing Window Guardrails
        if elapsed_seconds < self.scan_start:
            return f"IDLE: {elapsed_seconds}s < {self.scan_start}s", 50.0
        
        if elapsed_seconds > self.scan_end:
            return f"TIME_EXPIRED: Passed {self.scan_end}s", 50.0
            
        # Condition 3: Audited Alpha-Theta Trigger
        seconds_remaining = 900 - elapsed_seconds 
        p_yes = self._calculate_blended_prob(current_price, period_start_price, ewma_1m, atr_15m, seconds_remaining)
        p_no = 100.0 - p_yes
        
        # Target threshold check (multiplying config entry by 100 since probability is 0-100 here)
        target_prob = self.entry_cent * 100.0 
        
        if p_yes >= target_prob:
            if not self._fired_this_cycle.get(symbol, False):
                self._execute_iceberg_limit_order(symbol, 'LONG', self.entry_cent)  # UP -> LONG
                return f"EXECUTED: Target Locked (LONG) Edge P_YES={p_yes:.1f}% >= target {target_prob}%", p_yes
            else:
                return f"TRACKING (POST-EXECUTION): Target Locked (LONG) P_YES={p_yes:.1f}%", p_yes
            
        elif p_no >= target_prob:
            if not self._fired_this_cycle.get(symbol, False):
                self._execute_iceberg_limit_order(symbol, 'SHORT', self.entry_cent) # DOWN -> SHORT
                return f"EXECUTED: Target Locked (SHORT) Edge P_NO={p_no:.1f}% >= target {target_prob}%", p_yes
            else:
                return f"TRACKING (POST-EXECUTION): Target Locked (SHORT) P_NO={p_no:.1f}%", p_yes
            
        return f"SCANNING... (Current Pricing: YES {p_yes:.1f}% | NO {p_no:.1f}%)", p_yes
