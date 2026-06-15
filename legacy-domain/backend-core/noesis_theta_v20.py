"""
Noesis Theta Gate V20 — Merton Jump-Diffusion & Volatility Regime System
======================================================================
Production-grade system module.

Features:
- Adaptive Merton Jump-Diffusion probability calculation (v20_merton_prob).
- ATR-based rolling 100-period volatility regime classification (Regimes 0, 1, 2).
- Fat-tailed Student's t distribution (df=4.2) for High Volatility (Regime 2).
- Stateful position tracker (NoesisThetaV20Tracker) for real-time monitoring.
- Dynamic 50% stop-loss enforcement (minutes 9-13).
- Commissions accounting: 1% entry, 1% exit (on stop-loss, 0% on settlement).
"""

import math
from typing import Dict, Any, Optional, Tuple, List
from datetime import datetime
from scipy.stats import t as t_dist


# Merton Jump-Diffusion Global Constants
MERTON_JUMP_MU = 0.0
MERTON_JUMP_SIGMA = 0.08
MERTON_DF_STUDENT = 4.2
MINUTES_PER_YEAR = 525960.0  # 365.25 * 24 * 60

# Regime Parameter Roster
REGIME_PARAMS = {
    0: {"jump_lambda": 10.0,   "use_student_t": False, "label": "LOW"},
    1: {"jump_lambda": 120.0,  "use_student_t": False, "label": "MEDIUM"},
    2: {"jump_lambda": 500.0,  "use_student_t": True,  "label": "HIGH"},
}


