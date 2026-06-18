from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from services.common.bus import market_bus
from services.common.config import settings
from services.common.contracts import CME_INSTRUMENTS, SYNTHETIC_SPREADS
from services.algo_engine.service import algo_builder_templates, algo_manager_state, record_algo_guard_event
from services.intelligence.service import (
    acme_intelligence,
    audit_state,
    content_state,
    goose,
    macro_regime_state,
    news_state,
    notional_state,
    opportunity_map_state,
    spread_pack,
    trade_analytics_state,
)
from services.order.service import cancel_all_orders, cancel_order, order_state_snapshot, place_order, positions_orders_state
from services.price.service import price_service
from services.studies.service import studies_service
from services.fix_engine.service import fix_engine


app = FastAPI(title=settings.app_name)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

HISTORICAL_BAR_CACHE: dict[str, tuple[float, list[dict[str, Any]]]] = {}
DATABENTO_END_CACHE: dict[str, tuple[float, datetime]] = {}
DATABENTO_OHLCV_CACHE: dict[str, tuple[float, list[dict[str, Any]]]] = {}
HISTORICAL_REFRESH_TASKS: dict[str, asyncio.Task[None]] = {}
HISTORICAL_REFRESH_SEMAPHORE = asyncio.Semaphore(1)
INTELLIGENCE_LOCK = asyncio.Lock()
WARMUP_LOCK = asyncio.Lock()
WARMUP_TASK: asyncio.Task[None] | None = None
WARMUP_STATE: dict[str, Any] = {
    "ok": False,
    "status": "not-started",
    "app": "cerious-systems",
    "checkedAt": None,
    "warmupMs": 0,
    "error": None,
}
ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIST = ROOT / "apps" / "terminal" / "dist"
FRONTEND_ASSETS = FRONTEND_DIST / "assets"
FRONTEND_VENDOR = FRONTEND_DIST / "vendor"
FRONTEND_BRANDING = FRONTEND_DIST / "branding"
RECOVERED_WORKSPACE_DIR = ROOT / "data" / "recovered-workspaces"
WORKSPACE_STORE_DIR = ROOT / "data" / "workspace-store"
DOWNLOADS_DIR = ROOT / "data" / "downloads"
LAUNCHED_AT = datetime.now(timezone.utc)
LR_READY_MAX_AGE_MS = 90 * 60 * 1000
STUDY_WARMUP_TIMEOUT_SECONDS = 120.0
INTELLIGENCE_WARMUP_TIMEOUT_SECONDS = 75.0


async def publish_order_snapshot() -> dict[str, Any]:
    snapshot = order_state_snapshot()
    await market_bus.publish_event({"type": "order_snapshot", "data": snapshot})
    return snapshot
STUDY_ENDPOINT_TIMEOUT_SECONDS = 45.0

if FRONTEND_ASSETS.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_ASSETS)), name="terminal-assets")
if FRONTEND_VENDOR.exists():
    app.mount("/vendor", StaticFiles(directory=str(FRONTEND_VENDOR)), name="terminal-vendor")
if FRONTEND_BRANDING.exists():
    app.mount("/branding", StaticFiles(directory=str(FRONTEND_BRANDING)), name="terminal-branding")
DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/downloads", StaticFiles(directory=str(DOWNLOADS_DIR)), name="terminal-downloads")


def _base64url_json(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_base64url_json(encoded: str) -> dict[str, Any]:
    padding = "=" * (-len(encoded) % 4)
    raw = base64.urlsafe_b64decode((encoded + padding).encode("ascii"))
    payload = json.loads(raw.decode("utf-8"))
    return payload if isinstance(payload, dict) else {}


def _session_signature(encoded_payload: str) -> str:
    secret = settings.auth_secret or "cerious-local-dev-secret"
    return hmac.new(secret.encode("utf-8"), encoded_payload.encode("ascii"), hashlib.sha256).hexdigest()


def _make_session_token(username: str) -> tuple[str, int]:
    now = int(time.time())
    expires_at = now + 18 * 60 * 60
    encoded_payload = _base64url_json({
        "sub": username,
        "iat": now,
        "exp": expires_at,
        "scope": "cerious-terminal",
    })
    return f"{encoded_payload}.{_session_signature(encoded_payload)}", expires_at


def _verify_session_token(token: str | None) -> str | None:
    if not token or "." not in token:
        return None
    encoded_payload, supplied_signature = token.split(".", 1)
    expected_signature = _session_signature(encoded_payload)
    if not hmac.compare_digest(supplied_signature, expected_signature):
        return None
    try:
        payload = _decode_base64url_json(encoded_payload)
    except Exception:
        return None
    if int(payload.get("exp") or 0) < int(time.time()):
        return None
    username = str(payload.get("sub") or "").strip()
    if not username:
        return None
    return username


def _workspace_file_part(value: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in value.strip())
    cleaned = "-".join(part for part in cleaned.split("-") if part)
    return cleaned[:96] or "workspace"


def _workspace_user_dir(username: str) -> Path:
    safe_user = _workspace_file_part(username or settings.portal_username or "local")
    directory = WORKSPACE_STORE_DIR / safe_user
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _workspace_path(username: str, operator: str, name: str) -> Path:
    return _workspace_user_dir(username) / f"{_workspace_file_part(operator)}__{_workspace_file_part(name)}.json"


def _normalize_workspace_payload(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="workspace payload is required")
    workspace = dict(raw)
    windows = workspace.get("windows")
    if not isinstance(windows, list):
        raise HTTPException(status_code=400, detail="workspace windows are required")
    workspace["name"] = str(workspace.get("name") or "Untitled Workspace").strip() or "Untitled Workspace"
    workspace["operator"] = str(workspace.get("operator") or "Operator 1").strip() or "Operator 1"
    workspace["rows"] = workspace.get("rows") if isinstance(workspace.get("rows"), list) else []
    workspace["alerts"] = workspace.get("alerts") if isinstance(workspace.get("alerts"), list) else []
    workspace["updatedAt"] = int(time.time() * 1000)
    return workspace


async def run_intelligence(fn):
    async with INTELLIGENCE_LOCK:
        return await asyncio.to_thread(fn)


def _http_read_json(request: urlrequest.Request, timeout: float = 10.0) -> dict[str, Any]:
    with urlrequest.urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body) if body else {}
        except json.JSONDecodeError:
            parsed = {"body": body}
        return {
            "status": int(getattr(response, "status", 200)),
            "response": parsed,
        }


