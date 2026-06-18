from __future__ import annotations

import json
import math
import hashlib
import time
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean
from typing import Any

from services.common.bus import market_bus
from services.common.contracts import SYNTHETIC_SPREADS
from services.common.historical import bar_timestamp_ms, interval_ms
from services.studies.service import studies_service

ROOT = Path(__file__).resolve().parents[2]
FILLS_JOURNAL = ROOT / "data" / "fills" / "fills-journal.json"
RUNTIME_STATE_FILE = ROOT / "data" / "runtime" / "algo-order-runtime-state.json"
TRADE_ANALYTICS_ACCOUNT_SIZE = 500_000

NEWS_FEEDS = [
    ("Yahoo Finance", "https://finance.yahoo.com/news/rssindex"),
    ("CNBC Markets", "https://www.cnbc.com/id/100003114/device/rss/rss.html"),
    ("NBC Business", "https://feeds.nbcnews.com/nbcnews/public/business"),
]

NEWS_CACHE: dict[str, Any] = {"fetched_at": 0.0, "state": None}
GOOSE_UPDATE_SECONDS = 15 * 60.0
GOOSE_SWITCH_Z_DELTA = 0.45
GOOSE_ENTRY_Z = 1.5
GOOSE_HIGH_CONFIDENCE_Z = 2.25
GOOSE_CACHE: dict[str, Any] = {"updated_at": 0.0, "state": None}
SPREAD_RV_INTERVAL = "1d"
SPREAD_RV_LOOKBACK_DAYS = 30
SPREAD_RV_BACKFILL_LIMIT = 90
SPREAD_SIGNIFICANT_Z_DELTA = 0.35
SPREAD_SIGNIFICANT_ATR_MOVE = 0.35
SPREAD_PACK_CACHE: dict[str, Any] = {"updated_at": 0.0, "state": None}
LR_PEG_INTERVAL = "30m"
LR_PEG_PERIOD = 27
LR_PEG_BACKFILL_LIMIT = 80


SPREAD_DISPLAY = {
    "ES_NQ": "ES / NQ",
    "YM_ES": "YM / ES",
    "RTY_ES": "RTY / ES",
}

SPREAD_CONFIGS = [
    {
        "symbol": "ES_NQ",
        "label": "ES / NQ",
        "meaning": "Long broad S&P beta vs short Nasdaq growth.",
        "legA": "ES",
        "legB": "NQ",
        "ttRatio": "3 ES / -2 NQ",
        "displayFormula": "ES - 0.2667 * NQ",
        "syntheticTickValue": 37.5,
        "leftMultiplier": 50,
        "rightMultiplier": 20,
        "ratio": -0.2666667,
    },
    {
        "symbol": "YM_ES",
        "label": "YM / ES",
        "meaning": "Long Dow/value/cyclicals vs short S&P core.",
        "legA": "YM",
        "legB": "ES",
        "ttRatio": "3 YM / -2 ES",
        "displayFormula": "YM - 6.6667 * ES",
        "syntheticTickValue": 15,
        "leftMultiplier": 5,
        "rightMultiplier": 50,
        "ratio": -(20 / 3),
    },
    {
        "symbol": "RTY_ES",
        "label": "RTY / ES",
        "meaning": "Long small-cap domestic beta vs short S&P large cap.",
        "legA": "RTY",
        "legB": "ES",
        "ttRatio": "7 RTY / -3 ES",
        "displayFormula": "RTY - 0.4265 * ES",
        "syntheticTickValue": 35,
        "leftMultiplier": 50,
        "rightMultiplier": 50,
        "ratio": -0.4265,
    },
]

CROSS_SPREAD_PLAYBOOK_ROWS = [
    {
        "signalCombination": "RTY/ES up + ES/NQ up",
        "interpretation": "Small caps outperform, Nasdaq underperforms. Broadening / domestic cyclicals.",
        "expression": "Long RTY / short NQ",
        "risk": "Watch rates and credit. This can reverse violently on hawkish shocks.",
    },
    {
        "signalCombination": "RTY/ES down + ES/NQ down",
        "interpretation": "Small caps lag, Nasdaq leads. Narrow mega-cap growth regime.",
        "expression": "Long NQ / short RTY",
        "risk": "Momentum can persist. Avoid premature fades.",
    },
    {
        "signalCombination": "YM/ES up + RTY/ES up",
        "interpretation": "Value, cyclicals, and small caps all improving.",
        "expression": "Long YM and RTY basket / short ES",
        "risk": "Confirm with market breadth and regional banks.",
    },
    {
        "signalCombination": "YM/ES up + RTY/ES down",
        "interpretation": "Dow/value outperforms, but small-cap credit beta is still suspect.",
        "expression": "Long YM / short RTY",
        "risk": "Often defensive value, not true risk-on.",
    },
    {
        "signalCombination": "ES/NQ down + YM/ES down",
        "interpretation": "Nasdaq and S&P growth leadership over Dow value.",
        "expression": "Long NQ / short YM",
        "risk": "Size carefully around earnings concentration in mega-cap tech.",
    },
]

CROSS_SPREAD_PRODUCT_ROWS = [
    {
        "spread": "ES_NQ",
        "label": "ES / NQ",
        "tag": "Momentum-sensitive",
        "formula": "Spread = ES - 0.2667 * NQ",
        "buy": "Long ES / short NQ. This is a fade of Nasdaq outperformance or a broadening trade.",
        "sell": "Short ES / long NQ. This is a mega-cap tech leadership trade.",
        "nuance": "ES/NQ mean reversion is less reliable when AI, semiconductors, or mega-cap quality are leading with genuine earnings momentum.",
    },
    {
        "spread": "YM_ES",
        "label": "YM / ES",
        "tag": "Calmer leadership spread",
        "formula": "Spread = YM - 6.6667 * ES",
        "buy": "Long YM / short ES. You want Dow value, industrials, financials, or defensive cyclicals to outperform.",
        "sell": "Short YM / long ES. You want S&P mega-cap and growth weight to outperform the Dow.",
        "nuance": "YM is price-weighted and only 30 stocks, so single-stock Dow composition matters more than in ES.",
    },
    {
        "spread": "RTY_ES",
        "label": "RTY / ES",
        "tag": "Credit and rates sensitive",
        "formula": "Spread = RTY - 0.4265 * ES",
        "buy": "Long RTY / short ES. You want small caps, domestic cyclicals, regional banks, and breadth to improve.",
        "sell": "Short RTY / long ES. You want large-cap quality, mega-cap tech, or balance-sheet strength to dominate.",
        "nuance": "RTY can remain cheap for structural reasons when rates are high or credit spreads widen.",
    },
]

CROSS_SPREAD_RTY_ES_TRADE_PLAN = [
    {
        "title": "Long RTY / Short ES",
        "body": "Use when the spread is below fair value by at least 1.5 ATR and small-cap risk appetite is improving. Ideal confirmations: falling yields, tightening high-yield spreads, KRE/regional bank strength, RTY outperforming ES, and expanding market breadth.",
    },
    {
        "title": "Short RTY / Long ES",
        "body": "Use when the spread is above fair value by at least 1.5 ATR or when macro confirms that large-cap quality should dominate: higher yields, wider credit spreads, weak banks, poor breadth, or renewed mega-cap leadership.",
    },
    {
        "title": "Position Construction",
        "body": "Start with 7 RTY / -3 ES. If rolling beta materially diverges from the static notional ratio, adjust the display coefficient and/or trade ratio. Keep the trade ratio, displayed synthetic formula, and risk system in sync.",
    },
]

CROSS_SPREAD_RISK_CHECK_ROWS = [
    {"risk": "Tail beta mismatch", "control": "Measure dollar delta by leg and rebalance when index levels move materially."},
    {"risk": "Hidden ES exposure", "control": "When combining spreads, net all ES legs before sizing."},
    {"risk": "Volatility regime shift", "control": "Use ATR percentile to reduce size above the 80th percentile."},
    {"risk": "Macro invalidation", "control": "Stop buying small-cap weakness if rates and credit both deteriorate."},
    {"risk": "Execution slippage", "control": "Use legging settings conservatively around data releases and cash open."},
]


