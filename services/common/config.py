from __future__ import annotations

import os
from dataclasses import dataclass

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


@dataclass(frozen=True)
class Settings:
    app_name: str = "Cerious Systems Terminal Gateway"
    price_provider: str = os.getenv("CERIOUS_PRICE_PROVIDER", "databento").strip().lower()
    cme_dataset: str = os.getenv("CERIOUS_CME_DATASET", "GLBX.MDP3")
    cme_schema: str = os.getenv("CERIOUS_CME_SCHEMA", "mbp-1")
    cme_symbols: tuple[str, ...] = tuple(
        part.strip()
        for part in os.getenv("CERIOUS_CME_SYMBOLS", "ES.v.0,NQ.v.0,YM.v.0,RTY.v.0,CL.v.0,GC.v.0,ZM.v.0,ZS.v.0").split(",")
        if part.strip()
    )
    databento_api_key: str = os.getenv("DATABENTO_API_KEY", "")
    t4_auth_mode: str = os.getenv("T4_AUTH_MODE", "api_key").strip().lower()
    t4_api_key: str = os.getenv("T4_API_KEY", "")
    t4_ws_url: str = os.getenv("T4_WS_URL", "wss://wss-sim.t4login.com/v1")
    t4_api_url: str = os.getenv("T4_API_URL", "https://api-sim.t4login.com")
    t4_firm: str = os.getenv("T4_FIRM", "")
    t4_username: str = os.getenv("T4_USERNAME", "")
    t4_password: str = os.getenv("T4_PASSWORD", "")
    t4_app_name: str = os.getenv("T4_APP_NAME", "Cerious Systems")
    t4_app_license: str = os.getenv("T4_APP_LICENSE", "")
    t4_price_format: int = int(os.getenv("T4_PRICE_FORMAT", "2"))
    t4_exchange_id: str = os.getenv("T4_EXCHANGE_ID", "CME_Eq")
    t4_contracts: tuple[str, ...] = tuple(
        part.strip().upper()
        for part in os.getenv("T4_CONTRACTS", "ES,NQ,YM,RTY,CL,GC,ZM,ZS").split(",")
        if part.strip()
    )
    t4_markets: str = os.getenv("T4_MARKETS", "")
    t4_market_ids: str = os.getenv("T4_MARKET_IDS", "")
    t4_depth_buffer: str = os.getenv("T4_DEPTH_BUFFER", "smart_trade")
    t4_depth_levels: str = os.getenv("T4_DEPTH_LEVELS", "normal")
    t4_reconnect_seconds: float = float(os.getenv("T4_RECONNECT_SECONDS", "5"))
    dry_run: bool = os.getenv("CERIOUS_DRY_RUN", "1") != "0"


settings = Settings()
