from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any

from services.common.config import settings
from services.common.contracts import CME_INSTRUMENTS, SYNTHETIC_SPREADS


HISTORICAL_BAR_CACHE: dict[str, tuple[float, list[dict[str, Any]]]] = {}
DATABENTO_END_CACHE: dict[str, tuple[float, datetime]] = {}
DATABENTO_OHLCV_CACHE: dict[str, tuple[float, list[dict[str, Any]]]] = {}
HISTORICAL_CACHE_TTL_SECONDS = 6 * 60 * 60.0


def interval_ms(interval: str | float | int) -> int:
    raw = str(interval).strip().lower()
    aliases = {
        "1": 60_000,
        "1m": 60_000,
        "5": 5 * 60_000,
        "5m": 5 * 60_000,
        "30": 30 * 60_000,
        "30m": 30 * 60_000,
        "60": 60 * 60_000,
        "1h": 60 * 60_000,
        "1hr": 60 * 60_000,
        "1d": 24 * 60 * 60_000,
        "d": 24 * 60 * 60_000,
        "day": 24 * 60 * 60_000,
    }
    if raw in aliases:
        return aliases[raw]
    try:
        minutes = float(raw)
    except ValueError:
        return 30 * 60_000
    return max(1, int(minutes)) * 60_000


def bar_timestamp_ms(row: dict[str, Any]) -> int:
    raw = row.get("timestamp") or row.get("ts") or row.get("time") or 0
    if isinstance(raw, str):
        try:
            return int(datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            try:
                return int(float(raw))
            except ValueError:
                return 0
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 0


def number(value: Any, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed == parsed else fallback


def bucket_timestamp_ms(ts_ms: int, bucket_ms: int) -> int:
    if bucket_ms >= 24 * 60 * 60_000:
        dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
        return int(datetime(dt.year, dt.month, dt.day, tzinfo=timezone.utc).timestamp() * 1000)
    return (ts_ms // bucket_ms) * bucket_ms


def aggregate_bars(rows: list[dict[str, Any]], interval: str | float | int, limit: int) -> list[dict[str, Any]]:
    bucket_ms = interval_ms(interval)
    clean = sorted((row for row in rows if bar_timestamp_ms(row)), key=bar_timestamp_ms)
    if not clean:
        return []
    buckets: list[dict[str, Any]] = []
    current_key: int | None = None
    current: dict[str, Any] | None = None
    for row in clean:
        ts_ms = bar_timestamp_ms(row)
        bucket = bucket_timestamp_ms(ts_ms, bucket_ms)
        close = number(row.get("close"), number(row.get("price"), 0))
        open_px = number(row.get("open"), close)
        high = number(row.get("high"), max(open_px, close))
        low = number(row.get("low"), min(open_px, close))
        volume = number(row.get("volume"), 0)
        if current is None or current_key != bucket:
            if current is not None:
                buckets.append(current)
            current_key = bucket
            current = {
                "timestamp": bucket,
                "open": open_px,
                "high": high,
                "low": low,
                "close": close,
                "volume": volume,
            }
            continue
        current["high"] = max(number(current["high"]), high)
        current["low"] = min(number(current["low"]), low)
        current["close"] = close
        current["volume"] = number(current.get("volume")) + volume
    if current is not None:
        buckets.append(current)
    return buckets[-max(1, min(limit, 4500)) :]


def databento_symbol(asset: str) -> str | None:
    meta = CME_INSTRUMENTS.get(asset)
    return str(meta["symbol"]) if meta else None


def historical_cache_key(asset: str, interval: str, limit: int) -> str:
    return f"{asset.upper()}:{interval}:{max(1, min(int(limit), 4500))}"


def cached_historical_backfill(asset: str, interval: str, limit: int) -> list[dict[str, Any]]:
    cached = HISTORICAL_BAR_CACHE.get(historical_cache_key(asset, interval, limit))
    if cached and time.time() - cached[0] < HISTORICAL_CACHE_TTL_SECONDS:
        return cached[1]
    return []


def _databento_schema(interval: str) -> str:
    raw = interval.strip().lower()
    if raw in {"1d", "d", "day"}:
        return "ohlcv-1d"
    if raw in {"1h", "1hr", "60"}:
        return "ohlcv-1h"
    return "ohlcv-1m"


def _databento_end(schema: str) -> datetime:
    cached = DATABENTO_END_CACHE.get(schema)
    if cached and time.time() - cached[0] < 3600:
        return cached[1]

    import databento as db

    client = db.Historical(key=settings.databento_api_key)
    dataset_range = client.metadata.get_dataset_range(settings.cme_dataset)
    schema_range = dataset_range.get("schema", {}).get(schema, {})
    end_raw = schema_range.get("end") or dataset_range.get("end")
    if not end_raw:
        end = datetime.now(timezone.utc)
    else:
        end = datetime.fromisoformat(str(end_raw).replace("Z", "+00:00"))
    DATABENTO_END_CACHE[schema] = (time.time(), end)
    return end


def _databento_lookback(interval: str, limit: int) -> timedelta:
    bucket_ms = interval_ms(interval)
    schema = _databento_schema(interval)
    if schema == "ohlcv-1m":
        # Futures sessions have weekend and daily maintenance gaps, so calendar
        # minutes must be wider than the requested bar span.
        minutes = max(90, min(200_000, (limit + 40) * max(1, bucket_ms // 60_000) * 4))
        return timedelta(minutes=minutes)
    if schema == "ohlcv-1h":
        return timedelta(hours=max(48, min(3000, limit + 20)))
    return timedelta(days=max(90, min(2500, limit + 20)))


def databento_ohlcv(symbol: str, interval: str, limit: int) -> list[dict[str, Any]]:
    import databento as db

    schema = _databento_schema(interval)
    end = _databento_end(schema)
    start = end - _databento_lookback(interval, limit)
    cache_key = f"{settings.cme_dataset}:{schema}:{symbol}:{int(start.timestamp())}:{int(end.timestamp())}:{limit}"
    cached = DATABENTO_OHLCV_CACHE.get(cache_key)
    if cached and time.time() - cached[0] < 300:
        return cached[1]

    client = db.Historical(key=settings.databento_api_key)
    store = client.timeseries.get_range(
        dataset=settings.cme_dataset,
        schema=schema,
        symbols=symbol,
        stype_in="continuous",
        start=start,
        end=end,
    )
    df = store.to_df()
    rows: list[dict[str, Any]] = []
    for ts, row in df.iterrows():
        rows.append({
            "timestamp": int(ts.timestamp() * 1000),
            "open": number(row.get("open")),
            "high": number(row.get("high")),
            "low": number(row.get("low")),
            "close": number(row.get("close")),
            "volume": number(row.get("volume")),
            "source": f"databento-{schema}",
        })
    DATABENTO_OHLCV_CACHE[cache_key] = (time.time(), rows)
    return rows


def _flat_bar(timestamp: int, price: float, source: str) -> dict[str, Any]:
    return {
        "timestamp": timestamp,
        "open": price,
        "high": price,
        "low": price,
        "close": price,
        "volume": 0.0,
        "source": source,
    }


def _synthetic_bar(left: dict[str, Any], right: dict[str, Any], multiplier: float, source: str) -> dict[str, Any]:
    left_open = number(left.get("open"), number(left.get("close")))
    left_high = number(left.get("high"), left_open)
    left_low = number(left.get("low"), left_open)
    left_close = number(left.get("close"), left_open)
    right_open = number(right.get("open"), number(right.get("close")))
    right_high = number(right.get("high"), right_open)
    right_low = number(right.get("low"), right_open)
    right_close = number(right.get("close"), right_open)

    if multiplier < 0:
        high = left_high + right_low * multiplier
        low = left_low + right_high * multiplier
    else:
        high = left_high + right_high * multiplier
        low = left_low + right_low * multiplier

    return {
        "timestamp": bar_timestamp_ms(left),
        "open": left_open + right_open * multiplier,
        "high": max(high, low),
        "low": min(high, low),
        "close": left_close + right_close * multiplier,
        "volume": min(number(left.get("volume")), number(right.get("volume"))),
        "source": source,
    }


def _compose_aligned_synthetic_rows(
    left_rows: list[dict[str, Any]],
    right_rows: list[dict[str, Any]],
    multiplier: float,
    source: str,
) -> list[dict[str, Any]]:
    left_by_ts = {bar_timestamp_ms(row): row for row in left_rows if bar_timestamp_ms(row)}
    right_by_ts = {bar_timestamp_ms(row): row for row in right_rows if bar_timestamp_ms(row)}
    timestamps = sorted(set(left_by_ts) | set(right_by_ts))
    rows: list[dict[str, Any]] = []
    current_left: dict[str, Any] | None = None
    current_right: dict[str, Any] | None = None
    last_left_close: float | None = None
    last_right_close: float | None = None

    for timestamp in timestamps:
        left = left_by_ts.get(timestamp)
        right = right_by_ts.get(timestamp)
        if left is not None:
            current_left = left
            last_left_close = number(left.get("close"))
        elif last_left_close is not None:
            current_left = _flat_bar(timestamp, last_left_close, source)

        if right is not None:
            current_right = right
            last_right_close = number(right.get("close"))
        elif last_right_close is not None:
            current_right = _flat_bar(timestamp, last_right_close, source)

        if current_left is None or current_right is None:
            continue

        left_for_ts = dict(current_left)
        right_for_ts = dict(current_right)
        left_for_ts["timestamp"] = timestamp
        right_for_ts["timestamp"] = timestamp
        rows.append(_synthetic_bar(left_for_ts, right_for_ts, multiplier, source))

    return rows


def compose_synthetic_history(asset: str, interval: str, limit: int) -> list[dict[str, Any]]:
    spread = SYNTHETIC_SPREADS.get(asset)
    if not spread:
        return []
    left_symbol = databento_symbol(str(spread["left"]))
    right_symbol = databento_symbol(str(spread["right"]))
    if not left_symbol or not right_symbol:
        return []
    with ThreadPoolExecutor(max_workers=2) as pool:
        left_future = pool.submit(databento_ohlcv, left_symbol, interval, limit)
        right_future = pool.submit(databento_ohlcv, right_symbol, interval, limit)
        left_rows = aggregate_bars(left_future.result(), interval, limit * 4)
        right_rows = aggregate_bars(right_future.result(), interval, limit * 4)
    multiplier = float(spread["right_multiplier"])
    return _compose_aligned_synthetic_rows(left_rows, right_rows, multiplier, "databento-synthetic-spread")


def historical_backfill(asset: str, interval: str, limit: int) -> list[dict[str, Any]]:
    if not settings.databento_api_key:
        return []
    key = asset.upper()
    requested_limit = max(1, min(int(limit), 4500))
    cache_key = historical_cache_key(key, interval, requested_limit)
    cached = cached_historical_backfill(key, interval, requested_limit)
    if cached:
        return cached
    try:
        symbol = databento_symbol(key)
        rows = databento_ohlcv(symbol, interval, requested_limit) if symbol else compose_synthetic_history(key, interval, requested_limit)
    except Exception:
        return []
    rows = aggregate_bars(rows, interval, requested_limit)
    if not rows:
        return []
    HISTORICAL_BAR_CACHE[cache_key] = (time.time(), rows)
    return rows


def merge_bars(live_rows: list[dict[str, Any]], historical_rows: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    by_ts = {bar_timestamp_ms(row): row for row in historical_rows if bar_timestamp_ms(row)}
    for row in live_rows:
        ts_ms = bar_timestamp_ms(row)
        if ts_ms:
            by_ts[ts_ms] = row
    return sorted(by_ts.values(), key=bar_timestamp_ms)[-max(1, min(limit, 4500)) :]
