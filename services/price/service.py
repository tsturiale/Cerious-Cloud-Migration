from __future__ import annotations

import asyncio
import contextlib

from services.common.bus import market_bus
from services.common.config import settings
from services.price.cme_adapter import CmeAdapter
from services.price.native_databento_adapter import NativeDatabentoAdapter
from services.price.t4_adapter import T4Adapter


class PriceService:
    def __init__(self) -> None:
        self._task: asyncio.Task[None] | None = None
        self._provider = settings.price_provider
        self._adapter = self._build_adapter()

    def _build_adapter(self) -> CmeAdapter | T4Adapter | NativeDatabentoAdapter:
        if self._provider == "t4":
            return T4Adapter()
        if self._provider in {"databento_cpp", "cpp_databento", "native_databento"}:
            return NativeDatabentoAdapter()
        return CmeAdapter()

    def status(self) -> dict:
        adapter_status = getattr(self._adapter, "status", None)
        return {
            "provider": self._provider,
            "running": bool(self._task and not self._task.done()),
            "taskDone": bool(self._task and self._task.done()),
            "adapter": adapter_status if isinstance(adapter_status, dict) else {"provider": self._provider},
        }

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(self._run(), name=f"price.{self._provider}-ingress")

    async def stop(self) -> None:
        if not self._task:
            return
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task

    async def _run(self) -> None:
        async for quote in self._adapter.stream():
            await market_bus.publish_quote(quote)


price_service = PriceService()
