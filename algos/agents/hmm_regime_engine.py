"""
agents/hmm_regime_engine.py
Wraps the existing HybridHMMKeltnerTrader from run_crypto_system.py.
Classifies each 15-minute bar into a named HMM regime and publishes to StateStore.
"""

import sys
import os
import numpy as np
import pandas as pd
import logging
from typing import Dict, Optional

# Add parent data directory to path so we can import the existing engine
_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir, os.pardir))
_DATA_DIR = os.getenv("CERIOUS_CRYPTO_DATA_DIR", os.path.join(_PROJECT_ROOT, "data", "crypto"))
if _DATA_DIR not in sys.path:
    sys.path.insert(0, _DATA_DIR)

try:
    from run_crypto_system import HybridHMMKeltnerTrader, compute_features
    _HMM_AVAILABLE = True
except ImportError:
    _HMM_AVAILABLE = False
    logging.getLogger("HMMRegimeEngine").warning(
        "run_crypto_system.py not found — HMM regime will default to 'Unknown'."
    )

from core.state_store import StateStore, RegimeState

logger = logging.getLogger("HMMRegimeEngine")


class HMMRegimeEngine:
    """
    Maintains one HybridHMMKeltnerTrader per symbol.
    On each new 15-minute bar, updates the model and publishes regime to StateStore.
    """

    def __init__(self, cfg: dict, store: StateStore):
        self.cfg = cfg
        self.store = store
        self._hmm_cfg = cfg.get("hmm", {})
        self.n_regimes = self._hmm_cfg.get("n_regimes", 6)
        self.lookback = self._hmm_cfg.get("lookback", 300)
        self.resample_tf = self._hmm_cfg.get("resample_tf", "15min")

        # One trader per symbol
        self._traders: Dict[str, object] = {}

        # 1m bar accumulator for resampling -> 15m
        self._bar_buffer: Dict[str, pd.DataFrame] = {}
        self._last_15m: Dict[str, Optional[pd.Timestamp]] = {}
        self._precomputed_regimes: Dict[str, Dict[pd.Timestamp, RegimeState]] = {}

    def _get_or_create_trader(self, symbol: str):
        if symbol not in self._traders:
            if _HMM_AVAILABLE:
                self._traders[symbol] = HybridHMMKeltnerTrader(
                    n_regimes=self.n_regimes,
                    lookback=self.lookback
                )
            else:
                self._traders[symbol] = None
        return self._traders[symbol]

    def on_bar(self, symbol: str, high: float, low: float, close: float,
               volume: float, timestamp: pd.Timestamp):
        """
        Feed a new 1-minute bar. Will only update HMM when a new 15m boundary is crossed.
        In backtest mode, uses precomputed regimes if available.
        """
        # 1. Use precomputed if available (Backtest Speed Optimization)
        if symbol in self._precomputed_regimes:
            regime = self._precomputed_regimes[symbol].get(timestamp)
            if regime:
                self.store.update_regime(symbol, regime)
                return

        # 2. Otherwise use live/standard accumulator
        if symbol not in self._bar_buffer:
            self._bar_buffer[symbol] = []
            self._last_15m[symbol] = None

        self._bar_buffer[symbol].append({
            "timestamp": timestamp,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
            "open": close,
        })

        rounded = timestamp.floor("15min")
        if self._last_15m[symbol] is not None and rounded <= self._last_15m[symbol]:
            return

        self._last_15m[symbol] = rounded
        self._process_15m(symbol)

    def _process_15m(self, symbol: str):
        """Resample buffer to 15m, compute features, update HMM."""
        trader = self._get_or_create_trader(symbol)
        if trader is None:
            self.store.update_regime(symbol, RegimeState(
                hmm_regime_id=0,
                hmm_regime_name="NoHMM",
                updated_at=pd.Timestamp.now().timestamp()
            ))
            return

        buf = self._bar_buffer[symbol]
        if len(buf) < 15:
            return

        df = pd.DataFrame(buf)
        df["timestamp"] = pd.to_datetime(df["timestamp"])
        df = df.set_index("timestamp").sort_index()

        df_15m = df.resample("15min").agg({
            "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
        }).dropna()

        if len(df_15m) < 2:
            return

        try:
            if _HMM_AVAILABLE:
                df_15m = compute_features(df_15m)
                df_15m["mom"] = np.log(df_15m["close"] / df_15m["close"].shift(5))
                df_15m["tod_sin"] = np.sin(2 * np.pi * df_15m.index.hour / 24)
                df_15m = df_15m.dropna()

                if len(df_15m) > 0:
                    trader.update(df_15m.iloc[-1].to_dict())
                    rid = trader.regime_history[-1] if trader.regime_history else 0
                    rname = trader.regime_names.get(rid, f"Regime_{rid}")
                    self.store.update_regime(symbol, RegimeState(
                        hmm_regime_id=int(rid),
                        hmm_regime_name=str(rname),
                        updated_at=pd.Timestamp.now().timestamp()
                    ))
        except Exception as e:
            logger.error(f"HMM live update error: {e}")

    def precompute_regimes(self, symbol: str, df_1m: pd.DataFrame):
        """
        Bulk precompute HMM regimes for an entire 1-minute DataFrame.
        This is used for backtesting speed.
        """
        if not _HMM_AVAILABLE:
            return

        logger.info(f"Precomputing HMM regimes for {symbol} ({len(df_1m)} bars)...")
        trader = self._get_or_create_trader(symbol)
        
        # Resample to 15m
        df = df_1m.copy()
        df["timestamp"] = pd.to_datetime(df["timestamp"])
        df = df.set_index("timestamp").sort_index()
        
        if "open" not in df.columns:
            df["open"] = df["close"]

        df_15m = df.resample("15min").agg({
            "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
        }).dropna()

        try:
            df_15m = compute_features(df_15m)
            df_15m["mom"] = np.log(df_15m["close"] / df_15m["close"].shift(5))
            df_15m["tod_sin"] = np.sin(2 * np.pi * df_15m.index.hour / 24)
            
            if "raw_ofi" in df_15m.columns:
                df_15m["ofi_z"] = (
                    (df_15m["raw_ofi"] - df_15m["raw_ofi"].rolling(200).mean()) /
                    (df_15m["raw_ofi"].rolling(200).std() + 1e-8)
                )
            
            df_15m = df_15m.dropna()

            # Precompute history in batch
            regime_map = {}
            for ts, row in df_15m.iterrows():
                trader.update(row.to_dict())
                rid = trader.regime_history[-1] if trader.regime_history else 0
                rname = trader.regime_names.get(rid, f"Regime_{rid}")
                
                state = RegimeState(
                    hmm_regime_id=int(rid),
                    hmm_regime_name=str(rname),
                    updated_at=ts.timestamp()
                )
                
                # Assign this state to all 1m timestamps in this 15m block
                # We map the floor of the 15m window
                regime_map[ts.floor("15min")] = state
            
            # Expand to 1m resolution (forward fill)
            self._precomputed_regimes[symbol] = {}
            current_state = None
            for ts in df.index:
                floor_ts = ts.floor("15min")
                if floor_ts in regime_map:
                    current_state = regime_map[floor_ts]
                if current_state:
                    self._precomputed_regimes[symbol][ts] = current_state

            logger.info(f"Precomputed {len(df_15m)} HMM states for {symbol}")

        except Exception as e:
            logger.error(f"Failed to precompute HMM for {symbol}: {e}")

    def seed_from_df(self, symbol: str, df_1m: pd.DataFrame):
        # Deprecated in favor of precompute_regimes for backtest
        self.precompute_regimes(symbol, df_1m)
