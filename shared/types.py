"""
shared/types.py — Core domain types for EdgeCopy and Polymarket Terminal.
All data structures are frozen dataclasses or NamedTuples for immutability.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Optional


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class Direction(str, enum.Enum):
    UP = "UP"
    DOWN = "DOWN"


class Regime(str, enum.Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class ModelName(str, enum.Enum):
    KC_REVERSION = "kc_reversion"       # Keltner Channel Mean Reversion
    FLOW_TOXICITY = "flow_toxicity"     # Spot Order Flow Toxicity (VPIN)
    LOW_VOL_ACCUM = "low_vol_accum"     # Low Volatility Accumulation
    HIGH_VOL_MOMENTUM = "high_vol_momentum"  # High Volatility Momentum
    TRI_ENGINE = "tri_engine"           # Tri-Engine (HMM+JSD+Z-Score)
    THETA_SNIPER = "theta_sniper"       # FF Systematica Late-Stage Theta Sniper
    V3_TITANIUM = "v3_titanium"         # V3 Titanium ATR Gate (Z-Stretch + Vol Filter)
    CLOB_LAG_ARBER = "clob_lag_arber"  # Gravia-style: CLOB repricing lag vs spot drift
    NOESIS_V3 = "noesis_v3"
    V18 = "v18"
    V20_HYBRID = "v20_hybrid"


class OrderStatus(str, enum.Enum):
    PENDING = "pending"
    OPEN = "open"
    FILLED = "filled"
    CANCELLED = "cancelled"
    REJECTED = "rejected"


class PositionStatus(str, enum.Enum):
    PENDING = "pending"         # entry order placed, waiting for fill
    OPEN = "open"              # position open and being monitored
    STOPPED_OUT = "stopped_out"
    TAKEN_PROFIT = "taken_profit"
    EXPIRED = "expired"
    CANCELLED = "cancelled"    # entry limit timed out
    EMERGENCY = "emergency"     # risk gate forced close


# -----------------------------------------------------------------------------
# Market Data
# ---------------------------------------------------------------------------

@dataclass
class Bar:
    """Single OHLCV bar (1-min or 15-min)."""
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float

    @property
    def typical(self) -> float:
        return (self.high + self.low + self.close) / 3.0


@dataclass
class OrderBookLevel:
    price: float
    size: float


@dataclass
class OrderBook:
    market_id: str
    timestamp: datetime
    bids: list[OrderBookLevel]   # descending price
    asks: list[OrderBookLevel]   # ascending price

    @property
    def best_bid(self) -> Optional[float]:
        return self.bids[0].price if self.bids else None

    @property
    def best_ask(self) -> Optional[float]:
        return self.asks[0].price if self.asks else None

    @property
    def mid(self) -> Optional[float]:
        if self.best_bid and self.best_ask:
            return (self.best_bid + self.best_ask) / 2.0
        return None

    @property
    def spread_bps(self) -> Optional[float]:
        if self.best_bid and self.best_ask and self.mid:
            return ((self.best_ask - self.best_bid) / self.mid) * 10_000
        return None

    @property
    def bid_depth(self) -> float:
        return sum(lv.size for lv in self.bids)

    @property
    def ask_depth(self) -> float:
        return sum(lv.size for lv in self.asks)

    @property
    def depth_ratio(self) -> Optional[float]:
        """bid_depth / ask_depth; > 1 = more buying pressure."""
        if self.ask_depth == 0:
            return None
        return self.bid_depth / self.ask_depth


@dataclass
class TradeTick:
    timestamp: datetime
    price: float
    size: float
    side: Literal["buy", "sell"]


@dataclass
class Market:
    """A Polymarket binary-option market."""
    market_id: str
    asset: str           # "BTC", "ETH", "SOL", "XRP"
    direction: Direction  # which side this contract pays
    expiry: datetime
    description: str
    active: bool = True


# ---------------------------------------------------------------------------
# Feature Vector
# ---------------------------------------------------------------------------

@dataclass
class Features:
    """Computed features for one 15-min bar."""
    timestamp: datetime
    asset: str

    # Keltner Channel
    kc_upper: float
    kc_mid: float       # 20-period EMA
    kc_lower: float

    # Price position
    close: float
    zscore: float       # (close - kc_mid) / rolling_std

    # Volatility
    atr: float
    atr_percentile: float   # 0–1 within lookback window
    regime: Regime

    # Order flow
    ofi: float          # Order Flow Imbalance: (buy_vol - sell_vol) / total_vol
    ofi_zscore: float   # Standardised OFI
    vpin: float         # Volume-Sync Prob of Informed Trading (0–1)
    depth_ratio: float  # bid_depth / ask_depth
    bid_ask_imbalance: float  # (bid - ask) / (bid + ask)

    # Momentum
    price_change_5m: float  # 5-min price change %
    
    # Higher Timeframe
    htf_trend: int          # -1 (down), 0 (flat), +1 (up) - Based on 1h/4h EMA slope direction

    # Additional metrics for Truth Engine
    volatility: float       # Rolling 20-period standard deviation


# ---------------------------------------------------------------------------
# Signals
# ---------------------------------------------------------------------------

@dataclass
class Signal:
    """Output of one signal model for one bar."""
    timestamp: datetime
    asset: str
    model: ModelName
    direction: Direction
    strength: float     # 0.0 – 3.0
    regime: Regime
    features: Features


# ---------------------------------------------------------------------------
# Orders & Positions
# ---------------------------------------------------------------------------

@dataclass
class Order:
    order_id: str
    market_id: str
    asset: str
    direction: Direction
    size: float             # notional USD
    limit_price: float      # probability (0–1)
    status: OrderStatus
    created_at: datetime
    filled_at: Optional[datetime] = None
    fill_price: Optional[float] = None
    model: Optional[ModelName] = None
    is_copy: bool = False
    master_order_id: Optional[str] = None   # for copy trades


@dataclass
class PartialExitConfig:
    enabled: bool = True
    first_exit_multiple: float = 2.0   # sell half at 2× entry price
    first_exit_fraction: float = 0.5   # sell 50% of position


@dataclass
class ExitConfig:
    """Stop loss / take profit / trailing stop configuration for a single position."""
    stop_loss_pct: float = 0.10      # fraction of entry price away to trigger SL
    take_profit_pct: float = 0.20    # fraction of entry price away to trigger TP
    trailing_stop_pct: float = 0.0   # 0 = disabled; e.g. 0.05 = 5% trailing
    trailing_step_pct: float = 0.0   # min move to update trailing SL (0 = any move)
    entry_timeout_secs: int = 300     # cancel limit entry if no fill within N seconds


@dataclass
class ActivePosition:
    """In-memory position tracked by ExecutionAgent — from entry until close."""
    position_id: str
    market_id: str
    asset: str
    direction: Direction
    entry_price: float
    size: float                        # USD notional
    entry_time: datetime
    expiry: datetime
    signal_timestamp: datetime         # bar timestamp that generated the signal

    # Exit config
    stop_loss_pct: float
    take_profit_pct: float
    trailing_stop_pct: float
    trailing_step_pct: float
    entry_timeout_secs: int

    # Orders
    entry_order_id: Optional[str] = None
    sl_order_id: Optional[str] = None    # offsetting order for SL
    tp_order_id: Optional[str] = None    # offsetting order for TP

    # Live state
    status: PositionStatus = PositionStatus.PENDING
    trailing_stop_price: Optional[float] = None

    # Tracking
    model: Optional[ModelName] = None
    regime: Regime = Regime.MEDIUM
    signal_strength: float = 0.0

    # Populated on close
    exit_price: Optional[float] = None
    exit_time: Optional[datetime] = None
    close_reason: Optional[str] = None   # "stop_loss" | "take_profit" | "trailing_stop" | "expiry" | "emergency" | "timeout"


@dataclass
class Position:
    position_id: str
    market_id: str
    asset: str
    direction: Direction
    entry_price: float
    size: float
    entry_time: datetime
    expiry: datetime
    model: Optional[ModelName] = None
    partial_exit: PartialExitConfig = field(default_factory=PartialExitConfig)
    first_exit_done: bool = False
    unrealized_pnl: float = 0.0
    current_price: float = 0.0


# ---------------------------------------------------------------------------
# Trades (closed)
# ---------------------------------------------------------------------------

@dataclass
class Trade:
    """A completed (closed) trade, written to the journal."""
    trade_id: str
    market_id: str
    asset: str
    direction: Direction
    model: Optional[ModelName]
    regime: Regime

    entry_time: datetime
    exit_time: datetime
    entry_price: float
    exit_price: float
    size: float          # notional USD

    raw_pnl: float       # before fees/slippage
    fees: float          # 2% Polymarket fee
    slippage: float      # execution slippage cost
    net_pnl: float       # raw_pnl - fees - slippage

    win: bool

    signal_strength: float = 0.0
    is_copy: bool = False
    master_trade_id: Optional[str] = None

    # copy-specific
    master_entry_price: Optional[float] = None
    copy_divergence: Optional[float] = None   # |entry - master_entry|


# ---------------------------------------------------------------------------
# Performance Metrics
# ---------------------------------------------------------------------------

@dataclass
class ModelStats:
    model: ModelName
    trade_count: int
    win_count: int
    win_rate: float
    avg_win: float
    avg_loss: float
    profit_factor: float
    total_pnl: float


@dataclass
class DailyMetrics:
    date: str               # "YYYY-MM-DD"
    trade_count: int
    win_count: int
    loss_count: int
    win_rate: float
    gross_pnl: float
    net_pnl: float
    sharpe: float
    max_drawdown: float
    per_model: list[ModelStats] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Copy Trading
# ---------------------------------------------------------------------------

@dataclass
class MasterTrader:
    wallet_address: str
    alias: Optional[str]
    source: Literal["leaderboard", "manual"]

    # Performance window (rolling)
    win_rate: float = 0.0
    sharpe: float = 0.0
    profit_factor: float = 0.0
    max_drawdown: float = 0.0
    trade_count: int = 0

    active: bool = True
    paused: bool = False    # auto-paused if win rate decays


@dataclass
class CopyConfig:
    sizing_mode: Literal["proportional", "kelly", "fixed"] = "proportional"
    fixed_size_usd: float = 100.0
    kelly_fraction: float = 0.25
    max_size_usd: float = 500.0
    regime_reduce_high_vol: bool = True   # 50% size cut in HIGH regime


# ---------------------------------------------------------------------------
# Risk State (live, in-memory)
# ---------------------------------------------------------------------------

@dataclass
class DailyRiskState:
    date: str
    trade_count: int = 0
    concurrent_positions: int = 0
    realized_pnl: float = 0.0
    peak_pnl: float = 0.0

    @property
    def drawdown(self) -> float:
        return self.peak_pnl - self.realized_pnl if self.realized_pnl < self.peak_pnl else 0.0
