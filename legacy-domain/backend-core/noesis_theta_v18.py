"""
Noesis Theta Gate V18 — Standard Gaussian Projected Probability System
====================================================================
Production-grade system module.

Features:
- Pure Gaussian CDF probability projection (v18_p).
- Linear projected volatility using EWMA historical standard deviation + 15m ATR.
- Stateful position tracker (NoesisThetaV18Tracker) for real-time monitoring.
- Dynamic 50% stop-loss enforcement (minutes 9-13).
- Commissions accounting: 1% entry, 1% exit (on stop-loss, 0% on settlement).
"""

import math
from typing import Dict, Any, Optional, Tuple
from datetime import datetime


def compute_v18_probability(spot: float, strike: float, vol_remaining: float) -> float:
    """
    Computes P(S_T > K) using a simple linear normal model (Gaussian CDF).
    
    Args:
        spot: Current asset price.
        strike: Strike price of the binary contract (typically bar open price).
        vol_remaining: Projected standard deviation over the remaining bar duration.
        
    Returns:
        Probability in percentage (0.0 to 100.0).
    """
    if vol_remaining <= 0:
        return 50.0
    
    # Standard normal cumulative distribution function (Standardized distance z)
    z = (spot - strike) / (vol_remaining + 1e-8)
    
    # Standard Normal CDF using math.erf (faster than scipy.stats.norm)
    p_yes = 0.5 * (1.0 + math.erf(z / 1.4142135623730951)) * 100.0
    return float(max(0.0, min(100.0, p_yes)))


def calculate_vol_remaining(
    strike: float,
    ewma_vol_1m: float,
    atr_15m: float,
    minute_in_bar: int
) -> float:
    """
    Calculates the blended volatility parameter for the remaining time in the bar.
    
    Formula:
        sigma_proj = Vol_EWMA * sqrt(m_rem) * Strike
        sigma_rem = (sigma_proj + ATR_15m) / 2.0
    """
    minutes_remaining = max(0.1, float(15 - minute_in_bar))
    
    # Projection using 1-minute EWMA volatility
    vol_proj = ewma_vol_1m * math.sqrt(minutes_remaining) * strike
    
    # Blended volatility parameter
    vol_rem = (vol_proj + atr_15m) / 2.0
    return max(1e-8, vol_rem)


class NoesisThetaV18Tracker:
    """
    Stateful execution tracker for Noesis Theta Gate V18.
    Maintains trade lifecycles, computes dynamic probabilities, and checks stop conditions.
    """
    
    def __init__(
        self,
        symbol: str,
        strike: float,
        entry_minute: int,
        entry_price_cents: float,
        direction: str,
        entry_time: datetime,
        contracts: int = 1
    ):
        """
        Args:
            symbol: Target asset symbol (e.g., BTC).
            strike: Strike price of the binary option.
            entry_minute: The minute (8-14) the trade was entered.
            entry_price_cents: The entry premium in cents (e.g., 60.0).
            direction: "YES" or "NO".
            entry_time: Datetime of trade entry.
            contracts: Number of option contracts.
        """
        self.symbol = symbol
        self.strike = strike
        self.entry_minute = entry_minute
        self.entry_price_cents = entry_price_cents
        self.direction = direction.upper()
        self.entry_time = entry_time
        self.contracts = contracts
        
        self.active = True
        self.exit_minute: Optional[int] = None
        self.exit_price_cents: Optional[float] = None
        self.exit_time: Optional[datetime] = None
        self.exit_reason: Optional[str] = None  # "STOP_LOSS", "SETTLEMENT"
        self.net_pnl_usd = 0.0
        self.fees_usd = 0.0
        
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
        vol_rem = calculate_vol_remaining(self.strike, ewma_vol_1m, atr_15m, minute_in_bar)
        prob_yes = compute_v18_probability(current_price, self.strike, vol_rem)
        prob_current = prob_yes if self.direction == "YES" else (100.0 - prob_yes)

        # Stop-loss monitoring window: minutes 9 to 13 inclusive
        # Trade is NOT evaluated on the trigger minute or the settlement minute
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


def run_v18_signal_scan(
    spot: float,
    strike: float,
    ewma_vol_1m: float,
    atr_15m: float,
    minute_in_bar: int,
    trigger_threshold: float = 60.0
) -> Tuple[Optional[str], float]:
    """
    Scans for entry triggers at a specific minute (valid for minutes 8-14).
    
    Args:
        spot: Current asset price.
        strike: Strike price (bar open price).
        ewma_vol_1m: Current 1-minute EWMA volatility.
        atr_15m: Current 15-minute ATR.
        minute_in_bar: Elapsed minute (0-14).
        trigger_threshold: Trigger probability (default 60%).
        
    Returns:
        Tuple of (direction, probability) or (None, probability).
    """
    if not (8 <= minute_in_bar <= 14):
        return None, 50.0
        
    vol_rem = calculate_vol_remaining(strike, ewma_vol_1m, atr_15m, minute_in_bar)
    prob_yes = compute_v18_probability(spot, strike, vol_rem)
    prob_no = 100.0 - prob_yes
    
    if prob_yes >= trigger_threshold:
        return "YES", prob_yes
    elif prob_no >= trigger_threshold:
        return "NO", prob_no
        
    return None, max(prob_yes, prob_no)