def _bars(symbol: str) -> list[dict[str, Any]]:
    return list(market_bus.bars.get(symbol, []))


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _number(value: Any, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if math.isfinite(parsed) else fallback


def _read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def _fills() -> list[dict[str, Any]]:
    payload = _read_json(FILLS_JOURNAL, {})
    fills = payload.get("fills") if isinstance(payload, dict) else payload
    return [fill for fill in fills if isinstance(fill, dict)] if isinstance(fills, list) else []


def _runtime_state() -> dict[str, Any]:
    payload = _read_json(RUNTIME_STATE_FILE, {})
    return payload if isinstance(payload, dict) else {}


def _latest(symbol: str) -> float:
    quote = market_bus.quotes.get(symbol)
    if quote:
        return quote.last
    rows = _bars(symbol)
    if rows:
        return _number(rows[-1].get("close"))
    return 0.0


def _change(symbol: str, lookback: int = 60) -> float:
    rows = _bars(symbol)
    if len(rows) < 2:
        return 0.0
    start = _number(rows[max(0, len(rows) - lookback)].get("close"))
    end = _number(rows[-1].get("close"))
    return (end - start) / start if start else 0.0


def _ratio_change(left: str, right: str, lookback: int = 60) -> float:
    left_rows = _bars(left)
    right_rows = _bars(right)
    if len(left_rows) < 2 or len(right_rows) < 2:
        return 0.0
    left_start = _number(left_rows[max(0, len(left_rows) - lookback)].get("close"))
    left_end = _number(left_rows[-1].get("close"))
    right_start = _number(right_rows[max(0, len(right_rows) - lookback)].get("close"))
    right_end = _number(right_rows[-1].get("close"))
    if not left_start or not right_start:
        return 0.0
    return (left_end / left_start) - (right_end / right_start)


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _safe_mean(values: list[float]) -> float:
    clean = [value for value in values if math.isfinite(value)]
    return mean(clean) if clean else 0.0


def _true_ranges(rows: list[dict[str, Any]]) -> list[float]:
    ranges: list[float] = []
    for index in range(1, len(rows)):
        current = rows[index]
        prior = rows[index - 1]
        high = _number(current.get("high"), _number(current.get("close")))
        low = _number(current.get("low"), _number(current.get("close")))
        prior_close = _number(prior.get("close"))
        ranges.append(max(high - low, abs(high - prior_close), abs(low - prior_close)))
    return ranges


def _daily_vwap_basis(row: dict[str, Any] | None) -> float:
    if not row:
        return 0.0
    vwap = row.get("vwap")
    if vwap is not None and math.isfinite(_number(vwap)):
        return _number(vwap)
    return _safe_mean([
        _number(row.get("high")),
        _number(row.get("low")),
        _number(row.get("close")),
    ])


def _spread_signal(z: float) -> str:
    if z <= -1.5:
        return "Buy spread setup"
    if z >= 1.5:
        return "Sell spread setup"
    if z <= -1.0:
        return "Cheap watch; wait for reclaim"
    if z >= 1.0:
        return "Rich watch; wait for fade"
    if abs(z) < 0.5:
        return "Neutral / fair value"
    return "Rich, wait or fade" if z > 0 else "Cheap, wait or confirm"


def _linear_regression_band(closes: list[float], period: int = 27, deviations: float = 2.0) -> dict[str, float | None]:
    lookback = max(2, int(period))
    sample = [value for value in closes[-lookback:] if math.isfinite(value)]
    if len(sample) < lookback:
        return {
            "mean": None,
            "upper": None,
            "lower": None,
            "sigma": None,
            "slope": None,
        }

    n = len(sample)
    x_mean = (n - 1) / 2
    y_mean = mean(sample)
    numerator = 0.0
    denominator = 0.0
    for index, value in enumerate(sample):
        numerator += (index - x_mean) * (value - y_mean)
        denominator += (index - x_mean) ** 2
    slope = numerator / denominator if denominator else 0.0
    intercept = y_mean - slope * x_mean
    residuals = [value - (intercept + slope * index) for index, value in enumerate(sample)]
    sigma = math.sqrt(mean([value**2 for value in residuals])) if residuals else 0.0
    latest_mean = intercept + slope * (n - 1)
    std = max(0.0, float(deviations))
    return {
        "mean": latest_mean,
        "upper": latest_mean + std * sigma,
        "lower": latest_mean - std * sigma,
        "sigma": sigma,
        "slope": slope,
    }


def _completed_interval_bars(rows: list[dict[str, Any]], interval: str) -> list[dict[str, Any]]:
    bucket_ms = interval_ms(interval)
    now_ms = int(time.time() * 1000)
    return [
        row
        for row in rows
        if bar_timestamp_ms(row) and bar_timestamp_ms(row) + bucket_ms <= now_ms
    ]


def _bar_is_forming(row: dict[str, Any] | None, interval: str) -> bool:
    if not row:
        return False
    ts_ms = bar_timestamp_ms(row)
    return bool(ts_ms and ts_ms + interval_ms(interval) > int(time.time() * 1000))


def _lr_peg_bars(symbol: str) -> list[dict[str, Any]]:
    # Use bars() (not cached_bars) so the algo peg gets the same historical
    # backfill as the chart's LR27.  cached_bars() silently returns [] on a
    # cold cache, causing the regression to be computed from only a handful
    # of live rolling bars — which is why orders land at the wrong price.
    rows = studies_service.bars(symbol, LR_PEG_INTERVAL, LR_PEG_BACKFILL_LIMIT, include_forming=False)
    return _completed_interval_bars(rows, LR_PEG_INTERVAL)[-LR_PEG_BACKFILL_LIMIT:]


def _daily_rv_bars(symbol: str) -> list[dict[str, Any]]:
    rows = studies_service.cached_bars(symbol, SPREAD_RV_INTERVAL, SPREAD_RV_BACKFILL_LIMIT, include_forming=False)
    return _completed_interval_bars(rows, SPREAD_RV_INTERVAL)[-SPREAD_RV_BACKFILL_LIMIT:]


def _spread_stats(symbol: str) -> dict[str, Any]:
    rows = _bars(symbol)
    quote = market_bus.quotes.get(symbol)
    with ThreadPoolExecutor(max_workers=2) as pool:
        daily_future = pool.submit(_daily_rv_bars, symbol)
        lr_future = pool.submit(_lr_peg_bars, symbol)
        daily_bars = daily_future.result()
        lr_bars = lr_future.result()
    closes = [_number(row.get("close")) for row in daily_bars if row.get("close") is not None]
    last_completed = daily_bars[-1] if daily_bars else None
    prior_completed = daily_bars[-2] if len(daily_bars) >= 2 else last_completed
    last = quote.last if quote else (closes[-1] if closes else (rows[-1]["close"] if rows else 0.0))
    if len(closes) < 2:
        closes = [last - 1, last]
    lookback_days = SPREAD_RV_LOOKBACK_DAYS
    window = closes[-lookback_days:] if len(closes) >= lookback_days else closes
    prior_window = closes[-(lookback_days * 2):-lookback_days] if len(closes) >= lookback_days * 2 else []
    center = mean(window)
    prior_center = mean(prior_window) if prior_window else center
    ranges = _true_ranges(daily_bars)
    atr3 = mean(ranges[-3:]) if ranges else 0.0
    atr30 = mean(ranges[-lookback_days:]) if ranges else 0.0
    atr = _safe_mean([atr3, atr30])
    if atr <= 0:
        atr = max(abs(last) * 0.001, 0.01)
    z = (last - center) / atr if atr else 0.0
    half_atr = atr / 2
    vwap_basis = _daily_vwap_basis(last_completed)
    day_z = (last - vwap_basis) / half_atr if half_atr else 0.0
    threshold = 1.5
    abs_z = abs(z)
    bias = "buy" if z <= -threshold else "sell" if z >= threshold else "watch" if abs_z >= 1.0 else "neutral"
    move_from_mean = last - center
    order_flow = _clamp((abs_z - 0.5) / 1.75, 0, 1)
    lr_closes = [_number(row.get("close")) for row in lr_bars if row.get("close") is not None]
    lr27 = _linear_regression_band(lr_closes, LR_PEG_PERIOD, 2.0)
    lr_updated_at = bar_timestamp_ms(lr_bars[-1]) if lr_bars else 0
    active_lr_bars = market_bus.rolling_ohlcv(symbol, LR_PEG_INTERVAL, 1, include_forming=True)
    active_lr_bar = active_lr_bars[-1] if active_lr_bars and _bar_is_forming(active_lr_bars[-1], LR_PEG_INTERVAL) else None
    active_lr_updated_at = int(_number(active_lr_bar.get("lastUpdateMs"), bar_timestamp_ms(active_lr_bar))) if active_lr_bar else 0
    rv_updated_at = bar_timestamp_ms(daily_bars[-1]) if daily_bars else 0
    return {
        "key": symbol,
        "label": SPREAD_DISPLAY.get(symbol, symbol),
        "spread": last,
        "mean": center,
        "longTermMean": center,
        "lookbackMean": center,
        "priorLookbackMean": prior_center,
        "lookbackDays": lookback_days,
        "priorSettle": _number(prior_completed.get("close")) if prior_completed else center,
        "lastTraded": last,
        "moveFromMean": move_from_mean,
        "movePctOfAtr": move_from_mean / atr if atr else 0.0,
        "atr": atr,
        "atr3": atr3,
        "atr20": atr30,
        "atr30": atr30,
        "blendedAtr": atr,
        "halfAtr": half_atr,
        "vwapBasis": vwap_basis,
        "dayZ": day_z,
        "z": z,
        "rawZ": z,
        "signalThreshold": threshold,
        "bias": bias,
        "orderFlowScore": round(order_flow * 100),
        "updateCadence": "Acme RV cadence: 30-session daily context; live marker reprices, forecast rails update only from completed daily study history",
        "rvInterval": SPREAD_RV_INTERVAL,
        "rvBars": min(len(closes), SPREAD_RV_BACKFILL_LIMIT),
        "rvUpdatedAt": rv_updated_at,
        "lr27Mean": lr27["mean"],
        "lr27Upper2": lr27["upper"],
        "lr27Lower2": lr27["lower"],
        "lr27Sigma": lr27["sigma"],
        "lr27Slope": lr27["slope"],
        "lr27Interval": LR_PEG_INTERVAL,
        "lr27Period": LR_PEG_PERIOD,
        "lr27Bars": min(len(lr_closes), LR_PEG_PERIOD),
        "lr27UpdatedAt": lr_updated_at,
        "lr27IsForming": False,
        "lr27ActiveBarLive": bool(active_lr_bar),
        "lr27ActiveBarUpdatedAt": active_lr_updated_at,
        "lr27Source": "databento-rest-baseline-plus-live-rolling-30m",
        "theoreticalBid": vwap_basis - half_atr,
        "theoreticalAsk": vwap_basis + half_atr,
        "signal": _spread_signal(z),
        "volume": quote.volume if quote else 0,
        "live": quote is not None,
        "bars": daily_bars[-SPREAD_RV_BACKFILL_LIMIT:],
        "legs": SYNTHETIC_SPREADS.get(symbol, {}),
    }


def _spread_publish_reason(previous: dict[str, Any] | None, candidate: dict[str, Any]) -> str:
    if not previous:
        return "initial daily RV publish"

    previous_rows = {
        str(item.get("key")): item
        for item in previous.get("spreads", [])
        if isinstance(item, dict)
    }
    for item in candidate.get("spreads", []):
        key = str(item.get("key"))
        prior = previous_rows.get(key)
        if not prior:
            return f"{key} added to daily RV pack"
        if item.get("rvUpdatedAt") and item.get("rvUpdatedAt") != prior.get("rvUpdatedAt"):
            return f"{key} completed a new daily RV bar"
        if item.get("bias") != prior.get("bias"):
            return f"{key} bias changed from {prior.get('bias')} to {item.get('bias')}"
        if item.get("signal") != prior.get("signal"):
            return f"{key} signal changed"

        z_delta = abs(_number(item.get("z")) - _number(prior.get("z")))
        if z_delta >= SPREAD_SIGNIFICANT_Z_DELTA:
            return f"{key} z-score moved {z_delta:.2f}"

        atr = max(abs(_number(item.get("atr"))), abs(_number(prior.get("atr"))), 0.01)
        last_delta = abs(_number(item.get("lastTraded")) - _number(prior.get("lastTraded")))
        atr_move = last_delta / atr
        if atr_move >= SPREAD_SIGNIFICANT_ATR_MOVE:
            return f"{key} moved {atr_move:.2f} ATR since last publish"

    previous_strongest = (previous.get("strongest") or {}).get("key")
    candidate_strongest = (candidate.get("strongest") or {}).get("key")
    candidate_z = abs(_number((candidate.get("strongest") or {}).get("z")))
    if previous_strongest != candidate_strongest and candidate_z >= GOOSE_ENTRY_Z:
        return f"strongest spread changed to {candidate_strongest}"

    return ""


def _is_finite(value: Any) -> bool:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(parsed)


def _lr27_ready(item: dict[str, Any]) -> bool:
    updated_at = _number(item.get("lr27UpdatedAt"))
    return (
        int(_number(item.get("lr27Bars"))) >= LR_PEG_PERIOD
        and _is_finite(item.get("lr27Mean"))
        and _is_finite(item.get("lr27Upper2"))
        and _is_finite(item.get("lr27Lower2"))
        and updated_at > 0
    )


def _rv_ready(item: dict[str, Any]) -> bool:
    updated_at = _number(item.get("rvUpdatedAt"))
    return (
        int(_number(item.get("rvBars"))) >= SPREAD_RV_LOOKBACK_DAYS
        and _is_finite(item.get("mean"))
        and _is_finite(item.get("atr"))
        and updated_at > 0
    )


def _apply_live_overlay_to_row(base: dict[str, Any], fresh: dict[str, Any]) -> dict[str, Any]:
    item = dict(base)
    for field in [
        "spread",
        "lastTraded",
        "volume",
        "live",
        "lr27ActiveBarLive",
        "lr27ActiveBarUpdatedAt",
    ]:
        if field in fresh:
            item[field] = fresh.get(field)

    last = _number(item.get("lastTraded") or item.get("spread"))
    atr = max(abs(_number(item.get("atr"))), 0.01)
    center = _number(item.get("lookbackMean") or item.get("mean"))
    z = (last - center) / atr if atr else 0.0
    item["z"] = z
    item["rawZ"] = z
    item["moveFromMean"] = last - center
    item["movePctOfAtr"] = item["moveFromMean"] / atr if atr else 0.0
    item["signal"] = _spread_signal(z)
    return item


def _protect_incomplete_studies(cached: dict[str, Any] | None, candidate: dict[str, Any]) -> dict[str, Any]:
    if not cached:
        return candidate
    cached_by_key = {
        str(item.get("key")): item
        for item in cached.get("spreads", [])
        if isinstance(item, dict)
    }
    protected = dict(candidate)
    rows: list[dict[str, Any]] = []
    for fresh in candidate.get("spreads", []):
        if not isinstance(fresh, dict):
            continue
        prior = cached_by_key.get(str(fresh.get("key")))
        if not prior:
            rows.append(fresh)
            continue
        needs_lr_protection = _lr27_ready(prior) and not _lr27_ready(fresh)
        needs_rv_protection = _rv_ready(prior) and not _rv_ready(fresh)
        if needs_lr_protection or needs_rv_protection:
            rows.append(_apply_live_overlay_to_row(prior, fresh))
        else:
            rows.append(fresh)
    protected["spreads"] = rows
    protected["strongest"] = sorted(rows, key=lambda item: abs(_number(item.get("z"))), reverse=True)[0] if rows else None
    return protected


def _overlay_live_mark_and_studies(cached: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    fresh_by_key = {
        str(item.get("key")): item
        for item in candidate.get("spreads", [])
        if isinstance(item, dict)
    }
    merged = {**cached, "calculatedAt": candidate.get("calculatedAt"), "liveOverlayAt": _iso_now()}
    merged_spreads: list[dict[str, Any]] = []
    for cached_item in cached.get("spreads", []):
        if not isinstance(cached_item, dict):
            continue
        item = dict(cached_item)
        fresh = fresh_by_key.get(str(item.get("key")))
        if fresh:
            for field in [
                "spread",
                "lastTraded",
                "volume",
                "live",
                "lr27ActiveBarLive",
                "lr27ActiveBarUpdatedAt",
            ]:
                item[field] = fresh.get(field)
            if not _lr27_ready(item) or _lr27_ready(fresh):
                for field in [
                    "lr27Mean",
                    "lr27Upper2",
                    "lr27Lower2",
                    "lr27Sigma",
                    "lr27Slope",
                    "lr27Interval",
                    "lr27Period",
                    "lr27Bars",
                    "lr27UpdatedAt",
                    "lr27IsForming",
                    "lr27Source",
                ]:
                    item[field] = fresh.get(field)
            if not _rv_ready(item) or _rv_ready(fresh):
                for field in [
                    "mean",
                    "longTermMean",
                    "lookbackMean",
                    "priorLookbackMean",
                    "lookbackDays",
                    "priorSettle",
                    "atr",
                    "atr3",
                    "atr20",
                    "atr30",
                    "blendedAtr",
                    "halfAtr",
                    "vwapBasis",
                    "dayZ",
                    "rvBars",
                    "rvUpdatedAt",
                    "bars",
                ]:
                    item[field] = fresh.get(field)
            item = _apply_live_overlay_to_row(item, fresh)
        merged_spreads.append(item)
    merged["spreads"] = merged_spreads
    strongest_key = (cached.get("strongest") or {}).get("key")
    merged["strongest"] = next((item for item in merged_spreads if item.get("key") == strongest_key), cached.get("strongest"))
    return merged


def _light_spread_stat(symbol: str) -> dict[str, Any]:
    quote = market_bus.quotes.get(symbol)
    last = quote.last if quote else 0.0
    return {
        "key": symbol,
        "label": SPREAD_DISPLAY.get(symbol, symbol),
        "spread": last,
        "mean": last,
        "longTermMean": last,
        "lookbackMean": last,
        "priorLookbackMean": last,
        "lookbackDays": SPREAD_RV_LOOKBACK_DAYS,
        "priorSettle": last,
        "lastTraded": last,
        "moveFromMean": 0.0,
        "movePctOfAtr": 0.0,
        "atr": 0.0,
        "atr3": 0.0,
        "atr20": 0.0,
        "atr30": 0.0,
        "blendedAtr": 0.0,
        "halfAtr": 0.0,
        "vwapBasis": last,
        "dayZ": 0.0,
        "z": 0.0,
        "rawZ": 0.0,
        "signalThreshold": 1.5,
        "bias": "warming",
        "orderFlowScore": 0,
        "updateCadence": "live quote overlay; full LR/RV study refresh deferred until requested",
        "rvInterval": SPREAD_RV_INTERVAL,
        "rvBars": 0,
        "rvUpdatedAt": 0,
        "lr27Mean": None,
        "lr27Upper2": None,
        "lr27Lower2": None,
        "lr27Sigma": None,
        "lr27Slope": None,
        "lr27Interval": LR_PEG_INTERVAL,
        "lr27Period": LR_PEG_PERIOD,
        "lr27Bars": 0,
        "lr27UpdatedAt": 0,
        "lr27IsForming": False,
        "lr27ActiveBarLive": False,
        "lr27ActiveBarUpdatedAt": 0,
        "lr27Source": "not-warmed",
        "theoreticalBid": last,
        "theoreticalAsk": last,
        "signal": "Studies warming",
        "volume": quote.volume if quote else 0,
        "live": quote is not None,
        "bars": [],
        "legs": SYNTHETIC_SPREADS.get(symbol, {}),
    }


def _overlay_live_marks_only(cached: dict[str, Any]) -> dict[str, Any]:
    merged = {**cached, "calculatedAt": cached.get("calculatedAt") or _iso_now(), "liveOverlayAt": _iso_now()}
    merged_spreads: list[dict[str, Any]] = []
    for cached_item in cached.get("spreads", []):
        if not isinstance(cached_item, dict):
            continue
        item = dict(cached_item)
        quote = market_bus.quotes.get(str(item.get("key")))
        if quote:
            item["spread"] = quote.last
            item["lastTraded"] = quote.last
            item["volume"] = quote.volume
            item["live"] = True
            atr = max(abs(_number(item.get("atr"))), 0.01)
            center = _number(item.get("lookbackMean") or item.get("mean"))
            z = (quote.last - center) / atr
            item["z"] = z
            item["rawZ"] = z
            item["moveFromMean"] = quote.last - center
            item["movePctOfAtr"] = item["moveFromMean"] / atr
            item["signal"] = _spread_signal(z)
        merged_spreads.append(item)
    merged["spreads"] = merged_spreads
    merged["strongest"] = sorted(merged_spreads, key=lambda item: abs(_number(item.get("z"))), reverse=True)[0] if merged_spreads else None
    return merged


def _light_spread_pack() -> dict[str, Any]:
    spreads = [_light_spread_stat(symbol) for symbol in SYNTHETIC_SPREADS]
    strongest = sorted(spreads, key=lambda item: abs(_number(item.get("z"))), reverse=True)[0] if spreads else None
    return {
        "service": "intelligence.spreads",
        "cadence": "lightweight-live-overlay",
        "calculatedAt": _iso_now(),
        "spreads": spreads,
        "strongest": strongest,
        "publishedAt": _iso_now(),
        "publishReason": "startup light pack",
    }


def spread_pack(force_refresh: bool = False) -> dict[str, Any]:
    cached = SPREAD_PACK_CACHE.get("state")
    if not force_refresh:
        if cached and isinstance(cached, dict):
            return _overlay_live_marks_only(cached)
        return _light_spread_pack()

    symbols = list(SYNTHETIC_SPREADS)
    with ThreadPoolExecutor(max_workers=max(1, min(len(symbols), 3))) as pool:
        spreads = list(pool.map(_spread_stats, symbols))
    strongest = sorted(spreads, key=lambda item: abs(item["z"]), reverse=True)[0] if spreads else None
    candidate = {
        "service": "intelligence.spreads",
        "cadence": "daily-resolution-significant-change",
        "calculatedAt": _iso_now(),
        "spreads": spreads,
        "strongest": strongest,
    }
    cached = SPREAD_PACK_CACHE.get("state")
    candidate = _protect_incomplete_studies(cached if isinstance(cached, dict) else None, candidate)
    reason = _spread_publish_reason(cached if isinstance(cached, dict) else None, candidate)
    if cached and isinstance(cached, dict) and not reason:
        return _overlay_live_mark_and_studies(cached, candidate)

    published_at = _iso_now()
    candidate["publishedAt"] = published_at
    candidate["publishReason"] = reason or "manual daily RV refresh"
    for item in candidate["spreads"]:
        item["publishedAt"] = published_at
        item["publishReason"] = candidate["publishReason"]
    SPREAD_PACK_CACHE.update({"updated_at": time.time(), "state": candidate})
    return candidate


def _goose_candidate(pack: dict[str, Any], previous: dict[str, Any] | None) -> dict[str, Any] | None:
    spreads = list(pack.get("spreads") or [])
    if not spreads:
        return None
    strongest = sorted(spreads, key=lambda item: abs(float(item.get("z", 0))), reverse=True)[0]
    if not previous:
        return strongest

    previous_strategy = str(previous.get("strategy") or "")
    previous_spread = next((item for item in spreads if str(item.get("label")) == previous_strategy), None)
    if previous_spread is None:
        return strongest

    previous_z = abs(_number(previous_spread.get("z")))
    strongest_z = abs(_number(strongest.get("z")))
    if str(strongest.get("label")) != previous_strategy and strongest_z < max(GOOSE_ENTRY_Z, previous_z + GOOSE_SWITCH_Z_DELTA):
        return previous_spread

    previous_direction = str(previous.get("direction") or "")
    strongest_direction = "Long spread / mean reversion" if _number(strongest.get("z")) <= 0 else "Short spread / mean reversion"
    if str(strongest.get("label")) == previous_strategy and previous_direction and strongest_direction != previous_direction and strongest_z < GOOSE_ENTRY_Z + GOOSE_SWITCH_Z_DELTA:
        return previous_spread

    return strongest


def _build_goose(pack: dict[str, Any], previous: dict[str, Any] | None = None) -> dict[str, Any]:
    strongest = _goose_candidate(pack, previous)
    if not strongest:
        return {
            "service": "advisor.goose",
            "strategy": "Waiting",
            "direction": "-",
            "risk": "Conservative",
            "confidence": "Low",
            "read": "Waiting for synthetic spread marks.",
            "evidence": [],
            "updateCadence": "daily RV advisory; updates only after a meaningful spread-pack publish",
        }
    z = _number(strongest.get("z"))
    abs_z = abs(z)
    direction = "Long spread / mean reversion" if strongest["z"] <= 0 else "Short spread / mean reversion"
    risk = "Aggressive" if abs_z >= GOOSE_HIGH_CONFIDENCE_Z else "Moderate" if abs_z >= GOOSE_ENTRY_Z else "Conservative"
    confidence = "High" if abs_z >= GOOSE_HIGH_CONFIDENCE_Z else "Medium" if abs_z >= GOOSE_ENTRY_Z else "Low"
    evidence = [
        ["Daily RV location", f"{strongest['label']} last {strongest['lastTraded']:.3f} vs 30-session daily mean {strongest['longTermMean']:.3f}; z {strongest['z']:.2f}"],
        ["Daily ATR framework", f"3/30 blended daily ATR {strongest['atr']:.3f}; trigger +/-{strongest['signalThreshold']:.1f} ATR; bid/ask bands {strongest['theoreticalBid']:.3f} / {strongest['theoreticalAsk']:.3f}"],
        ["Signal", strongest["signal"]],
        ["Order flow pressure", f"{strongest['orderFlowScore']}/100 intensity; Goose ignores normal tick noise and requires material daily RV movement."],
        ["Cadence", f"Daily resolution; held until a completed daily bar, signal/bias change, {SPREAD_SIGNIFICANT_Z_DELTA:.2f} z move, or {SPREAD_SIGNIFICANT_ATR_MOVE:.2f} ATR move."],
        ["Source", "Live CME-derived synthetic spread marks through Cerious price service"],
    ]
    read = (
        f"GOOSE favors {strongest['label']} as the active relative-value focus. "
        f"{direction}. Risk posture {risk}; confidence {confidence}. "
        "Use planned clips only when live ladder liquidity, 30-session location, macro regime, and spread z-score stop worsening."
    )
    return {
        "service": "advisor.goose",
        "strategy": strongest["label"],
        "direction": direction,
        "risk": risk,
        "confidence": confidence,
        "read": read,
        "evidence": evidence,
        "spreadPack": pack,
        "updateCadence": "daily RV advisory; updates only after meaningful spread-pack change",
        "publishReason": pack.get("publishReason"),
        "updatedAt": _iso_now(),
    }


def goose() -> dict[str, Any]:
    now = time.time()
    cached = GOOSE_CACHE.get("state")
    pack = spread_pack()
    cached_pack_at = (cached.get("spreadPack") or {}).get("publishedAt") if isinstance(cached, dict) else None
    if cached and cached_pack_at == pack.get("publishedAt"):
        return cached
    if cached and now - float(GOOSE_CACHE.get("updated_at") or 0) < GOOSE_UPDATE_SECONDS and not pack.get("publishReason"):
        return cached

    next_state = _build_goose(pack, cached if isinstance(cached, dict) else None)
    next_state["nextReviewSeconds"] = GOOSE_UPDATE_SECONDS
    GOOSE_CACHE["updated_at"] = now
    GOOSE_CACHE["state"] = next_state
    return next_state


def acme_intelligence(force_refresh: bool = False) -> dict[str, Any]:
    pack = spread_pack(force_refresh=force_refresh)
    macro = macro_regime_state()
    return {
        "goose": goose(),
        "spreadPack": pack,
        "macroRegime": macro,
        "liveSpreadSignals": [
            {
                "key": item["key"],
                "label": item["label"],
                "spread": item["spread"],
                "lastTraded": item["lastTraded"],
                "mean": item["mean"],
                "longTermMean": item["longTermMean"],
                "lookbackMean": item["lookbackMean"],
                "lookbackDays": item["lookbackDays"],
                "priorSettle": item["priorSettle"],
                "moveFromMean": item["moveFromMean"],
                "movePctOfAtr": item["movePctOfAtr"],
                "z": item["z"],
                "atr": item["atr"],
                "atr3": item["atr3"],
                "atr20": item["atr20"],
                "atr30": item["atr30"],
                "blendedAtr": item["blendedAtr"],
                "halfAtr": item["halfAtr"],
                "vwapBasis": item["vwapBasis"],
                "dayZ": item["dayZ"],
                "signalThreshold": item["signalThreshold"],
                "bias": item["bias"],
                "orderFlowScore": item["orderFlowScore"],
                "updateCadence": item["updateCadence"],
                "rvInterval": item["rvInterval"],
                "rvBars": item["rvBars"],
                "rvUpdatedAt": item["rvUpdatedAt"],
                "publishedAt": item.get("publishedAt"),
                "publishReason": item.get("publishReason"),
                "lr27Mean": item["lr27Mean"],
                "lr27Upper2": item["lr27Upper2"],
                "lr27Lower2": item["lr27Lower2"],
                "lr27Sigma": item["lr27Sigma"],
                "lr27Slope": item["lr27Slope"],
                "lr27Interval": item["lr27Interval"],
                "lr27Period": item["lr27Period"],
                "lr27Bars": item["lr27Bars"],
                "lr27UpdatedAt": item["lr27UpdatedAt"],
                "lr27IsForming": item["lr27IsForming"],
                "lr27Source": item["lr27Source"],
                "signal": item["signal"],
                "theoreticalBid": item["theoreticalBid"],
                "theoreticalAsk": item["theoreticalAsk"],
                "volume": item["volume"],
                "live": item["live"],
            }
            for item in pack["spreads"]
        ],
    }


def _news_id(item: dict[str, Any]) -> str:
    raw = f"{item.get('source')}|{item.get('title')}|{item.get('pubDate') or item.get('link')}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:24]


def _classify_news_item(item: dict[str, Any]) -> dict[str, Any]:
    text = f"{item.get('title', '')} {item.get('description', '')}".lower()
    urgent = any(term in text for term in [
        "fed", "fomc", "powell", "cpi", "pce", "jobs", "payroll", "tariff",
        "treasury", "yield", "inflation", "war", "attack", "oil", "default",
        "downgrade", "bank", "credit", "recession",
    ])
    risk_on = any(term in text for term in [
        "rally", "surge", "beats", "eases", "cuts", "soft landing", "stimulus",
        "record high", "risk-on", "cooling inflation",
    ])
    risk_off = any(term in text for term in [
        "selloff", "plunge", "misses", "hot inflation", "hikes", "default",
        "downgrade", "recession", "risk-off", "bank stress", "widening",
    ])
    return {
        **item,
        "id": item.get("id") or _news_id(item),
        "receivedAt": _iso_now(),
        "urgency": "high" if urgent else "normal",
        "bias": "risk-on" if risk_on and not risk_off else "risk-off" if risk_off and not risk_on else "mixed",
    }


def _parse_rss(xml: str, source: str) -> list[dict[str, Any]]:
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return []
    items: list[dict[str, Any]] = []
    for node in root.findall(".//item")[:12]:
        def text(name: str) -> str:
            found = node.find(name)
            return "".join(found.itertext()).strip() if found is not None else ""
        title = text("title")
        if not title:
            continue
        items.append({
            "source": source,
            "title": title,
            "link": text("link"),
            "pubDate": text("pubDate") or _iso_now(),
            "description": text("description"),
        })
    return items


def _fetch_news_feed(source: str, url: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/rss+xml,text/xml,*/*", "User-Agent": "CeriousSystems/1.0"},
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        xml = response.read().decode("utf-8", errors="replace")
    items = _parse_rss(xml, source)
    return items, {"source": source, "ok": True, "count": len(items)}


def news_state() -> dict[str, Any]:
    now = time.time()
    if NEWS_CACHE["state"] and now - float(NEWS_CACHE["fetched_at"]) < 60:
        return NEWS_CACHE["state"]

    news: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    warnings: list[str] = []
    for source, url in NEWS_FEEDS:
        try:
            items, status = _fetch_news_feed(source, url)
            news.extend(items)
            sources.append(status)
        except Exception as exc:  # noqa: BLE001 - feed failures should degrade, not break the terminal.
            sources.append({"source": source, "ok": False, "count": 0, "warning": str(exc)})
            warnings.append(f"{source}: {exc}")

    if not news:
        pack = spread_pack()
        strongest = pack.get("strongest") or {}
        news = [
            {
                "source": "Cerious local intelligence",
                "title": f"{strongest.get('label', 'CME spread')} is the active relative-value focus",
                "description": strongest.get("signal", "Waiting for live spread signal."),
                "link": "",
                "pubDate": _iso_now(),
            },
            {
                "source": "Cerious local intelligence",
                "title": f"Market data source: {market_bus.source}",
                "description": "RSS feeds are offline or unavailable; local CME/spread state is still updating.",
                "link": "",
                "pubDate": _iso_now(),
            },
        ]

    classified = sorted(
        [_classify_news_item(item) for item in news],
        key=lambda item: str(item.get("pubDate") or ""),
        reverse=True,
    )[:36]
    public_live = sum(1 for item in sources if item.get("ok"))
    state = {
        "service": "news.stream",
        "provider": "public-rss-polling",
        "status": "ok" if classified else "waiting",
        "fetchedAt": _iso_now(),
        "items": classified,
        "sources": sources,
        "warnings": warnings,
        "publicSourcesExpected": len(NEWS_FEEDS),
        "publicSourcesLive": public_live,
        "allPublicSourcesLive": public_live == len(NEWS_FEEDS),
    }
    NEWS_CACHE.update({"fetched_at": now, "state": state})
    return state


def _news_read(items: list[dict[str, Any]]) -> dict[str, Any]:
    risk_on = sum(1 for item in items if item.get("bias") == "risk-on")
    risk_off = sum(1 for item in items if item.get("bias") == "risk-off")
    high = sum(1 for item in items if item.get("urgency") == "high")
    net = risk_on - risk_off
    bias = "risk-on" if net > 0 else "risk-off" if net < 0 else "mixed"
    return {
        "bias": bias,
        "score": _clamp(net / 4, -1, 1),
        "urgentCount": high,
        "summary": f"{bias}; {high} high-urgency headline(s), {risk_on} risk-on, {risk_off} risk-off",
    }


def macro_regime_state() -> dict[str, Any]:
    pack = spread_pack()
    spreads = pack["spreads"]
    news = news_state()
    read = _news_read(news["items"])
    small_caps = _ratio_change("RTY", "ES")
    nq_leadership = _ratio_change("NQ", "ES")
    ym_leadership = _ratio_change("YM", "ES")
    z_pressure = _safe_mean([min(2, abs(item["z"])) / 2 for item in spreads])
    es_trend = _change("ES")
    rty_volume = market_bus.quotes.get("RTY").volume if market_bus.quotes.get("RTY") else 0
    es_volume = market_bus.quotes.get("ES").volume if market_bus.quotes.get("ES") else 1
    rty_volume_share = rty_volume / max(1, es_volume)
    factors = {
        "volatility": _clamp((0.01 - abs(_change("ES", 30))) / 0.02, -1, 1),
        "rates": 0.0,
        "credit": _clamp(small_caps / 0.02, -1, 1),
        "banks": _clamp(ym_leadership / 0.02, -1, 1),
        "breadth": _clamp((small_caps + ym_leadership - abs(nq_leadership)) / 0.035, -1, 1),
        "smallCaps": _clamp(small_caps / 0.02, -1, 1),
        "liquidity": _clamp((rty_volume_share - 0.08) / 0.12, -1, 1),
        "headlines": read["score"],
        "location": _clamp(z_pressure, -1, 1),
        "sourceBreadth": _clamp((news["publicSourcesLive"] - 1) / 2, -1, 1),
    }
    weights = {
        "volatility": 0.14,
        "rates": 0.13,
        "credit": 0.13,
        "banks": 0.10,
        "breadth": 0.12,
        "smallCaps": 0.12,
        "liquidity": 0.06,
        "headlines": 0.08,
        "location": 0.07,
        "sourceBreadth": 0.05,
    }
    score = sum(factors[key] * weight for key, weight in weights.items())
    strength = round((score + 1) * 50)
    label = "Risk-On" if strength >= 67 else "Risk-Off" if strength <= 33 else "Mixed"
    strongest_z = abs((pack.get("strongest") or {}).get("z", 0))
    algo = "Momentum" if strength >= 67 else "Defense" if strength <= 33 else "Mean Revert" if strongest_z >= 1.2 else "Wait"
    return {
        "service": "macro.regime",
        "fetchedAt": _iso_now(),
        "label": label,
        "strength": strength,
        "algo": algo,
        "score": score,
        "factors": factors,
        "factorRows": [
            {"key": key, "value": factors[key], "weight": weights[key], "contribution": factors[key] * weights[key]}
            for key in weights
        ],
        "newsRead": read,
        "leadership": {"smallCaps": small_caps, "nqLeadership": nq_leadership, "ymLeadership": ym_leadership, "esTrend": es_trend},
        "rtyVolumeShare": rty_volume_share,
        "read": f"{label} {strength}/100. Suggested approach: {algo}. {read['summary']}.",
    }


def opportunity_map_state() -> dict[str, Any]:
    pack = spread_pack()
    metrics = macro_regime_state()
    leadership = metrics["leadership"]
    rows = []
    for item in pack["spreads"]:
        if item["key"] == "RTY_ES":
            lead = leadership["smallCaps"]
            regime = max(0, metrics["factors"]["smallCaps"] * 18 + metrics["factors"]["credit"] * 10)
            expression = "Long RTY / short ES" if item["z"] < 0 else "Short RTY / long ES"
            risk = "Watch rates, credit, and regional bank pressure."
        elif item["key"] == "ES_NQ":
            lead = -leadership["nqLeadership"]
            regime = max(0, abs(leadership["nqLeadership"]) * 900)
            expression = "Long ES / short NQ" if item["z"] < 0 else "Short ES / long NQ"
            risk = "Mega-cap tech leadership can trend longer than the z-score implies."
        else:
            lead = leadership["ymLeadership"]
            regime = max(0, metrics["factors"]["banks"] * 12 + leadership["ymLeadership"] * 900)
            expression = "Long YM / short ES" if item["z"] < 0 else "Short YM / long ES"
            risk = "Dow composition and defensive-value rotations matter."
        location = min(40, abs(item["z"]) * 18)
        confirmation = max(0, lead * 900)
        liquidity = 8 if item.get("volume", 0) else 0
        score = round(min(100, location + confirmation + regime + liquidity + metrics["factors"]["sourceBreadth"] * 8))
        rows.append({
            "key": item["key"],
            "label": item["label"],
            "score": score,
            "z": item["z"],
            "spread": item["spread"],
            "signal": item["signal"],
            "expression": expression,
            "risk": risk,
            "location": location,
            "confirmation": confirmation,
            "regime": regime,
            "liquidity": liquidity,
        })
    return {
        "service": "signal.cross-spread",
        "fetchedAt": _iso_now(),
        "regime": metrics,
        "rows": sorted(rows, key=lambda row: row["score"], reverse=True),
        "playbookRows": CROSS_SPREAD_PLAYBOOK_ROWS,
        "productRows": CROSS_SPREAD_PRODUCT_ROWS,
        "tradePlanRows": CROSS_SPREAD_RTY_ES_TRADE_PLAN,
        "riskChecklistRows": CROSS_SPREAD_RISK_CHECK_ROWS,
    }


def notional_state() -> dict[str, Any]:
    rows = []
    basket_ratios = {
        "ES_NQ": {"left": 3, "right": -2},
        "YM_ES": {"left": 3, "right": -2},
        "RTY_ES": {"left": 7, "right": -3},
    }
    for config in SPREAD_CONFIGS:
        left_price = _latest(str(config["legA"]))
        right_price = _latest(str(config["legB"]))
        display_value = left_price + float(config["ratio"]) * right_price
        ratio = basket_ratios[str(config["symbol"])]
        basket = (
            ratio["left"] * left_price * float(config["leftMultiplier"])
            + ratio["right"] * right_price * float(config["rightMultiplier"])
        )
        rows.append({
            **config,
            "leftPrice": left_price,
            "rightPrice": right_price,
            "displayValue": display_value,
            "basketDollarDiff": basket,
        })
    return {"service": "risk.notional", "fetchedAt": _iso_now(), "rows": rows}


def audit_state() -> dict[str, Any]:
    runtime = _runtime_state()
    fills = _fills()
    pack = spread_pack()
    sequence = sum(len(rows) for rows in market_bus.bars.values())
    runtime_events = []
    if isinstance(runtime.get("auditEvents"), list):
        for item in runtime["auditEvents"][:200]:
            if not isinstance(item, dict):
                continue
            runtime_events.append({
                "id": str(item.get("id") or f"AUD-RUNTIME-{len(runtime_events) + 1}"),
                "timestamp": str(item.get("timestamp") or runtime.get("updatedAt") or _iso_now()),
                "sequence": item.get("sequence") or runtime.get("sequence", ""),
                "channel": str(item.get("channel") or "algos"),
                "type": str(item.get("type") or "runtime-event"),
                "source": str(item.get("source") or "algo.order-runtime"),
                "severity": str(item.get("severity") or "info"),
                "summary": str(item.get("summary") or item.get("message") or "Runtime event."),
            })

    entries = [
        *runtime_events,
        {
            "id": "AUD-MARKET",
            "timestamp": _iso_now(),
            "sequence": sequence,
            "channel": "market-depth",
            "type": "price-service",
            "source": market_bus.source,
            "severity": "info",
            "summary": f"CME ingress active via {market_bus.source}; {len(market_bus.quotes)} quote stream(s), sequence {sequence}.",
        },
        {
            "id": "AUD-SPREADS",
            "timestamp": _iso_now(),
            "sequence": sequence,
            "channel": "analysis",
            "type": "spread-pack",
            "source": "intelligence.spreads",
            "severity": "info",
            "summary": f"{len(pack['spreads'])} synthetic spread(s) scored; top focus {(pack.get('strongest') or {}).get('label', 'waiting')}.",
        },
        {
            "id": "AUD-FILLS",
            "timestamp": _iso_now(),
            "sequence": runtime.get("sequence", ""),
            "channel": "fills",
            "type": "fills-journal",
            "source": "data/fills/fills-journal.json",
            "severity": "info",
            "summary": f"{len(fills)} fill event(s) retained for positions, analytics, and audit reconstruction.",
        },
        {
            "id": "AUD-ALGOS",
            "timestamp": str(runtime.get("updatedAt") or _iso_now()),
            "sequence": runtime.get("sequence", ""),
            "channel": "algos",
            "type": "runtime-state",
            "source": "algo.order-runtime",
            "severity": "warn" if not runtime else "info",
            "summary": "Algo runtime state loaded." if runtime else "Algo runtime file not populated yet; manager boundary is in dry-run mode.",
        },
    ]
    return {"service": "audit.journal", "fetchedAt": _iso_now(), "entries": entries}


def _equity_curve(pnls: list[float]) -> list[dict[str, Any]]:
    cumulative = 0.0
    peak = TRADE_ANALYTICS_ACCOUNT_SIZE
    max_dd = 0.0
    curve = []
    for index, pnl in enumerate(pnls):
        cumulative += pnl
        equity = TRADE_ANALYTICS_ACCOUNT_SIZE + cumulative
        peak = max(peak, equity)
        drawdown = peak - equity
        max_dd = max(max_dd, drawdown)
        curve.append({"index": index + 1, "equity": equity, "drawdown": drawdown, "maxDrawdown": max_dd})
    return curve


def trade_analytics_state() -> dict[str, Any]:
    fills = _fills()
    records = []
    known = {"ES", "NQ", "YM", "RTY", "ES_NQ", "YM_ES", "RTY_ES", "ZM", "ZS", "CL", "GC"}
    for fill in fills:
        pnl = _number(
            fill.get("realizedPnl")
            or fill.get("closedPnl")
            or fill.get("netPnl")
            or fill.get("tradePnl")
            or fill.get("pnl")
            or fill.get("profit")
            or fill.get("net"),
            0,
        )
        records.append({
            "pnl": pnl,
            "instrument": str(fill.get("instrumentId") or fill.get("symbol") or fill.get("product") or "").upper(),
            "timestamp": str(fill.get("timestamp") or fill.get("createdAt") or ""),
        })
    pnls = [record["pnl"] for record in records]
    wins = [value for value in pnls if value > 0]
    losses = [value for value in pnls if value < 0]
    total = sum(pnls)
    returns = [value / TRADE_ANALYTICS_ACCOUNT_SIZE for value in pnls]
    mean_return = _safe_mean(returns)
    variance = _safe_mean([(value - mean_return) ** 2 for value in returns])
    sigma = math.sqrt(variance) if variance > 0 else 0
    downside = math.sqrt(_safe_mean([min(0, value) ** 2 for value in returns])) if returns else 0
    curve = _equity_curve(pnls)
    drawdown = curve[-1]["maxDrawdown"] if curve else 0
    return_pct = total / TRADE_ANALYTICS_ACCOUNT_SIZE
    drawdown_pct = drawdown / TRADE_ANALYTICS_ACCOUNT_SIZE
    gross_profit = sum(wins)
    gross_loss = abs(sum(losses))
    metrics = {
        "rows": len(records),
        "accountSize": TRADE_ANALYTICS_ACCOUNT_SIZE,
        "total": total,
        "returnPct": return_pct,
        "winRate": len(wins) / len(records) if records else 0,
        "sharpe": (mean_return / sigma * math.sqrt(len(returns))) if sigma and returns else 0,
        "sortino": (mean_return / downside * math.sqrt(len(returns))) if downside and returns else 0,
        "calmar": return_pct / drawdown_pct if drawdown_pct else 0,
        "profitFactor": gross_profit / gross_loss if gross_loss else gross_profit if gross_profit else 0,
        "expectancy": _safe_mean(pnls),
        "drawdown": drawdown,
        "drawdownPct": drawdown_pct,
        "studyCoverage": (sum(1 for record in records if record["instrument"] in known) / len(records)) if records else 0,
        "largestLossPct": abs(min([0, *pnls])) / TRADE_ANALYTICS_ACCOUNT_SIZE,
    }
    risk_level = "High" if metrics["drawdownPct"] >= 0.02 or total < 0 or metrics["sharpe"] < 0 else "Elevated" if metrics["drawdownPct"] >= 0.01 or metrics["profitFactor"] < 1.2 else "Controlled"
    studies = [
        {"study": "Risk assessment", "passed": risk_level == "Controlled", "result": risk_level, "read": f"Drawdown {metrics['drawdownPct']:.2%}, Sharpe {metrics['sharpe']:.2f}, Calmar {metrics['calmar']:.2f}"},
        {"study": "Account base", "passed": return_pct >= 0, "result": f"{return_pct:.2%}", "read": f"${total:,.0f} on ${TRADE_ANALYTICS_ACCOUNT_SIZE:,.0f}"},
        {"study": "Expectancy", "passed": metrics["expectancy"] > 0 and metrics["profitFactor"] >= 1, "result": f"${metrics['expectancy']:,.0f} / {metrics['profitFactor']:.2f} PF", "read": "Positive average trade contribution" if metrics["expectancy"] > 0 else "Negative expectancy day"},
        {"study": "Study coverage", "passed": metrics["studyCoverage"] >= 0.8, "result": f"{metrics['studyCoverage']:.0%}", "read": "Rows mapped to defined products or spreads"},
    ]
    product_totals: dict[str, float] = {}
    for record in records:
        key = record["instrument"] or "UNKNOWN"
        product_totals[key] = product_totals.get(key, 0.0) + record["pnl"]
    return {
        "service": "analytics.trade",
        "fetchedAt": _iso_now(),
        "status": f"Analyzed {len(records)} fill row(s); account base ${TRADE_ANALYTICS_ACCOUNT_SIZE:,.0f}.",
        "riskLevel": risk_level,
        "metrics": metrics,
        "studies": studies,
        "curve": curve,
        "productTotals": [{"instrument": key, "pnl": value} for key, value in sorted(product_totals.items(), key=lambda item: abs(item[1]), reverse=True)],
    }


CONTENT: dict[str, dict[str, Any]] = {
    "liveApiArchitecture": {
        "service": "terminal.gateway",
        "sections": [
            {"title": "Price Engine", "body": "Normalizes CME market data into instrument, price, depth, and timestamp events."},
            {"title": "Decision Plane", "body": "Strategy services publish state while the UI monitors decisions without owning execution latency."},
            {"title": "Realtime UI", "body": "Merges market, news, analysis, order, fill, algo, and audit state for the operator."},
        ],
        "rows": [
            ["Market data API", "GET /api/markets, GET /api/bars/{asset}, WS /ws/{asset}"],
            ["Order API", "GET /api/acme/positions-orders, POST /api/acme/orders/{id}/cancel"],
            ["Algo API", "GET /api/algo-manager/state, GET /api/algo-builder/templates"],
            ["News and audit", "GET /api/news/state, GET /api/audit/state"],
        ],
    },
    "spreadConfigurations": {
        "service": "product-library",
        "rows": [[item["label"], item["meaning"], item["ttRatio"], item["syntheticTickValue"], item["displayFormula"]] for item in SPREAD_CONFIGS],
    },
    "atrZScoreEngine": {
        "service": "signal.atr-zscore",
        "rows": [
            ["Spread Series", "Prefer synchronized intraday spread bars rolled into daily OHLC; fall back to matched daily OHLC bars for the displayed synthetic formula.", "Creates spread-native ATR and raw study values."],
            ["30D Baseline", "Compare the last traded synthetic spread against the 30-session mean.", "Keeps live spread signals slow and meaningful."],
            ["ATR", "Average the last 3-session ATR and 30-session ATR. The theoretical market applies half of this ATR to each side of VWAP.", "Volatility unit for the raw technical read."],
            ["Session VWAP", "Use synchronized intraday prices and volume when available; fall back to time-weighted average when volume is missing.", "Raw midpoint reference for discretionary interpretation."],
            ["Z-Score", "(Spread - Mean) / ATR plus an intraday VWAP z-score using ATR/2.", "Cross-spread ranking and intraday trigger pressure."],
            ["ATR Percentile", "Current ATR vs one-year ATR distribution.", "Size down when volatility is unusually elevated."],
        ],
    },
    "executionRules": {
        "service": "risk.execution-rules",
        "sections": [
            {"title": "Base entry", "body": "Enter at +/-1.5 ATR only when macro regime, GOOSE direction, and live spread signal agree. If only two of three agree, cut the first clip in half."},
            {"title": "Stress rule", "body": "If ATR percentile is above 80, cut size by 50%, widen bands to +/-2 ATR, and require live z-score to stop worsening before entry."},
            {"title": "No-trade rule", "body": "Do not buy RTY/ES just because it is statistically cheap if credit spreads are widening, rates are rising, and regional banks are weak."},
            {"title": "Timing rule", "body": "Avoid initiating new layered positions in the first 3-5 minutes after major data releases. Let the synthetic spread print a first reaction, a pullback, and then a second attempt before committing."},
            {"title": "Confirmation rule", "body": "For mean reversion, require price to re-enter from beyond the band. Example: buy only after the spread trades below -1.5 ATR and then recovers back above -1.4 ATR."},
            {"title": "Layering rule", "body": "Use three clips: 40% at trigger, 30% at an additional 0.35 ATR extension, 30% only after stabilization. Never add simply because the trade is losing."},
            {"title": "Profit rule", "body": "Take 1/3 off at the rolling mean, another 1/3 at +0.5 ATR in your favor, and trail the final 1/3 with a 0.5 ATR giveback or a GOOSE regime flip."},
            {"title": "Invalidation rule", "body": "Exit if live z-score extends 0.75 ATR beyond your final layer without reversal, or macro score flips against the trade by two factors."},
            {"title": "Time-of-day note", "body": "Maintain time-of-day ATR bands for intraday execution. Cash open, Fed/CPI/jobs windows, and closing imbalance windows should not use the same thresholds as midday liquidity."},
        ],
    },
    "orderLayeringTechniques": {
        "service": "algo.layering",
        "rows": [
            ["Passive first clip", "Join or shade the synthetic bid/offer for 40% planned size.", "Normal liquidity, no urgent catalyst."],
            ["Extension layer", "Place second 30% only if spread extends another 0.35 ATR and macro has not deteriorated.", "Controlled mean-reversion setup."],
            ["Stabilization layer", "Final 30% enters after spread stops making new extremes and reclaims 0.10-0.20 ATR.", "When timing precision matters."],
            ["Scratch layer", "If first clip fills and immediately loses 0.35 ATR without stabilization, scratch instead of adding.", "Fast markets and news shocks."],
            ["Mean exit ladder", "Scale out at mean, +0.5 ATR, then trail remainder.", "Spread mean-reversion trades."],
        ],
    },
    "moneyManagement": {
        "service": "risk.money-management",
        "rows": [
            ["Risk unit", "Define 1R as the dollar loss from entry to invalidation on the full layered position."],
            ["Daily loss stop", "Stop new entries after -2R realized or two failed attempts in the same spread."],
            ["Correlation cap", "Do not hold multiple spread trades that leave the same hidden ES exposure unless the net ES leg is intentional."],
            ["Size cap", "Size from the thinner leg. For RTY/ES, RTY liquidity is usually the bottleneck; for YM/ES, watch YM liquidity."],
            ["Regime cap", "If GOOSE confidence is Low, max size is one starter clip. Medium permits two clips. High permits full layering."],
            ["Event cap", "Before CPI, FOMC, NFP, or major megacap earnings, either flatten or reduce to a size you can hold through a gap."],
        ],
    },
    "riskChecklist": {
        "service": "risk.checklist",
        "rows": [
            ["Tail beta mismatch", "Measure dollar delta by leg and rebalance when index levels move materially."],
            ["Hidden ES exposure", "When combining spreads, net all ES legs before sizing."],
            ["Volatility regime shift", "Use ATR percentile to reduce size above the 80th percentile."],
            ["Macro invalidation", "Stop buying small-cap weakness if rates and credit both deteriorate."],
            ["Execution slippage", "Use legging settings conservatively around data releases and cash open."],
        ],
    },
    "sourceNotes": {
        "service": "knowledge.notes",
        "sections": [
            {"title": "Daily ATR source", "body": "ATR is calculated from OHLC bars. Acme provider order was CME EOD/OHLC adapter first, configured Stooq daily futures CSV second, and public Yahoo daily futures bars as the no-key fallback. Cerious prioritizes CME ingress and local normalized bars."},
            {"title": "Live cockpit source", "body": "Acme attempted configured Databento GLBX.MDP3 live trades for outright last price, MBP-10 L2 books by product symbol for the Depth Ladder, optional MBO L3 reconstruction when enabled, and OHLCV-1m for live candle collection. Synthetic last/book display is calculated from underlying leg bid/ask depth like an Autospreader view."},
            {"title": "Live platform scaffold", "body": "Acme exposed sequenced event envelopes for platform, market-depth, news, analysis, data-status, orders, fills, algos, and heartbeat; snapshot endpoints remained polling fallbacks. Cerious keeps that boundary as gateway fanout plus service snapshots."},
            {"title": "GOOSE source", "body": "Combines refreshed futures history, macro regime inputs, spread z-scores, volume context, delayed live quote layer, public ETF factor proxies, CFTC positioning, and available public market headline feeds."},
            {"title": "Contract spec anchors", "body": "CME contract pages anchor ES, NQ, RTY, and YM contract specification checks for tick size, tick value, and multiplier assumptions."},
            {"title": "Macro regime source", "body": "Acme fetched free daily chart history for VIX, rates, HYG, KRE, RSP, SPY, ES, and RTY proxies, then scored volatility, rates, credit, regional banks, breadth, and small-cap leadership."},
            {"title": "Disclaimer", "body": "This is a risk-management framework and decision-support system, not financial advice."},
        ],
    },
    "modelResearchGovernance": {
        "service": "knowledge.governance",
        "sections": [
            {"title": "Objective process record", "body": "Quantitative signal development, review, monitoring, and variant control. This process is intentionally strategy-neutral so it can support partner, investor, regulator, and internal model-review conversations."},
            {"title": "Registry defaults", "body": "Model: ACME-FactorStack-Monitor. Version: v0.1. Horizon: Intraday / 1-week. Owner / reviewer: Research."},
            {"title": "Research objective", "body": "Combine independent market, macro, positioning, news, and liquidity signals into a bounded decision-support score with explainable attribution."},
            {"title": "Variant notes", "body": "Baseline factor stack: trend/relative strength, volatility, rates/credit, CFTC positioning, news pressure, and liquidity checks."},
            {"title": "Review criteria", "body": "Promote only after data-quality checks, walk-forward validation, turnover/slippage review, adverse-regime review, and live-monitoring notes."},
        ],
        "rows": [
            ["Research hypothesis", "State the economic rationale before scoring. A model should explain why an observable variable may forecast risk, return, liquidity, or execution quality.", "Named hypothesis, target horizon, eligible markets, expected failure modes."],
            ["Data intake", "Separate raw collection, normalization, scoring, and decision display. Vendor, public, and internal feeds must be source-labeled and timestamped.", "Provider, refresh cadence, timestamp, transformation notes, missing-data policy."],
            ["Feature design", "Prefer independent factor families over duplicate measures. Current families: trend/momentum, relative strength, volatility, credit/rates, positioning, breadth, news pressure, and liquidity.", "Feature list, lookback, directionality, cap/winsorization rule, correlation review."],
            ["Scoring", "Convert each feature into bounded scores, combine with documented weights, and expose both composite score and factor-level attribution.", "Weights, factor contribution, confidence tier, score version, threshold table."],
            ["Decision policy", "Advice must distinguish observation, watch, action, sizing, invalidation, and review horizon. Execution remains separate from signal generation.", "Day plan, week plan, trigger, stop/invalidation, confidence downgrade rule."],
            ["Validation", "Backtest and forward-monitor separately. Require out-of-sample checks, turnover/slippage assumptions, stale-data tests, and adverse-regime review.", "Backtest window, holdout window, hit rate, drawdown, turnover, slippage, exceptions."],
            ["Governance", "Every variant gets name, owner, version, changelog, activation date, and deprecation rule.", "Registry entry, approval status, reviewer notes."],
        ],
    },
}


def content_state(kind: str) -> dict[str, Any]:
    return {
        "kind": kind,
        "fetchedAt": _iso_now(),
        **CONTENT.get(kind, {"service": "terminal.workspace", "sections": [{"title": kind, "body": "Window registered; service content pending."}]}),
    }
