"""
Noesis Zscore V1 — HTF ADXVMA Gated & Keltner Channel Z-Score Filtered Options System
=====================================================================================
Production-grade system module.

Features:
- Standard normal cumulative distribution probability projection.
- Gated by Higher Time Frame (HTF) ADXVMA trend direction (+1 for YES, -1 for NO).
- Filtered by Keltner Channel Z-Score bounds to prevent buying swing extremes.
- Stateful position tracker (NoesisZscoreV1Tracker) for real-time monitoring.
- Dynamic 50% stop-loss enforcement (minutes 2 to event_mins - 2).
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
    
    z = (spot - strike) / (vol_remaining + 1e-8)
    p_yes = 0.5 * (1.0 + math.erf(z / 1.4142135623730951)) * 100.0
    return float(max(0.0, min(100.0, p_yes)))


def calculate_vol_remaining(
    strike: float,
    ewma_vol_1m: float,
    atr_event: float,
    minute_in_event: int,
    event_mins: int = 15
) -> float:
    """
    Calculates the blended volatility parameter for the remaining time in the event.
    
    Formula:
        sigma_proj = Vol_EWMA * sqrt(m_rem) * Strike
        sigma_rem = (sigma_proj + ATR_event) / 2.0
    """
    minutes_remaining = max(0.1, float(event_mins - minute_in_event))
    vol_proj = ewma_vol_1m * math.sqrt(minutes_remaining) * strike
    vol_rem = (vol_proj + atr_event) / 2.0
    return max(1e-8, vol_rem)


class NoesisZscoreV1Tracker:
    """
    Stateful execution tracker for Noesis Zscore V1.
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
        event_mins: int = 15,
        use_stop_loss: bool = True,
        contracts: int = 1
    ):
        """
        Args:
            symbol: Target asset symbol (e.g., BTC).
            strike: Strike price of the binary option (typically bar open price).
            entry_minute: The minute the trade was entered (typically 1).
            entry_price_cents: The entry premium in cents (e.g., 51.5).
            direction: "YES" or "NO".
            entry_time: Datetime of trade entry.
            event_mins: Duration of the event bar (5 or 15).
            use_stop_loss: Whether stop-loss monitoring is enabled.
            contracts: Number of option contracts.
        """
        self.symbol = symbol
        self.strike = strike
        self.entry_minute = entry_minute
        self.entry_price_cents = entry_price_cents
        self.direction = direction.upper()
        self.entry_time = entry_time
        self.event_mins = event_mins
        self.use_stop_loss = use_stop_loss
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
        atr_event: float,
        minute_in_event: int,
        timestamp: datetime
    ) -> Tuple[str, float]:
        """
        Evaluates a real-time price update for stop-loss or settlement triggers.
        
        Args:
            current_price: Current asset price.
            ewma_vol_1m: Current 1-minute EWMA volatility.
            atr_event: ATR of the event timeframe.
            minute_in_event: Current elapsed minute of the event bar.
            timestamp: Timestamp of the tick.
            
        Returns:
            Tuple of (status, probability) where status is 'HOLD', 'STOPPED_OUT', or 'SETTLED'.
        """
        if not self.active:
            return "CLOSED", 0.0

        # Settle at event_mins - 1 (the final minute, e.g. minute 4 for 5m, or minute 14 for 15m)
        if minute_in_event >= (self.event_mins - 1):
            win = (current_price > self.strike and self.direction == "YES") or \
                  (current_price <= self.strike and self.direction == "NO")
            final_val = 100.0 if win else 0.0
            self.settle(final_val, minute_in_event, timestamp, "SETTLEMENT")
            return "SETTLED", final_val

        # Compute probability for monitoring
        vol_rem = calculate_vol_remaining(self.strike, ewma_vol_1m, atr_event, minute_in_event, self.event_mins)
        prob_yes = compute_v18_probability(current_price, self.strike, vol_rem)
        prob_current = prob_yes if self.direction == "YES" else (100.0 - prob_yes)

        # Stop-loss monitoring window: minutes 2 to event_mins - 2 inclusive
        if self.use_stop_loss and (2 <= minute_in_event <= (self.event_mins - 2)):
            stop_level = self.entry_price_cents * 0.5
            if prob_current <= stop_level:
                self.settle(stop_level, minute_in_event, timestamp, "STOP_LOSS")
                return "STOPPED_OUT", stop_level

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


def run_zscore_v1_signal_scan(
    spot: float,
    strike: float,
    ewma_vol_1m: float,
    atr_event: float,
    mid_event: float,
    std_event: float,
    htf_trend: float,
    minute_in_event: int,
    event_mins: int = 15,
    z_limit: Optional[float] = None
) -> Tuple[Optional[str], float]:
    """
    Scans for entry triggers. Only valid at the first minute bar (minute_in_event == 1).
    
    Args:
        spot: Current asset price.
        strike: Strike price (bar open price).
        ewma_vol_1m: Current 1-minute EWMA volatility.
        atr_event: Current event timeframe ATR.
        mid_event: Current Keltner Channel Mid (20 EWM).
        std_event: Current Keltner Channel Standard Deviation (20 rolling std).
        htf_trend: Current HTF ADXVMA slope direction (+1.0 for UP, -1.0 for DOWN, 0.0 for flat).
        minute_in_event: Elapsed minutes in the event.
        event_mins: Duration of the event (5 or 15).
        z_limit: Optional Z-score cutoff limit.
        
    Returns:
        Tuple of (direction, probability) or (None, probability).
    """
    # System only triggers on the first minute bar of the event (minute 1)
    if minute_in_event != 1:
        return None, 50.0
        
    if htf_trend == 0.0 or math.isnan(htf_trend):
        return None, 50.0
        
    # Check Z-score filter if standard deviation is valid
    if std_event <= 0 or math.isnan(mid_event) or math.isnan(std_event):
        return None, 50.0
        
    zscore = (spot - mid_event) / std_event
    direction = "YES" if htf_trend > 0 else "NO"
    
    # Apply Z-score cutoff gates
    if z_limit is not None:
        if direction == "YES" and zscore > z_limit:
            return None, 50.0
        if direction == "NO" and zscore < -z_limit:
            return None, 50.0
            
    vol_rem = calculate_vol_remaining(strike, ewma_vol_1m, atr_event, minute_in_event, event_mins)
    prob_yes = compute_v18_probability(spot, strike, vol_rem)
    
    # Cap probability between 10% and 90% as done in sweep audit
    prob_yes = max(10.0, min(90.0, prob_yes))
    entry_prob = prob_yes if direction == "YES" else (100.0 - prob_yes)
    
    return direction, entry_prob
