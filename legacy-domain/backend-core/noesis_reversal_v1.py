"""
Noesis Reversal v1 — HTF ADXVMA Gated, Double Z-Score Filtered, 20s Reversal Pullback Options System
==================================================================================================
Production-grade system module.

Features:
- Standard normal cumulative distribution probability projection.
- Gated by Higher Time Frame (HTF) ADXVMA trend direction (+1 for YES, -1 for NO).
- Double Z-Score Filtered: requires both 5-minute and 1-minute Z-scores to be extended (oversold for YES, overbought for NO).
- Triggered by a bullish or bearish 2-bar reversal on the 20-second chart.
- Stateful position tracker (NoesisReversalV1Tracker) for real-time monitoring.
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
    minute_in_event: float,
    event_mins: int = 5
) -> float:
    """
    Calculates the blended volatility parameter for the remaining time in the event.
    
    Formula:
        sigma_proj = Vol_EWMA * sqrt(m_rem) * Strike
        sigma_rem = (sigma_proj + ATR_event) / 2.0
    """
    minutes_remaining = max(0.1, float(event_mins) - minute_in_event)
    vol_proj = ewma_vol_1m * math.sqrt(minutes_remaining) * strike
    vol_rem = (vol_proj + atr_event) / 2.0
    return max(1e-8, vol_rem)


class NoesisReversalV1Tracker:
    """
    Stateful execution tracker for Noesis Reversal v1.
    Maintains trade lifecycles, computes dynamic probabilities, and checks stop conditions.
    """
    
    def __init__(
        self,
        symbol: str,
        strike: float,
        entry_minute: float,
        entry_price_cents: float,
        direction: str,
        entry_time: datetime,
        event_mins: int = 5,
        use_stop_loss: bool = True,
        contracts: int = 1
    ):
        """
        Args:
            symbol: Target asset symbol (e.g., BTC).
            strike: Strike price of the binary option (typically 5m open price).
            entry_minute: The minute inside the event when the trade was entered (e.g. 0.33 to 4.67).
            entry_price_cents: The entry premium in cents (e.g., 25.5).
            direction: "YES" or "NO".
            entry_time: Datetime of trade entry.
            event_mins: Duration of the event bar (typically 5).
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
        self.exit_minute: Optional[float] = None
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
        minute_in_event: float,
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

        # Settle on the final 20s tick or if elapsed minute >= 4.67 (the last 20s of the 5m block)
        if minute_in_event >= (float(self.event_mins) - 0.33):
            win = (current_price > self.strike and self.direction == "YES") or \
                  (current_price <= self.strike and self.direction == "NO")
            final_val = 100.0 if win else 0.0
            self.settle(final_val, minute_in_event, timestamp, "SETTLEMENT")
            return "SETTLED", final_val

        # Compute probability for monitoring
        vol_rem = calculate_vol_remaining(self.strike, ewma_vol_1m, atr_event, minute_in_event, self.event_mins)
        prob_yes = compute_v18_probability(current_price, self.strike, vol_rem)
        prob_current = prob_yes if self.direction == "YES" else (100.0 - prob_yes)

        # Stop-loss monitoring window: minutes 2 to 4 (2.0 <= elapsed < 4.0)
        if self.use_stop_loss and (2.0 <= minute_in_event < 4.0):
            stop_level = self.entry_price_cents * 0.5
            if prob_current <= stop_level:
                self.settle(stop_level, minute_in_event, timestamp, "STOP_LOSS")
                return "STOPPED_OUT", stop_level

        return "HOLD", prob_current

    def settle(self, exit_price_cents: float, minute: float, timestamp: datetime, reason: str):
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


def run_reversal_v1_signal_scan(
    spot: float,
    open_t1: float,
    close_t1: float,
    open_t2: float,
    close_t2: float,
    strike: float,
    ewma_vol_1m: float,
    atr_event: float,
    mid_5m: float,
    std_5m: float,
    mid_1m: float,
    std_1m: float,
    htf_trend: float,
    minute_in_event: float,
    event_mins: int = 5,
    z_limit: float = 2.0
) -> Tuple[Optional[str], float]:
    """
    Scans for entry triggers. Only triggers if Z-scores are extended and a 20s 2-bar reversal is confirmed.
    
    Args:
        spot: Current asset price (which is close_t1).
        open_t1: Open of the most recently completed 20s bar (t-1).
        close_t1: Close of the most recently completed 20s bar (t-1).
        open_t2: Open of the second most recently completed 20s bar (t-2).
        close_t2: Close of the second most recently completed 20s bar (t-2).
        strike: Strike price of the 5m event block (the 5m open price).
        ewma_vol_1m: Current 1-minute EWMA volatility.
        atr_event: Current 5m ATR.
        mid_5m: Shifted 5-minute Keltner Channel Mid (from completed 5m bar).
        std_5m: Shifted 5-minute Keltner Channel Standard Deviation.
        mid_1m: Shifted 1-minute Keltner Channel Mid (from completed 1m bar).
        std_1m: Shifted 1-minute Keltner Channel Standard Deviation.
        htf_trend: Current HTF ADXVMA slope direction (+1.0 for UP, -1.0 for DOWN, 0.0 for flat).
        minute_in_event: Elapsed minutes in the current 5m block.
        event_mins: Duration of the event (5).
        z_limit: The Z-score cutoff limit (typically 2.0).
        
    Returns:
        Tuple of (direction, probability) or (None, probability).
    """
    # Gated by HTF trend
    if htf_trend == 0.0 or math.isnan(htf_trend):
        return None, 50.0
        
    # Check that Keltner Channel values are valid
    if std_5m <= 0 or std_1m <= 0 or math.isnan(mid_5m) or math.isnan(std_5m) or math.isnan(mid_1m) or math.isnan(std_1m):
        return None, 50.0
        
    # Z-scores are evaluated at the close of the completed 20s bar t-1 (which is spot)
    zscore_5m = (spot - mid_5m) / std_5m
    zscore_1m = (spot - mid_1m) / std_1m
    
    direction = "YES" if htf_trend > 0 else "NO"
    
    # 1. Check double Z-score pullback condition
    if direction == "YES":
        # Buy the dip: both Z-scores must be oversold
        if not (zscore_5m <= -z_limit and zscore_1m <= -z_limit):
            return None, 50.0
            
        # 2. Check 20-second Bullish Reversal trigger
        # Bar t-2 closed down, Bar t-1 closed up
        bullish_rev = (close_t2 < open_t2) and (close_t1 > open_t1)
        if not bullish_rev:
            return None, 50.0
            
    else:  # direction == "NO"
        # Sell the rip: both Z-scores must be overbought
        if not (zscore_5m >= z_limit and zscore_1m >= z_limit):
            return None, 50.0
            
        # 2. Check 20-second Bearish Reversal trigger
        # Bar t-2 closed up, Bar t-1 closed down
        bearish_rev = (close_t2 > open_t2) and (close_t1 < open_t1)
        if not bearish_rev:
            return None, 50.0
            
    # If triggers pass, compute entry probability at the start of the next bar (whose open is opens[idx] ~ spot)
    vol_rem = calculate_vol_remaining(strike, ewma_vol_1m, atr_event, minute_in_event, event_mins)
    prob_yes = compute_v18_probability(spot, strike, vol_rem)
    
    # Cap probability between 10% and 90% as done in sweep audit
    prob_yes = max(10.0, min(90.0, prob_yes))
    entry_prob = prob_yes if direction == "YES" else (100.0 - prob_yes)
    
    return direction, entry_prob
