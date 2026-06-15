from __future__ import annotations

import asyncio
import math
import random
from typing import AsyncIterator

from services.common.config import settings
from services.common.contracts import CME_INSTRUMENTS, SYMBOL_TO_ASSET, Quote, now_ms


class CmeAdapter:
    def __init__(self) -> None:
        self._instrument_assets: dict[int, str] = {}

    async def stream(self) -> AsyncIterator[Quote]:
        if settings.databento_api_key:
            async for quote in self._databento_stream():
                yield quote
            return

        async for quote in self._simulated_stream():
            yield quote

    async def _simulated_stream(self) -> AsyncIterator[Quote]:
        rng = random.Random(17)
        prices = {asset: float(meta["seed"]) for asset, meta in CME_INSTRUMENTS.items()}
        volume = {asset: 0.0 for asset in CME_INSTRUMENTS}
        phase = 0
        while True:
            phase += 1
            for asset, meta in CME_INSTRUMENTS.items():
                tick = float(meta["tick"])
                wave = math.sin((phase + len(asset) * 7) / 18) * tick * 2
                noise = rng.choice([-1, 0, 1]) * tick
                prices[asset] = round((prices[asset] + wave + noise) / tick) * tick
                bid = prices[asset] - tick
                ask = prices[asset] + tick
                last_size = rng.randint(1, 18)
                volume[asset] += last_size
                yield Quote(
                    asset=asset,
                    ts_ms=now_ms(),
                    bid=round(bid, 6),
                    ask=round(ask, 6),
                    bid_size=rng.randint(5, 80),
                    ask_size=rng.randint(5, 80),
                    last=round(prices[asset], 6),
                    last_size=last_size,
                    volume=volume[asset],
                    source="cme-sim",
                )
            await asyncio.sleep(0.2)

    async def _databento_stream(self) -> AsyncIterator[Quote]:
        try:
            import databento as db
        except ImportError:
            async for quote in self._simulated_stream():
                yield quote
            return

        queue: asyncio.Queue[Quote] = asyncio.Queue(maxsize=10000)

        def run_client() -> None:
            client = db.Live(key=settings.databento_api_key)
            client.subscribe(
                dataset=settings.cme_dataset,
                schema=settings.cme_schema,
                symbols=list(settings.cme_symbols),
                stype_in="continuous",
            )
            for record in client:
                quote = self._handle_record(record)
                if quote is not None:
                    try:
                        queue.put_nowait(quote)
                    except asyncio.QueueFull:
                        pass

        task = asyncio.create_task(asyncio.to_thread(run_client))
        try:
            while True:
                yield await queue.get()
        finally:
            task.cancel()

    def _handle_record(self, record: object) -> Quote | None:
        stype_in_symbol = getattr(record, "stype_in_symbol", None)
        instrument_id = getattr(record, "instrument_id", None)
        if stype_in_symbol and isinstance(instrument_id, int):
            asset = SYMBOL_TO_ASSET.get(str(stype_in_symbol))
            if asset:
                self._instrument_assets[instrument_id] = asset
            return None
        return self._record_to_quote(record)

    def _record_to_quote(self, record: object) -> Quote | None:
        symbol = str(getattr(record, "symbol", "") or getattr(record, "raw_symbol", "") or "")
        asset = SYMBOL_TO_ASSET.get(symbol)
        if asset is None:
            instrument_id = getattr(record, "instrument_id", None)
            asset = self._instrument_assets.get(instrument_id)
        if asset not in CME_INSTRUMENTS:
            return None

        levels = getattr(record, "levels", None)
        level0 = levels[0] if levels else None
        bid = self._record_px(record, "bid_px_00", "pretty_bid_px_00", level0, "bid_px")
        ask = self._record_px(record, "ask_px_00", "pretty_ask_px_00", level0, "ask_px")
        if bid <= 0 or ask <= 0:
            return None

        ts_raw = getattr(record, "ts_event", None) or getattr(record, "ts_recv", None)
        ts_ms = int(ts_raw / 1_000_000) if isinstance(ts_raw, int) else now_ms()
        last = self._record_px(record, "price", "pretty_price", None, "") or (bid + ask) / 2
        return Quote(
            asset=asset,
            ts_ms=ts_ms,
            bid=bid,
            ask=ask,
            bid_size=self._record_size(record, "bid_sz_00", level0, "bid_sz"),
            ask_size=self._record_size(record, "ask_sz_00", level0, "ask_sz"),
            last=last,
            last_size=float(getattr(record, "size", 0) or 0),
            volume=float(getattr(record, "size", 0) or 0),
            source="databento-cme",
        )

    def _record_px(self, record: object, raw_name: str, pretty_name: str, level: object | None, level_name: str) -> float:
        pretty = getattr(record, pretty_name, None)
        if pretty is not None:
            return self._px(pretty)
        if level is not None and level_name:
            return self._px(getattr(level, level_name, 0))
        return self._px(getattr(record, raw_name, 0))

    def _record_size(self, record: object, raw_name: str, level: object | None, level_name: str) -> float:
        raw = getattr(record, raw_name, None)
        if raw is None and level is not None:
            raw = getattr(level, level_name, 0)
        try:
            return float(raw or 0)
        except (TypeError, ValueError):
            return 0.0

    def _px(self, raw: object) -> float:
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return 0.0
        if abs(value) > 1_000_000:
            value = value / 1_000_000_000
        return value
