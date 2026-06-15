"""
core/state_store.py
Thread-safe shared state bus for F Systematica agents.
All agents read/write through this store — no direct cross-agent coupling.
"""

import threading
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional
import time


@dataclass
class ATRState:
    atr_5m: float = 0.0
    atr_15m: float = 0.0
    ratio: float = 0.577        # theoretical √(5/15)
    regime: str = "balanced"    # extreme_compression/moderate_compression/balanced/moderate_expansion/extreme_expansion
    updated_at: float = 0.0


@dataclass
class RegimeState:
    hmm_regime_id: int = 0
    hmm_regime_name: str = "Unknown"
    updated_at: float = 0.0


@dataclass
class BarState:
    """Latest OHLCV for a symbol/timeframe."""
    symbol: str = ""
    tf: str = ""           # "1m", "5m", "15m"
    open: float = 0.0
    high: float = 0.0
    low: float = 0.0
    close: float = 0.0
    volume: float = 0.0
    vwap: float = 0.0
    timestamp: float = 0.0


@dataclass
class ScaleOutTarget:
    target_price: float
    size_reduction: float  # Absolute size to close
    filled: bool = False


@dataclass
class PendingOrder:
    symbol: str
    strategy: str
    side: str
    order_type: str         # "LIMIT", "STOP"
    price: float
    size: float
    # Management plan for when filled
    stop_loss: float = 0.0
    take_profit: float = 0.0
    trailing_stop_dist: float = 0.0
    scale_outs: List[ScaleOutTarget] = field(default_factory=list)


@dataclass
class Position:
    symbol: str = ""
    strategy: str = ""     # "alpha", "beta", "gamma"
    side: str = ""         # "LONG", "SHORT"
    size: float = 0.0
    entry_price: float = 0.0
    entry_time: float = 0.0
    pnl: float = 0.0
    open: bool = True
    
    # Risk Management Plan
    stop_loss: float = 0.0
    take_profit: float = 0.0
    trailing_stop_dist: float = 0.0
    trailing_stop_price: float = 0.0
    scale_outs: List[ScaleOutTarget] = field(default_factory=list)


@dataclass
class PortfolioState:
    bankroll: float = 10000.0
    session_pnl: float = 0.0
    daily_pnl: float = 0.0
    peak_bankroll: float = 10000.0
    drawdown: float = 0.0
    kill_switch_active: bool = False
    trades_today: int = 0
    wins_today: int = 0


