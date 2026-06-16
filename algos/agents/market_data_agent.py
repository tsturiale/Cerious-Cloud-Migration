"""
agents/market_data_agent.py
Fetches OHLCV data in three modes:
  - LIVE: Binance REST polling every 60s (upgrade to WebSocket for <2s latency)
  - PAPER: Same as live but execution is simulated
  - BACKTEST: Reads local CSV files bar-by-bar for portfolio validation
"""

import ccxt
import pandas as pd
import numpy as np
import time
import logging
import os
import requests
from typing import Callable, Dict, List, Optional

from core.state_store import StateStore, BarState

logger = logging.getLogger("MarketDataAgent")
_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir, os.pardir))
_DEFAULT_CRYPTO_DATA_DIR = os.path.join(_PROJECT_ROOT, "data", "crypto")


# ─── VWAP calculation helper ──────────────────────────────────────────────────

def compute_vwap(bars: List[BarState]) -> float:
    """Compute VWAP from a list of BarState objects."""
    if not bars:
        return 0.0
    total_vol = sum(b.volume for b in bars)
    if total_vol < 1e-10:
        return bars[-1].close
    typical = sum(((b.high + b.low + b.close) / 3) * b.volume for b in bars)
    return typical / total_vol


# ─── Market Data Agent ────────────────────────────────────────────────────────

