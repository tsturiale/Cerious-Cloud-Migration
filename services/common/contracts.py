from __future__ import annotations

from dataclasses import dataclass
from time import time


CME_INSTRUMENTS: dict[str, dict[str, str | float]] = {
    "ES": {"symbol": "ES.v.0", "label": "E-mini S&P 500", "tick": 0.25, "multiplier": 50.0, "tick_value": 12.5, "seed": 6025.0},
    "NQ": {"symbol": "NQ.v.0", "label": "E-mini Nasdaq-100", "tick": 0.25, "multiplier": 20.0, "tick_value": 5.0, "seed": 21950.0},
    "YM": {"symbol": "YM.v.0", "label": "E-mini Dow", "tick": 1.0, "multiplier": 5.0, "tick_value": 5.0, "seed": 43650.0},
    "RTY": {"symbol": "RTY.v.0", "label": "E-mini Russell 2000", "tick": 0.1, "multiplier": 50.0, "tick_value": 5.0, "seed": 2145.0},
    "CL": {"symbol": "CL.v.0", "label": "WTI Crude Oil", "tick": 0.01, "multiplier": 1000.0, "tick_value": 10.0, "seed": 74.25},
    "GC": {"symbol": "GC.v.0", "label": "Gold", "tick": 0.1, "multiplier": 100.0, "tick_value": 10.0, "seed": 3380.0},
    "ZM": {"symbol": "ZM.v.0", "label": "Soybean Meal", "tick": 0.1, "multiplier": 100.0, "tick_value": 10.0, "seed": 285.0},
    "ZS": {"symbol": "ZS.v.0", "label": "Soybeans", "tick": 0.25, "multiplier": 50.0, "tick_value": 12.5, "seed": 1075.0},
}

SYNTHETIC_SPREADS: dict[str, dict] = {
    "ES_NQ": {
        "label": "ES / NQ",
        "left": "ES",
        "right": "NQ",
        "right_multiplier": -0.2666667,
        "tick": 0.25,
        "multiplier": 150.0,
        "tick_value": 37.5,
        "ratio": "3 ES / -2 NQ",
    },
    "YM_ES": {
        "label": "YM / ES",
        "left": "YM",
        "right": "ES",
        "right_multiplier": -(20 / 3),
        "tick": 1.0,
        "multiplier": 15.0,
        "tick_value": 15.0,
        "ratio": "3 YM / -2 ES",
    },
    "RTY_ES": {
        "label": "RTY / ES",
        "left": "RTY",
        "right": "ES",
        "right_multiplier": -0.4265,
        "tick": 0.1,
        "multiplier": 350.0,
        "tick_value": 35.0,
        "ratio": "7 RTY / -3 ES",
    },
}

SYMBOL_TO_ASSET = {str(meta["symbol"]): asset for asset, meta in CME_INSTRUMENTS.items()}


def instrument_spec(asset: str) -> dict[str, float]:
    meta = CME_INSTRUMENTS.get(asset) or SYNTHETIC_SPREADS.get(asset) or {}
    tick = float(meta.get("tick", 0.01))
    multiplier = float(meta.get("multiplier", 1.0))
    tick_value = float(meta.get("tick_value", tick * multiplier))
    return {
        "tickSize": tick,
        "multiplier": multiplier,
        "tickValue": tick_value,
    }


@dataclass(frozen=True)
class Quote:
    asset: str
    ts_ms: int
    bid: float
    ask: float
    bid_size: float
    ask_size: float
    last: float
    last_size: float
    volume: float
    source: str
    is_trade: bool = True


def now_ms() -> int:
    return int(time() * 1000)


def cme_market(asset: str, quote: Quote | None = None) -> dict:
    meta = CME_INSTRUMENTS[asset]
    last = quote.last if quote else float(meta["seed"])
    ts = quote.ts_ms if quote else now_ms()
    return {
        "key": asset,
        "asset": asset,
        "timeframe": "20sec",
        "question": f"{asset} {meta['label']} front month",
        "category": "CME Futures",
        "up_pct": 50.0,
        "down_pct": 50.0,
        "volume": quote.volume if quote else 0.0,
        "expiry_ts": ts + 24 * 60 * 60 * 1000,
        "resolution_price": last,
        "start_price": last,
        "price_to_beat": last,
        "condition_id": f"cme-{asset}",
        "up_token_id": asset,
        "live": True,
        "last_update_ms": ts,
        "prob_history": [{"ts": ts, "up_pct": 50.0}],
        "truth_up_pct": 50.0,
        "truth_down_pct": 50.0,
        **instrument_spec(asset),
    }


def synthetic_quote(symbol: str, quotes: dict[str, Quote], is_trade: bool | None = None) -> Quote | None:
    spread = SYNTHETIC_SPREADS[symbol]
    left = quotes.get(spread["left"])
    right = quotes.get(spread["right"])
    if left is None or right is None:
        return None
    multiplier = float(spread["right_multiplier"])
    bid = left.bid + (right.ask if multiplier < 0 else right.bid) * multiplier
    ask = left.ask + (right.bid if multiplier < 0 else right.ask) * multiplier
    last = left.last + right.last * multiplier
    ts_ms = max(left.ts_ms, right.ts_ms)
    spread_is_trade = bool(left.is_trade or right.is_trade) if is_trade is None else is_trade
    return Quote(
        asset=symbol,
        ts_ms=ts_ms,
        bid=round(bid, 6),
        ask=round(ask, 6),
        bid_size=min(left.bid_size, right.ask_size if multiplier < 0 else right.bid_size),
        ask_size=min(left.ask_size, right.bid_size if multiplier < 0 else right.ask_size),
        last=round(last, 6),
        last_size=min(left.last_size, right.last_size),
        volume=min(left.volume, right.volume),
        source="synthetic-spread",
        is_trade=spread_is_trade,
    )