def _send_sms_alert_sync(to: str, message: str) -> dict[str, Any]:
    if settings.alert_sms_webhook_url:
        body = json.dumps({
            "to": to,
            "message": message,
            "source": "cerious-terminal",
            "sentAt": _iso_now(),
        }).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if settings.alert_sms_webhook_bearer:
            headers["Authorization"] = f"Bearer {settings.alert_sms_webhook_bearer}"
        request = urlrequest.Request(settings.alert_sms_webhook_url, data=body, headers=headers, method="POST")
        try:
            result = _http_read_json(request)
        except urlerror.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            return {
                "ok": False,
                "configured": True,
                "provider": "webhook",
                "error": f"SMS webhook rejected alert with HTTP {exc.code}: {detail[:240]}",
            }
        return {
            "ok": 200 <= int(result["status"]) < 300,
            "configured": True,
            "provider": "webhook",
            "status": result["status"],
            "response": result["response"],
        }

    if settings.twilio_account_sid and settings.twilio_auth_token and settings.twilio_from_phone:
        form = urlparse.urlencode({
            "To": to,
            "From": settings.twilio_from_phone,
            "Body": message,
        }).encode("utf-8")
        token = base64.b64encode(f"{settings.twilio_account_sid}:{settings.twilio_auth_token}".encode("utf-8")).decode("ascii")
        request = urlrequest.Request(
            f"https://api.twilio.com/2010-04-01/Accounts/{settings.twilio_account_sid}/Messages.json",
            data=form,
            headers={
                "Authorization": f"Basic {token}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            method="POST",
        )
        try:
            result = _http_read_json(request)
        except urlerror.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            return {
                "ok": False,
                "configured": True,
                "provider": "twilio",
                "error": f"Twilio rejected alert with HTTP {exc.code}: {detail[:240]}",
            }
        return {
            "ok": 200 <= int(result["status"]) < 300,
            "configured": True,
            "provider": "twilio",
            "status": result["status"],
            "response": result["response"],
        }

    return {
        "ok": False,
        "configured": False,
        "error": "SMS transport is not configured. Set CERIOUS_ALERT_SMS_WEBHOOK_URL or TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_PHONE.",
    }


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _finite(value: Any) -> bool:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(parsed)


def _study_readiness(intelligence: dict[str, Any]) -> dict[str, Any]:
    pack = intelligence.get("spreadPack") or {}
    spreads = pack.get("spreads") or []
    by_key = {str(item.get("key")): item for item in spreads if isinstance(item, dict)}
    now_ms = int(time.time() * 1000)
    rows: list[dict[str, Any]] = []
    ok = True
    for symbol in SYNTHETIC_SPREADS:
        stat = by_key.get(symbol, {})
        updated_at = int(float(stat.get("lr27UpdatedAt") or 0))
        age_ms = now_ms - updated_at if updated_at else None
        ready = (
            int(float(stat.get("lr27Bars") or 0)) >= 27
            and _finite(stat.get("lr27Mean"))
            and _finite(stat.get("lr27Upper2"))
            and _finite(stat.get("lr27Lower2"))
            and updated_at > 0
            and (age_ms is not None and age_ms <= LR_READY_MAX_AGE_MS)
        )
        ok = ok and ready
        rows.append({
            "symbol": symbol,
            "ready": ready,
            "lr27Bars": int(float(stat.get("lr27Bars") or 0)),
            "lr27UpdatedAt": updated_at,
            "lr27AgeMs": age_ms,
            "lr27Mean": stat.get("lr27Mean"),
            "lr27Upper2": stat.get("lr27Upper2"),
            "lr27Lower2": stat.get("lr27Lower2"),
            "lastTraded": stat.get("lastTraded"),
            "live": bool(stat.get("live")),
        })
    return {
        "ok": ok,
        "maxAgeMs": LR_READY_MAX_AGE_MS,
        "spreads": rows,
        "publishedAt": pack.get("publishedAt"),
        "calculatedAt": pack.get("calculatedAt"),
        "liveOverlayAt": pack.get("liveOverlayAt"),
    }


def _market_readiness() -> dict[str, Any]:
    now_ms = int(time.time() * 1000)
    required = ["ES", "NQ", "YM", "RTY", *SYNTHETIC_SPREADS.keys()]
    rows: list[dict[str, Any]] = []
    for symbol in required:
        quote = market_bus.quotes.get(symbol)
        ts_ms = int(quote.ts_ms) if quote else 0
        rows.append({
            "symbol": symbol,
            "live": quote is not None,
            "ageMs": now_ms - ts_ms if ts_ms else None,
            "last": quote.last if quote else None,
            "bid": quote.bid if quote else None,
            "ask": quote.ask if quote else None,
        })
    return {
        "source": market_bus.source,
        "quotes": rows,
        "liveQuoteCount": sum(1 for row in rows if row["live"]),
    }


def _readiness_payload(intelligence: dict[str, Any]) -> dict[str, Any]:
    price = price_service.status()
    studies = _study_readiness(intelligence)
    markets_state = _market_readiness()
    ok = bool(price.get("running")) and bool(studies.get("ok"))
    return {
        "ok": ok,
        "status": "ready" if ok else "warming",
        "app": "cerious-systems",
        "checkedAt": _iso_now(),
        "launchedAt": LAUNCHED_AT.isoformat().replace("+00:00", "Z"),
        "price": price,
        "markets": markets_state,
        "studies": studies,
    }


def _warm_symbol_studies(symbol: str) -> None:
        studies_service.bars(symbol, "30m", 80, True)
        studies_service.bars(symbol, "1d", 90, False)
        studies_service.lr27(symbol)


def _warm_core_studies() -> None:
    symbols = list(SYNTHETIC_SPREADS)
    with ThreadPoolExecutor(max_workers=max(1, min(len(symbols), 3))) as pool:
        futures = [pool.submit(_warm_symbol_studies, symbol) for symbol in symbols]
        for future in futures:
            future.result()


async def _run_system_warmup() -> None:
    global WARMUP_STATE
    started = time.time()
    WARMUP_STATE = {
        **WARMUP_STATE,
        "ok": False,
        "status": "warming",
        "checkedAt": _iso_now(),
        "error": None,
        "warnings": [],
    }
    try:
        try:
            await asyncio.wait_for(
                asyncio.to_thread(_warm_core_studies),
                timeout=STUDY_WARMUP_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            WARMUP_STATE.setdefault("warnings", []).append(
                f"studies warmup exceeded {int(STUDY_WARMUP_TIMEOUT_SECONDS)}s; continuing fail-closed"
            )
        except Exception as exc:
            WARMUP_STATE.setdefault("warnings", []).append(f"studies warmup: {exc}")
        try:
            intelligence = await asyncio.wait_for(
                run_intelligence(lambda: acme_intelligence(force_refresh=True)),
                timeout=INTELLIGENCE_WARMUP_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            WARMUP_STATE.setdefault("warnings", []).append(
                f"intelligence warmup exceeded {int(INTELLIGENCE_WARMUP_TIMEOUT_SECONDS)}s; using current cached state"
            )
            intelligence = await asyncio.to_thread(lambda: acme_intelligence(force_refresh=False))
        for fn in [goose, macro_regime_state, news_state, audit_state, opportunity_map_state, trade_analytics_state, notional_state]:
            try:
                await asyncio.to_thread(fn)
            except Exception as exc:
                # Warmup should report partial failures without taking down the
                # terminal. Algo deployment still performs its own fresh-data
                # validation before sending orders.
                WARMUP_STATE.setdefault("warnings", []).append(f"{fn.__name__}: {exc}")
        payload = _readiness_payload(intelligence)
        WARMUP_STATE = {
            **payload,
            "status": "ready" if payload.get("ok") else "warming",
            "warmupMs": round((time.time() - started) * 1000),
            "error": None,
        }
    except Exception as exc:
        WARMUP_STATE = {
            **WARMUP_STATE,
            "ok": False,
            "status": "error",
            "checkedAt": _iso_now(),
            "warmupMs": round((time.time() - started) * 1000),
            "error": str(exc),
        }


async def ensure_warmup_task(force: bool = False) -> asyncio.Task[None]:
    global WARMUP_TASK
    async with WARMUP_LOCK:
        if WARMUP_TASK is None or (force and WARMUP_TASK.done()):
            WARMUP_TASK = asyncio.create_task(_run_system_warmup(), name="system.warmup")
    return WARMUP_TASK


@app.on_event("startup")
async def startup() -> None:
    await price_service.start()
    await ensure_warmup_task()


@app.on_event("shutdown")
async def shutdown() -> None:
    await fix_engine.stop()  # closes the HTTP client only
    await price_service.stop()


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "status": "ok",
        "app": "cerious-systems",
        "ingress": "cme",
        "dataset": settings.cme_dataset,
        "schema": settings.cme_schema,
        "symbols": list(settings.cme_symbols),
        "source": market_bus.source,
        "dry_run": settings.dry_run,
    }


@app.get("/api/system/contract")
async def system_contract() -> dict[str, Any]:
    return {
        "ok": True,
        "app": "cerious-systems",
        "contractVersion": 10,
        "rootPath": str(ROOT),
        "features": [
            "backend-served-terminal",
            "startup-warmup",
            "study-readiness",
            "algo-deploy-fail-closed",
            "databento-rest-baseline-live-rolling-ohlcv",
            "nonblocking-chart-backfill",
        ],
    }


@app.post("/api/auth/login")
async def auth_login(payload: dict[str, Any]) -> dict[str, Any]:
    username = str(payload.get("username") or "").strip()
    password = str(payload.get("password") or "")
    if not settings.portal_password:
        raise HTTPException(status_code=503, detail="portal credential is not configured")
    username_ok = hmac.compare_digest(username, settings.portal_username)
    password_ok = hmac.compare_digest(password, settings.portal_password)
    if not username_ok or not password_ok:
        raise HTTPException(status_code=401, detail="invalid Cerious credential")
    session_token, expires_at = _make_session_token(username)
    return {
        "ok": True,
        "username": username,
        "sessionToken": session_token,
        "expiresAt": expires_at,
    }


@app.get("/api/auth/session")
async def auth_session(token: str = "") -> dict[str, Any]:
    username = _verify_session_token(token)
    if not username:
        raise HTTPException(status_code=401, detail="session expired")
    return {
        "ok": True,
        "username": username,
    }


@app.post("/api/auth/logout")
async def auth_logout() -> dict[str, Any]:
    return {"ok": True}


@app.post("/api/auth/auto")
async def auth_auto() -> dict[str, Any]:
    """Auto-login using .env credentials — local dev only.

    The frontend calls this when a stored session is invalid.  Instead of
    forcing a manual re-login, we mint a fresh token from the server-side
    credentials so the user never gets locked out after a backend restart.
    """
    if not settings.portal_password:
        raise HTTPException(status_code=503, detail="portal credential is not configured")
    username = settings.portal_username or "local"
    session_token, expires_at = _make_session_token(username)
    return {
        "ok": True,
        "username": username,
        "sessionToken": session_token,
        "expiresAt": expires_at,
    }


@app.get("/api/workspaces/saved")
async def saved_workspaces(token: str = "") -> dict[str, Any]:
    username = _verify_session_token(token) or settings.portal_username or "local"
    directory = _workspace_user_dir(username)
    workspaces: list[dict[str, Any]] = []
    for path in sorted(directory.glob("*.json")):
        if path.name == "latest.json":
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        if isinstance(payload, dict) and isinstance(payload.get("windows"), list):
            payload = dict(payload)
            payload["serverFile"] = str(path.relative_to(ROOT))
            workspaces.append(payload)
    workspaces.sort(key=lambda item: float(item.get("updatedAt") or 0), reverse=True)
    return {"workspaces": workspaces}


@app.post("/api/workspaces/save")
async def save_workspace(payload: dict[str, Any]) -> dict[str, Any]:
    username = _verify_session_token(str(payload.get("sessionToken") or "")) or settings.portal_username or "local"
    workspace = _normalize_workspace_payload(payload.get("workspace"))
    path = _workspace_path(username, workspace["operator"], workspace["name"])
    envelope = {
        **workspace,
        "serverSavedAt": _iso_now(),
        "serverReason": str(payload.get("reason") or "manual save"),
    }
    path.write_text(json.dumps(envelope, indent=2), encoding="utf-8")
    latest_path = _workspace_user_dir(username) / "latest.json"
    latest_path.write_text(json.dumps(envelope, indent=2), encoding="utf-8")
    return {
        "ok": True,
        "workspace": workspace["name"],
        "path": str(path.relative_to(ROOT)),
        "latest": str(latest_path.relative_to(ROOT)),
    }


@app.get("/api/system/ready")
async def system_ready() -> dict[str, Any]:
    task = await ensure_warmup_task()
    return {
        **WARMUP_STATE,
        "running": not task.done(),
    }


@app.post("/api/system/warmup")
async def system_warmup(blocking: bool = False, timeout: float = 45.0) -> dict[str, Any]:
    task = await ensure_warmup_task(force=True)
    if blocking and not task.done():
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=max(1.0, min(timeout, 180.0)))
        except asyncio.TimeoutError:
            pass
    return {
        **WARMUP_STATE,
        "running": not task.done(),
    }


@app.get("/api/workspaces/recovered")
async def recovered_workspaces() -> dict[str, Any]:
    workspaces: list[dict[str, Any]] = []
    if not RECOVERED_WORKSPACE_DIR.exists():
        return {"workspaces": workspaces}

    for path in sorted(RECOVERED_WORKSPACE_DIR.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        if not isinstance(payload.get("windows"), list):
            continue
        # This recovery path exists to restore real user snapshots. Do not
        # re-import the temporary placeholder that was created during repair.
        recovered_name = str(payload.get("name") or "").strip().lower()
        if recovered_name in {"ted", "teddy"}:
            continue
        payload = dict(payload)
        payload["recoveredFrom"] = path.name
        workspaces.append(payload)

    workspaces.sort(key=lambda item: float(item.get("updatedAt") or 0), reverse=True)
    return {"workspaces": workspaces}


@app.get("/api/metrics")
async def metrics() -> dict[str, Any]:
    return market_bus.metrics()


@app.get("/api/price/status")
async def price_status() -> dict[str, Any]:
    return price_service.status()


@app.get("/api/markets")
async def markets() -> dict[str, Any]:
    return {"markets": market_bus.markets()}


@app.get("/api/cme/book/{symbol}")
async def cme_book(symbol: str) -> JSONResponse:
    key = symbol.upper()
    book = market_bus.cme_books.get(key)
    if not book:
        return JSONResponse({"error": f"CME book not ready for {key}"}, status_code=404)
    return JSONResponse(book)


@app.get("/api/cme/trades/{symbol}")
async def cme_trades(symbol: str) -> dict[str, Any]:
    key = symbol.upper()
    return {
        "symbol": key,
        "venue": "CME",
        "trades": list(market_bus.cme_trades.get(key, []))[-100:],
    }


@app.get("/api/acme/intelligence")
async def acme_intelligence_endpoint(fresh: bool = False) -> dict[str, Any]:
    return await run_intelligence(lambda: acme_intelligence(force_refresh=fresh))


@app.get("/api/acme/goose")
async def acme_goose_endpoint() -> dict[str, Any]:
    return await run_intelligence(goose)


@app.get("/api/acme/spreads")
async def acme_spreads_endpoint(fresh: bool = False) -> dict[str, Any]:
    return await run_intelligence(lambda: spread_pack(force_refresh=fresh))


@app.get("/api/acme/news")
async def acme_news_endpoint() -> dict[str, Any]:
    return news_state()


@app.get("/api/news/state")
async def news_state_compat() -> dict[str, Any]:
    return news_state()


@app.get("/api/acme/audit")
async def acme_audit_endpoint() -> dict[str, Any]:
    return audit_state()


@app.get("/api/audit/state")
async def audit_state_compat() -> dict[str, Any]:
    return audit_state()


@app.get("/api/acme/macro-regime")
async def acme_macro_regime_endpoint() -> dict[str, Any]:
    return macro_regime_state()


@app.get("/api/acme/trade-analytics")
async def acme_trade_analytics_endpoint() -> dict[str, Any]:
    return trade_analytics_state()


@app.get("/api/acme/opportunity-map")
async def acme_opportunity_map_endpoint() -> dict[str, Any]:
    return opportunity_map_state()


@app.get("/api/acme/notional")
async def acme_notional_endpoint() -> dict[str, Any]:
    return notional_state()


@app.get("/api/acme/content/{kind}")
async def acme_content_endpoint(kind: str) -> dict[str, Any]:
    return content_state(kind)


@app.get("/api/algo-manager/state")
async def algo_manager_state_endpoint() -> dict[str, Any]:
    return algo_manager_state()


@app.post("/api/algo-manager/guard-event")
async def algo_manager_guard_event_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(record_algo_guard_event, payload)


@app.get("/api/algo-builder/templates")
async def algo_builder_templates_endpoint() -> dict[str, Any]:
    return algo_builder_templates()


@app.get("/api/acme/positions-orders")
async def acme_positions_orders_endpoint() -> dict[str, Any]:
    return positions_orders_state()


@app.post("/api/acme/orders/cancel-all")
async def acme_cancel_all_orders_endpoint(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    source = str((payload or {}).get("source") or "").strip().lower() or None
    result = cancel_all_orders(source=source)
    result["state"] = await publish_order_snapshot()
    return result


@app.post("/api/acme/orders/{order_id}/cancel")
async def acme_cancel_order_endpoint(order_id: str) -> dict[str, Any]:
    result = cancel_order(order_id)
    result["state"] = await publish_order_snapshot()
    return result


def _interval_ms(interval: str | float | int) -> int:
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


def _bar_ts(row: dict[str, Any]) -> int:
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


def _number(value: Any, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed == parsed else fallback


def _bucket_ts(ts_ms: int, interval_ms: int) -> int:
    if interval_ms >= 24 * 60 * 60_000:
        dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
        return int(datetime(dt.year, dt.month, dt.day, tzinfo=timezone.utc).timestamp() * 1000)
    return (ts_ms // interval_ms) * interval_ms


def _aggregate_bars(rows: list[dict[str, Any]], interval: str | float | int, limit: int) -> list[dict[str, Any]]:
    interval_ms = _interval_ms(interval)
    clean = sorted((row for row in rows if _bar_ts(row)), key=_bar_ts)
    if not clean:
        return []
    buckets: list[dict[str, Any]] = []
    current_key: int | None = None
    current: dict[str, Any] | None = None
    for row in clean:
        ts_ms = _bar_ts(row)
        bucket = _bucket_ts(ts_ms, interval_ms)
        close = _number(row.get("close"), _number(row.get("price"), 0))
        open_px = _number(row.get("open"), close)
        high = _number(row.get("high"), max(open_px, close))
        low = _number(row.get("low"), min(open_px, close))
        volume = _number(row.get("volume"), 0)
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
        current["high"] = max(_number(current["high"]), high)
        current["low"] = min(_number(current["low"]), low)
        current["close"] = close
        current["volume"] = _number(current.get("volume")) + volume
    if current is not None:
        buckets.append(current)
    return buckets[-max(1, min(limit, 4500)) :]


def _completed_bars(rows: list[dict[str, Any]], interval: str) -> list[dict[str, Any]]:
    bucket_ms = _interval_ms(interval)
    now_ms = int(time.time() * 1000)
    return [row for row in rows if _bar_ts(row) and _bar_ts(row) + bucket_ms <= now_ms]


def _linear_regression_band(values: list[float], period: int = 27, deviations: float = 2.0) -> dict[str, float]:
    sample = values[-period:]
    if len(sample) < 2:
        value = sample[-1] if sample else 0.0
        return {"mean": value, "upper": value, "lower": value, "sigma": 0.0, "slope": 0.0}
    n = len(sample)
    xs = list(range(n))
    x_mean = sum(xs) / n
    y_mean = sum(sample) / n
    denom = sum((x - x_mean) ** 2 for x in xs) or 1.0
    slope = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, sample)) / denom
    intercept = y_mean - slope * x_mean
    residuals = [value - (intercept + slope * index) for index, value in enumerate(sample)]
    sigma = math.sqrt(sum(value * value for value in residuals) / len(residuals)) if residuals else 0.0
    mean_value = intercept + slope * (n - 1)
    std = max(0.0, deviations)
    return {
        "mean": mean_value,
        "upper": mean_value + std * sigma,
        "lower": mean_value - std * sigma,
        "sigma": sigma,
        "slope": slope,
    }


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


def _databento_symbol(asset: str) -> str | None:
    meta = CME_INSTRUMENTS.get(asset)
    return str(meta["symbol"]) if meta else None


def _databento_lookback(interval: str, limit: int) -> timedelta:
    interval_ms = _interval_ms(interval)
    schema = _databento_schema(interval)
    if schema == "ohlcv-1m":
        # Futures sessions have weekend and daily maintenance gaps, so calendar
        # minutes must be wider than the requested bar span.
        minutes = max(90, min(200_000, (limit + 40) * max(1, interval_ms // 60_000) * 4))
        return timedelta(minutes=minutes)
    if schema == "ohlcv-1h":
        return timedelta(hours=max(48, min(3000, limit + 20)))
    return timedelta(days=max(90, min(2500, limit + 20)))


def _databento_ohlcv(symbol: str, interval: str, limit: int) -> list[dict[str, Any]]:
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
        timestamp = int(ts.timestamp() * 1000)
        rows.append({
            "timestamp": timestamp,
            "open": _number(row.get("open")),
            "high": _number(row.get("high")),
            "low": _number(row.get("low")),
            "close": _number(row.get("close")),
            "volume": _number(row.get("volume")),
            "source": f"databento-{schema}",
        })
    DATABENTO_OHLCV_CACHE[cache_key] = (time.time(), rows)
    return rows


def _flat_synthetic_bar(timestamp: int, price: float, source: str) -> dict[str, Any]:
    return {
        "timestamp": timestamp,
        "open": price,
        "high": price,
        "low": price,
        "close": price,
        "volume": 0.0,
        "source": source,
    }


def _synthetic_ohlc_bar(left: dict[str, Any], right: dict[str, Any], multiplier: float, source: str) -> dict[str, Any]:
    left_open = _number(left.get("open"), _number(left.get("close")))
    left_high = _number(left.get("high"), left_open)
    left_low = _number(left.get("low"), left_open)
    left_close = _number(left.get("close"), left_open)
    right_open = _number(right.get("open"), _number(right.get("close")))
    right_high = _number(right.get("high"), right_open)
    right_low = _number(right.get("low"), right_open)
    right_close = _number(right.get("close"), right_open)
    if multiplier < 0:
        high = left_high + right_low * multiplier
        low = left_low + right_high * multiplier
    else:
        high = left_high + right_high * multiplier
        low = left_low + right_low * multiplier
    return {
        "timestamp": _bar_ts(left),
        "open": left_open + right_open * multiplier,
        "high": max(high, low),
        "low": min(high, low),
        "close": left_close + right_close * multiplier,
        "volume": min(_number(left.get("volume")), _number(right.get("volume"))),
        "source": source,
    }


def _compose_aligned_synthetic_rows(
    left_rows: list[dict[str, Any]],
    right_rows: list[dict[str, Any]],
    multiplier: float,
    source: str,
) -> list[dict[str, Any]]:
    left_by_ts = {_bar_ts(row): row for row in left_rows if _bar_ts(row)}
    right_by_ts = {_bar_ts(row): row for row in right_rows if _bar_ts(row)}
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
            last_left_close = _number(left.get("close"))
        elif last_left_close is not None:
            current_left = _flat_synthetic_bar(timestamp, last_left_close, source)

        if right is not None:
            current_right = right
            last_right_close = _number(right.get("close"))
        elif last_right_close is not None:
            current_right = _flat_synthetic_bar(timestamp, last_right_close, source)

        if current_left is None or current_right is None:
            continue
        left_for_ts = dict(current_left)
        right_for_ts = dict(current_right)
        left_for_ts["timestamp"] = timestamp
        right_for_ts["timestamp"] = timestamp
        rows.append(_synthetic_ohlc_bar(left_for_ts, right_for_ts, multiplier, source))
    return rows


def _compose_synthetic_history(asset: str, interval: str, limit: int) -> list[dict[str, Any]]:
    spread = SYNTHETIC_SPREADS.get(asset)
    if not spread:
        return []
    left_symbol = _databento_symbol(str(spread["left"]))
    right_symbol = _databento_symbol(str(spread["right"]))
    if not left_symbol or not right_symbol:
        return []
    with ThreadPoolExecutor(max_workers=2) as pool:
        left_future = pool.submit(_databento_ohlcv, left_symbol, interval, limit)
        right_future = pool.submit(_databento_ohlcv, right_symbol, interval, limit)
        left_rows = _aggregate_bars(left_future.result(), interval, limit * 4)
        right_rows = _aggregate_bars(right_future.result(), interval, limit * 4)
    multiplier = float(spread["right_multiplier"])
    return _compose_aligned_synthetic_rows(left_rows, right_rows, multiplier, "databento-synthetic-spread")


def _historical_backfill(asset: str, interval: str, limit: int) -> list[dict[str, Any]]:
    if not settings.databento_api_key:
        return []
    cache_key = f"{asset}:{interval}:{limit}"
    cached = HISTORICAL_BAR_CACHE.get(cache_key)
    if cached and time.time() - cached[0] < 300:
        return cached[1]
    try:
        symbol = _databento_symbol(asset)
        rows = _databento_ohlcv(symbol, interval, limit) if symbol else _compose_synthetic_history(asset, interval, limit)
    except Exception:
        return []
    rows = _aggregate_bars(rows, interval, limit)
    if not rows:
        return []
    HISTORICAL_BAR_CACHE[cache_key] = (time.time(), rows)
    return rows


def _historical_cache_key(asset: str, interval: str, limit: int) -> str:
    return f"{asset}:{interval}:{limit}"


def _cached_historical_backfill(asset: str, interval: str, limit: int) -> list[dict[str, Any]]:
    cached = HISTORICAL_BAR_CACHE.get(_historical_cache_key(asset, interval, limit))
    if cached and time.time() - cached[0] < 300:
        return cached[1]
    return []


async def _refresh_historical_backfill(asset: str, interval: str, limit: int) -> None:
    key = _historical_cache_key(asset, interval, limit)
    try:
        async with HISTORICAL_REFRESH_SEMAPHORE:
            await asyncio.to_thread(studies_service.bars, asset, interval, limit, True)
    finally:
        HISTORICAL_REFRESH_TASKS.pop(key, None)


def _ensure_historical_refresh(asset: str, interval: str, limit: int) -> None:
    key = _historical_cache_key(asset, interval, limit)
    task = HISTORICAL_REFRESH_TASKS.get(key)
    if task is None or task.done():
        HISTORICAL_REFRESH_TASKS[key] = asyncio.create_task(
            _refresh_historical_backfill(asset, interval, limit),
            name=f"historical.{asset}.{interval}.{limit}",
        )


def _merge_backfill(live_rows: list[dict[str, Any]], historical_rows: list[dict[str, Any]], interval: str, limit: int) -> list[dict[str, Any]]:
    by_ts = {row["timestamp"]: row for row in historical_rows}
    for row in live_rows:
        by_ts[row["timestamp"]] = row
    return sorted(by_ts.values(), key=lambda row: row["timestamp"])[-max(1, min(limit, 4500)) :]


def _live_bars(asset: str, interval: str, limit: int, include_forming: bool = True) -> list[dict[str, Any]]:
    rolling = market_bus.rolling_ohlcv(asset, interval, limit, include_forming=include_forming)
    if rolling:
        return rolling
    rows = list(market_bus.bars.get(asset, []))
    return _aggregate_bars(rows, interval, limit) if rows else []


@app.get("/api/bars/{asset}")
async def bars(asset: str, interval: str = "1m", limit: int = 1000) -> list[dict[str, Any]]:
    key = asset.upper()
    requested_limit = max(1, min(limit, 4500))
    rows = studies_service.cached_bars(key, interval, requested_limit, include_forming=True)
    if len(rows) < requested_limit:
        _ensure_historical_refresh(key, interval, requested_limit)
    return rows


@app.get("/api/studies/lr27/{symbol}")
async def studies_lr27(symbol: str, fresh: bool = False) -> dict[str, Any]:
    key = symbol.upper()
    try:
        if fresh:
            return await asyncio.wait_for(
                asyncio.to_thread(studies_service.lr27, key),
                timeout=STUDY_ENDPOINT_TIMEOUT_SECONDS,
            )
        try:
            return studies_service.lr27_cached(key)
        except ValueError:
            _ensure_historical_refresh(key, "30m", 80)
            raise
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown symbol {key}") from None
    except TimeoutError:
        raise HTTPException(status_code=503, detail=f"LR27 refresh timed out for {key}; send price not published") from None
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=f"send price not published: {exc}") from None


@app.get("/api/acme/lr27/{symbol}")
async def acme_lr27(symbol: str, fresh: bool = False) -> dict[str, Any]:
    key = symbol.upper()
    if key not in SYNTHETIC_SPREADS and key not in CME_INSTRUMENTS:
        raise HTTPException(status_code=404, detail=f"Unknown symbol {key}")
    try:
        if fresh:
            return await asyncio.wait_for(
                asyncio.to_thread(studies_service.lr27, key),
                timeout=STUDY_ENDPOINT_TIMEOUT_SECONDS,
            )
        try:
            return studies_service.lr27_cached(key)
        except ValueError:
            _ensure_historical_refresh(key, "30m", 80)
            raise
    except TimeoutError:
        raise HTTPException(status_code=503, detail=f"LR27 refresh timed out for {key}; send price not published") from None
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=f"send price not published: {exc}") from None


@app.get("/api/crypto/prices")
async def crypto_prices_compat() -> dict[str, Any]:
    return market_bus.crypto_prices_compat()


@app.get("/api/kalshi/markets")
async def kalshi_disabled() -> dict[str, Any]:
    return {"markets": []}


@app.get("/api/ibkr/markets")
async def ibkr_disabled() -> dict[str, Any]:
    return {"markets": []}


@app.get("/api/poly/book/{market_key}")
async def poly_book_compat(market_key: str) -> JSONResponse:
    key = market_key.upper()
    book = market_bus.poly_books.get(key)
    if not book:
        return JSONResponse({"error": f"CME book not ready for {key}"}, status_code=404)
    return JSONResponse(book)


@app.get("/api/poly/prices-history")
async def poly_history_compat(market_key: str | None = None, asset: str | None = None) -> dict[str, Any]:
    key = (market_key or asset or "ES").upper()
    bars = list(market_bus.bars.get(key, []))
    points = [{"ts": bar["timestamp"], "up_pct": bar["close"]} for bar in bars[-1500:]]
    return {"market_key": key, "points": points}


@app.post("/api/order")
async def order_stub(payload: dict[str, Any]) -> dict[str, Any]:
    result = place_order(payload)
    result["dry_run"] = settings.dry_run
    result["state"] = await publish_order_snapshot()
    return result


# ---------------------------------------------------------------------------
# FIX Engine endpoints — UI proxy to C++ daemon (all FIX logic is in C++)
# ---------------------------------------------------------------------------

@app.get("/api/fix/status")
async def fix_status() -> dict[str, Any]:
    return await fix_engine.status()


@app.get("/api/fix/journal")
async def fix_journal(
    limit: int = 200,
    direction: str | None = None,
    msgType: str | None = None,
    errorsOnly: bool = False,
) -> dict[str, Any]:
    return await fix_engine.journal(
        limit=limit,
        direction=direction,
        msg_type=msgType,
        errors_only=errorsOnly,
    )


@app.post("/api/fix/send")
async def fix_send(payload: dict[str, Any]) -> dict[str, Any]:
    return await fix_engine.send_new_order(payload)


@app.post("/api/fix/cancel")
async def fix_cancel(payload: dict[str, Any]) -> dict[str, Any]:
    return await fix_engine.send_cancel(payload)


@app.post("/api/fix/replace")
async def fix_replace(payload: dict[str, Any]) -> dict[str, Any]:
    return await fix_engine.send_cancel_replace(payload)


@app.get("/api/fix/stats")
async def fix_stats() -> dict[str, Any]:
    return await fix_engine.stats()


@app.post("/api/execution/entry")
async def execution_entry_stub(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": True,
        "dry_run": settings.dry_run,
        "service": "execution",
        "position": {
            "position_id": "local-dry-run",
            "asset": payload.get("signal_dict", {}).get("asset", "ES"),
            "direction": payload.get("signal_dict", {}).get("direction", "UP"),
            "status": "pending",
            "entry_price": 0,
            "current_price": 0,
            "size": payload.get("size_usd", 0),
            "unrealized_pnl": 0,
            "pnl_pct": None,
        },
    }


@app.post("/api/alerts/sms")
async def send_sms_alert(payload: dict[str, Any]) -> JSONResponse:
    to = str(payload.get("to") or "").strip()
    message = str(payload.get("message") or "").strip()
    if not to or not message:
        return JSONResponse(
            {"ok": False, "configured": False, "error": "SMS alert requires both to and message."},
            status_code=400,
        )

    try:
        result = await asyncio.to_thread(_send_sms_alert_sync, to, message)
    except Exception as exc:
        return JSONResponse(
            {"ok": False, "configured": True, "error": f"SMS transport failed: {exc}"},
            status_code=502,
        )
    return JSONResponse(result, status_code=200 if result.get("ok") else 503)


@app.websocket("/ws/{asset}")
async def ws_endpoint(websocket: WebSocket, asset: str, provider: str = "cme") -> None:
    asset = asset.upper()
    if asset not in CME_INSTRUMENTS and asset not in SYNTHETIC_SPREADS:
        await websocket.close(code=1003)
        return

    await websocket.accept()
    await websocket.send_text(json.dumps(market_bus.snapshot(asset)))
    await websocket.send_text(json.dumps({"type": "order_snapshot", "data": order_state_snapshot()}))
    queue = market_bus.subscribe()
    try:
        while True:
            message = await queue.get()
            await websocket.send_text(json.dumps(message))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        market_bus.unsubscribe(queue)


@app.get("/")
async def terminal_index() -> FileResponse:
    index_path = FRONTEND_DIST / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=503, detail="Terminal frontend build is missing. Run apps/terminal build.")
    return FileResponse(index_path)


@app.get("/{full_path:path}")
async def terminal_spa(full_path: str) -> FileResponse:
    if full_path.startswith(("api/", "ws/")):
        raise HTTPException(status_code=404, detail="Not found")
    index_path = FRONTEND_DIST / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=503, detail="Terminal frontend build is missing. Run apps/terminal build.")
    return FileResponse(index_path)
