"""
agents/exit_agent.py
Handles advanced scale-out exit logic, trailing stops, and real-time P&L monitoring.
Operates on a 2-second heartbeat for high-precision management.
"""

import logging
import time
import threading
from typing import List, Dict, Optional
from core.state_store import StateStore, Position, ScaleOutTarget

logger = logging.getLogger("ExitAgent")

class ExitAgent:
    """
    Manages the lifecycle of an exit plan once a position is opened.
    Scale-out Plan:
      - 33% of position at +133% profit (Target 1)
      - 33% of position at +300% profit (Target 2)
      - 34% of position held for settlement.
    """

    def __init__(self, cfg: dict, store: StateStore, execution_agent):
        self.cfg = cfg
        self.store = store
        self.execution_agent = execution_agent
        self.heartbeat_interval = 2.0  # 2 seconds
        self._running = False
        self._thread = None

    def start(self):
        """Start the 2s heartbeat monitor in a background thread."""
        self._running = True
        self._thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
        self._thread.start()
        logger.info("ExitAgent heartbeat started (2s interval).")

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join()

    def _heartbeat_loop(self):
        while self._running:
            try:
                self.process_exits()
                self._log_realtime_stats()
            except Exception as e:
                logger.error(f"Error in ExitAgent heartbeat: {e}")
            time.sleep(self.heartbeat_interval)

    def register_exit_plan(self, pos_id: str, entry_price: float, side: str):
        """
        Calculates and applies the 133%/300% scale-out targets to a position.
        Called immediately after an entry fill.
        """
        with self.store._lock:
            pos = self.store.positions.get(pos_id)
            if not pos:
                return

            # Profit Calculation (Binary style: Price moves toward $1.00)
            # User defined profit targets: +20% and +50% for Polymarket
            # Price target = entry_price + (entry_price * profit_pct)
            # OR for binary return: (Exit / Entry - 1) = ProfitPct
            # Exit = Entry * (1 + ProfitPct)
            
            target1_price = entry_price * (1 + 0.20) if side == "LONG" else entry_price * (1 - 0.20)
            target2_price = entry_price * (1 + 0.50) if side == "LONG" else entry_price * (1 - 0.50)
            
            # Capping for Binary Markets ($1.00 max)
            if side == "LONG":
                target1_price = min(target1_price, 0.99)
                target2_price = min(target2_price, 0.999)
            else:
                target1_price = max(target1_price, 0.01)
                target2_price = max(target2_price, 0.001)

            pos.scale_outs = [
                ScaleOutTarget(target_price=target1_price, size_reduction=pos.size * 0.33),
                ScaleOutTarget(target_price=target2_price, size_reduction=pos.size * 0.33)
            ]
            
            logger.info(f"[EXIT] Registered scale-out plan for {pos_id}: T1={target1_price:.4f} (-33%), T2={target2_price:.4f} (-33%)")
            
            # Proactively place limit orders if in live/clob mode
            if hasattr(self.execution_agent, "live_mode") and self.execution_agent.live_mode:
                self._place_clob_limit_exits(pos, target1_price, target2_price)

    def process_exits(self):
        """
        Monitor all open positions for target hits or trailing stop adjustments.
        In paper/backtest, this acts as the 'fill' engine for exit limits.
        """
        # We use the latest known price from the store
        symbols = self.store.bars.keys()
        for symbol_key in list(symbols): # (symbol, tf)
            symbol, tf = symbol_key
            if tf != "1m": continue
            
            bar = self.store.get_bar(symbol, tf)
            if not bar: continue

            # Check positions for this symbol
            positions_to_check = []
            with self.store._lock:
                for pid, pos in self.store.positions.items():
                    if pos.symbol == symbol:
                        positions_to_check.append((pid, pos))

            for pid, pos in positions_to_check:
                # 1. Check Trailing Stops 
                self._update_trailing_stop(pid, pos, bar)
                
                # 2. Check Scale-outs
                self._check_scale_outs(pid, pos, bar)
                
                # 3. Check Stop Loss
                self._check_stop_loss(pid, pos, bar)

    def _update_trailing_stop(self, pid, pos, bar):
        if pos.trailing_stop_dist <= 0: return
        
        if pos.side == "LONG":
            new_ts = bar.close - pos.trailing_stop_dist
            if new_ts > pos.trailing_stop_price:
                pos.trailing_stop_price = new_ts
        else:
            new_ts = bar.close + pos.trailing_stop_dist
            if new_ts < pos.trailing_stop_price and pos.trailing_stop_price > 0:
                pos.trailing_stop_price = new_ts

    def _check_scale_outs(self, pid, pos, bar):
        for target in pos.scale_outs:
            if target.filled: continue
            
            hit = False
            if pos.side == "LONG" and bar.high >= target.target_price:
                hit = True
            elif pos.side == "SHORT" and bar.low <= target.target_price:
                hit = True
            
            if hit:
                reduction = target.size_reduction
                logger.info(f"[EXIT] Scale-out Hit {pid} @ {target.target_price:.4f} (Reduction: {reduction:.2f})")
                target.filled = True
                self.store.close_position(pid, target.target_price, bar.timestamp, size_reduction=reduction)

    def _check_stop_loss(self, pid, pos, bar):
        # trailing stop price is the active stop if set
        active_stop = pos.trailing_stop_price if pos.trailing_stop_price > 0 else pos.stop_loss
        if active_stop <= 0: return

        hit = False
        if pos.side == "LONG" and bar.low <= active_stop:
            hit = True
        elif pos.side == "SHORT" and bar.high >= active_stop:
            hit = True

        if hit:
            logger.info(f"[EXIT] Stop Hit {pid} @ {active_stop:.4f}")
            self.store.close_position(pid, active_stop, bar.timestamp)

    def _log_realtime_stats(self):
        """Log P&L snapshot every heartbeat."""
        snap = self.store.get_portfolio_snapshot()
        open_pos = self.store.get_open_positions_count()
        if open_pos > 0:
            logger.debug(f"[HEARTBEAT] Bankroll: ${snap['bankroll']:,.2f} | Open: {open_pos} | SessPnL: ${snap['session_pnl']:,.2f}")

    def _place_clob_limit_exits(self, pos: Position, t1: float, t2: float):
        """Stub for actual CLOB limit placement."""
        # This would call the Polymarket/Binance API to place Limit Sell orders
        pass
