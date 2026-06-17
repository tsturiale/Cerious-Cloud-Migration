from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

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


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


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


def _save_runtime_state(runtime: dict[str, Any]) -> None:
    runtime["version"] = runtime.get("version") or "cerious.order-runtime-state.v1"
    runtime["updatedAt"] = _iso_now()
    _write_json(RUNTIME_STATE_FILE, runtime)


def _normalize_order_side(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if raw in {"ask", "offer", "sell", "s"}:
        return "offer"
    return "bid"


def _normalize_order_type(value: Any) -> str:
    raw = str(value or "").strip().lower()
    return "market" if raw == "market" else "limit"


def _normalize_source(value: Any) -> str:
    raw = str(value or "").strip().lower()
    return "algo" if raw == "algo" else "manual"


def _runtime_orders(runtime: dict[str, Any]) -> list[dict[str, Any]]:
    orders = runtime.get("orders")
    if not isinstance(orders, list):
        orders = []
        runtime["orders"] = orders
    return [order for order in orders if isinstance(order, dict)]


def _to_sim_order(raw: dict[str, Any]) -> dict[str, Any]:
    market_key = str(raw.get("marketKey") or raw.get("instrumentId") or raw.get("symbol") or raw.get("product") or "-").upper()
    side = _normalize_order_side(raw.get("side") or raw.get("orderSide"))
    source = _normalize_source(raw.get("source"))
    order_type = _normalize_order_type(raw.get("orderType") or raw.get("type"))
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    size = abs(_number(raw.get("size") or raw.get("qty") or raw.get("quantity"), 1)) or 1
    filled_size = abs(_number(raw.get("filledSize"), 0))
    remaining = max(0.0, _number(raw.get("remaining"), size - filled_size))
    status = str(raw.get("status") or ("filled" if remaining <= 0 else "working")).lower()
    if status in {"canceled"}:
        status = "cancelled"
    if status not in {"working", "partially_filled", "filled", "cancelled"}:
        status = "working"
    created_at = int(_number(raw.get("createdAt"), now_ms))
    updated_at = int(_number(raw.get("updatedAt"), created_at))
    spec = instrument_spec(market_key)
    return {
        "id": str(raw.get("id") or raw.get("orderId") or raw.get("clientOrderId") or f"ord-{uuid4().hex[:12]}"),
        "marketKey": market_key,
        "outcome": "yes",
        "side": side,
        "orderType": order_type,
        "price": _number(raw.get("price") or raw.get("limitPrice") or raw.get("workingPrice"), 0),
        "size": size,
        "remaining": remaining,
        "filledSize": filled_size,
        "matchedVolume": _number(raw.get("matchedVolume"), 0),
        "status": status,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "operator": str(raw.get("operator") or raw.get("user") or "tsturiale"),
        "source": source,
        "strategy": str(raw.get("strategy") or raw.get("algoName") or ("algo-router" if source == "algo" else "manual")),
        "legId": str(raw.get("legId") or raw.get("leg_id") or f"{market_key}-{side}-{uuid4().hex[:8]}"),
        "orderTag": raw.get("orderTag") or ("ALGO ENTRY" if source == "algo" else "MANUAL"),
        "algoRole": raw.get("algoRole"),
        "algoId": raw.get("algoId"),
        "algoName": raw.get("algoName"),
        "parentOrderId": raw.get("parentOrderId"),
        "layer": raw.get("layer"),
        "trigger": raw.get("trigger"),
        "coverTicksFromFill": raw.get("coverTicksFromFill"),
        "coverTickSize": raw.get("coverTickSize"),
        "tickSize": _number(raw.get("tickSize"), spec["tickSize"]),
        "tickValue": _number(raw.get("tickValue"), spec["tickValue"]),
        "multiplier": _number(raw.get("multiplier"), spec["multiplier"]),
    }


def order_state_snapshot() -> dict[str, Any]:
    runtime = _runtime_state()
    orders = [_to_sim_order(order) for order in _runtime_orders(runtime)]
    return {
        "service": "order.session",
        "fetchedAt": _iso_now(),
        "updatedAt": runtime.get("updatedAt"),
        "simOrders": orders,
        "simPositions": [],
        "fills": {},
        "simMessages": runtime.get("messages") if isinstance(runtime.get("messages"), list) else [],
    }


def place_order(payload: dict[str, Any]) -> dict[str, Any]:
    runtime = _runtime_state()
    orders = _runtime_orders(runtime)
    order = _to_sim_order(payload)
    orders = [existing for existing in orders if str(existing.get("id")) != order["id"]]
    orders.insert(0, order)
    runtime["orders"] = orders[:500]
    runtime["messages"] = [
        f"Order service accepted {order['source'].upper()} {order['orderTag']} {order['remaining']:g}x {order['side'].upper()} {order['marketKey']} @ {order['price']}",
        *([msg for msg in runtime.get("messages", []) if isinstance(msg, str)] if isinstance(runtime.get("messages"), list) else []),
    ][:100]
    _save_runtime_state(runtime)
    return {"ok": True, "service": "order.session", "order": order, "state": order_state_snapshot()}


def _normalize_order(raw: dict[str, Any], source: str) -> dict[str, Any]:
    instrument_id = str(raw.get("instrumentId") or raw.get("marketKey") or raw.get("symbol") or raw.get("product") or "-")
    qty = _number(raw.get("qty") or raw.get("quantity") or raw.get("remainingQty") or raw.get("remaining") or raw.get("size"), 0)
    price = _number(raw.get("price") or raw.get("limitPrice") or raw.get("workingPrice"), 0)
    side_raw = _normalize_order_side(raw.get("side") or raw.get("action"))
    side = "BUY" if side_raw == "bid" else "SELL"
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
        "orderClass": raw.get("orderClass") or raw.get("class") or raw.get("source") or ("algo" if source == "algoState.working" else "manual"),
        "orderType": raw.get("orderType") or raw.get("type") or raw.get("templateId") or "Limit",
        "algoName": raw.get("algoName") or raw.get("strategyName") or raw.get("definitionName"),
        "algoLegRole": raw.get("algoLegRole") or raw.get("algoRole") or raw.get("legRole"),
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
    runtime = _runtime_state()
    cancelled = False
    orders: list[dict[str, Any]] = []
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    for order in _runtime_orders(runtime):
        if str(order.get("id")) == str(order_id) and str(order.get("status", "")).lower() not in {"filled", "cancelled", "canceled"}:
            order = {**order, "status": "cancelled", "updatedAt": now_ms}
            cancelled = True
        orders.append(order)
    runtime["orders"] = orders
    runtime["messages"] = [
        f"Order service cancelled {order_id}." if cancelled else f"Order service cancel ignored for {order_id}; order not working.",
        *([msg for msg in runtime.get("messages", []) if isinstance(msg, str)] if isinstance(runtime.get("messages"), list) else []),
    ][:100]
    _save_runtime_state(runtime)
    return {"ok": True, "orderId": order_id, "cancelled": cancelled, "state": order_state_snapshot()}


def cancel_all_orders(source: str | None = None) -> dict[str, Any]:
    runtime = _runtime_state()
    source_filter = _normalize_source(source) if source else None
    count = 0
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    orders: list[dict[str, Any]] = []
    for order in _runtime_orders(runtime):
        status = str(order.get("status", "")).lower()
        source_ok = not source_filter or _normalize_source(order.get("source")) == source_filter
        if source_ok and status not in {"filled", "cancelled", "canceled", "rejected"}:
            order = {**order, "status": "cancelled", "updatedAt": now_ms}
            count += 1
        orders.append(order)
    runtime["orders"] = orders
    runtime["messages"] = [
        f"Order service cancel-all cancelled {count} {source_filter or 'all'} working order{'s' if count != 1 else ''}.",
        *([msg for msg in runtime.get("messages", []) if isinstance(msg, str)] if isinstance(runtime.get("messages"), list) else []),
    ][:100]
    _save_runtime_state(runtime)
    return {"ok": True, "count": count, "state": order_state_snapshot()}
