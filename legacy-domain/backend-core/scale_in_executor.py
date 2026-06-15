"""
Noesis Scale-In Algorithm Executor
==================================
Production-grade algorithmic execution module for QuantSwarmTerminal.

This module implements a stateful scale-in execution algorithm designed to enter
binary prediction positions on Polymarket over a 30-second window post-trigger.

Execution Schedule (30-second window):
1. Iceberg Limit Thread (40% allocation):
   - Exposes only 10% of the total size as a limit order at the Best Bid/Ask at a time.
   - Refills upon execution. Reprices if the price moves away.
2. Sample Limit Ladder Thread (30% allocation):
   - Places 3 separate limit orders: 10% at Mid price, 10% at Bid/Ask, 10% at 1 tick worse.
3. Scheduled Market Orders Thread (20% allocation):
   - Places a 10% market order at t=10s.
   - Places a 10% market order at t=20s.
4. Clean-up Market Order (remaining size):
   - At t=30s, cancels all outstanding limits, calculates unfilled size, and executes a market order to achieve 100% fill.
"""

import asyncio
import logging
import uuid
import time
from datetime import datetime, timezone
from typing import Dict, Any, Optional, List, Tuple
from shared.types import Direction, Order, OrderStatus
from shared.polymarket_client import PolymarketClient

logger = logging.getLogger(__name__)


