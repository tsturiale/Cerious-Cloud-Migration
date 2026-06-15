from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from services.common.bus import market_bus
from services.common.contracts import CME_INSTRUMENTS, SYNTHETIC_SPREADS, instrument_spec


ROOT = Path(__file__).resolve().parents[2]
FILLS_JOURNAL = ROOT / "data" / "fills" / "fills-journal.json"
RUNTIME_STATE_FILE = ROOT / "data" / "runtime" / "algo-order-runtime-state.json"


def _read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def _number(value: Any, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed == parsed else fallback


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _instrument_label(instrument_id: str) -> str:
    if instrument_id in CME_INSTRUMENTS:
        return str(CME_INSTRUMENTS[instrument_id]["label"])
    if instrument_id in SYNTHETIC_SPREADS:
        return str(SYNTHETIC_SPREADS[instrument_id]["label"])
    return instrument_id


def _instrument_multiplier(instrument_id: str, fill: dict[str, Any] | None = None) -> float:
    if fill:
        multiplier = _number(fill.get("multiplier"), 0)
        if multiplier:
            return multiplier
        tick_value = _number(fill.get("tickValue"), 0)
        tick_size = _number(fill.get("tickSize"), 0)
        if tick_value and tick_size:
            return tick_value / tick_size
    return instrument_spec(instrument_id)["multiplier"]


def _mark_price(instrument_id: str, avg_price: float) -> tuple[float, bool]:
    quote = market_bus.quotes.get(instrument_id)
    if quote is not None:
        return quote.last, True
    bars = market_bus.bars.get(instrument_id)
    if bars:
        try:
            return float(list(bars)[-1]["close"]), True
        except (KeyError, TypeError, ValueError, IndexError):
            pass
    return avg_price, False


def _fill_timestamp(fill: dict[str, Any]) -> str:
    return str(fill.get("timestamp") or fill.get("createdAt") or "")


def _fills() -> list[dict[str, Any]]:
    payload = _read_json(FILLS_JOURNAL, {})
    fills = payload.get("fills") if isinstance(payload, dict) else payload
    if not isinstance(fills, list):
        return []
    return [fill for fill in fills if isinstance(fill, dict)]


def _runtime_state() -> dict[str, Any]:
    payload = _read_json(RUNTIME_STATE_FILE, {})
    return payload if isinstance(payload, dict) else {}


def _normalize_order(raw: dict[str, Any], source: str) -> dict[str, Any]:
    instrument_id = str(raw.get("instrumentId") or raw.get("symbol") or raw.get("product") or "-")
    qty = _number(raw.get("qty") or raw.get("quantity") or raw.get("remainingQty"), 0)
    price = _number(raw.get("price") or raw.get("limitPrice") or raw.get("workingPrice"), 0)
    side = str(raw.get("side") or raw.get("action") or "-")
    status = str(raw.get("status") or ("Working" if raw.get("held") is not True else "Held"))
    return {
        "id": str(raw.get("id") or raw.get("orderId") or raw.get("clientOrderId") or raw.get("algoOrderId") or "-"),
        "instrumentId": instrument_id,
        "label": _instrument_label(instrument_id),
        "side": side,
        "qty": qty,
        "price": price,
        "status": status,
        "held": bool(raw.get("held", False)),
        "source": source,
        "orderClass": raw.get("orderClass") or raw.get("class") or ("algo" if source == "algoState.working" else "manual"),
        "orderType": raw.get("orderType") or raw.get("type") or raw.get("templateId") or "Limit",
        "algoName": raw.get("algoName") or raw.get("strategyName") or raw.get("definitionName"),
        "algoLegRole": raw.get("algoLegRole") or raw.get("legRole"),
        "updatedAt": str(raw.get("updatedAt") or raw.get("createdAt") or ""),
    }


def _working_orders(runtime: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for order in runtime.get("orders", []):
        if isinstance(order, dict):
            rows.append(_normalize_order(order, "runtime.orders"))
    working = runtime.get("algoState", {}).get("working") if isinstance(runtime.get("algoState"), dict) else []
    for order in working or []:
        if isinstance(order, dict):
            rows.append(_normalize_order(order, "algoState.working"))
    return [
        row
        for row in rows
        if row["status"].lower() not in {"filled", "cancelled", "canceled", "rejected", "done"}
    ]


def _positions_from_fills(fills: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], float, float]:
    positions: dict[str, dict[str, Any]] = {}
    closed_pnl = 0.0

    for fill in sorted(fills, key=_fill_timestamp):
        instrument_id = str(fill.get("instrumentId") or fill.get("symbol") or "")
        if not instrument_id:
            continue
        side = str(fill.get("side") or "").lower()
        side_sign = -1 if side.startswith("sell") else 1
        qty = abs(_number(fill.get("qty") or fill.get("quantity"), 0))
        price = _number(fill.get("price"), float("nan"))
        if not qty or price != price:
            continue
        signed_qty = side_sign * qty
        current = positions.get(instrument_id) or {
            "instrumentId": instrument_id,
            "label": _instrument_label(instrument_id),
            "qty": 0.0,
            "avgPrice": 0.0,
            "multiplier": _instrument_multiplier(instrument_id, fill),
            "realizedPnl": 0.0,
            "account": fill.get("account") or "-",
            "lastFillAt": _fill_timestamp(fill),
            "fillCount": 0,
        }
        current_qty = _number(current["qty"])
        multiplier = _number(current.get("multiplier"), _instrument_multiplier(instrument_id, fill))

        if current_qty == 0 or (current_qty > 0) == (signed_qty > 0):
            next_qty = current_qty + signed_qty
            current["avgPrice"] = (
                0.0
                if next_qty == 0
                else ((_number(current["avgPrice"]) * abs(current_qty)) + (price * qty)) / abs(next_qty)
            )
            current["qty"] = next_qty
        else:
            closing_qty = min(abs(current_qty), qty)
            fill_realized = closing_qty * (price - _number(current["avgPrice"])) * (1 if current_qty > 0 else -1) * multiplier
            current["realizedPnl"] = _number(current.get("realizedPnl")) + fill_realized
            closed_pnl += fill_realized
            remaining_signed = current_qty + signed_qty
            if remaining_signed == 0:
                current["qty"] = 0.0
                current["avgPrice"] = 0.0
            elif (remaining_signed > 0) == (current_qty > 0):
                current["qty"] = remaining_signed
            else:
                current["qty"] = remaining_signed
                current["avgPrice"] = price

        current["lastFillAt"] = _fill_timestamp(fill)
        current["account"] = fill.get("account") or current.get("account") or "-"
        current["fillCount"] = int(current.get("fillCount") or 0) + 1
        positions[instrument_id] = current

    open_pnl = 0.0
    rows: list[dict[str, Any]] = []
    for position in positions.values():
        qty = _number(position.get("qty"))
        if qty == 0:
            continue
        avg_price = _number(position.get("avgPrice"))
        mark_price, mark_live = _mark_price(str(position["instrumentId"]), avg_price)
        multiplier = _number(position.get("multiplier"), 1)
        position_open_pnl = (mark_price - avg_price) * qty * multiplier
        open_pnl += position_open_pnl
        rows.append({
            **position,
            "qty": qty,
            "avgPrice": avg_price,
            "markPrice": mark_price,
            "markLive": mark_live,
            "openPnl": position_open_pnl,
        })

    rows.sort(key=lambda item: str(item.get("instrumentId", "")))
    return rows, open_pnl, closed_pnl


def positions_orders_state() -> dict[str, Any]:
    fills = _fills()
    runtime = _runtime_state()
    positions, open_pnl, closed_pnl = _positions_from_fills(fills)
    orders = _working_orders(runtime)
    return {
        "service": "order.positions",
        "fetchedAt": _iso_now(),
        "fillsJournalUpdatedAt": _read_json(FILLS_JOURNAL, {}).get("updatedAt"),
        "runtimeUpdatedAt": runtime.get("updatedAt"),
        "positions": positions,
        "orders": orders,
        "fills": fills[:200],
        "summary": {
            "positionCount": len(positions),
            "workingOrderCount": len(orders),
            "fillCount": len(fills),
            "openPnl": open_pnl,
            "closedPnl": closed_pnl,
            "totalPnl": open_pnl + closed_pnl,
        },
    }


def cancel_order(order_id: str) -> dict[str, Any]:
    return {
        "ok": True,
        "dryRun": True,
        "orderId": order_id,
        "message": "Cancel routed to Cerious order service dry-run boundary.",
    }


def cancel_all_orders() -> dict[str, Any]:
    state = positions_orders_state()
    return {
        "ok": True,
        "dryRun": True,
        "count": state["summary"]["workingOrderCount"],
        "message": "Cancel-all routed to Cerious order service dry-run boundary.",
    }
