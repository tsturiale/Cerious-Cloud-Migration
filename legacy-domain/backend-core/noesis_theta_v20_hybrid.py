"""
Noesis Theta Gate V20 Hybrid — Merton Jump-Diffusion Hybrid Binomial Tree & Volatility Regime System
==============================================================================================
Production-grade system module using the Hybrid Jump-Diffusion Binomial Tree engine.

Features:
- Step-by-step path-wise Binomial Tree simulation with log-normal jumps.
- ATR-based rolling 100-period volatility regime classification (Regimes 0, 1, 2).
- Dynamic jump size scaling representing regime-specific tail distributions.
- Stateful position tracker (NoesisThetaV20HybridTracker) for real-time monitoring.
- Dynamic 50% stop-loss enforcement (minutes 9-13).
- Commissions accounting: 1% entry, 1% exit (on stop-loss, 0% on settlement).
"""

import math
from typing import Dict, Any, Optional, Tuple, List
from datetime import datetime

from terminal.backend.core.hybrid_jump_binomial import price_hybrid_binary_up


# Merton Jump-Diffusion Global Constants
MERTON_JUMP_MU = 0.0
MINUTES_PER_YEAR = 525960.0  # 365.25 * 24 * 60

# Regime Parameter Roster
REGIME_PARAMS = {
    0: {"jump_lambda": 10.0,   "jump_sigma": 0.02, "label": "LOW"},
    1: {"jump_lambda": 120.0,  "jump_sigma": 0.02, "label": "MEDIUM"},
    2: {"jump_lambda": 500.0,  "jump_sigma": 0.08, "label": "HIGH"},
}


def classify_vol_regime(atr_val: float, atr_history: List[float]) -> int:
    """
    Classifies the current volatility regime (0, 1, or 2) based on the
    percentile rank of the current ATR vs its rolling history.
    """
    if not atr_history:
        return 1  # Default to MEDIUM
        
    valid_history = [x for x in atr_history if not math.isnan(x)]
    if not valid_history:
        return 1
        
    smaller = sum(1 for x in valid_history if x < atr_val)
    pct = smaller / len(valid_history)
    
    if pct < 0.30:
        return 0
    elif pct > 0.70:
        return 2
    return 1


def compute_v20_hybrid_probability(
    spot: float,
    strike: float,
    sigma_annual: float,
    tau_years: float,
    jump_lambda: float,
    jump_sigma: float,
    paths: int = 50000,
    n_steps: int = 30,
    use_lattice_sim: bool = False
) -> float:
    """
    Computes P(S_T > K) using HybridJumpBinomialEngine wrapper.
    """
    if tau_years <= 1e-8:
        return 100.0 if spot > strike else 0.0
    if sigma_annual <= 0 or strike <= 0 or spot <= 0:
        return 50.0

    time_rem_mins = tau_years * MINUTES_PER_YEAR

    return price_hybrid_binary_up(
        spot=spot,
        strike=strike,
        volatility=sigma_annual,
        time_to_expiry_mins=time_rem_mins,
        drift_annualized=0.0,
        jump_lambda=jump_lambda,
        jump_mu=MERTON_JUMP_MU,
        jump_sigma=jump_sigma,
        paths=paths,
        n_steps=n_steps,
        use_lattice_sim=use_lattice_sim
    )


def calculate_annualized_vol(
    strike: float,
    ewma_vol_1m: float,
    atr_15m: float
) -> float:
    """
    Annualizes volatility components and returns the blended sigma value.
    """
    ewma_ann = ewma_vol_1m * math.sqrt(525600.0)
    atr_frac = atr_15m / max(strike, 0.01)
    atr_ann = atr_frac * math.sqrt(35040.0)
    
    sigma_blend = (ewma_ann + atr_ann) / 2.0
    return max(1e-4, sigma_blend)


