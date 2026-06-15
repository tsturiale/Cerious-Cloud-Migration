from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from typing import Any

from services.common.contracts import (
    CME_INSTRUMENTS,
    SYNTHETIC_SPREADS,
    Quote,
    cme_market,
    quote_to_bar,
    quote_to_book,
    quote_to_cme_book,
    quote_to_cme_trade,
    quote_to_poly_book,
    quote_to_poly_tick,
    quote_to_tick,
    synthetic_market,
    synthetic_quote,
)

ROLLING_STUDY_INTERVAL_MS = 30 * 60 * 1000
ROLLING_STUDY_INTERVAL = "30m"


class MarketBus:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self.bars: dict[str, deque[dict[str, Any]]] = {
            asset: deque(maxlen=4500) for asset in [*CME_INSTRUMENTS, *SYNTHETIC_SPREADS]
        }
        self.ohlcv_30m: dict[str, deque[dict[str, Any]]] = {
            asset: deque(maxlen=4500) for asset in [*CME_INSTRUMENTS, *SYNTHETIC_SPREADS]
        }
        self._forming_30m: dict[str, dict[str, Any]] = {}
        self.books: dict[str, dict[str, Any]] = {}
        self.cme_books: dict[str, dict[str, Any]] = {}
        self.cme_trades: dict[str, deque[dict[str, Any]]] = defaultdict(lambda: deque(maxlen=200))
        self.poly_books: dict[str, dict[str, Any]] = {}
        self.poly_ticks: dict[str, deque[dict[str, Any]]] = defaultdict(lambda: deque(maxlen=200))
        self.ticks: dict[str, deque[dict[str, Any]]] = {asset: deque(maxlen=200) for asset in CME_INSTRUMENTS}
        self.quotes: dict[str, Quote] = {}
        self.source = "local-sim"

    def _number(self, value: Any, fallback: float = 0.0) -> float:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return fallback
        return parsed if parsed == parsed else fallback

    def _study_bucket(self, ts_ms: int) -> int:
        return (int(ts_ms) // ROLLING_STUDY_INTERVAL_MS) * ROLLING_STUDY_INTERVAL_MS

    def _record_rolling_ohlcv(self, quote: Quote) -> dict[str, Any] | None:
        price = self._number(quote.last)
        if not price:
            return None

        asset = quote.asset.upper()
        bucket = self._study_bucket(quote.ts_ms)
        size = max(0.0, self._number(quote.last_size))
        source = (
            "databento-rest-baseline-plus-live-rolling-30m"
            if "databento" in quote.source
            else f"{quote.source}-rolling-30m"
        )
        current = self._forming_30m.get(asset)

        if current is not None and int(current.get("timestamp") or 0) != bucket:
            completed = dict(current)
            completed["isForming"] = False
            self.ohlcv_30m.setdefault(asset, deque(maxlen=4500)).append(completed)
            current = None

        if current is None:
            current = {
                "timestamp": bucket,
                "open": price,
                "high": price,
                "low": price,
                "close": price,
                "volume": size,
                "isForming": True,
                "lastUpdateMs": quote.ts_ms,
                "source": source,
            }
        else:
            current["high"] = max(self._number(current.get("high"), price), price)
            current["low"] = min(self._number(current.get("low"), price), price)
            current["close"] = price
            current["volume"] = self._number(current.get("volume")) + size
            current["isForming"] = True
            current["lastUpdateMs"] = quote.ts_ms
            current["source"] = source

        self._forming_30m[asset] = current
        return dict(current)

    def rolling_ohlcv(self, asset: str, interval: str = ROLLING_STUDY_INTERVAL, limit: int = 100, include_forming: bool = True) -> list[dict[str, Any]]:
        if str(interval).strip().lower() not in {"30", "30m"}:
            return []
        key = asset.upper()
        rows = [dict(row) for row in self.ohlcv_30m.get(key, [])]
        forming = self._forming_30m.get(key)
        if include_forming and forming:
            rows.append(dict(forming))
        return rows[-max(1, min(int(limit), 4500)) :]

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=500)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)

    async def publish_quote(self, quote: Quote) -> None:
        self.quotes[quote.asset] = quote
        self.source = quote.source
        book = quote_to_book(quote)
        cme_book = quote_to_cme_book(quote)
        poly_book = quote_to_poly_book(quote)
        self.books[quote.asset] = book
        self.cme_books[quote.asset] = cme_book
        self.poly_books[quote.asset] = poly_book
        trade_messages: list[dict[str, Any]] = []
        if quote.is_trade:
            bar = quote_to_bar(quote)
            cme_trade = quote_to_cme_trade(quote)
            tick = quote_to_tick(quote)
            poly_tick = quote_to_poly_tick(quote)
            ohlcv_30m = self._record_rolling_ohlcv(quote)
            self.bars[quote.asset].append(bar)
            self.cme_trades[quote.asset].append(cme_trade)
            self.ticks[quote.asset].append(tick)
            self.poly_ticks[quote.asset].append(poly_tick)
            trade_messages.extend(
                [
                    {"type": "bar", "asset": quote.asset, "data": bar},
                    {"type": "tick", "asset": quote.asset, "data": tick},
                    {"type": "cme_trade", "symbol": quote.asset, "data": cme_trade},
                    {"type": "poly_tick", "market_key": quote.asset, "data": poly_tick},
                    *([{"type": "ohlcv_30m", "asset": quote.asset, "data": ohlcv_30m}] if ohlcv_30m else []),
                ]
            )
        synthetic_messages: list[dict[str, Any]] = []
        for symbol, spread in SYNTHETIC_SPREADS.items():
            if quote.asset not in {spread["left"], spread["right"]}:
                continue
            spread_quote = synthetic_quote(symbol, self.quotes, is_trade=quote.is_trade)
            if spread_quote is None:
                continue
            self.quotes[symbol] = spread_quote
            spread_book = quote_to_book(spread_quote)
            spread_cme_book = quote_to_cme_book(spread_quote)
            spread_poly_book = quote_to_poly_book(spread_quote)
            self.books[symbol] = spread_book
            self.cme_books[symbol] = spread_cme_book
            self.poly_books[symbol] = spread_poly_book
            synthetic_messages.extend(
                [
                    {"type": "book", "asset": symbol, "data": spread_book},
                    {"type": "cme_book", "symbol": symbol, "data": spread_cme_book},
                    {"type": "poly_book", "market_key": symbol, "data": spread_poly_book},
                ]
            )
            if spread_quote.is_trade:
                spread_bar = quote_to_bar(spread_quote)
                spread_cme_trade = quote_to_cme_trade(spread_quote)
                spread_tick = quote_to_tick(spread_quote)
                spread_poly_tick = quote_to_poly_tick(spread_quote)
                spread_ohlcv_30m = self._record_rolling_ohlcv(spread_quote)
                self.bars[symbol].append(spread_bar)
                self.cme_trades[symbol].append(spread_cme_trade)
                self.ticks.setdefault(symbol, deque(maxlen=200)).append(spread_tick)
                self.poly_ticks[symbol].append(spread_poly_tick)
                synthetic_messages.extend(
                    [
                        {"type": "bar", "asset": symbol, "data": spread_bar},
                        {"type": "tick", "asset": symbol, "data": spread_tick},
                        {"type": "cme_trade", "symbol": symbol, "data": spread_cme_trade},
                        {"type": "poly_tick", "market_key": symbol, "data": spread_poly_tick},
                        *([{"type": "ohlcv_30m", "asset": symbol, "data": spread_ohlcv_30m}] if spread_ohlcv_30m else []),
                    ]
                )

        messages = [
            {"type": "book", "asset": quote.asset, "data": book},
            {"type": "cme_book", "symbol": quote.asset, "data": cme_book},
            {"type": "poly_book", "market_key": quote.asset, "data": poly_book},
            *trade_messages,
            *synthetic_messages,
            {"type": "markets", "data": self.markets()},
        ]
        for message in messages:
            await self._fanout(message)

    async def _fanout(self, message: dict[str, Any]) -> None:
        stale: list[asyncio.Queue[dict[str, Any]]] = []
        for queue in self._subscribers:
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                stale.append(queue)
        for queue in stale:
            self.unsubscribe(queue)

    def markets(self) -> list[dict[str, Any]]:
        outright = [cme_market(asset, self.quotes.get(asset)) for asset in CME_INSTRUMENTS]
        synthetic = [synthetic_market(symbol, self.quotes.get(symbol)) for symbol in SYNTHETIC_SPREADS]
        return [*outright, *synthetic]

    def metrics(self) -> dict[str, Any]:
        return {
            "date": "local",
            "trade_count": 0,
            "win_count": 0,
            "win_rate": 0,
            "net_pnl": 0,
            "sharpe": 0,
            "max_drawdown": 0,
            "trades_remaining": 100,
            "concurrent_positions": 0,
            "at_trade_limit": False,
            "at_loss_limit": False,
            "source": self.source,
        }

    def crypto_prices_compat(self) -> dict[str, Any]:
        prices: dict[str, Any] = {}
        for asset, quote in self.quotes.items():
            prices[asset] = {
                "price": quote.last,
                "change24h": 0,
                "open": quote.last,
                "high": quote.last,
                "low": quote.last,
                "previousClose": quote.last,
                "volume": quote.volume,
                "bid": quote.bid,
                "ask": quote.ask,
                "bidSize": quote.bid_size,
                "askSize": quote.ask_size,
                "timestamp": quote.ts_ms,
            }
        return prices

    def snapshot(self, asset: str) -> dict[str, Any]:
        asset = asset.upper()
        return {
            "type": "snapshot",
            "asset": asset,
            "bars": list(self.bars.get(asset, [])),
            "ohlcv30m": self.rolling_ohlcv(asset, ROLLING_STUDY_INTERVAL, 120),
            "bands": None,
            "zscore": 0,
            "regime": "medium",
            "signals": [],
            "positions": [],
            "metrics": self.metrics(),
            "copy_status": {"enabled": False, "active_masters": [], "copy_trades_today": 0, "copy_pnl_today": 0},
            "markets": self.markets(),
            "cme_books": self.cme_books,
            "cme_trades": {key: list(value)[-50:] for key, value in self.cme_trades.items()},
            "poly_books": self.poly_books,
            "poly_ticks": {key: list(value)[-50:] for key, value in self.poly_ticks.items()},
            "settlements": [],
            "execution_positions": [],
            "execution_risk": None,
        }


market_bus = MarketBus()
