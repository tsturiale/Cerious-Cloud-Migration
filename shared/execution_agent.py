"""
shared/execution_agent.py — Model-driven Execution Agent for QuantSwarmTerminal.

Manages the full lifecycle of a signal-driven trade on Polymarket:
  1. Entry  — limit or market order via PolymarketClient
  2. SL/TP  — offsetting orders placed immediately after entry fill
  3. Monitor — heartbeat checks stop loss, take profit, trailing stop, expiry
  4. Close   — records to journal, broadcasts state, notifies callbacks

Design principles:
  - Fully async, thread-safe (asyncio.Lock per position)
  - No look-ahead: all price checks use current market data, not future bars
  - SL and TP are OFFSETING orders on the opposite side of the position
  - Positions are in-memory only (survive WS disconnect via the backend's _positions dict)
  - Journal entries written on every close with full reason tagging

Usage:
    agent = ExecutionAgent(
        client=polymarket_client,
        journal=journal,
        broadcast_fn=broadcast_fn,   # callable(msg: dict) — pushes WS update
        dry_run=True,
    )
    await agent.start()

    # On signal from best_signal():
    pos = await agent.place_entry(
        signal=signal,
        market_id="...",
        order_type="LIMIT",
        size_usd=100.0,
        exit_config=ExitConfig(stop_loss_pct=0.10, take_profit_pct=0.20),
    )
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timezone, timedelta
from typing import Callable, Optional

from shared.polymarket_client import PolymarketClient
from shared.journal import Journal, build_trade
from shared.types import (
    ActivePosition,
    Direction,
    ExitConfig,
    ModelName,
    Order,
    PositionStatus,
    Regime,
    Signal,
)

logger = logging.getLogger(__name__)


# Default exit config used when none is provided
DEFAULT_EXIT_CONFIG = ExitConfig(
    stop_loss_pct=0.10,
    take_profit_pct=0.20,
    trailing_stop_pct=0.0,
    trailing_step_pct=0.0,
    entry_timeout_secs=300,
)


# -----------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------

def _offset_side(direction: Direction) -> Direction:
    """The side that closes an open position."""
    return Direction.DOWN if direction == Direction.UP else Direction.UP


def _sl_price(pos: ActivePosition) -> float:
    """Stop-loss trigger price (probability)."""
    if pos.direction == Direction.UP:
        return pos.entry_price * (1.0 - pos.stop_loss_pct)
    else:
        return pos.entry_price * (1.0 + pos.stop_loss_pct)


def _tp_price(pos: ActivePosition) -> float:
    """Take-profit trigger price (probability)."""
    if pos.direction == Direction.UP:
        return pos.entry_price * (1.0 + pos.take_profit_pct)
    else:
        return pos.entry_price * (1.0 - pos.take_profit_pct)


def _next_trailing_price(pos: ActivePosition, current: float) -> Optional[float]:
    """Compute new trailing stop price given current market price. Returns None if no update."""
    if pos.trailing_stop_pct <= 0:
        return None

    ts = pos.trailing_stop_price
    if pos.direction == Direction.UP:
        # For long UP: trailing SL rises with price; trigger if price falls back to trailing level
        new_ts = current * (1.0 - pos.trailing_stop_pct)
        if ts is None or new_ts > ts:
            # Check step threshold
            if ts is None or (new_ts - ts) / ts >= pos.trailing_step_pct:
                return new_ts
        return ts
    else:
        # For short DOWN: trailing SL falls with price; trigger if price rises back to trailing level
        new_ts = current * (1.0 + pos.trailing_stop_pct)
        if ts is None or new_ts < ts:
            if ts is None or (ts - new_ts) / ts >= pos.trailing_step_pct:
                return new_ts
        return ts


def _build_trade_from_position(
    pos: ActivePosition,
    exit_price: float,
    exit_time: datetime,
    reason: str,
    fee_rate: float,
    slippage_bps: float,
) -> dict:
    """Convert an ActivePosition + close info into a journal-ready dict."""
    direction = pos.direction
    entry = pos.entry_price
    size = pos.size

    # Raw P&L for binary: size * (exit_price - entry_price) for UP direction
    if direction == Direction.UP:
        raw_pnl = size * (exit_price - entry)
        fees = size * fee_rate
    else:
        raw_pnl = size * (entry - exit_price)
        fees = size * fee_rate

    slippage_cost = size * slippage_bps / 10_000
    net_pnl = raw_pnl - fees - slippage_cost

    return {
        "trade_id": pos.position_id,
        "asset": pos.asset,
        "direction": direction.value,
        "model": pos.model.value if pos.model else None,
        "regime": pos.regime.value if isinstance(pos.regime, Regime) else pos.regime,
        "entry_time": pos.entry_time.isoformat(),
        "exit_time": exit_time.isoformat(),
        "entry_price": entry,
        "exit_price": exit_price,
        "size": size,
        "raw_pnl": raw_pnl,
        "fees": fees,
        "slippage": slippage_cost,
        "net_pnl": net_pnl,
        "win": net_pnl > 0,
        "signal_strength": pos.signal_strength,
        "close_reason": reason,
        "is_copy": False,
    }


# -----------------------------------------------------------------------
# ExecutionAgent
# -----------------------------------------------------------------------

class ExecutionAgent:
    """
    Full lifecycle execution for model-driven Polymarket trades.

    Args:
        client:             PolymarketClient (REST + order placement)
        journal:            Journal for recording closed trades
        broadcast_fn:       callable(dict) — called with event dict on every state change
        fee_rate:           Polymarket fee (default 0.02)
        slippage_bps:       Assumption for slippage cost on close (default 3.0 bps)
        monitor_interval:   Seconds between heartbeat checks (default 5)
        dry_run:            If True, place stub orders and skip API calls
    """

    def __init__(
        self,
        client: PolymarketClient,
        journal: Journal,
        broadcast_fn: Callable[[dict], None],
        fee_rate: float = 0.02,
        slippage_bps: float = 3.0,
        monitor_interval: int = 5,
        dry_run: bool = False,
    ) -> None:
        self._client = client
        self._journal = journal
        self._broadcast = broadcast_fn
        self._fee_rate = fee_rate
        self._slippage_bps = slippage_bps
        self._monitor_interval = monitor_interval
        self._dry_run = dry_run

        # position_id → ActivePosition
        self._positions: dict[str, ActivePosition] = {}
        self._lock = asyncio.Lock()

        # Limit-entry timeouts: position_id → asyncio.Task
        self._timeout_tasks: dict[str, asyncio.Task] = {}

        self._running = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Start the monitor loop. Call once after construction."""
        self._running = True
        asyncio.create_task(self._monitor_loop())
        logger.info("ExecutionAgent started (monitor_interval=%ds, dry_run=%s)",
                    self._monitor_interval, self._dry_run)

    async def stop(self) -> None:
        """Stop the monitor loop and cancel all pending entry timeouts."""
        self._running = False
        for task in self._timeout_tasks.values():
            task.cancel()
        self._timeout_tasks.clear()
        logger.info("ExecutionAgent stopped")

    # ------------------------------------------------------------------
    # Entry point
    # ------------------------------------------------------------------

    async def place_entry(
        self,
        signal: Signal,
        market_id: str,
        order_type: str = "LIMIT",   # "LIMIT" | "MARKET"
        size_usd: float = 100.0,
        exit_config: Optional[ExitConfig] = None,
    ) -> Optional[ActivePosition]:
        """
        Place an entry order (limit or market) for the given signal.

        After fill:
          - Places offsetting SL and TP orders immediately
          - Starts the heartbeat monitor
          - Broadcasts position open to UI

        Returns None if order could not be placed (slippage guard, dry-run, etc.)
        """
        if exit_config is None:
            exit_config = DEFAULT_EXIT_CONFIG

        pos_id = str(uuid.uuid4())
        now = datetime.now(tz=timezone.utc)

        # Expiry: 15-minute binary market from now
        expiry = now + timedelta(minutes=15)

        # Fetch current Polymarket contract price from the matching engine (0.01 - 0.99)
        try:
            book = await self._client.get_order_book(market_id)
            if signal.direction == Direction.UP:
                entry_price = book.best_ask or book.mid or 0.50
            else:
                entry_price = book.best_bid or book.mid or 0.50
        except Exception as e:
            logger.warning("Failed to fetch order book for market_id %s: %s, using fallback 0.50", market_id, e)
            entry_price = 0.50

        pos = ActivePosition(
            position_id=pos_id,
            market_id=market_id,
            asset=signal.asset,
            direction=signal.direction,
            entry_price=entry_price,
            size=size_usd,
            entry_time=now,
            expiry=expiry,
            signal_timestamp=signal.timestamp,
            stop_loss_pct=exit_config.stop_loss_pct,
            take_profit_pct=exit_config.take_profit_pct,
            trailing_stop_pct=exit_config.trailing_stop_pct,
            trailing_step_pct=exit_config.trailing_step_pct,
            entry_timeout_secs=exit_config.entry_timeout_secs,
            model=signal.model,
            regime=signal.regime,
            signal_strength=signal.strength,
            status=PositionStatus.PENDING,
        )

        # Place entry order
        order = await self._place_order(
            market_id=market_id,
            direction=signal.direction,
            size_usd=size_usd,
            limit_price=entry_price,
            order_type=order_type,
        )

        if order is None:
            logger.warning("Entry order not filled — %s %s %s @ %.4f",
                          order_type, signal.asset, signal.direction.value, entry_price)
            return None

        pos.entry_order_id = order.order_id if order.order_id else None

        # For MARKET orders, the order fills synchronously or very fast — treat as OPEN immediately
        if order_type.upper() == "MARKET" or order.status.value == "filled":
            pos.status = PositionStatus.OPEN
            await self._place_sl_tp_orders(pos)
        else:
            # LIMIT order — start the timeout watcher
            task = asyncio.create_task(self._wait_entry_timeout(pos))
            self._timeout_tasks[pos_id] = task

        async with self._lock:
            self._positions[pos_id] = pos

        self._broadcast_position(pos, event="position_open")
        logger.info(
            "Entry placed: %s | %s %s | size=%.2f | price=%.4f | SL=%.4f | TP=%.4f",
            pos_id[:8], signal.asset, signal.direction.value, size_usd,
            entry_price, _sl_price(pos), _tp_price(pos),
        )
        return pos

    async def place_entry_log_grid(
        self,
        signal: Signal,
        market_id: str,
        entry_price: float,
        size_usd: float,
    ) -> Optional[ActivePosition]:
        """
        Place a log-grid limit entry order for the given price bucket (Noesis v3).
        """
        pos_id = str(uuid.uuid4())
        now = datetime.now(tz=timezone.utc)
        
        # Expiry is at the next 15-minute boundary
        tm = now.minute % 15
        expiry = now + timedelta(minutes=15 - tm) - timedelta(seconds=now.second, microseconds=now.microsecond)
        
        pos = ActivePosition(
            position_id=pos_id,
            market_id=market_id,
            asset=signal.asset,
            direction=signal.direction,
            entry_price=entry_price,
            size=size_usd,
            entry_time=now,
            expiry=expiry,
            signal_timestamp=signal.timestamp,
            stop_loss_pct=0.0,
            take_profit_pct=0.0,
            trailing_stop_pct=0.0,
            trailing_step_pct=0.0,
            entry_timeout_secs=900,
            model=signal.model,
            regime=signal.regime,
            signal_strength=signal.strength,
            status=PositionStatus.PENDING,
        )
        
        # Place entry order
        order = await self._place_order(
            market_id=market_id,
            direction=signal.direction,
            size_usd=size_usd,
            limit_price=entry_price,
            order_type="LIMIT",
        )
        
        if order is None:
            logger.warning("Log-grid limit entry order not placed: %s @ %.4f", signal.asset, entry_price)
            return None
            
        pos.entry_order_id = order.order_id if order.order_id else None
        
        if order.status.value == "filled":
            pos.status = PositionStatus.OPEN
            await self._place_sl_tp_orders(pos)
            
        async with self._lock:
            self._positions[pos_id] = pos
            
        self._broadcast_position(pos, event="position_open")
        logger.info(
            "Log-grid entry placed: %s | %s %s | size=%.2f | price=%.4f",
            pos_id[:8], signal.asset, signal.direction.value, size_usd, entry_price
        )
        return pos

    # ------------------------------------------------------------------
    # Entry order helpers
    # ------------------------------------------------------------------

    async def _place_order(
        self,
        market_id: str,
        direction: Direction,
        size_usd: float,
        limit_price: float,
        order_type: str = "LIMIT",
    ) -> Optional[Order]:
        if self._dry_run:
            logger.info("[DRY RUN] PLACE %s %s size=%.2f price=%.4f",
                        direction.value, market_id, size_usd, limit_price)
            return Order(
                order_id=f"dry-{uuid.uuid4().hex[:8]}",
                market_id=market_id,
                asset="",
                direction=direction,
                size=size_usd,
                limit_price=limit_price,
                status=__import__("shared.types", fromlist=["OrderStatus"]).OrderStatus.FILLED,
                created_at=datetime.now(tz=timezone.utc),
                fill_price=limit_price,
            )

        return await self._client.place_order(
            market_id=market_id,
            direction=direction,
            size_usd=size_usd,
            limit_price=limit_price,
        )

    async def _wait_entry_timeout(self, pos: ActivePosition) -> None:
        """Cancel the entry order if it doesn't fill within the timeout."""
        try:
            await asyncio.sleep(pos.entry_timeout_secs)
        except asyncio.CancelledError:
            return

        async with self._lock:
            current = self._positions.get(pos.position_id)
            if current is None or current.status != PositionStatus.PENDING:
                return

        # Entry still pending — cancel it
        logger.info("Entry timeout: cancelling pending entry for %s", pos.position_id[:8])
        if pos.entry_order_id and not self._dry_run:
            await self._client.cancel_order(pos.entry_order_id)

        await self._close_position(pos, exit_price=pos.entry_price,
                                    reason="timeout", close_reason="entry_timeout")

    async def _place_sl_tp_orders(self, pos: ActivePosition) -> None:
        """
        Place offsetting orders for SL and TP as GTC limit orders.
        These sit in the book — we monitor their fills in _monitor_loop.
        """
        if pos.model in {ModelName.V18, ModelName.V20_HYBRID}:
            # Exits are handled dynamically in _check_position, so no limit sell orders are placed GTC.
            return

        if pos.model == ModelName.NOESIS_V3:
            # Place Noesis V3 custom Target 1 (+250%) and Target 2 (+500%) limit sell orders
            opp = _offset_side(pos.direction)
            pb = pos.entry_price
            
            # total contracts N = size / pb
            if pb > 0:
                N = pos.size / pb
                
                scale1_pct = 0.40
                scale1_mult = 3.5 # (+250%)
                scale2_pct = 0.30
                scale2_mult = 6.0 # (+500%)
                
                q_t1 = scale1_pct * N
                p_t1 = min(1.00, scale1_mult * pb)
                size_t1 = q_t1 * p_t1
                
                q_t2 = scale2_pct * N
                p_t2 = min(1.00, scale2_mult * pb)
                size_t2 = q_t2 * p_t2
                
                t1_order = await self._place_order(
                    market_id=pos.market_id,
                    direction=opp,
                    size_usd=size_t1,
                    limit_price=p_t1,
                )
                if t1_order:
                    pos.sl_order_id = t1_order.order_id if t1_order.order_id else None
                    logger.info("Noesis V3 Target 1 order placed: %s @ %.4f for %.2f contracts", 
                                pos.position_id[:8], p_t1, q_t1)
                                
                t2_order = await self._place_order(
                    market_id=pos.market_id,
                    direction=opp,
                    size_usd=size_t2,
                    limit_price=p_t2,
                )
                if t2_order:
                    pos.tp_order_id = t2_order.order_id if t2_order.order_id else None
                    logger.info("Noesis V3 Target 2 order placed: %s @ %.4f for %.2f contracts", 
                                pos.position_id[:8], p_t2, q_t2)
            return

        opp = _offset_side(pos.direction)
        sl_price = _sl_price(pos)
        tp_price = _tp_price(pos)

        # Place SL order
        sl_order = await self._place_order(
            market_id=pos.market_id,
            direction=opp,
            size_usd=pos.size,
            limit_price=sl_price,
        )
        if sl_order:
            pos.sl_order_id = sl_order.order_id if sl_order.order_id else None
            logger.info("SL order placed: %s @ %.4f", pos.position_id[:8], sl_price)

        # Place TP order
        tp_order = await self._place_order(
            market_id=pos.market_id,
            direction=opp,
            size_usd=pos.size,
            limit_price=tp_price,
        )
        if tp_order:
            pos.tp_order_id = tp_order.order_id if tp_order.order_id else None
            logger.info("TP order placed: %s @ %.4f", pos.position_id[:8], tp_price)

        # If we got fills immediately (rare but possible), process them
        if sl_order and sl_order.status.value == "filled":
            await self._close_position(pos, exit_price=sl_order.fill_price or sl_price,
                                       reason="sl_filled", close_reason="stop_loss")
            return
        if tp_order and tp_order.status.value == "filled":
            await self._close_position(pos, exit_price=tp_order.fill_price or tp_price,
                                       reason="tp_filled", close_reason="take_profit")

    # ------------------------------------------------------------------
    # Monitor loop
    # ------------------------------------------------------------------

    async def _monitor_loop(self) -> None:
        """Heartbeat: checks SL/TP/trailing/expiry conditions every N seconds."""
        logger.info("ExecutionAgent monitor loop started")
        while self._running:
            try:
                await asyncio.sleep(self._monitor_interval)
                await self._check_all_positions()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("Monitor loop error: %s", exc, exc_info=True)

    async def _check_all_positions(self) -> None:
        now = datetime.now(tz=timezone.utc)

        async with self._lock:
            positions = [p for p in self._positions.values() if p.status == PositionStatus.OPEN]

        for pos in positions:
            try:
                await self._check_position(pos, now)
            except Exception as exc:
                logger.error("Error checking position %s: %s", pos.position_id[:8], exc)

    async def _check_position(self, pos: ActivePosition, now: datetime) -> None:
        """Evaluate exit conditions for a single open position."""
        # Get current market price
        book = await self._client.get_order_book(pos.market_id)
        current = book.mid if book else None
        if current is None:
            return

        if pos.model in {ModelName.V18, ModelName.V20_HYBRID}:
            tm = now.minute % 15
            if 9 <= tm <= 13:
                if current <= 0.50:
                    logger.info("Noesis Theta Stop Loss: %s at minute %d (price=%f)", pos.position_id[:8], tm, current)
                    await self._close_position(pos, exit_price=0.50,
                                               reason="stop_loss", close_reason="stop_loss")
                    return
            elif tm >= 14:
                logger.info("Noesis Theta Expiry close: %s", pos.position_id[:8])
                await self._close_position(pos, exit_price=current,
                                           reason="expiry", close_reason="expiry")
                return
            return

        if pos.model == ModelName.NOESIS_V3:
            # Exits are managed strictly by target limit orders or contract settlement at expiry
            if now >= pos.expiry:
                logger.info("Noesis V3 Expiry close: %s", pos.position_id[:8])
                await self._close_position(pos, exit_price=current,
                                           reason="expiry", close_reason="expiry")
            return

        direction = pos.direction
        entry = pos.entry_price

        # --- Compute SL / TP trigger thresholds ---
        if direction == Direction.UP:
            sl_triggered = current <= entry * (1.0 - pos.stop_loss_pct)
            tp_triggered = current >= entry * (1.0 + pos.take_profit_pct)
        else:
            sl_triggered = current >= entry * (1.0 + pos.stop_loss_pct)
            tp_triggered = current <= entry * (1.0 - pos.take_profit_pct)

        # --- Trailing stop update ---
        new_ts = _next_trailing_price(pos, current)
        ts_triggered = False
        if new_ts is not None and pos.trailing_stop_price is not None:
            # Check if price has pulled back to / through the trailing level
            if direction == Direction.UP:
                ts_triggered = current <= pos.trailing_stop_price
            else:
                ts_triggered = current >= pos.trailing_stop_price
            # Update trailing stop level FIRST before checking trigger
            async with self._lock:
                p = self._positions.get(pos.position_id)
                if p:
                    p.trailing_stop_price = new_ts
            self._broadcast_position(pos, event="trailing_stop_update")

        if ts_triggered:
            logger.info("Trailing stop hit: %s | current=%.4f < ts=%.4f",
                        pos.position_id[:8], current, pos.trailing_stop_price)
            await self._close_position(pos, exit_price=current,
                                       reason="trailing_stop", close_reason="trailing_stop")
            return

        # --- Primary SL / TP ---
        if sl_triggered:
            logger.info("Stop loss hit: %s | current=%.4f vs SL=%.4f",
                        pos.position_id[:8], current, _sl_price(pos))
            await self._close_position(pos, exit_price=current,
                                       reason="stop_loss", close_reason="stop_loss")
            return

        if tp_triggered:
            logger.info("Take profit hit: %s | current=%.4f vs TP=%.4f",
                        pos.position_id[:8], current, _tp_price(pos))
            await self._close_position(pos, exit_price=current,
                                       reason="take_profit", close_reason="take_profit")
            return

        # --- Expiry check ---
        if now >= pos.expiry:
            logger.info("Expiry close: %s", pos.position_id[:8])
            await self._close_position(pos, exit_price=current,
                                       reason="expiry", close_reason="expiry")

    # ------------------------------------------------------------------
    # Close helpers
    # ------------------------------------------------------------------

    async def _close_position(
        self,
        pos: ActivePosition,
        exit_price: float,
        reason: str,
        close_reason: str,
    ) -> None:
        """
        Internal close — cancels SL/TP orders, records journal, broadcasts.
        Idempotent: double-close is a no-op.
        """
        # Cancel any remaining SL/TP orders
        for oid in [pos.sl_order_id, pos.tp_order_id]:
            if oid and not self._dry_run:
                asyncio.create_task(self._client.cancel_order(oid))

        now = datetime.now(tz=timezone.utc)

        # Map close_reason string → PositionStatus
        _reason_map = {
            "stop_loss":      PositionStatus.STOPPED_OUT,
            "take_profit":    PositionStatus.TAKEN_PROFIT,
            "trailing_stop":  PositionStatus.STOPPED_OUT,
            "sl_filled":      PositionStatus.STOPPED_OUT,
            "tp_filled":      PositionStatus.TAKEN_PROFIT,
            "expiry":         PositionStatus.EXPIRED,
            "timeout":        PositionStatus.CANCELLED,
            "entry_timeout":  PositionStatus.CANCELLED,
            "manual":         PositionStatus.EXPIRED,
            "emergency":      PositionStatus.EMERGENCY,
        }
        new_status = _reason_map.get(close_reason, PositionStatus.EXPIRED)

        # Mark closed BEFORE async journal write (prevents race double-close)
        async with self._lock:
            if pos.status in (PositionStatus.STOPPED_OUT, PositionStatus.TAKEN_PROFIT,
                              PositionStatus.EXPIRED, PositionStatus.CANCELLED,
                              PositionStatus.EMERGENCY):
                return  # already closed
            pos.status = new_status
            pos.exit_price = exit_price
            pos.exit_time = now
            pos.close_reason = close_reason

        # Build and record trade
        trade_dict = _build_trade_from_position(
            pos=pos,
            exit_price=exit_price,
            exit_time=now,
            reason=close_reason,
            fee_rate=self._fee_rate,
            slippage_bps=self._slippage_bps,
        )
        try:
            trade = build_trade(**{
                k: v for k, v in trade_dict.items()
                if k in build_trade.__code__.co_varnames
            })
            await self._journal.record(trade)
        except Exception as exc:
            logger.error("Failed to record trade for %s: %s", pos.position_id[:8], exc)

        self._broadcast_position(pos, event="position_closed")
        logger.info(
            "Position closed: %s | reason=%s | entry=%.4f exit=%.4f | net_pnl=%.2f",
            pos.position_id[:8], close_reason, pos.entry_price, exit_price,
            trade_dict["net_pnl"],
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def close_position(
        self,
        position_id: str,
        reason: str = "manual",
    ) -> bool:
        """
        Manually close a position by id.
        Returns True if the position was found and closed.
        """
        async with self._lock:
            pos = self._positions.get(position_id)
        if pos is None:
            return False
        await self._close_position(pos, exit_price=0.0, reason=reason,
                                   close_reason="manual")
        return True

    async def emergency_close_all(self) -> int:
        """
        Force-close all open positions at current market price.
        Returns the number of positions closed.
        """
        async with self._lock:
            positions = [p for p in self._positions.values()
                         if p.status == PositionStatus.OPEN]

        count = 0
        for pos in positions:
            try:
                book = await self._client.get_order_book(pos.market_id)
                price = book.mid or pos.entry_price
            except Exception:
                price = pos.entry_price
            await self._close_position(pos, exit_price=price,
                                       reason="emergency", close_reason="emergency")
            count += 1
        logger.warning("Emergency close: %d positions closed", count)
        return count

    @property
    def open_positions(self) -> list[ActivePosition]:
        return [
            p for p in self._positions.values()
            if p.status in (PositionStatus.PENDING, PositionStatus.OPEN)
        ]

    @property
    def all_positions(self) -> list[ActivePosition]:
        return list(self._positions.values())

    def get_position(self, position_id: str) -> Optional[ActivePosition]:
        return self._positions.get(position_id)

    def _broadcast_position(self, pos: ActivePosition, event: str) -> None:
        """Serialize ActivePosition to a dict and broadcast to all WS clients."""
        try:
            self._broadcast({
                "type": "execution_event",
                "event": event,
                "position": _position_to_dict(pos),
            })
        except Exception as exc:
            logger.warning("Broadcast failed: %s", exc)


# -----------------------------------------------------------------------
# Serialization helper — ActivePosition → plain dict for JSON/WebSocket
# -----------------------------------------------------------------------

def _position_to_dict(pos: ActivePosition) -> dict:
    return {
        "position_id": pos.position_id,
        "market_id": pos.market_id,
        "asset": pos.asset,
        "direction": pos.direction.value,
        "entry_price": pos.entry_price,
        "size": pos.size,
        "entry_time": pos.entry_time.isoformat() if pos.entry_time else None,
        "expiry": pos.expiry.isoformat() if pos.expiry else None,
        "signal_timestamp": pos.signal_timestamp.isoformat() if pos.signal_timestamp else None,
        "stop_loss_pct": pos.stop_loss_pct,
        "take_profit_pct": pos.take_profit_pct,
        "trailing_stop_pct": pos.trailing_stop_pct,
        "trailing_stop_price": pos.trailing_stop_price,
        "entry_timeout_secs": pos.entry_timeout_secs,
        "entry_order_id": pos.entry_order_id,
        "sl_order_id": pos.sl_order_id,
        "tp_order_id": pos.tp_order_id,
        "status": pos.status.value,
        "model": pos.model.value if pos.model else None,
        "regime": pos.regime.value if isinstance(pos.regime, Regime) else pos.regime,
        "signal_strength": pos.signal_strength,
        "exit_price": pos.exit_price,
        "exit_time": pos.exit_time.isoformat() if pos.exit_time else None,
        "close_reason": pos.close_reason,
        # Computed live fields (added by _live_position_dict when broadcasting)
    }


def live_position_dict(pos: ActivePosition, current_price: Optional[float] = None) -> dict:
    """
    Build the full dict for the UI — includes live PnL, SL/TP distances, etc.
    Call this when pushing WS updates so the UI gets everything in one message.
    """
    d = _position_to_dict(pos)
    cp = current_price

    if cp is not None and pos.status == PositionStatus.OPEN:
        d["current_price"] = cp
        if pos.direction == Direction.UP:
            raw_pnl = pos.size * (cp - pos.entry_price)
        else:
            raw_pnl = pos.size * (pos.entry_price - cp)
        d["unrealized_pnl"] = raw_pnl - (pos.size * pos.stop_loss_pct)  # rough
        d["pnl_pct"] = (cp - pos.entry_price) / pos.entry_price if pos.entry_price > 0 else 0

        # Distance to SL / TP
        if pos.direction == Direction.UP:
            d["sl_distance_pct"] = (pos.entry_price * (1 - pos.stop_loss_pct) - cp) / cp if cp > 0 else None
            d["tp_distance_pct"] = (pos.entry_price * (1 + pos.take_profit_pct) - cp) / cp if cp > 0 else None
        else:
            d["sl_distance_pct"] = (cp - pos.entry_price * (1 + pos.stop_loss_pct)) / cp if cp > 0 else None
            d["tp_distance_pct"] = (cp - pos.entry_price * (1 - pos.take_profit_pct)) / cp if cp > 0 else None
    else:
        d["current_price"] = cp
        d["unrealized_pnl"] = 0.0
        d["pnl_pct"] = 0.0
        d["sl_distance_pct"] = None
        d["tp_distance_pct"] = None

    return d