class StateStore:
    """
    Central shared memory bus. Thread-safe via per-key RW locks.
    Agents register callbacks for state changes (event-driven).
    """

    def __init__(self):
        self._lock = threading.RLock()
        
        # ATR states by symbol
        self.atr: Dict[str, ATRState] = defaultdict(ATRState)
        
        # HMM regime states by symbol
        self.regime: Dict[str, RegimeState] = defaultdict(RegimeState)
        
        # Latest bars — keyed by (symbol, tf)
        self.bars: Dict[tuple, BarState] = {}
        
        # Bar history — keyed by (symbol, tf), rolling window
        self.bar_history: Dict[tuple, deque] = defaultdict(lambda: deque(maxlen=500))
        
        # Open positions — keyed by position_id
        self.positions: Dict[str, Position] = {}
        
        # Pending Orders (Limit/Stop entries)
        self.pending_orders: List[PendingOrder] = []
        
        # Portfolio state
        self.portfolio = PortfolioState()
        
        # Event callbacks — keyed by event type
        self._callbacks: Dict[str, List[Callable]] = defaultdict(list)
        
        # Per-strategy PnL tracking
        self.strategy_pnl: Dict[str, float] = {"alpha": 0.0, "beta": 0.0, "gamma": 0.0}
        self.strategy_trades: Dict[str, List[dict]] = {"alpha": [], "beta": [], "gamma": []}
        
        # Regime-specific Beta loss tracking
        self.beta_regime_losses: Dict[str, float] = defaultdict(float)
        self.beta_regime_suspend_until: Dict[str, float] = defaultdict(float)
        
        # Gamma correlation estimates by symbol pair
        self.gamma_correlations: Dict[str, float] = {}
        
        # Gamma suspend until (strategy-level)
        self.gamma_suspended_until: float = 0.0

    # ─── Bar updates ──────────────────────────────────────────────────────────

    def update_bar(self, symbol: str, tf: str, bar: BarState):
        with self._lock:
            key = (symbol, tf)
            self.bars[key] = bar
            self.bar_history[key].append(bar)
        self._fire("bar_update", symbol=symbol, tf=tf, bar=bar)

    def get_bar(self, symbol: str, tf: str) -> Optional[BarState]:
        with self._lock:
            return self.bars.get((symbol, tf))

    def get_bar_history(self, symbol: str, tf: str, n: int = 100) -> List[BarState]:
        with self._lock:
            hist = list(self.bar_history.get((symbol, tf), []))
            return hist[-n:]

    # ─── ATR updates ──────────────────────────────────────────────────────────

    def update_atr(self, symbol: str, atr_state: ATRState):
        with self._lock:
            prev_regime = self.atr[symbol].regime
            self.atr[symbol] = atr_state
        if atr_state.regime != prev_regime:
            self._fire("regime_change", symbol=symbol, old=prev_regime, new=atr_state.regime)

    def get_atr(self, symbol: str) -> ATRState:
        with self._lock:
            return self.atr[symbol]

    # ─── HMM regime ───────────────────────────────────────────────────────────

    def update_regime(self, symbol: str, regime: RegimeState):
        with self._lock:
            self.regime[symbol] = regime

    def get_regime(self, symbol: str) -> RegimeState:
        with self._lock:
            return self.regime[symbol]

    # ─── Positions ────────────────────────────────────────────────────────────

    def open_position(self, pos_id: str, position: Position):
        with self._lock:
            self.positions[pos_id] = position
        self._fire("position_opened", pos_id=pos_id, position=position)

    def close_position(self, pos_id: str, exit_price: float, timestamp: float, 
                       size_reduction: float = None) -> Optional[Position]:
        """Close an open position (partially or fully) at exit_price."""
        with self._lock:
            pos = self.positions.get(pos_id, None)
            if pos is None:
                return None
            
            # Full closure if size_reduction is None or >= current size
            full_close = (size_reduction is None) or (size_reduction >= pos.size)
            reduction = pos.size if full_close else size_reduction
            
            # Calculate PnL for the closed portion
            if pos.side == "LONG":
                pnl = reduction * (exit_price / pos.entry_price - 1)
            else:
                # SHORT (Buy NO/Fade): Inverse return
                pnl = reduction * (1 - exit_price / pos.entry_price)
            
            # Log pnl to portfolio
            self._update_portfolio_on_close(pos.strategy, pos.symbol, pos.side, 
                                             reduction, pos.entry_price, pnl, pos.entry_time)

            if full_close:
                self.positions.pop(pos_id)
                pos.open = False
                pos.pnl = pnl # Total PnL for the final closed portion
                self._fire("position_closed", pos_id=pos_id, position=pos)
                return pos
            else:
                # Partial scale out
                pos.size -= reduction
                # Create a "pseudo-position" for the partial close event
                partial_pos = Position(
                    symbol=pos.symbol, strategy=pos.strategy, side=pos.side,
                    size=reduction, entry_price=pos.entry_price, entry_time=pos.entry_time,
                    pnl=pnl, open=False
                )
                self._fire("position_partial_close", pos_id=pos_id, position=partial_pos)
                return partial_pos

    def get_open_positions(self, strategy: str = None) -> List[Position]:
        with self._lock:
            if strategy:
                return [p for p in self.positions.values() if p.strategy == strategy]
            return list(self.positions.values())

    def get_open_positions_count(self) -> int:
        with self._lock:
            return len(self.positions)

    # ─── Portfolio ────────────────────────────────────────────────────────────

    def _update_portfolio_on_close(self, strategy: str, symbol: str, side: str, 
                                   size: float, entry_price: float, pnl: float, 
                                   entry_time: float):
        with self._lock:
            self.portfolio.bankroll += pnl
            self.portfolio.session_pnl += pnl
            self.portfolio.daily_pnl += pnl
            self.portfolio.trades_today += 1
            if pnl > 0:
                self.portfolio.wins_today += 1
            if self.portfolio.bankroll > self.portfolio.peak_bankroll:
                self.portfolio.peak_bankroll = self.portfolio.bankroll
            self.portfolio.drawdown = max(0, (self.portfolio.peak_bankroll - self.portfolio.bankroll) / self.portfolio.peak_bankroll)
            
            # Record to strategy PnL
            self.strategy_pnl[strategy] = self.strategy_pnl.get(strategy, 0) + pnl
            self.strategy_trades[strategy].append({
                "symbol": symbol,
                "side": side,
                "size": size,
                "entry_price": entry_price,
                "pnl": pnl,
                "entry_time": entry_time,
            })

    def get_portfolio_snapshot(self) -> dict:
        with self._lock:
            p = self.portfolio
            return {
                "bankroll": round(p.bankroll, 2),
                "session_pnl": round(p.session_pnl, 2),
                "daily_pnl": round(p.daily_pnl, 2),
                "drawdown_pct": round(p.drawdown * 100, 2),
                "kill_switch_active": p.kill_switch_active,
                "trades_today": p.trades_today,
                "win_rate": round(p.wins_today / max(p.trades_today, 1) * 100, 2),
            }

    def activate_kill_switch(self, reason: str = ""):
        with self._lock:
            self.portfolio.kill_switch_active = True
        self._fire("kill_switch", reason=reason)

    def is_kill_switch_active(self) -> bool:
        with self._lock:
            return self.portfolio.kill_switch_active

    def reset_daily(self):
        """Call at start of each trading day."""
        with self._lock:
            self.portfolio.daily_pnl = 0.0
            self.portfolio.kill_switch_active = False
            self.portfolio.trades_today = 0
            self.portfolio.wins_today = 0

    # ─── General get/set ──────────────────────────────────────────────────────

    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            return getattr(self, key, default)

    # ─── Event system ─────────────────────────────────────────────────────────

    def subscribe(self, event: str, callback: Callable):
        with self._lock:
            self._callbacks[event].append(callback)

    def _fire(self, event: str, **kwargs):
        handlers = []
        with self._lock:
            handlers = list(self._callbacks.get(event, []))
        for handler in handlers:
            try:
                handler(**kwargs)
            except Exception as e:
                pass  # Never let callbacks crash the store


# Singleton instance
_store_instance: Optional[StateStore] = None

def get_store() -> StateStore:
    global _store_instance
    if _store_instance is None:
        _store_instance = StateStore()
    return _store_instance