def synthetic_market(symbol: str, quote: Quote | None = None) -> dict:
    spread = SYNTHETIC_SPREADS[symbol]
    last = quote.last if quote else 0.0
    ts = quote.ts_ms if quote else now_ms()
    return {
        "key": symbol,
        "asset": symbol,
        "timeframe": "synthetic",
        "question": f"{spread['label']} Acme synthetic spread",
        "category": "ACME Synthetic Spread",
        "up_pct": last,
        "down_pct": last,
        "volume": quote.volume if quote else 0.0,
        "expiry_ts": ts + 24 * 60 * 60 * 1000,
        "resolution_price": last,
        "start_price": last,
        "price_to_beat": last,
        "condition_id": f"acme-{symbol}",
        "up_token_id": symbol,
        "live": quote is not None,
        "last_update_ms": ts,
        "prob_history": [{"ts": ts, "up_pct": last}],
        "truth_up_pct": last,
        "truth_down_pct": last,
        "legs": {
            "left": spread["left"],
            "right": spread["right"],
            "right_multiplier": spread["right_multiplier"],
            "ratio": spread.get("ratio"),
        },
        **instrument_spec(symbol),
    }


def quote_to_bar(q: Quote) -> dict:
    return {
        "timestamp": q.ts_ms,
        "open": q.last,
        "high": q.last,
        "low": q.last,
        "close": q.last,
        "volume": q.last_size,
    }


def quote_to_book(q: Quote) -> dict:
    mid = (q.bid + q.ask) / 2
    return {
        "market_id": q.asset,
        "bids": [{"price": q.bid, "size": q.bid_size}],
        "asks": [{"price": q.ask, "size": q.ask_size}],
        "best_bid": q.bid,
        "best_ask": q.ask,
        "mid": mid,
        "spread_bps": ((q.ask - q.bid) / mid) * 10000 if mid else 0.0,
    }


def quote_to_cme_book(q: Quote) -> dict:
    mid = (q.bid + q.ask) / 2
    spec = instrument_spec(q.asset)
    return {
        "symbol": q.asset,
        "venue": "CME",
        "source": q.source,
        "bids": [{"price": q.bid, "size": q.bid_size, "level": 0}],
        "asks": [{"price": q.ask, "size": q.ask_size, "level": 0}],
        "bestBid": q.bid,
        "bestAsk": q.ask,
        "bidSize": q.bid_size,
        "askSize": q.ask_size,
        "mid": round(mid, 6),
        "ltp": q.last,
        "ltpSize": q.last_size,
        "volume": q.volume,
        "spread": round(q.ask - q.bid, 6),
        "tsMs": q.ts_ms,
        **spec,
    }


def quote_to_poly_book(q: Quote) -> dict:
    meta = CME_INSTRUMENTS.get(q.asset)
    spread = SYNTHETIC_SPREADS.get(q.asset)
    tick = float((meta or spread or {"tick": 0.01})["tick"])
    label = str((meta or spread or {"label": q.asset})["label"])
    return {
        "market_key": q.asset,
        "question": f"{q.asset} {label} CME depth",
        "up_token_id": q.asset,
        "bids": [{"price": q.bid, "size": q.bid_size}],
        "asks": [{"price": q.ask, "size": q.ask_size}],
        "best_bid": q.bid,
        "best_ask": q.ask,
        "mid": round((q.bid + q.ask) / 2, 6),
        "spread_pct": round(q.ask - q.bid, 6),
        "up_pct": q.last,
        "down_pct": q.last - tick,
        "ltp": q.last,
        "ltp_size": q.last_size,
        "expiry_ts": q.ts_ms + 24 * 60 * 60 * 1000,
        "live": True,
        "timestamp_ms": q.ts_ms,
        "seen_ms": q.ts_ms,
    }


def quote_to_tick(q: Quote) -> dict:
    return {
        "timestamp": q.ts_ms,
        "price": q.last,
        "size": q.last_size,
        "volume": q.last_size,
        "side": "buy" if q.last >= (q.bid + q.ask) / 2 else "sell",
    }


def quote_to_cme_trade(q: Quote) -> dict:
    spec = instrument_spec(q.asset)
    return {
        "symbol": q.asset,
        "venue": "CME",
        "source": q.source,
        "timestamp": q.ts_ms,
        "price": q.last,
        "size": q.last_size,
        "volume": q.volume,
        "side": "buy" if q.last >= (q.bid + q.ask) / 2 else "sell",
        "bestBid": q.bid,
        "bestAsk": q.ask,
        **spec,
    }


def quote_to_poly_tick(q: Quote) -> dict:
    return {
        "timestamp": q.ts_ms,
        "marketKey": q.asset,
        "price": q.last,
        "size": q.last_size,
        "side": "yes",
    }