def classify_vol_regime(atr_val: float, atr_history: List[float]) -> int:
    """
    Classifies the current volatility regime (0, 1, or 2) based on the
    percentile rank of the current ATR vs its rolling history.
    
    Args:
        atr_val: The current 15-minute ATR value.
        atr_history: A list of recent 15-minute ATR values (typically lookback = 100).
        
    Returns:
        Volatility regime: 0 (LOW), 1 (MEDIUM), or 2 (HIGH).
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


def compute_v20_probability(
    spot: float,
    strike: float,
    sigma_annual: float,
    tau_years: float,
    jump_lambda: float,
    use_student_t: bool
) -> float:
    """
    Computes P(S_T > K) using Merton's Jump-Diffusion model with an adaptive
    number of Poisson terms and optional Student's t tail distribution.
    
    Args:
        spot: Current spot price.
        strike: Strike price.
        sigma_annual: Annualized blended volatility.
        tau_years: Time to expiry in years.
        jump_lambda: Annual jump intensity parameter.
        use_student_t: Flag to use Student's t distribution (Regime 2).
        
    Returns:
        Probability in percentage (0.0 to 100.0).
    """
    if tau_years <= 1e-8:
        return 100.0 if spot > strike else 0.0
    if sigma_annual <= 0 or strike <= 0 or spot <= 0:
        return 50.0

    expected_jumps = jump_lambda * tau_years
    
    # Adaptive Poisson term selection: compute only terms with weight >= 1e-9
    if expected_jumps < 1e-6:
        n_terms = 2
    else:
        n_terms = min(11, max(3, int(expected_jumps + 3 * math.sqrt(expected_jumps)) + 1))

    # Risk-neutral drift adjustment under Merton
    expected_jump_size = math.exp(MERTON_JUMP_MU + 0.5 * MERTON_JUMP_SIGMA**2) - 1
    drift_adj = -jump_lambda * expected_jump_size
    sqt = math.sqrt(tau_years)

    p_up_sum = 0.0
    for n in range(n_terms):
        # Poisson weight calculation
        poisson_p = (math.exp(-expected_jumps) * expected_jumps**n) / math.factorial(n)
        if poisson_p < 1e-9:
            break
            
        # Volatility and drift for n-jump state
        sigma_n = math.sqrt(sigma_annual**2 + (n * MERTON_JUMP_SIGMA**2 / tau_years))
        drift_n = drift_adj + (n * MERTON_JUMP_MU / tau_years)

        # Standardized distance d2
        d2 = (math.log(spot / strike) + (drift_n - 0.5 * sigma_n**2) * tau_years) / (sigma_n * sqt)

        if use_student_t:
            p_n = float(t_dist.cdf(d2, df=MERTON_DF_STUDENT))
        else:
            # Fast normal CDF using math.erf
            p_n = 0.5 * (1.0 + math.erf(d2 / 1.4142135623730951))

        p_up_sum += poisson_p * p_n

    return float(max(0.0, min(100.0, p_up_sum * 100.0)))


def calculate_annualized_vol(
    strike: float,
    ewma_vol_1m: float,
    atr_15m: float
) -> float:
    """
    Annualizes volatility components and returns the blended sigma value.
    
    Formula:
        ewma_ann = Vol_EWMA * sqrt(525,600)
        atr_ann = (ATR_15m / Strike) * sqrt(35,040)
        sigma_blend = (ewma_ann + atr_ann) / 2.0
    """
    ewma_ann = ewma_vol_1m * math.sqrt(525600.0)
    atr_frac = atr_15m / max(strike, 0.01)
    atr_ann = atr_frac * math.sqrt(35040.0)
    
    sigma_blend = (ewma_ann + atr_ann) / 2.0
    return max(1e-4, sigma_blend)


class NoesisThetaV20Tracker:
    """
    Stateful execution tracker for Noesis Theta Gate V20.
    Maintains trade lifecycles, computes dynamic Merton probabilities, and checks stop conditions.
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
        contracts: int = 1
    ):
        """
        Args:
            symbol: Target asset symbol.
            strike: Strike price of the binary option.
            entry_minute: Minute the trade was entered (8-14).
            entry_price_cents: Entry premium in cents.
            direction: "YES" or "NO".
            entry_time: Datetime of trade entry.
            regime: Pre-classified volatility regime (0, 1, or 2).
            contracts: Number of option contracts.
        """
        self.symbol = symbol
        self.strike = strike
        self.entry_minute = entry_minute
        self.entry_price_cents = entry_price_cents
        self.direction = direction.upper()
        self.entry_time = entry_time
        self.regime = regime
        self.contracts = contracts
        
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
        self.use_student_t = rp["use_student_t"]
        
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
        
        Args:
            current_price: Current asset price.
            ewma_vol_1m: Current 1-minute EWMA volatility.
            atr_15m: 15-minute ATR at bar start.
            minute_in_bar: Current elapsed minute of the 15-minute bar (0-14).
            timestamp: Timestamp of the tick.
            
        Returns:
            Tuple of (status, probability) where status is 'HOLD', 'STOPPED_OUT', or 'SETTLED'.
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
        
        prob_yes = compute_v20_probability(
            current_price, self.strike, sigma_blend, tau, self.jump_lambda, self.use_student_t
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


def run_v20_signal_scan(
    spot: float,
    strike: float,
    ewma_vol_1m: float,
    atr_15m: float,
    minute_in_bar: int,
    regime: int,
    trigger_threshold: float = 75.0
) -> Tuple[Optional[str], float]:
    """
    Scans for entry triggers at a specific minute (valid for minutes 8-14).
    
    Args:
        spot: Current price.
        strike: Strike price (bar open price).
        ewma_vol_1m: Current 1-minute EWMA volatility.
        atr_15m: Current 15-minute ATR.
        minute_in_bar: Elapsed minute (0-14).
        regime: Pre-classified volatility regime (0, 1, or 2).
        trigger_threshold: Trigger probability (default 75%).
        
    Returns:
        Tuple of (direction, probability) or (None, probability).
    """
    if not (8 <= minute_in_bar <= 14):
        return None, 50.0
        
    sigma_blend = calculate_annualized_vol(strike, ewma_vol_1m, atr_15m)
    minutes_remaining = max(0.1, float(15 - minute_in_bar))
    tau = minutes_remaining / MINUTES_PER_YEAR
    
    rp = REGIME_PARAMS[regime]
    jl = rp["jump_lambda"]
    use_t = rp["use_student_t"]
    
    prob_yes = compute_v20_probability(spot, strike, sigma_blend, tau, jl, use_t)
    prob_no = 100.0 - prob_yes
    
    if prob_yes >= trigger_threshold:
        return "YES", prob_yes
    elif prob_no >= trigger_threshold:
        return "NO", prob_no
        
    return None, max(prob_yes, prob_no)
