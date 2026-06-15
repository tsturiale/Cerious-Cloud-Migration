"""
shared/risk_gate.py — Hard risk limit enforcement.

RiskGate is the single authority that decides whether a trade signal may
proceed to order placement.  It enforces all limits from config.toml [risk]
and maintains live daily state.

Design principles:
  - All checks are synchronous (no I/O).
  - State is held in DailyRiskState, reset each UTC day.
  - Every rejection is logged with a reason code for audit.
  - The gate is passed by reference to both EdgeCopy and the Terminal.

Usage:
    gate = RiskGate(cfg)
    result = gate.check(signal, proposed_size)
    if result.allowed:
        # place order
    else:
        logger.warning("Blocked: %s", result.reason)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Optional

from shared.types import DailyRiskState, Direction, Regime, Signal

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Config snapshot (populated from config.toml [risk] section)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class RiskConfig:
    initial_capital: float       = 10_000.0
    max_daily_trades: int        = 20
    max_concurrent: int          = 3
    daily_loss_limit_pct: float  = 0.03     # 3%
    max_position_size: float     = 500.0
    min_position_size: float     = 10.0
    kelly_fraction: float        = 0.25
    slippage_guard_bps: float    = 3.0
    fee_rate: float              = 0.02

    # Regime size multipliers
    regime_low_mult: float       = 1.0
    regime_medium_mult: float    = 1.0
    regime_high_mult: float      = 0.5

    # Model enable flags
    kc_reversion_enabled: bool      = True
    flow_toxicity_enabled: bool     = True
    low_vol_accum_enabled: bool     = True
    high_vol_momentum_enabled: bool = True

    min_signal_strength: float   = 0.5

    @classmethod
    def from_dict(cls, d: dict) -> "RiskConfig":
        regime = d.get("regime_sizing", {})
        return cls(
            initial_capital=d.get("initial_capital", 10_000.0),
            max_daily_trades=d.get("max_daily_trades", 20),
            max_concurrent=d.get("max_concurrent", 3),
            daily_loss_limit_pct=d.get("daily_loss_limit_pct", 0.03),
            max_position_size=d.get("max_position_size", 500.0),
            min_position_size=d.get("min_position_size", 10.0),
            kelly_fraction=d.get("kelly_fraction", 0.25),
            slippage_guard_bps=d.get("slippage_guard_bps", 3.0),
            fee_rate=d.get("fee_rate", 0.02),
            regime_low_mult=regime.get("low_multiplier", 1.0),
            regime_medium_mult=regime.get("medium_multiplier", 1.0),
            regime_high_mult=regime.get("high_multiplier", 0.5),
            min_signal_strength=d.get("min_signal_strength", 0.5),
        )


# ---------------------------------------------------------------------------
# Check result
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class GateResult:
    allowed: bool
    reason: Optional[str] = None         # None when allowed=True
    adjusted_size: Optional[float] = None  # regime-adjusted size if allowed

    @classmethod
    def ok(cls, size: float) -> "GateResult":
        return cls(allowed=True, adjusted_size=size)

    @classmethod
    def block(cls, reason: str) -> "GateResult":
        return cls(allowed=False, reason=reason)


# ---------------------------------------------------------------------------
# RiskGate
# ---------------------------------------------------------------------------

class RiskGate:
    """
    Stateful risk gate.  One instance per account (follower or live trader).

    Thread-safe for asyncio use (no locks needed — single event loop).
    """

    def __init__(self, cfg: RiskConfig) -> None:
        self.cfg = cfg
        self._state: DailyRiskState = self._fresh_state()

    # ------------------------------------------------------------------
    # Daily state management
    # ------------------------------------------------------------------

    def _today(self) -> str:
        return datetime.now(tz=timezone.utc).date().isoformat()

    def _fresh_state(self) -> DailyRiskState:
        return DailyRiskState(date=self._today())

    def _maybe_reset(self) -> None:
        """Reset state if the UTC date has rolled over."""
        if self._state.date != self._today():
            logger.info("New UTC day — resetting daily risk state")
            self._state = self._fresh_state()

    # ------------------------------------------------------------------
    # External state updates (called by order engine on fills/closes)
    # ------------------------------------------------------------------

    def on_trade_opened(self) -> None:
        self._maybe_reset()
        self._state = replace(
            self._state,
            trade_count=self._state.trade_count + 1,
            concurrent_positions=self._state.concurrent_positions + 1,
        )

    def on_trade_closed(self, net_pnl: float) -> None:
        self._maybe_reset()
        new_pnl = self._state.realized_pnl + net_pnl
        new_peak = max(self._state.peak_pnl, new_pnl)
        new_concurrent = max(0, self._state.concurrent_positions - 1)
        self._state = replace(
            self._state,
            realized_pnl=new_pnl,
            peak_pnl=new_peak,
            concurrent_positions=new_concurrent,
        )

    # ------------------------------------------------------------------
    # Pre-trade check
    # ------------------------------------------------------------------

    def check(
        self,
        signal: Signal,
        proposed_size: float,
    ) -> GateResult:
        """
        Evaluate whether signal + size may proceed.

        Returns GateResult.ok(adjusted_size) or GateResult.block(reason).
        """
        self._maybe_reset()
        cfg = self.cfg
        state = self._state

        # 1. Daily trade count
        if state.trade_count >= cfg.max_daily_trades:
            return GateResult.block(
                f"Daily trade limit reached ({state.trade_count}/{cfg.max_daily_trades})"
            )

        # 2. Concurrent positions
        if state.concurrent_positions >= cfg.max_concurrent:
            return GateResult.block(
                f"Max concurrent positions ({cfg.max_concurrent}) already open"
            )

        # 3. Daily loss limit
        loss_limit = cfg.initial_capital * cfg.daily_loss_limit_pct
        if state.realized_pnl < -loss_limit:
            return GateResult.block(
                f"Daily loss limit hit: P&L={state.realized_pnl:.2f}, "
                f"limit=-{loss_limit:.2f}"
            )

        # 4. Signal strength floor
        if signal.strength < cfg.min_signal_strength:
            return GateResult.block(
                f"Signal strength {signal.strength:.2f} < "
                f"minimum {cfg.min_signal_strength:.2f}"
            )

        # 5. Model enable check
        from shared.types import ModelName
        model_enabled = {
            ModelName.KC_REVERSION: cfg.kc_reversion_enabled,
            ModelName.FLOW_TOXICITY: cfg.flow_toxicity_enabled,
            ModelName.LOW_VOL_ACCUM: cfg.low_vol_accum_enabled,
            ModelName.HIGH_VOL_MOMENTUM: cfg.high_vol_momentum_enabled,
        }
        if not model_enabled.get(signal.model, True):
            return GateResult.block(f"Model {signal.model.value} is disabled in config")

        # 6. Position size bounds
        size = proposed_size
        size = max(size, cfg.min_position_size)   # floor
        size = min(size, cfg.max_position_size)   # hard cap

        # 7. Regime size adjustment
        regime_mult = {
            Regime.LOW: cfg.regime_low_mult,
            Regime.MEDIUM: cfg.regime_medium_mult,
            Regime.HIGH: cfg.regime_high_mult,
        }.get(signal.regime, 1.0)
        size *= regime_mult

        if size < cfg.min_position_size:
            return GateResult.block(
                f"After regime adjustment ({regime_mult}×), size "
                f"{size:.2f} < minimum {cfg.min_position_size:.2f}"
            )

        return GateResult.ok(round(size, 2))

    # ------------------------------------------------------------------
    # Read-only state accessors
    # ------------------------------------------------------------------

    @property
    def daily_trade_count(self) -> int:
        self._maybe_reset()
        return self._state.trade_count

    @property
    def daily_pnl(self) -> float:
        self._maybe_reset()
        return self._state.realized_pnl

    @property
    def drawdown(self) -> float:
        self._maybe_reset()
        return self._state.drawdown

    @property
    def concurrent_positions(self) -> int:
        self._maybe_reset()
        return self._state.concurrent_positions

    @property
    def trades_remaining_today(self) -> int:
        self._maybe_reset()
        return max(0, self.cfg.max_daily_trades - self._state.trade_count)

    def summary(self) -> dict:
        self._maybe_reset()
        cfg = self.cfg
        state = self._state
        loss_limit = cfg.initial_capital * cfg.daily_loss_limit_pct
        return {
            "date": state.date,
            "trades_done": state.trade_count,
            "trades_remaining": self.trades_remaining_today,
            "concurrent": state.concurrent_positions,
            "realized_pnl": state.realized_pnl,
            "drawdown": state.drawdown,
            "daily_loss_limit": -loss_limit,
            "at_trade_limit": state.trade_count >= cfg.max_daily_trades,
            "at_position_limit": state.concurrent_positions >= cfg.max_concurrent,
            "at_loss_limit": state.realized_pnl < -loss_limit,
        }
