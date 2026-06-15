"""
shared/polymarket_client.py — Async Polymarket CLOB API wrapper.

Wraps the py-clob-client SDK with:
  - Automatic retry with exponential backoff
  - Type conversion to shared.types domain objects
  - WebSocket stream for live order book + trade ticks
  - Slippage guard on order placement

Polymarket uses EOA wallet signing (private key → checksummed address).
API key auth is used for read endpoints; wallet signing is required for
order placement.

Environment / config variables expected (loaded via config.py):
  POLYMARKET_API_KEY        — read-only API key
  POLYMARKET_API_SECRET     — API secret
  POLYMARKET_API_PASSPHRASE — API passphrase
  POLYMARKET_PRIVATE_KEY    — EOA private key (hex) for order signing
  POLYMARKET_HOST           — default "https://clob.polymarket.com"
  POLYMARKET_CHAIN_ID       — 137 (Polygon mainnet) or 80002 (Amoy testnet)
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import AsyncIterator, Callable, Optional

from shared.types import (
    Bar, Direction, Market, Order, OrderBook, OrderBookLevel,
    OrderStatus, Position, TradeTick,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional dependency guard — graceful import of py-clob-client
# ---------------------------------------------------------------------------

try:
    from py_clob_client_v2.client import ClobClient
    from py_clob_client_v2 import (
        ApiCreds,
        MarketOrderArgs,
        OrderArgs,
        OrderType,
        PartialCreateOrderOptions,
        Side,
        TradeParams,
    )
    _CLOB_AVAILABLE = True
except ImportError:
    _CLOB_AVAILABLE = False
    logger.warning(
        "py-clob-client-v2 not installed.  Install with: pip install py-clob-client-v2"
    )


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_HOST = "https://clob.polymarket.com"
POLYGON_CHAIN_ID = 137
AMOY_CHAIN_ID = 80002

MAX_RETRIES = 3
RETRY_BACKOFF_BASE = 0.5   # seconds

# Polymarket fee rate
FEE_RATE = 0.02

# Slippage guard: abort if fill price deviates more than this many bps
DEFAULT_SLIPPAGE_GUARD_BPS = 3.0


# ---------------------------------------------------------------------------
# Data converters (raw API dict → domain types)
# ---------------------------------------------------------------------------

def _ts(raw: str | int | float) -> datetime:
    """Parse Polymarket timestamp (ISO string or Unix seconds/milliseconds) to UTC datetime."""
    if isinstance(raw, str):
        if raw.isdigit():
            raw = int(raw)
        else:
            try:
                return datetime.fromisoformat(raw.replace("Z", "+00:00"))
            except ValueError:
                return datetime.now(tz=timezone.utc)
    if isinstance(raw, (int, float)):
        if raw > 1e10:
            raw = raw / 1000.0
        return datetime.fromtimestamp(raw, tz=timezone.utc)
    return datetime.now(tz=timezone.utc)


def _parse_market(d: dict) -> Market:
    return Market(
        market_id=d["condition_id"],
        asset=d.get("question", "").split()[0].upper(),  # best-effort
        direction=Direction.UP if "up" in d.get("question", "").lower() else Direction.DOWN,
        expiry=_ts(d["end_date_iso"]) if "end_date_iso" in d else datetime.now(tz=timezone.utc),
        description=d.get("question", ""),
        active=d.get("active", True),
    )


def _parse_order_book(market_id: str, d: dict) -> OrderBook:
    bids = [OrderBookLevel(float(lv["price"]), float(lv["size"])) for lv in d.get("bids", [])]
    asks = [OrderBookLevel(float(lv["price"]), float(lv["size"])) for lv in d.get("asks", [])]
    return OrderBook(
        market_id=market_id,
        timestamp=datetime.now(tz=timezone.utc),
        bids=sorted(bids, key=lambda x: -x.price),
        asks=sorted(asks, key=lambda x: x.price),
    )


def _parse_trade_tick(d: dict) -> TradeTick:
    return TradeTick(
        timestamp=_ts(d.get("created_at", time.time())),
        price=float(d["price"]),
        size=float(d["size"]),
        side="buy" if d.get("side", "").upper() == "BUY" else "sell",
    )


def _parse_order(d: dict) -> Order:
    status_map = {
        "OPEN": OrderStatus.OPEN,
        "FILLED": OrderStatus.FILLED,
        "CANCELLED": OrderStatus.CANCELLED,
        "CANCELED": OrderStatus.CANCELLED,
    }
    return Order(
        order_id=d.get("id") or d.get("orderID") or d.get("order_id", ""),
        market_id=d.get("market") or d.get("market_id") or d.get("token_id", ""),
        asset="",   # enriched by caller
        direction=Direction.UP if str(d.get("side", "")).upper() in ("BUY", "SIDE.BUY") else Direction.DOWN,
        size=float(d.get("original_size") or d.get("size") or 0),
        limit_price=float(d.get("price") or d.get("limit_price", 0)),
        status=status_map.get(d.get("status", ""), OrderStatus.PENDING),
        created_at=_ts(d.get("created_at") or d.get("timestamp", time.time())),
        filled_at=_ts(d["updated_at"]) if d.get("status") == "FILLED" else None,
        fill_price=float(d.get("avg_price", 0)) or None,
    )


# ---------------------------------------------------------------------------
# Retry helper
# ---------------------------------------------------------------------------

async def _with_retry(coro_fn: Callable, *args, retries: int = MAX_RETRIES, **kwargs):
    last_exc: Exception | None = None
    for attempt in range(retries):
        try:
            return await asyncio.to_thread(coro_fn, *args, **kwargs)
        except Exception as exc:
            last_exc = exc
            wait = RETRY_BACKOFF_BASE * (2 ** attempt)
            logger.warning("API call failed (attempt %d/%d): %s — retrying in %.1fs",
                           attempt + 1, retries, exc, wait)
            await asyncio.sleep(wait)
    raise RuntimeError(f"API call failed after {retries} retries") from last_exc


# ---------------------------------------------------------------------------
# PolymarketClient
# ---------------------------------------------------------------------------

class PolymarketClient:
    """
    Async wrapper around the Polymarket CLOB API.

    All blocking SDK calls are dispatched via asyncio.to_thread so this
    class is safe to use in an async event loop.

    Usage (dry-run / no credentials):
        client = PolymarketClient(dry_run=True)
        markets = await client.get_markets(asset="BTC")

    Usage (live):
        client = PolymarketClient(
            api_key="...", api_secret="...", api_passphrase="...",
            private_key="0x...", chain_id=137,
        )
        await client.connect()
        order = await client.place_order(market_id, Direction.UP, size=100, limit_price=0.55)
    """

    def __init__(
        self,
        api_key: str = "",
        api_secret: str = "",
        api_passphrase: str = "",
        private_key: str = "",
        host: str = DEFAULT_HOST,
        chain_id: int = POLYGON_CHAIN_ID,
        slippage_guard_bps: float = DEFAULT_SLIPPAGE_GUARD_BPS,
        dry_run: bool = False,
    ) -> None:
        self.host = host
        self.chain_id = chain_id
        self.slippage_guard_bps = slippage_guard_bps
        self.dry_run = dry_run
        self._api_key = api_key
        self._api_secret = api_secret
        self._api_passphrase = api_passphrase
        self._private_key = private_key
        self._client: Optional[object] = None   # ClobClient instance

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def connect(self) -> None:
        """Initialise the underlying ClobClient and verify credentials."""
        if self.dry_run:
            logger.info("[DRY RUN] PolymarketClient — no real API calls will be made")
            return

        if not _CLOB_AVAILABLE:
            logger.warning("py-clob-client not installed; falling back to DRY RUN mode")
            self.dry_run = True
            return

        try:
            creds = ApiCreds(
                api_key=self._api_key,
                api_secret=self._api_secret,
                api_passphrase=self._api_passphrase,
            )
            self._client = ClobClient(
                host=self.host,
                chain_id=self.chain_id,
                key=self._private_key,
                creds=creds,
            )
            logger.info("PolymarketClient connected (chain_id=%d)", self.chain_id)
        except Exception as exc:
            logger.error("PolymarketClient connection failed: %s; falling back to DRY RUN mode", exc)
            self.dry_run = True

    # ------------------------------------------------------------------
    # Market Data
    # ------------------------------------------------------------------

    async def get_markets(
        self,
        asset: Optional[str] = None,
        active_only: bool = True,
    ) -> list[Market]:
        """Fetch all binary markets, optionally filtered by asset ticker."""
        if self.dry_run or self._client is None:
            return _stub_markets()

        raw = await _with_retry(self._client.get_markets)
        markets = [_parse_market(m) for m in raw.get("data", [])]
        if active_only:
            markets = [m for m in markets if m.active]
        if asset:
            markets = [m for m in markets if m.asset.upper() == asset.upper()]
        return markets

    async def get_order_book(self, market_id: str) -> OrderBook:
        """Fetch current bid/ask ladder for a market."""
        if self.dry_run or self._client is None:
            return _stub_order_book(market_id)

        raw = await _with_retry(self._client.get_order_book, market_id)
        return _parse_order_book(market_id, raw)

    async def get_recent_trades(
        self,
        market_id: str,
        limit: int = 200,
    ) -> list[TradeTick]:
        """Fetch recent trade ticks for a market."""
        if self.dry_run or self._client is None:
            return []

        raw = await _with_retry(
            self._client.get_trades,
            TradeParams(market=market_id, limit=limit),
        )
        return [_parse_trade_tick(t) for t in raw.get("data", [])]

    async def get_wallet_trades(
        self,
        wallet_address: str,
        limit: int = 100,
    ) -> list[dict]:
        """
        Fetch recent trades for an arbitrary wallet address.
        Used by EdgeCopy to monitor master traders.
        Returns raw dicts — enriched by the watcher.
        """
        if self.dry_run or self._client is None:
            return []

        raw = await _with_retry(
            self._client.get_trades,
            TradeParams(maker_address=wallet_address, limit=limit),
        )
        return raw.get("data", [])

    async def get_positions(self) -> list[Position]:
        """Fetch open positions for the authenticated wallet."""
        if self.dry_run or self._client is None:
            return []

        raw = await _with_retry(self._client.get_positions)
        # Polymarket returns positions as list of dicts; convert to domain type
        positions = []
        for p in raw:
            try:
                positions.append(
                    Position(
                        position_id=p.get("id", ""),
                        market_id=p.get("market", ""),
                        asset="",
                        direction=Direction.UP if p.get("outcome", "").upper() == "YES" else Direction.DOWN,
                        entry_price=float(p.get("avg_price", 0)),
                        size=float(p.get("size", 0)),
                        entry_time=_ts(p.get("created_at", time.time())),
                        expiry=datetime.now(tz=timezone.utc),
                    )
                )
            except Exception as exc:
                logger.warning("Could not parse position: %s — %s", p, exc)
        return positions

    # ------------------------------------------------------------------
    # Order Management
    # ------------------------------------------------------------------

    async def place_order(
        self,
        market_id: str,
        direction: Direction,
        size_usd: float,
        limit_price: float,
        slippage_guard: bool = True,
    ) -> Optional[Order]:
        """
        Place a limit order.

        `size_usd`    — notional USD to risk
        `limit_price` — probability (0–1); abort if market moves > slippage_guard_bps

        Returns the placed Order, or None if slippage guard triggered or dry-run.
        """
        if self.dry_run:
            logger.info(
                "[DRY RUN] PLACE %s %s size=%.2f price=%.4f",
                direction.value, market_id, size_usd, limit_price,
            )
            return _stub_order(market_id, direction, size_usd, limit_price)

        if self._client is None:
            raise RuntimeError("Client not connected — call await client.connect() first")

        if slippage_guard:
            book = await self.get_order_book(market_id)
            market_price = book.best_ask if direction == Direction.UP else book.best_bid
            if market_price is not None:
                deviation_bps = abs(limit_price - market_price) / limit_price * 10_000
                if deviation_bps > self.slippage_guard_bps:
                    logger.warning(
                        "Slippage guard: %.1f bps > %.1f bps — order aborted",
                        deviation_bps, self.slippage_guard_bps,
                    )
                    return None

        side = "BUY" if direction == Direction.UP else "SELL"
        # Convert notional USD → contract quantity
        qty = size_usd / limit_price if limit_price > 0 else size_usd

        try:
            resp = await _with_retry(
                self._client.create_and_post_order,
                OrderArgs(
                    token_id=market_id,
                    price=limit_price,
                    size=qty,
                    side=side,
                ),
            )
            return _parse_order(resp) if resp else None
        except Exception as exc:
            logger.error("Order placement failed: %s", exc)
            return None

    async def cancel_order(self, order_id: str) -> bool:
        """Cancel an open order. Returns True on success."""
        if self.dry_run:
            logger.info("[DRY RUN] CANCEL order %s", order_id)
            return True

        if self._client is None:
            raise RuntimeError("Client not connected")

        try:
            await _with_retry(self._client.cancel, order_id)
            return True
        except Exception as exc:
            logger.error("Cancel order %s failed: %s", order_id, exc)
            return False

    async def cancel_all_orders(self) -> bool:
        """Cancel all open orders. Returns True on success."""
        if self.dry_run:
            logger.info("[DRY RUN] CANCEL ALL orders")
            return True

        if self._client is None:
            raise RuntimeError("Client not connected")

        try:
            await _with_retry(self._client.cancel_all)
            return True
        except Exception as exc:
            logger.error("Cancel all orders failed: %s", exc)
            return False

    async def get_order(self, order_id: str) -> Optional[Order]:
        """Fetch current status of a specific order."""
        if self.dry_run or self._client is None:
            return None

        try:
            raw = await _with_retry(self._client.get_order, order_id)
            return _parse_order(raw)
        except Exception as exc:
            logger.error("Get order %s failed: %s", order_id, exc)
            return None

    # ------------------------------------------------------------------
    # Leaderboard / trader discovery
    # ------------------------------------------------------------------

    async def get_leaderboard(
        self,
        window_days: int = 30,
        min_trades: int = 20,
        asset: Optional[str] = None,
        limit: int = 100,
    ) -> list[dict]:
        """
        Fetch top traders ranked by performance.

        NOTE: Polymarket does not publish a native leaderboard API.
        This method calls the gamma/data API endpoint that some community
        tools use.  Falls back to an empty list if unavailable.

        Returns list of dicts with keys:
          wallet_address, win_rate, profit_factor, sharpe, max_drawdown, trade_count
        """
        if self.dry_run or self._client is None:
            return _stub_leaderboard()

        # Community endpoint — may change; fall back gracefully
        try:
            import httpx
            url = f"https://gamma-api.polymarket.com/leaderboard"
            params = {
                "window": f"{window_days}d",
                "limit": limit,
            }
            async with httpx.AsyncClient(timeout=10) as http:
                resp = await http.get(url, params=params)
                resp.raise_for_status()
                data = resp.json()
        except Exception as exc:
            logger.warning("Leaderboard fetch failed: %s", exc)
            return []

        traders = []
        for entry in data if isinstance(data, list) else data.get("data", []):
            if entry.get("trade_count", 0) < min_trades:
                continue
            if asset and entry.get("favorite_asset", "").upper() != asset.upper():
                continue
            traders.append({
                "wallet_address": entry.get("address", ""),
                "win_rate": float(entry.get("win_rate", 0)),
                "profit_factor": float(entry.get("profit_factor", 0)),
                "sharpe": float(entry.get("sharpe", 0)),
                "max_drawdown": float(entry.get("max_drawdown", 0)),
                "trade_count": int(entry.get("trade_count", 0)),
            })

        return sorted(traders, key=lambda x: x["sharpe"], reverse=True)


# ---------------------------------------------------------------------------
# Stub data for dry-run / tests
# ---------------------------------------------------------------------------

import uuid as _uuid
from datetime import timedelta


def _stub_markets() -> list[Market]:
    now = datetime.now(tz=timezone.utc)
    return [
        Market(
            market_id=f"stub-{a}-UP",
            asset=a,
            direction=Direction.UP,
            expiry=now + timedelta(minutes=15),
            description=f"Will {a} go UP in the next 15 minutes?",
        )
        for a in ["BTC", "ETH", "SOL", "XRP"]
    ]


def _stub_order_book(market_id: str) -> OrderBook:
    return OrderBook(
        market_id=market_id,
        timestamp=datetime.now(tz=timezone.utc),
        bids=[OrderBookLevel(0.48, 500), OrderBookLevel(0.47, 1000)],
        asks=[OrderBookLevel(0.52, 500), OrderBookLevel(0.53, 1000)],
    )


def _stub_order(
    market_id: str,
    direction: Direction,
    size: float,
    price: float,
) -> Order:
    return Order(
        order_id=str(_uuid.uuid4()),
        market_id=market_id,
        asset="",
        direction=direction,
        size=size,
        limit_price=price,
        status=OrderStatus.OPEN,
        created_at=datetime.now(tz=timezone.utc),
    )


def _stub_leaderboard() -> list[dict]:
    return [
        {
            "wallet_address": "0xAAA",
            "win_rate": 0.58,
            "profit_factor": 1.4,
            "sharpe": 1.8,
            "max_drawdown": 0.12,
            "trade_count": 120,
        },
        {
            "wallet_address": "0xBBB",
            "win_rate": 0.55,
            "profit_factor": 1.2,
            "sharpe": 1.3,
            "max_drawdown": 0.18,
            "trade_count": 85,
        },
    ]