class MarketDataAgent:
    """
    Feeds 1-minute OHLCV bars into StateStore.
    ATREngine and strategy agents consume from the store.

    Supported symbols: BTC, ETH, SOL, XRP (maps to Coinbase USD pairs)
    """

    SYMBOL_MAP = {
        "BTC": "BTC/USD",
        "ETH": "ETH/USD",
        "SOL": "SOL/USD",
        "XRP": "XRP/USD",
    }

    CSV_MAP = {
        "BTC": "BTC_USD_1m_3y.csv",
        "ETH": "ETH_USD_1m_3y.csv",
        "SOL": "SOL_USD_1m_3y.csv",
        "XRP": "XRP_USD_1m_3y.csv",
    }

    def __init__(self, symbols: List[str], cfg: dict, store: StateStore,
                 on_bar_callback: Optional[Callable] = None, data_dir: str = None):
        self.symbols = symbols
        self.cfg = cfg
        self.store = store
        self.on_bar_callback = on_bar_callback
        self.data_dir = data_dir or os.getenv("CERIOUS_CRYPTO_DATA_DIR", _DEFAULT_CRYPTO_DATA_DIR)

        self._exchange = None
        self._backtest_data: Dict[str, pd.DataFrame] = {}
        self._backtest_idx: Dict[str, int] = {}
        self._running = False
        md_cfg = cfg.get("market_data", {})
        self._data_source = md_cfg.get("source", "binance").lower()
        self._backend_base = md_cfg.get("backend_base_url", "http://127.0.0.1:8001").rstrip("/")
        self._poly_timeframe = md_cfg.get("polymarket_timeframe", "5min")
        self._poly_poll_seconds = float(md_cfg.get("polymarket_poll_seconds", 8.0))
        self._last_poly_close: Dict[str, float] = {}

    # ─── Data loading ─────────────────────────────────────────────────────────

    def _init_live(self):
        if self._data_source == "polymarket_backend":
            logger.info(f"Polymarket backend source initialized: {self._backend_base}")
            return
        self._exchange = ccxt.coinbase({"enableRateLimit": True})
        logger.info("Binance exchange initialized.")

    def _fetch_backend_markets(self) -> List[dict]:
        resp = requests.get(f"{self._backend_base}/api/markets", timeout=60)
        resp.raise_for_status()
        data = resp.json()
        return data.get("markets", [])

    def _pick_market_for_symbol(self, symbol: str, markets: List[dict]) -> Optional[dict]:
        tf = str(self._poly_timeframe)
        for m in markets:
            if m.get("asset") == symbol and m.get("timeframe") == tf:
                return m
        # Fallback: first market for asset if selected tf missing
        for m in markets:
            if m.get("asset") == symbol:
                return m
        return None

    def _build_poly_df_from_history(self, symbol: str, n: int) -> pd.DataFrame:
        markets = self._fetch_backend_markets()
        m = self._pick_market_for_symbol(symbol, markets)
        if not m or not m.get("up_token_id"):
            return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume"])

        token_id = m.get("up_token_id")
        resp = requests.get(
            f"{self._backend_base}/api/poly/prices-history",
            params={"token_id": token_id, "fidelity": 1, "days": 3},
            timeout=60,
        )
        resp.raise_for_status()
        pts = resp.json().get("history", [])
        if not pts:
            return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume"])

        rows = []
        prev_close = None
        for pt in pts[-n:]:
            close = float(pt.get("up_pct", 50.0)) / 100.0
            ts = pd.to_datetime(int(pt.get("ts", int(time.time() * 1000))), unit="ms")
            open_px = prev_close if prev_close is not None else close
            high = max(open_px, close)
            low = min(open_px, close)
            rows.append({
                "timestamp": ts,
                "open": open_px,
                "high": high,
                "low": low,
                "close": close,
                "volume": float(m.get("volume", 0.0)),
            })
            prev_close = close
        if rows:
            self._last_poly_close[symbol] = rows[-1]["close"]
        return pd.DataFrame(rows)

    def load_backtest_data(self, start: str = None, end: str = None):
        """Load CSV files for all symbols. Call before run_backtest()."""
        for sym in self.symbols:
            fname = self.CSV_MAP.get(sym)
            if not fname:
                logger.warning(f"No CSV mapping for {sym}")
                continue
            fpath = os.path.join(self.data_dir, fname)
            if not os.path.exists(fpath):
                logger.error(f"CSV not found: {fpath}")
                continue
            logger.info(f"Loading {sym} from {fname} ...")
            try:
                # Read with standard columns: timestamp, open, high, low, close, volume
                df = pd.read_csv(fpath, encoding="utf-8")
                # Normalize columns to lowercase
                df.columns = [c.lower().strip() for c in df.columns]
                # Find the timestamp column (first col or named 'timestamp')
                if "timestamp" not in df.columns:
                    df = df.rename(columns={df.columns[0]: "timestamp"})
                df["timestamp"] = pd.to_datetime(df["timestamp"])
                # Ensure required columns exist
                for col in ["open", "high", "low", "close", "volume"]:
                    if col not in df.columns:
                        df[col] = 0.0
                df = df[["timestamp", "open", "high", "low", "close", "volume"]]
                df = df.sort_values("timestamp").reset_index(drop=True)
                # Date range filter
                if start:
                    df = df[df["timestamp"] >= pd.to_datetime(start)]
                if end:
                    df = df[df["timestamp"] <= pd.to_datetime(end)]
                df = df.reset_index(drop=True)
                self._backtest_data[sym] = df
                self._backtest_idx[sym] = 0
                logger.info(
                    f"  {sym}: {len(df):,} bars  "
                    f"({df['timestamp'].min().strftime('%Y-%m-%d')} → "
                    f"{df['timestamp'].max().strftime('%Y-%m-%d')})"
                )
            except Exception as e:
                logger.error(f"Failed to load {sym}: {e}")

    def _fetch_live_bars(self, symbol: str, limit: int = 5) -> pd.DataFrame:
        """Fetch last N 1-minute bars from Binance."""
        if self._data_source == "polymarket_backend":
            markets = self._fetch_backend_markets()
            m = self._pick_market_for_symbol(symbol, markets)
            if not m:
                return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume"])
            close = float(m.get("up_pct", 50.0)) / 100.0
            now = pd.Timestamp.utcnow().floor("s")
            prev = self._last_poly_close.get(symbol, close)
            self._last_poly_close[symbol] = close
            rows = [
                {
                    "timestamp": now - pd.Timedelta(minutes=1),
                    "open": prev,
                    "high": max(prev, close),
                    "low": min(prev, close),
                    "close": prev,
                    "volume": float(m.get("volume", 0.0)),
                },
                {
                    "timestamp": now,
                    "open": prev,
                    "high": max(prev, close),
                    "low": min(prev, close),
                    "close": close,
                    "volume": float(m.get("volume", 0.0)),
                },
            ]
            return pd.DataFrame(rows).tail(limit).reset_index(drop=True)
        ex_sym = self.SYMBOL_MAP.get(symbol, symbol)
        ohlcv = self._exchange.fetch_ohlcv(ex_sym, "1m", limit=limit)
        df = pd.DataFrame(ohlcv, columns=["timestamp", "open", "high", "low", "close", "volume"])
        df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms")
        return df

    def _prime_model_bars(self, symbol: str, n: int = 4800) -> pd.DataFrame:
        """Fetch enough historical bars to warm up the HMM model."""
        if self._data_source == "polymarket_backend":
            logger.info(f"Priming {symbol} from Polymarket backend with {n} points...")
            return self._build_poly_df_from_history(symbol, n)
        logger.info(f"Priming {symbol} with {n} bars...")
        ex_sym = self.SYMBOL_MAP.get(symbol, symbol)
        since = self._exchange.milliseconds() - (n * 60 * 1000 + 3600000)
        ohlcv = []
        while len(ohlcv) < n:
            batch = self._exchange.fetch_ohlcv(ex_sym, "1m", since=since + len(ohlcv) * 60000, limit=1000)
            if not batch:
                break
            ohlcv.extend(batch)
            time.sleep(0.1)
        df = pd.DataFrame(ohlcv, columns=["timestamp", "open", "high", "low", "close", "volume"])
        df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms")
        df = df.drop_duplicates("timestamp").sort_values("timestamp")
        return df.tail(n).reset_index(drop=True)

    # ─── Bar emission ─────────────────────────────────────────────────────────

    def _emit_bar(self, symbol: str, row: pd.Series):
        """Push a 1m bar into StateStore and call strategies via callback."""
        # 15-min VWAP from recent history
        hist = self.store.get_bar_history(symbol, "1m", n=15)
        vwap = compute_vwap(hist) if hist else float(row.get("close", 0))

        bar = BarState(
            symbol=symbol,
            tf="1m",
            open=float(row.get("open", 0)),
            high=float(row.get("high", 0)),
            low=float(row.get("low", 0)),
            close=float(row.get("close", 0)),
            volume=float(row.get("volume", 0)),
            vwap=vwap,
            timestamp=float(pd.Timestamp(row.get("timestamp", pd.Timestamp.now())).timestamp()),
        )
        self.store.update_bar(symbol, "1m", bar)

        if self.on_bar_callback:
            self.on_bar_callback(symbol, bar)

    # ─── Live / Paper mode ────────────────────────────────────────────────────

    def run_live(self):
        """
        Live polling loop. Fetches new 1m candles every 60 seconds.
        For sub-2s execution, replace with WebSocket feed.
        """
        self._init_live()
        self._running = True
        # Prime each symbol
        for sym in self.symbols:
            df_prime = self._prime_model_bars(sym)
            for _, row in df_prime.iterrows():
                self._emit_bar(sym, row)
            logger.info(f"{sym} primed with {len(df_prime)} bars.")

        logger.info("LIVE mode: monitoring markets...")
        while self._running:
            for sym in self.symbols:
                try:
                    df = self._fetch_live_bars(sym, limit=2)
                    for _, row in df.iterrows():
                        self._emit_bar(sym, row)
                except Exception as e:
                    logger.error(f"Error fetching {sym}: {e}")
            time.sleep(self._poly_poll_seconds if self._data_source == "polymarket_backend" else 60)

    def stop(self):
        self._running = False

    # ─── Backtest mode ────────────────────────────────────────────────────────

    def run_backtest(self, speed_factor: float = 0.0) -> bool:
        """
        Step through all symbols bar-by-bar in time order.
        Returns True when all data is exhausted.
        speed_factor=0.0 means max speed (no sleep).
        """
        if not self._backtest_data:
            logger.error("No backtest data loaded. Call load_backtest_data() first.")
            return True

        # Build a unified time-sorted index across all symbols
        dfs = {sym: self._backtest_data[sym] for sym in self._backtest_data}
        # Find common time range
        all_timestamps = None
        for sym, df in dfs.items():
            ts = set(df["timestamp"].astype(str))
            all_timestamps = ts if all_timestamps is None else all_timestamps & ts

        logger.info(f"Backtest: aligned {len(all_timestamps or [])} common timestamps")

        # Emit bars bar-by-bar across all symbols at each timestamp
        # Use a simple per-symbol sequential approach for speed
        total_bars = max(len(df) for df in dfs.values())
        idx = {sym: 0 for sym in dfs}

        # Find global min/max
        min_len = min(len(df) for df in dfs.values())
        logger.info(f"Running backtest for {min_len} bars per symbol...")

        for i in range(min_len):
            for sym, df in dfs.items():
                if idx[sym] < len(df):
                    row = df.iloc[idx[sym]]
                    self._emit_bar(sym, row)
                    idx[sym] += 1

            if speed_factor > 0:
                time.sleep(speed_factor)

        logger.info("Backtest complete.")
        return True

    def get_backtest_df(self, symbol: str) -> Optional[pd.DataFrame]:
        """Return the raw backtest DataFrame for a symbol."""
        return self._backtest_data.get(symbol)
