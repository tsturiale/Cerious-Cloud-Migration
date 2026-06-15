"""
agents/execution_agent.py
Paper/backtest execution broker.
In paper/backtest mode: simulates fills at bar close prices with configurable slippage.
In live mode: routes to Polymarket CLOB API (stub — extend with polymarket_binary_engine.py).
"""

import logging
import time
import uuid
from typing import Any, Optional

from core.state_store import StateStore, Position

logger = logging.getLogger("ExecutionAgent")


class ExecutionAgent:
    """
    Handles order routing for all three strategies.
    - Paper/Backtest: immediate fill at close + slippage estimate
    - Live: Polymarket CLOB (connect polymarket_binary_engine.py)
    """

    def __init__(self, cfg: dict, store: StateStore, exit_agent: Any = None):
        self.cfg = cfg
        self.store = store
        self.exit_agent = exit_agent
        mode_cfg = cfg.get("mode", {})
        self.live_mode = mode_cfg.get("live_mode", False)
        self.backtest_mode = mode_cfg.get("backtest_mode", False)

        exec_cfg = cfg.get("execution", {})
        self.slippage_pct = 0.0005  # 0.05% slippage estimate
        self.fee_rate = 0.02        # 2% approximate Polymarket taker fee

        self._order_count = 0
        self._order_rate_limit = exec_cfg.get("order_rate_limit_per_min", 55)
        self._orders_this_minute: list = []

    def place_order(self, symbol: str, side: str, size: float,
                    entry_price: float, strategy: str,
                    stop_loss: float = 0.0, take_profit: float = 0.0,
                    trailing_stop_dist: float = 0.0,
                    scale_outs: list = None) -> Optional[str]:
        """
        Place an order with optional risk management plan.
        """
        if self.store.is_kill_switch_active():
            logger.warning(f"Kill switch active — rejecting {strategy} {side} {symbol}")
            return None

        # Rate limit check 
        now = time.time()
        self._orders_this_minute = [t for t in self._orders_this_minute if now - t < 60]
        if len(self._orders_this_minute) >= self._order_rate_limit:
            logger.warning("Order rate limit hit — skipping order")
            return None

        # Apply slippage
        fill_price = entry_price * (1 + self.slippage_pct) if side == "LONG" else entry_price * (1 - self.slippage_pct)

        # Net cost check
        net_cost = fill_price + (fill_price * self.fee_rate)
        if net_cost >= 1.0:
            logger.debug(f"Fee-adjusted cost exceeds payout — skipping {symbol}")
            return None

        pos_id = f"{strategy}_{symbol}_{uuid.uuid4().hex[:8]}"
        
        # Initialize trailing stop price if distance provided
        ts_price = 0.0
        if trailing_stop_dist > 0:
            ts_price = fill_price - trailing_stop_dist if side == "LONG" else fill_price + trailing_stop_dist

        pos = Position(
            symbol=symbol, strategy=strategy, side=side, size=size,
            entry_price=fill_price, entry_time=now,
            stop_loss=stop_loss, take_profit=take_profit,
            trailing_stop_dist=trailing_stop_dist,
            trailing_stop_price=ts_price,
            scale_outs=scale_outs or []
        )
        
        self.store.open_position(pos_id, pos)
        
        # Trigger exit plan registration immediately
        if self.exit_agent:
            self.exit_agent.register_exit_plan(pos_id, fill_price, side)

        self._orders_this_minute.append(now)
        self._order_count += 1

        logger.info(f"[EXEC] {strategy.upper()} {side} {symbol} @ {fill_price:.4f} [SL:{stop_loss} TP:{take_profit} TS:{trailing_stop_dist}]")
        return pos_id

    def place_limit_order(self, symbol: str, side: str, price: float, size: float,
                          strategy: str, stop_loss: float = 0.0, 
                          take_profit: float = 0.0, trailing_stop_dist: float = 0.0,
                          scale_outs: list = None):
        """Place a limit entry order."""
        from core.state_store import PendingOrder
        order = PendingOrder(
            symbol=symbol, strategy=strategy, side=side, order_type="LIMIT",
            price=price, size=size, stop_loss=stop_loss,
            take_profit=take_profit, trailing_stop_dist=trailing_stop_dist,
            scale_outs=scale_outs or []
        )
        with self.store._lock:
            self.store.pending_orders.append(order)
        logger.info(f"[EXEC] Placed LIMIT {side} {symbol} @ {price:.4f}")

    def close_order(self, pos_id: str, exit_price: float) -> Optional[Position]:
        """Close an open position at exit_price."""
        now = time.time()
        closed = self.store.close_position(pos_id, exit_price, now)
        if closed and self.live_mode:
            logger.info(f"[EXEC-LIVE] Closed {pos_id} @ {exit_price:.4f} PnL=${closed.pnl:.2f}")
        return closed

    def get_stats(self) -> dict:
        return {
            "total_orders": self._order_count,
            "open_positions": self.store.get_open_positions_count(),
        }
