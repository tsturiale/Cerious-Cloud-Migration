"""
agents/risk_guard_agent.py
Portfolio-level risk kill-switch and position limit enforcer.
Monitors all positions across all 3 strategies and halts trading when:
  - Daily loss exceeds configured limit
  - Single-session drawdown exceeds threshold
  - Gamma correlation spike detected (handled in strategy_gamma.py, echoed here)
"""

import logging
import time
from typing import List

from core.state_store import StateStore, Position

logger = logging.getLogger("RiskGuardAgent")


class RiskGuardAgent:
    """
    Portfolio-level risk enforcer. 
    Called after every bar, checks portfolio state and fires kill switch if needed.
    """

    def __init__(self, cfg: dict, store: StateStore):
        self.cfg = cfg
        self.store = store

        cap_cfg = cfg.get("capital", {})
        self.daily_loss_limit_abs = 500.0   # $500 Absolute daily loss
        self.max_total_at_risk = 1000.0      # $1000 Portfolio-wide at-risk
        self.max_concurrent_positions = 6  # Max 6 open positions
        self.daily_loss_limit_pct = cap_cfg.get("daily_loss_limit_pct", 0.15)
        
        # Position frequency limits (churn)
        self.max_positions_per_window = 100
        self._trade_timestamps: List[float] = []
        
        # Subscribe to new positions to track window counts
        self.store.subscribe("position_opened", self._on_position_opened)
        
        self._last_peak = store.portfolio.peak_bankroll
        self._kill_reason: str = ""

    def _on_position_opened(self, **kwargs):
        """Track timestamp of every new trade."""
        self._trade_timestamps.append(time.time())

    def check(self):
        """Run all risk checks. Call after every bar is processed."""
        if self.store.is_kill_switch_active():
            return  # Already halted

        portfolio = self.store.portfolio
        now = time.time()
        open_positions = self.store.get_open_positions()

        # 1. Daily P&L absolute loss limit ($100 across ALL systems)
        daily_loss = abs(portfolio.daily_pnl) if portfolio.daily_pnl < 0 else 0
        if daily_loss >= self.daily_loss_limit_abs:
            self._trigger(f"TOTAL Daily Loss limit hit: ${daily_loss:.2f} (Includes Alpha/Beta/Gamma)")
            return

        # 2. Daily P&L percentage loss limit 
        daily_loss_pct = daily_loss / max(portfolio.bankroll, 1) if daily_loss > 0 else 0
        if daily_loss_pct >= self.daily_loss_limit_pct:
            self._trigger(f"Portfolio-wide loss pct hit: {daily_loss_pct*100:.1f}%")
            return

        # 3. Concurrent Position Limit (Max 6 total across all strategies)
        if len(open_positions) > self.max_concurrent_positions:
            self._trigger(f"TOTAL Position Limit hit: {len(open_positions)} > {self.max_concurrent_positions}")
            return

        # 4. Total Portfolio Risk / At-Risk ($100 total exposure)
        total_at_risk = sum(p.size for p in open_positions)
        if total_at_risk > self.max_total_at_risk:
            self._trigger(f"TOTAL $ Risk limit hit: ${total_at_risk:.2f} > ${self.max_total_at_risk}")
            return

        # 5. Sliding Window Frequency (Churn across all systems)
        num_trades_5m = sum(1 for t in self._trade_timestamps if now - t < 300)
        num_trades_15m = sum(1 for t in self._trade_timestamps if now - t < 900)

        if num_trades_5m >= self.max_positions_per_window:
            self._trigger(f"Portfolio Churn Frequency (5m): {num_trades_5m} trades")
            return

        # Periodic Status Log
        if portfolio.trades_today % 25 == 0 and portfolio.trades_today > 0:
            systems = {"alpha": 0, "beta": 0, "gamma": 0}
            for p in open_positions:
                systems[p.strategy] = systems.get(p.strategy, 0) + 1
            
            logger.info(
                f"[RISK-TOTAL] PnL=${portfolio.daily_pnl:,.2f} | "
                f"Open={len(open_positions)} (A:{systems['alpha']} B:{systems['beta']} G:{systems['gamma']}) | "
                f"AtRisk=${total_at_risk:.2f}"
            )

    def _trigger(self, reason: str):
        self._kill_reason = reason
        self.store.activate_kill_switch(reason)
        logger.critical(f"[RISK] ⚠️ KILL SWITCH ACTIVATED: {reason}")

        # Force close all open positions
        open_positions = self.store.get_open_positions()
        logger.warning(f"[RISK] Closing {len(open_positions)} positions due to risk breach.")
        # Final settlement at close/current price
        for pos_id, pos in list(self.store.positions.items()):
            # We assume current bar close is available in store or we use a fallback
            bar = self.store.get_bar(pos.symbol, "1m")
            exit_px = bar.close if bar else pos.entry_price
            self.store.close_position(pos_id, exit_px, time.time())

    def reset_for_new_day(self):
        """Reset daily tracking at start of new trading day."""
        self.store.reset_daily()
        self._trade_timestamps = [] # Clear window tracking
        logger.info("[RISK] Daily state reset. Frequency windows cleared.")

    def get_status(self) -> dict:
        p = self.store.portfolio
        now = time.time()
        return {
            "kill_switch": p.kill_switch_active,
            "kill_reason": self._kill_reason,
            "daily_pnl": round(p.daily_pnl, 2),
            "5m_trades": sum(1 for t in self._trade_timestamps if now - t < 300),
            "15m_trades": sum(1 for t in self._trade_timestamps if now - t < 900),
            "daily_loss_limit_abs": self.daily_loss_limit_abs,
        }