class NoesisThetaV20HybridTracker:
    """
    Stateful execution tracker for Noesis Theta Gate V20 Hybrid.
    Maintains trade lifecycles, computes dynamic hybrid lattice probabilities, and checks stop conditions.
    """
    
    def __init__(
        self,
        symbol: str,
        strike: float,
        entry_minute: int,
        entry_price_cents: float,
        direction: str,
        entry_time: datetime,
        regime: int,
        contracts: int = 1,
        paths: int = 50000,
        n_steps: int = 30,
        use_lattice_sim: bool = False
    ):
        self.symbol = symbol
        self.strike = strike
        self.entry_minute = entry_minute
        self.entry_price_cents = entry_price_cents
        self.direction = direction.upper()
        self.entry_time = entry_time
        self.regime = regime
        self.contracts = contracts
        self.paths = paths
        self.n_steps = n_steps
        self.use_lattice_sim = use_lattice_sim
        
        self.active = True
        self.exit_minute: Optional[int] = None
        self.exit_price_cents: Optional[float] = None
        self.exit_time: Optional[datetime] = None
        self.exit_reason: Optional[str] = None
        self.net_pnl_usd = 0.0
        self.fees_usd = 0.0
        
        # Merton params for tracker
        rp = REGIME_PARAMS[self.regime]
        self.jump_lambda = rp["jump_lambda"]
        self.jump_sigma = rp["jump_sigma"]
        
        # Calculate entry commission: 1% of entry price
        self.comm_entry_usd = 0.01 * (self.entry_price_cents / 100.0) * self.contracts
        
    def evaluate_tick(
        self,
        current_price: float,
        ewma_vol_1m: float,
        atr_15m: float,
        minute_in_bar: int,
        timestamp: datetime
    ) -> Tuple[str, float]:
        """
        Evaluates a real-time price update for stop-loss or settlement triggers.
        """
        if not self.active:
            return "CLOSED", 0.0

        # Settle at minute 14
        if minute_in_bar >= 14:
            win = (current_price > self.strike and self.direction == "YES") or \
                  (current_price <= self.strike and self.direction == "NO")
            final_val = 100.0 if win else 0.0
            self.settle(final_val, 14, timestamp, "SETTLEMENT")
            return "SETTLED", final_val

        # Compute probability for monitoring
        sigma_blend = calculate_annualized_vol(self.strike, ewma_vol_1m, atr_15m)
        minutes_remaining = max(0.1, float(15 - minute_in_bar))
        tau = minutes_remaining / MINUTES_PER_YEAR
        
        prob_yes = compute_v20_hybrid_probability(
            current_price, self.strike, sigma_blend, tau, self.jump_lambda, self.jump_sigma,
            paths=self.paths, n_steps=self.n_steps, use_lattice_sim=self.use_lattice_sim
        )
        prob_current = prob_yes if self.direction == "YES" else (100.0 - prob_yes)

        # Stop-loss monitoring window: minutes 9 to 13 inclusive
        if 9 <= minute_in_bar <= 13:
            if prob_current <= 50.0:
                self.settle(50.0, minute_in_bar, timestamp, "STOP_LOSS")
                return "STOPPED_OUT", 50.0

        return "HOLD", prob_current

    def settle(self, exit_price_cents: float, minute: int, timestamp: datetime, reason: str):
        """Finalizes the trade stats and P&L."""
        self.active = False
        self.exit_minute = minute
        self.exit_price_cents = exit_price_cents
        self.exit_time = timestamp
        self.exit_reason = reason
        
        # Gross P&L in cents per contract
        gross_cents = exit_price_cents - self.entry_price_cents
        
        # Calculate exit commission: 1% of stopped price if stopped out; 0 if settled
        comm_exit_usd = 0.0
        if reason == "STOP_LOSS":
            comm_exit_usd = 0.01 * (exit_price_cents / 100.0) * self.contracts
            
        self.fees_usd = self.comm_entry_usd + comm_exit_usd
        
        # P&L in USD (1 contract = $1.00 settlement value)
        self.net_pnl_usd = (gross_cents / 100.0) * self.contracts - self.fees_usd


def run_v20_hybrid_signal_scan(
    spot: float,
    strike: float,
    ewma_vol_1m: float,
    atr_15m: float,
    minute_in_bar: int,
    regime: int,
    trigger_threshold: float = 75.0,
    paths: int = 50000,
    n_steps: int = 30,
    use_lattice_sim: bool = False
) -> Tuple[Optional[str], float]:
    """
    Scans for entry triggers at a specific minute (valid for minutes 8-14).
    """
    if not (8 <= minute_in_bar <= 14):
        return None, 50.0
        
    sigma_blend = calculate_annualized_vol(strike, ewma_vol_1m, atr_15m)
    minutes_remaining = max(0.1, float(15 - minute_in_bar))
    tau = minutes_remaining / MINUTES_PER_YEAR
    
    rp = REGIME_PARAMS[regime]
    jl = rp["jump_lambda"]
    js = rp["jump_sigma"]
    
    prob_yes = compute_v20_hybrid_probability(
        spot, strike, sigma_blend, tau, jl, js,
        paths=paths, n_steps=n_steps, use_lattice_sim=use_lattice_sim
    )
    prob_no = 100.0 - prob_yes
    
    if prob_yes >= trigger_threshold:
        return "YES", prob_yes
    elif prob_no >= trigger_threshold:
        return "NO", prob_no
        
    return None, max(prob_yes, prob_no)
