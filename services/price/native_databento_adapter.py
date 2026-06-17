from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import AsyncIterator

from services.common.config import settings
from services.common.contracts import CME_INSTRUMENTS, Quote, now_ms


class NativeDatabentoAdapter:
    def __init__(self) -> None:
        self._root = Path(__file__).resolve().parents[2]
        self._process: asyncio.subprocess.Process | None = None
        self._last_trade_price: dict[str, float] = {}
        self._last_trade_size: dict[str, float] = {}
        self._session_volume: dict[str, float] = {}
        self._last_error = ""
        self._restart_count = 0
        self._records = 0

    @property
    def status(self) -> dict:
        return {
            "provider": "databento_cpp",
            "mode": "native-subprocess",
            "schema": settings.cme_schema,
            "symbols": list(settings.cme_symbols),
            "records": self._records,
            "restartCount": self._restart_count,
            "pid": self._process.pid if self._process else None,
            "lastError": self._last_error,
            "executable": str(self._executable_path()),
        }

    async def stream(self) -> AsyncIterator[Quote]:
        while True:
            try:
                async for quote in self._run_once():
                    yield quote
            except asyncio.CancelledError:
                await self._stop_process()
                raise
            except Exception as exc:
                self._last_error = str(exc)
                self._restart_count += 1
                await self._stop_process()
                await asyncio.sleep(2.0)

    async def _run_once(self) -> AsyncIterator[Quote]:
        executable = self._executable_path()
        if not executable.exists():
            raise FileNotFoundError(f"Native Databento feed handler not built: {executable}")
        if not settings.databento_api_key:
            raise RuntimeError("DATABENTO_API_KEY is required for native Databento feed handler")

        env = dict(os.environ)
        env["DATABENTO_API_KEY"] = settings.databento_api_key
        args = [
            str(executable),
            "--symbols",
            ",".join(settings.cme_symbols),
            "--stype",
            "continuous",
        ]
        self._process = await asyncio.create_subprocess_exec(
            *args,
            cwd=str(self._root),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stderr_task = asyncio.create_task(self._consume_stderr(), name="price.databento_cpp.stderr")
        try:
            assert self._process.stdout is not None
            while True:
                raw = await self._process.stdout.readline()
                if not raw:
                    code = await self._process.wait()
                    raise RuntimeError(f"Native Databento feed handler exited with code {code}")
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    self._last_error = f"native feed decode error: {exc}"
                    continue
                quote = self._payload_to_quote(payload)
                if quote is None:
                    continue
                self._records += 1
                yield quote
        finally:
            stderr_task.cancel()
            await self._stop_process()

    async def _consume_stderr(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        while True:
            raw = await process.stderr.readline()
            if not raw:
                return
            line = raw.decode("utf-8", errors="replace").strip()
            if line:
                self._last_error = line[-500:]

    async def _stop_process(self) -> None:
        process = self._process
        self._process = None
        if process is None or process.returncode is not None:
            return
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=3.0)
        except TimeoutError:
            process.kill()
            await process.wait()

    def _executable_path(self) -> Path:
        configured = os.getenv("CERIOUS_DATABENTO_CPP_EXE", "").strip()
        if configured:
            return Path(configured)
        suffix = ".exe" if os.name == "nt" else ""
        return self._root / "native" / "price-feed-cpp" / "build" / f"cerious_price_feed{suffix}"

    def _payload_to_quote(self, payload: dict) -> Quote | None:
        if payload.get("type") != "market.mbp1":
            return None
        asset = self._asset_from_symbol(str(payload.get("symbol") or ""))
        if asset not in CME_INSTRUMENTS:
            return None

        bid = self._number(payload.get("bid"))
        ask = self._number(payload.get("ask"))
        if bid <= 0 or ask <= 0:
            return None
        ts_ns = int(self._number(payload.get("tsEventNs")))
        ts_ms = int(ts_ns / 1_000_000) if ts_ns > 0 else now_ms()
        action = str(payload.get("action") or "").upper()
        is_trade = action == "T"
        trade_price = self._number(payload.get("price"))
        trade_size = self._number(payload.get("size"))
        if is_trade and trade_price > 0:
            self._last_trade_price[asset] = trade_price
            self._last_trade_size[asset] = trade_size
            self._session_volume[asset] = self._session_volume.get(asset, 0.0) + trade_size

        last = self._last_trade_price.get(asset, (bid + ask) / 2)
        return Quote(
            asset=asset,
            ts_ms=ts_ms,
            bid=round(bid, 6),
            ask=round(ask, 6),
            bid_size=self._number(payload.get("bidSize")),
            ask_size=self._number(payload.get("askSize")),
            last=round(last, 6),
            last_size=self._last_trade_size.get(asset, 0.0) if not is_trade else trade_size,
            volume=self._session_volume.get(asset, 0.0),
            source="databento-cme-native",
            is_trade=is_trade,
        )

    def _asset_from_symbol(self, symbol: str) -> str | None:
        upper = symbol.upper()
        for asset in sorted(CME_INSTRUMENTS, key=len, reverse=True):
            if upper.startswith(asset):
                return asset
        return None

    def _number(self, value: object, fallback: float = 0.0) -> float:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return fallback
        return parsed if parsed == parsed else fallback
