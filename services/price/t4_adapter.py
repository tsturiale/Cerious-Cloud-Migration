from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx
import websockets

from services.common.config import settings
from services.common.contracts import CME_INSTRUMENTS, Quote, now_ms
from t4.v1 import service_pb2
from t4.v1.auth import auth_pb2
from t4.v1.common import enums_pb2
from t4.v1.market import market_pb2


LOGGER = logging.getLogger(__name__)


class T4AuthenticationError(RuntimeError):
    pass


@dataclass(frozen=True)
class T4MarketRef:
    asset: str
    exchange_id: str
    contract_id: str
    market_id: str


def _parse_key_value_pairs(raw: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for part in raw.replace(",", ";").split(";"):
        if not part.strip() or "=" not in part:
            continue
        key, value = part.split("=", 1)
        key = key.strip().upper()
        value = value.strip()
        if key and value:
            result[key] = value
    return result


def _parse_market_refs(raw: str) -> dict[str, tuple[str, str, str]]:
    refs: dict[str, tuple[str, str, str]] = {}
    for part in raw.replace(",", ";").split(";"):
        if not part.strip() or "=" not in part:
            continue
        asset, value = part.split("=", 1)
        pieces = [piece.strip() for piece in value.split(":", 2)]
        if len(pieces) != 3 or not all(pieces):
            continue
        refs[asset.strip().upper()] = (pieces[0], pieces[1], pieces[2])
    return refs


def _depth_buffer(value: str) -> int:
    normalized = value.strip().lower().replace("-", "_")
    return {
        "slow_trade": enums_pb2.DEPTH_BUFFER_SLOW_TRADE,
        "smart_trade": enums_pb2.DEPTH_BUFFER_SMART_TRADE,
        "slow": enums_pb2.DEPTH_BUFFER_SLOW_SMART,
        "slow_smart": enums_pb2.DEPTH_BUFFER_SLOW_SMART,
        "smart": enums_pb2.DEPTH_BUFFER_SMART,
        "fast": enums_pb2.DEPTH_BUFFER_FAST_SMART,
        "fast_smart": enums_pb2.DEPTH_BUFFER_FAST_SMART,
        "all": enums_pb2.DEPTH_BUFFER_ALL,
        "fast_trade": enums_pb2.DEPTH_BUFFER_FAST_TRADE,
        "trade_only": enums_pb2.DEPTH_BUFFER_TRADE_ONLY,
    }.get(normalized, enums_pb2.DEPTH_BUFFER_SMART_TRADE)


def _depth_levels(value: str) -> int:
    normalized = value.strip().lower().replace("-", "_")
    return {
        "best": enums_pb2.DEPTH_LEVELS_BEST_ONLY,
        "best_only": enums_pb2.DEPTH_LEVELS_BEST_ONLY,
        "normal": enums_pb2.DEPTH_LEVELS_NORMAL,
        "all": enums_pb2.DEPTH_LEVELS_ALL,
    }.get(normalized, enums_pb2.DEPTH_LEVELS_NORMAL)


class T4Adapter:
    def __init__(self) -> None:
        self._ws: Any | None = None
        self._token: str = ""
        self._market_refs: dict[str, T4MarketRef] = {}
        self._market_to_asset: dict[str, str] = {}
        self._details: dict[str, Any] = {}
        self._latest_quotes: dict[str, Quote] = {}
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._last_error = ""
        self._connected = False
        self._logged_in = False
        self._subscribed = False

    @property
    def status(self) -> dict[str, Any]:
        return {
            "provider": "t4",
            "wsUrl": settings.t4_ws_url,
            "apiUrl": settings.t4_api_url,
            "exchangeId": settings.t4_exchange_id,
            "contracts": list(settings.t4_contracts),
            "marketCount": len(self._market_refs),
            "markets": [ref.__dict__ for ref in self._market_refs.values()],
            "connected": self._connected,
            "loggedIn": self._logged_in,
            "subscribed": self._subscribed,
            "lastError": self._last_error,
            "authMode": settings.t4_auth_mode,
            "hasApiKey": bool(settings.t4_api_key),
            "hasUserPassword": bool(settings.t4_username and settings.t4_password),
        }

    async def stream(self) -> AsyncIterator[Quote]:
        if not settings.t4_api_key and not (settings.t4_username and settings.t4_password):
            raise RuntimeError("T4 credentials are missing. Set T4_API_KEY or T4_USERNAME/T4_PASSWORD in .env.")

        while True:
            try:
                async with websockets.connect(settings.t4_ws_url, max_size=None) as websocket:
                    self._ws = websocket
                    self._connected = True
                    self._logged_in = False
                    self._subscribed = False
                    self._last_error = ""
                    await self._send_login()
                    self._heartbeat_task = asyncio.create_task(self._heartbeat_loop(), name="price.t4-heartbeat")

                    async for raw_message in websocket:
                        for quote in await self._handle_raw_message(raw_message):
                            yield quote
                        if self._logged_in and not self._subscribed:
                            await self._subscribe_default_markets()
            except asyncio.CancelledError:
                raise
            except T4AuthenticationError:
                self._connected = False
                self._logged_in = False
                self._subscribed = False
                raise
            except Exception as exc:
                self._connected = False
                self._logged_in = False
                self._subscribed = False
                self._last_error = str(exc)
                LOGGER.warning("T4 ingress disconnected: %s", exc)
                await asyncio.sleep(settings.t4_reconnect_seconds)
            finally:
                self._connected = False
                if self._heartbeat_task:
                    self._heartbeat_task.cancel()
                    try:
                        await self._heartbeat_task
                    except asyncio.CancelledError:
                        pass
                    self._heartbeat_task = None

    async def _send_login(self) -> None:
        login = auth_pb2.LoginRequest(price_format=settings.t4_price_format)
        if self._use_api_key_auth():
            login.api_key = settings.t4_api_key
            login.app_name = settings.t4_app_name
            login.app_license = settings.t4_app_license
        else:
            login.firm = settings.t4_firm
            login.username = settings.t4_username
            login.password = settings.t4_password
            login.app_name = settings.t4_app_name
            login.app_license = settings.t4_app_license
        await self._send({"login_request": login})

    def _use_api_key_auth(self) -> bool:
        mode = settings.t4_auth_mode.replace("-", "_")
        if mode in {"user", "user_password", "username", "password"}:
            return False
        return bool(settings.t4_api_key)

    async def _heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(20)
            heartbeat = service_pb2.Heartbeat(timestamp=now_ms())
            await self._send({"heartbeat": heartbeat})

    async def _send(self, payload: dict[str, Any]) -> None:
        if self._ws is None:
            raise RuntimeError("T4 websocket is not connected")
        client_message = service_pb2.ClientMessage()
        key, message = next(iter(payload.items()))
        getattr(client_message, key).CopyFrom(message)
        await self._ws.send(client_message.SerializeToString())

    async def _handle_raw_message(self, raw_message: bytes | str) -> list[Quote]:
        if isinstance(raw_message, str):
            raw_message = raw_message.encode()
        server_message = service_pb2.ServerMessage()
        server_message.ParseFromString(raw_message)
        payload = server_message.WhichOneof("payload")
        if payload == "login_response":
            self._handle_login(server_message.login_response)
            return []
        if payload == "authentication_token":
            token = server_message.authentication_token
            self._token = token.token if token.HasField("token") else ""
            return []
        if payload == "market_details":
            details = server_message.market_details
            self._details[details.market_id] = details
            if details.contract_id:
                self._market_to_asset.setdefault(details.market_id, details.contract_id.upper())
            return []
        if payload == "market_depth":
            quote = self._quote_from_depth(server_message.market_depth)
            return [quote] if quote else []
        if payload == "market_depth_trade":
            quote = self._quote_from_trade(server_message.market_depth_trade)
            return [quote] if quote else []
        if payload == "market_snapshot":
            return self._quotes_from_snapshot(server_message.market_snapshot)
        if payload in {"market_depth_subscribe_reject", "market_by_order_subscribe_reject"}:
            reject = getattr(server_message, payload)
            self._last_error = f"{payload}: {reject.market_id}"
            LOGGER.warning("T4 subscription rejected: %s", self._last_error)
        return []

    def _handle_login(self, response: Any) -> None:
        if response.result != enums_pb2.LOGIN_RESULT_SUCCESS:
            self._last_error = f"login failed result={response.result} {response.error_message}"
            raise T4AuthenticationError(self._last_error)
        self._logged_in = True
        if response.HasField("authentication_token"):
            self._token = response.authentication_token.token

    async def _subscribe_default_markets(self) -> None:
        self._market_refs = await self._resolve_markets()
        if not self._market_refs:
            raise RuntimeError("No T4 markets resolved. Set T4_MARKETS or T4_MARKET_IDS in .env.")

        for ref in self._market_refs.values():
            self._market_to_asset[ref.market_id] = ref.asset
            subscribe = market_pb2.MarketDepthSubscribe(
                exchange_id=ref.exchange_id,
                contract_id=ref.contract_id,
                market_id=ref.market_id,
                buffer=_depth_buffer(settings.t4_depth_buffer),
                depth_levels=_depth_levels(settings.t4_depth_levels),
            )
            await self._send({"market_depth_subscribe": subscribe})
        self._subscribed = True

    async def _resolve_markets(self) -> dict[str, T4MarketRef]:
        explicit_refs = _parse_market_refs(settings.t4_markets)
        explicit_ids = _parse_key_value_pairs(settings.t4_market_ids)
        refs: dict[str, T4MarketRef] = {}

        for asset in settings.t4_contracts:
            if asset not in CME_INSTRUMENTS:
                continue
            if asset in explicit_refs:
                exchange_id, contract_id, market_id = explicit_refs[asset]
            else:
                exchange_id = settings.t4_exchange_id
                contract_id = asset
                market_id = explicit_ids.get(asset) or await self._fetch_first_market_id(exchange_id, contract_id)
            if market_id:
                refs[asset] = T4MarketRef(
                    asset=asset,
                    exchange_id=exchange_id,
                    contract_id=contract_id,
                    market_id=market_id,
                )
        return refs

    async def _fetch_first_market_id(self, exchange_id: str, contract_id: str) -> str:
        headers = {"Content-Type": "application/json"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        elif settings.t4_api_key:
            headers["Authorization"] = f"APIKey {settings.t4_api_key}"

        url = f"{settings.t4_api_url.rstrip('/')}/markets/picker/firstmarket"
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(url, params={"exchangeid": exchange_id, "contractid": contract_id}, headers=headers)
            if response.status_code != 200:
                LOGGER.warning("T4 firstmarket failed for %s/%s: %s", exchange_id, contract_id, response.status_code)
                return ""
            data = response.json()
            return str(data.get("marketID") or data.get("marketId") or data.get("market_id") or "")

    def _quotes_from_snapshot(self, snapshot: Any) -> list[Quote]:
        quotes: list[Quote] = []
        for message in snapshot.messages:
            payload = message.WhichOneof("payload")
            if payload == "market_depth":
                quote = self._quote_from_depth(message.market_depth)
            elif payload == "market_depth_trade":
                quote = self._quote_from_trade(message.market_depth_trade)
            else:
                quote = None
            if quote:
                quotes.append(quote)
        return quotes

    def _quote_from_depth(self, depth: Any) -> Quote | None:
        asset = self._asset_for_market(depth.market_id)
        if not asset or not depth.bids or not depth.offers:
            return None

        bid = self._price(depth.bids[0].price)
        ask = self._price(depth.offers[0].price)
        if bid <= 0 or ask <= 0:
            return None

        previous = self._latest_quotes.get(asset)
        ts_ms = self._timestamp_ms(depth.time)
        last = previous.last if previous else (bid + ask) / 2
        last_size = previous.last_size if previous else 0.0
        volume = previous.volume if previous else 0.0
        if depth.HasField("trade_data"):
            trade = depth.trade_data
            if trade.HasField("last_trade_price"):
                last = self._price(trade.last_trade_price)
            last_size = float(trade.last_trade_volume or last_size)
            volume = float(trade.total_traded_volume or volume)
            ts_ms = self._timestamp_ms(trade.time) or ts_ms

        quote = Quote(
            asset=asset,
            ts_ms=ts_ms or now_ms(),
            bid=bid,
            ask=ask,
            bid_size=float(depth.bids[0].volume or 0),
            ask_size=float(depth.offers[0].volume or 0),
            last=last,
            last_size=last_size,
            volume=volume,
            source="t4-cme",
        )
        self._latest_quotes[asset] = quote
        return quote

    def _quote_from_trade(self, trade: Any) -> Quote | None:
        asset = self._asset_for_market(trade.market_id)
        previous = self._latest_quotes.get(asset or "")
        if not asset or previous is None or not trade.HasField("last_trade_price"):
            return None
        quote = Quote(
            asset=asset,
            ts_ms=self._timestamp_ms(trade.time) or now_ms(),
            bid=previous.bid,
            ask=previous.ask,
            bid_size=previous.bid_size,
            ask_size=previous.ask_size,
            last=self._price(trade.last_trade_price),
            last_size=float(trade.last_trade_volume or 0),
            volume=float(trade.total_traded_volume or previous.volume),
            source="t4-cme",
        )
        self._latest_quotes[asset] = quote
        return quote

    def _asset_for_market(self, market_id: str) -> str:
        asset = self._market_to_asset.get(market_id, "")
        if asset in CME_INSTRUMENTS:
            return asset
        details = self._details.get(market_id)
        if details and details.contract_id.upper() in CME_INSTRUMENTS:
            return details.contract_id.upper()
        return ""

    def _timestamp_ms(self, timestamp: Any) -> int:
        seconds = int(getattr(timestamp, "seconds", 0) or 0)
        nanos = int(getattr(timestamp, "nanos", 0) or 0)
        if not seconds and not nanos:
            return 0
        return seconds * 1000 + nanos // 1_000_000

    def _price(self, price: Any) -> float:
        try:
            return float(price.value)
        except (TypeError, ValueError):
            return 0.0
