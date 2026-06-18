"""Cerious FIX Engine — Python UI proxy.

This module contains ZERO FIX logic. It is a thin HTTP client that proxies
requests from the Python gateway REST API to the C++ FIX engine daemon
running on localhost:8010.

All FIX message construction, parsing, session management, TCP I/O, and
Aeron IPC live in C++ at native/fix-engine-cpp/. Python is UI-only.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from services.common.config import settings


class FixEngineProxy:
    """Thin HTTP proxy to the C++ FIX engine daemon."""

    def __init__(self) -> None:
        host = settings.fix_http_host if hasattr(settings, "fix_http_host") else "127.0.0.1"
        port = settings.fix_http_port if hasattr(settings, "fix_http_port") else 8010
        self._base_url = f"http://{host}:{port}"
        self._client = httpx.AsyncClient(base_url=self._base_url, timeout=5.0)

    async def start(self) -> None:
        """No-op — the C++ daemon manages its own lifecycle."""
        pass

    async def stop(self) -> None:
        """Close the HTTP client."""
        await self._client.aclose()

    async def status(self) -> dict[str, Any]:
        """Proxy GET /status to the C++ daemon."""
        try:
            resp = await self._client.get("/status")
            resp.raise_for_status()
            return resp.json()
        except Exception:
            return {
                "state": "UNREACHABLE",
                "senderCompId": "",
                "targetCompId": "",
                "targetHost": "(C++ daemon not running)",
                "targetPort": 0,
                "sendSeqNum": 0,
                "recvSeqNum": 0,
                "heartbeatInterval": 0,
                "sentCount": 0,
                "recvCount": 0,
                "errorCount": 0,
                "journalSize": 0,
                "startedAt": None,
                "uptimeSeconds": 0,
                "dryRun": settings.dry_run,
                "fixVersion": "FIX.4.4",
            }

    async def journal(
        self,
        limit: int = 200,
        direction: str | None = None,
        msg_type: str | None = None,
        errors_only: bool = False,
    ) -> dict[str, Any]:
        """Proxy GET /journal to the C++ daemon."""
        try:
            params: dict[str, Any] = {"limit": limit}
            if direction:
                params["direction"] = direction
            if msg_type:
                params["msgType"] = msg_type
            if errors_only:
                params["errorsOnly"] = "true"
            resp = await self._client.get("/journal", params=params)
            resp.raise_for_status()
            return resp.json()
        except Exception:
            return {"entries": [], "total": 0, "status": await self.status()}

    async def send_new_order(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Proxy POST /send to the C++ daemon."""
        try:
            resp = await self._client.post("/send", json=payload)
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:
            return {"ok": False, "error": f"C++ daemon unreachable: {exc}"}

    async def send_cancel(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Proxy POST /cancel to the C++ daemon."""
        try:
            resp = await self._client.post("/cancel", json=payload)
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:
            return {"ok": False, "error": f"C++ daemon unreachable: {exc}"}

    async def send_cancel_replace(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Proxy POST /replace to the C++ daemon."""
        try:
            resp = await self._client.post("/replace", json=payload)
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:
            return {"ok": False, "error": f"C++ daemon unreachable: {exc}"}

    async def stats(self) -> dict[str, Any]:
        """Proxy GET /stats to the C++ daemon."""
        try:
            resp = await self._client.get("/stats")
            resp.raise_for_status()
            return resp.json()
        except Exception:
            return {
                "sentCount": 0,
                "recvCount": 0,
                "errorCount": 0,
                "journalSize": 0,
                "state": "UNREACHABLE",
            }


# Singleton — the gateway imports this.
fix_engine = FixEngineProxy()