class NoesisScaleInExecutor:
    """
    Executes a scale-in algorithm to build a Polymarket position over a 30-second window.
    """
    
    def __init__(
        self,
        client: PolymarketClient,
        market_id: str,
        direction: Direction,
        total_size_usd: float,
        dry_run: bool = False
    ):
        self.client = client
        self.market_id = market_id
        self.direction = direction
        self.total_size_usd = total_size_usd
        self.dry_run = dry_run
        
        # Allocations
        self.iceberg_alloc = 0.40 * total_size_usd  # 40%
        self.limits_alloc = 0.30 * total_size_usd   # 30%
        self.markets_alloc = 0.20 * total_size_usd  # 20%
        self.reserve_alloc = 0.10 * total_size_usd  # 10% (buffer/clean-up)
        
        # Execution State
        self.filled_size_usd = 0.0
        self.active_orders: Dict[str, Dict[str, Any]] = {}  # order_id -> order details
        self.cancelled_orders: List[str] = []
        self.start_time = 0.0
        self.lock = asyncio.Lock()

    async def execute(self) -> float:
        """
        Runs the scale-in execution loops concurrently over a 30-second window.
        Returns the total filled size in USD.
        """
        logger.info(
            "[Scale-In] Initializing scale-in execution. Market: %s, Side: %s, Target: $%.2f USD (Dry Run: %s)",
            self.market_id, self.direction.value, self.total_size_usd, self.dry_run
        )
        self.start_time = time.time()
        
        # Spawn tasks for Iceberg, Limits, and Scheduled Markets
        tasks = [
            asyncio.create_task(self._run_iceberg_thread()),
            asyncio.create_task(self._run_limit_ladder_thread()),
            asyncio.create_task(self._run_scheduled_markets_thread())
        ]
        
        # Wait for the 30-second execution window to elapse
        await asyncio.sleep(30.0)
        
        # Cancel any active execution threads
        for t in tasks:
            t.cancel()
        
        # Clean-up Phase (t = 30s)
        logger.info("[Scale-In] Execution window elapsed (30s). Starting clean-up phase...")
        await self._cleanup_and_finalize()
        
        logger.info(
            "[Scale-In] Scale-in completed. Total filled size: $%.2f / $%.2f USD (%.1f%% fill)",
            self.filled_size_usd, self.total_size_usd, (self.filled_size_usd / self.total_size_usd) * 100.0
        )
        return self.filled_size_usd

    async def _place_scale_in_order(
        self,
        size_usd: float,
        price: float,
        order_type: str,
        tag: str
    ) -> Optional[Order]:
        """Places a limit or market order and tracks it."""
        if size_usd <= 0.50:  # Avoid dust orders
            return None
            
        logger.info(
            "[Scale-In] Placing %s %s order for $%.2f @ %.4f (%s)",
            order_type, self.direction.value, size_usd, price, tag
        )
        
        # Handle market order pricing (0.99 for YES/UP, 0.01 for NO/DOWN)
        if order_type.upper() == "MARKET":
            limit_price = 0.99 if self.direction == Direction.UP else 0.01
            slippage_guard = False
        else:
            limit_price = price
            slippage_guard = True
            
        order = await self.client.place_order(
            market_id=self.market_id,
            direction=self.direction,
            size_usd=size_usd,
            limit_price=limit_price,
            slippage_guard=slippage_guard
        )
        
        if order:
            async with self.lock:
                self.active_orders[order.order_id] = {
                    "size_usd": size_usd,
                    "qty": size_usd / limit_price,
                    "limit_price": limit_price,
                    "order_type": order_type,
                    "tag": tag,
                    "placed_at": time.time() - self.start_time,
                    "order": order
                }
            return order
        return None

    async def _run_iceberg_thread(self):
        """
        Manages the iceberg limit orders.
        Exposes 10% of the total size at a time at the best bid/ask.
        """
        try:
            slice_size = 0.10 * self.total_size_usd
            iceberg_filled = 0.0
            
            while iceberg_filled < self.iceberg_alloc:
                # 1. Fetch current order book to find the best bid/ask
                book = await self.client.get_order_book(self.market_id)
                best_price = book.best_bid if self.direction == Direction.UP else book.best_ask
                if best_price is None:
                    best_price = book.mid or 0.50
                    
                # 2. Place limit slice
                rem_iceberg = self.iceberg_alloc - iceberg_filled
                current_slice = min(slice_size, rem_iceberg)
                
                order = await self._place_scale_in_order(
                    size_usd=current_slice,
                    price=best_price,
                    order_type="LIMIT",
                    tag="Iceberg-Slice"
                )
                
                if not order:
                    await asyncio.sleep(2.0)
                    continue
                    
                # 3. Monitor the slice
                filled = False
                for _ in range(5):  # Check status every 1 second for 5 seconds
                    await asyncio.sleep(1.0)
                    status_order = await self.client.get_order(order.order_id)
                    
                    if status_order and status_order.status == OrderStatus.FILLED:
                        logger.info("[Scale-In] Iceberg slice %s filled fully.", order.order_id[:8])
                        iceberg_filled += current_slice
                        async with self.lock:
                            self.filled_size_usd += current_slice
                            if order.order_id in self.active_orders:
                                del self.active_orders[order.order_id]
                        filled = True
                        break
                        
                # 4. If not filled in 5s, cancel and reprice (follow the bid/ask)
                if not filled:
                    logger.info("[Scale-In] Iceberg slice %s unfilled after 5s. Cancelling to reprice...", order.order_id[:8])
                    await self.client.cancel_order(order.order_id)
                    # Check if there was partial fill before canceling
                    # In dry_run or simple setup, assume 0 fill if canceled
                    async with self.lock:
                        if order.order_id in self.active_orders:
                            self.cancelled_orders.append(order.order_id)
                            del self.active_orders[order.order_id]
                            
        except asyncio.CancelledError:
            pass

    async def _run_limit_ladder_thread(self):
        """
        Places a ladder of limit orders:
        - 10% at Midpoint
        - 10% at Best Bid/Ask
        - 10% at 1 tick worse
        """
        try:
            # 1. Fetch order book to find reference prices
            book = await self.client.get_order_book(self.market_id)
            mid = book.mid or 0.50
            best = book.best_bid if self.direction == Direction.UP else book.best_ask
            if best is None:
                best = mid
                
            tick_size = 0.01
            worse = (best - tick_size) if self.direction == Direction.UP else (best + tick_size)
            worse = max(0.01, min(0.99, worse))
            
            slice_size = 0.10 * self.total_size_usd
            
            # Place the 3 ladder orders
            await self._place_scale_in_order(slice_size, mid, "LIMIT", "Ladder-Mid")
            await self._place_scale_in_order(slice_size, best, "LIMIT", "Ladder-Best")
            await self._place_scale_in_order(slice_size, worse, "LIMIT", "Ladder-Worse")
            
            # Just keep them active (monitored in cleanup)
            while True:
                await asyncio.sleep(10.0)
                
        except asyncio.CancelledError:
            pass

    async def _run_scheduled_markets_thread(self):
        """
        Executes scheduled market orders during the scale-in window:
        - 10% market order at t=10s
        - 10% market order at t=20s
        """
        try:
            slice_size = 0.10 * self.total_size_usd
            
            # Wait for t=10s
            await asyncio.sleep(10.0)
            order10 = await self._place_scale_in_order(slice_size, 0.0, "MARKET", "Market-10s")
            if order10:
                async with self.lock:
                    self.filled_size_usd += slice_size
                    if order10.order_id in self.active_orders:
                        del self.active_orders[order10.order_id]
                        
            # Wait for t=20s (10s more)
            await asyncio.sleep(10.0)
            order20 = await self._place_scale_in_order(slice_size, 0.0, "MARKET", "Market-20s")
            if order20:
                async with self.lock:
                    self.filled_size_usd += slice_size
                    if order20.order_id in self.active_orders:
                        del self.active_orders[order20.order_id]
                        
        except asyncio.CancelledError:
            pass

    async def _cleanup_and_finalize(self):
        """
        Cancels all active limits, queries fills, and fills the remaining size at market.
        """
        # 1. Cancel all outstanding limit orders
        cancel_tasks = []
        async with self.lock:
            active_ids = list(self.active_orders.keys())
            
        for oid in active_ids:
            logger.info("[Scale-In] Cancelling outstanding limit order: %s", oid[:8])
            cancel_tasks.append(self.client.cancel_order(oid))
            
        if cancel_tasks:
            await asyncio.gather(*cancel_tasks, return_exceptions=True)
            
        # 2. Wait 1 second for cancellations to sync
        await asyncio.sleep(1.0)
        
        # 3. Finalize filled amount so far
        # For outstanding orders, check if they got filled or partially filled
        for oid in active_ids:
            order_info = self.active_orders[oid]
            # Verify status from API
            try:
                status_order = await self.client.get_order(oid)
                if status_order:
                    if status_order.status == OrderStatus.FILLED:
                        self.filled_size_usd += order_info["size_usd"]
                        logger.info("[Scale-In] Verified order %s was filled.", oid[:8])
                    elif status_order.status == OrderStatus.OPEN or status_order.status == OrderStatus.CANCELLED:
                        # Standard check: if it has raw size info
                        # In dry run it behaves as filled. In live we check remaining size:
                        # filled_fraction = (original - remaining) / original
                        # For safety, if it is cancelled/open, default to 0 fill unless we can verify
                        pass
            except Exception as e:
                logger.error("[Scale-In] Error checking status for order %s: %s", oid[:8], e)
                
        # 4. Fill remaining unfilled size at market
        unfilled_usd = self.total_size_usd - self.filled_size_usd
        if unfilled_usd > 0.50:  # Threshold of $0.50 minimum
            logger.info(
                "[Scale-In] Filling remaining unfilled size: $%.2f USD at market",
                unfilled_usd
            )
            final_order = await self._place_scale_in_order(
                size_usd=unfilled_usd,
                price=0.0,
                order_type="MARKET",
                tag="Clean-up-Market"
            )
            if final_order:
                self.filled_size_usd += unfilled_usd
        else:
            logger.info("[Scale-In] Position is fully filled. No clean-up order required.")
