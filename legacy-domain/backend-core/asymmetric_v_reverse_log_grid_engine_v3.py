"""
terminal/backend/core/asymmetric_v_reverse_log_grid_engine_v3.py
================================================================
Asymmetric Log-Grid V-Reversal Engine — VERSION 3

Changes from V2:
  1. Default trigger thresholds adjusted to Pure High resolution:
     - SQUEEZE_THRESHOLD = 0.50
     - VOL_CLIMAX_MIN = 2.00 (optimal volume gate)
  2. Gate 2 (Momentum Confirmation) upgraded with Order Flow Proxy:
     - Calculates the Closing Location Value (CLV) proxy.
     - Bullish reversals require CLV >= CLV_THRESHOLD (close in upper half of range).
     - Bearish reversals require CLV <= -CLV_THRESHOLD (close in lower half of range).
  3. Configurable Mid-Trade Scale-Out Rules:
     - Custom scale-out weights (scale1_pct, scale2_pct) and price multipliers (scale1_mult, scale2_mult)
       passed via the constructor, letting clients toggle dynamically between 40/30/30 (+250%/+500%)
       and Equal Thirds (+150%/+300%) or other custom settings.
"""

import numpy as np
import math
from typing import Dict, Any, List, Tuple, Optional
from datetime import datetime

from terminal.backend.core.bates_engine import BatesEngine


# ──────────────────────────────────────────────────────────────────────────────
# Helper: EMA
# ──────────────────────────────────────────────────────────────────────────────
def _ema(series: np.ndarray, period: int) -> float:
    """Returns final EMA value for a series."""
    if len(series) < period:
        return float(series.mean())
    k = 2.0 / (period + 1)
    val = float(series[:period].mean())
    for price in series[period:]:
        val = price * k + val * (1 - k)
    return val


class AsymmetricVReverseLogGridEngineV3:
    """
    Asymmetric Log-Grid V-Reversal Engine — V3
    
    Features Pure High parameters, Order Flow (CLV) Gate 2 confirmation, and
    configurable scale-out properties.
    """

    # ── Gate thresholds (tunable defaults) ──────────────────────────────────
    SQUEEZE_THRESHOLD: float = 0.50          # Gated Pure High threshold
    VOL_CLIMAX_MIN: float = 2.00             # Gate 3: minimum volume ratio
    HTF_BARS: int = 240                      # Gate 1: bars defining "4h" at 1m
    HTF_SLOPE_NEUTRAL_BAND: float = 0.003    # ±0.3% slope = neutral (no block)
    CLV_THRESHOLD: float = 0.00              # Gate 2: CLV confirmation threshold

    def __init__(
        self,
        S0: float,
        sigma: float,
        lam_base: float = 8.0,
        mu_j_base: float = -0.045,
        sigma_j: float = 0.28,
        risk_capital: float = 166666.6667,    # $5,000 risk cap on $1M capital base
        kappa: float = 3.5,
        xi: float = 0.55,
        rho: float = -0.75,
        scale1_pct: float = 0.40,             # Weight for Target 1 (e.g. 40%)
        scale1_mult: float = 3.5,             # Multiplier for T1 (e.g. 3.5 = +250%)
        scale2_pct: float = 0.30,             # Weight for Target 2 (e.g. 30%)
        scale2_mult: float = 6.0,             # Multiplier for T2 (e.g. 6.0 = +500%)
    ):
        """
        Initializes the V3 engine with option pricing and scale-out configurations.
        """
        self.S0 = S0
        self.sigma = sigma
        self.lam_base = lam_base
        self.mu_j_base = mu_j_base
        self.sigma_j = sigma_j
        self.risk_capital = risk_capital
        self.kappa = kappa
        self.xi = xi
        self.rho = rho
        
        # Scale-out parameters
        self.scale1_pct = scale1_pct
        self.scale1_mult = scale1_mult
        self.scale2_pct = scale2_pct
        self.scale2_mult = scale2_mult

        # Rolling candle history arrays (highly optimized flat lists)
        self.closes: List[float] = []
        self.volumes: List[float] = []
        self.highs: List[float] = []
        self.lows: List[float] = []

        # Gate 2 — pending signal state
        self._pending: Optional[Dict[str, Any]] = None  # {direction, rsi_trigger, close_trigger}

        # Stateful RSI trackers
        self._avg_gain: Optional[float] = None
        self._avg_loss: Optional[float] = None

    # ──────────────────────────────────────────────────────────────────────────
    # Spot update
    # ──────────────────────────────────────────────────────────────────────────
    def update_spot(self, spot_candle: Dict[str, Any]) -> None:
        """Appends latest 1m candle. Keeps rolling 500-bar history."""
        c = float(spot_candle["close"])
        v = float(spot_candle.get("volume", 0.0))
        h = float(spot_candle.get("high", c))
        l = float(spot_candle.get("low", c))

        self.closes.append(c)
        self.volumes.append(v)
        self.highs.append(h)
        self.lows.append(l)
        
        # Stateful RSI update
        n = len(self.closes)
        if n == 15:
            closes_arr = np.array(self.closes)
            deltas = np.diff(closes_arr)
            gains = np.where(deltas > 0, deltas, 0.0)
            losses = np.where(deltas < 0, -deltas, 0.0)
            self._avg_gain = float(gains.mean())
            self._avg_loss = float(losses.mean())
        elif n > 15:
            delta = c - self.closes[-2]
            gain = max(0.0, delta)
            loss = max(0.0, -delta)
            if self._avg_gain is not None and self._avg_loss is not None:
                self._avg_gain = (self._avg_gain * 13.0 + gain) / 14.0
                self._avg_loss = (self._avg_loss * 13.0 + loss) / 14.0

        if len(self.closes) > 500:
            self.closes.pop(0)
            self.volumes.pop(0)
            self.highs.pop(0)
            self.lows.pop(0)
        self.S0 = c

    # ──────────────────────────────────────────────────────────────────────────
    # Gate 1: HTF Trend from 240-bar EMA slope
    # ──────────────────────────────────────────────────────────────────────────
    def get_htf_trend(self) -> float:
        """
        Returns:
          +1.0  → uptrend   (UP reversals allowed, DOWN blocked)
           0.0  → neutral   (both directions allowed)
          -1.0  → downtrend (DOWN reversals allowed, UP blocked)

        Method: EMA(20) vs EMA(240) on the last 240 bars.
        Slope = (EMA_fast - EMA_slow) / EMA_slow.
        """
        if len(self.closes) < self.HTF_BARS:
            return 0.0  # Not enough history → neutral, don't block

        closes = np.array(self.closes)
        ema_fast = _ema(closes, 20)
        ema_slow = _ema(closes, self.HTF_BARS)

        slope = (ema_fast - ema_slow) / max(ema_slow, 1e-8)

        if slope > self.HTF_SLOPE_NEUTRAL_BAND:
            return 1.0
        elif slope < -self.HTF_SLOPE_NEUTRAL_BAND:
            return -1.0
        return 0.0

    # ──────────────────────────────────────────────────────────────────────────
    # Technical Indicators (RSI, Volume Climax Quality, Momentum)
    # ──────────────────────────────────────────────────────────────────────────
    def calculate_technical_indicators(self) -> Tuple[float, float, float]:
        """
        Computes RSI (14-period), Volume Climax Quality score, and Momentum Rollover.
        """
        if len(self.closes) < 2:
            return 50.0, 1.0, 0.0

        # ── RSI (Stateful Wilder smoothing with loop fallback) ────────────────
        rsi = 50.0
        if len(self.closes) >= 15:
            if self._avg_gain is not None and self._avg_loss is not None:
                if self._avg_loss == 0:
                    rsi = 100.0
                else:
                    rs = self._avg_gain / self._avg_loss
                    rsi = 100.0 - (100.0 / (1.0 + rs))
            else:
                # Fallback to loop calculation if state is not initialized
                closes_arr = np.array(self.closes)
                deltas = np.diff(closes_arr)
                gains = np.where(deltas > 0, deltas, 0.0)
                losses = np.where(deltas < 0, -deltas, 0.0)

                avg_gain = gains[0:14].mean()
                avg_loss = losses[0:14].mean()

                for i in range(14, len(deltas)):
                    avg_gain = (avg_gain * 13 + gains[i]) / 14
                    avg_loss = (avg_loss * 13 + losses[i]) / 14

                if avg_loss == 0:
                    rsi = 100.0
                else:
                    rs = avg_gain / avg_loss
                    rsi = 100.0 - (100.0 / (1.0 + rs))

        # ── Gate 3: Volume Climax Quality ─────────────────────────────────────
        volume_climax = 0.0
        if len(self.volumes) >= 21:
            v_slice = self.volumes[-21:-1]
            avg_vol = sum(v_slice) / len(v_slice)
            raw_ratio = self.volumes[-1] / max(1e-8, avg_vol)
            
            is_local_peak = self.volumes[-1] >= max(self.volumes[-11:-1])  # Highest of last 10
            is_strong = raw_ratio >= self.VOL_CLIMAX_MIN

            if is_strong and is_local_peak:
                volume_climax = raw_ratio
        elif len(self.volumes) >= 2:
            volume_climax = 0.0

        # ── Momentum Rollover ─────────────────────────────────────────────────
        momentum_rollover = 0.0
        if len(self.closes) >= 10:
            roc_short = (self.closes[-1] - self.closes[-3]) / self.closes[-3]
            roc_long = (self.closes[-3] - self.closes[-10]) / self.closes[-10]
            momentum_rollover = float(roc_short - roc_long)

        return rsi, volume_climax, momentum_rollover

    # ──────────────────────────────────────────────────────────────────────────
    # Squeeze Scores
    # ──────────────────────────────────────────────────────────────────────────
    def get_squeeze_scores(self) -> Tuple[float, float]:
        """
        Directional squeeze scores (0–1) using the V3-gate volume climax.
        """
        rsi, vol_climax, mom = self.calculate_technical_indicators()

        vol_factor = min(1.0, max(0.0, (vol_climax - 1.0) / 2.5))

        # Bullish (UP reversal)
        rsi_factor_up = max(0.0, (30.0 - rsi) / 30.0)
        mom_factor_up = max(0.0, mom) if mom > 0 else 0.0
        squeeze_score_up = rsi_factor_up * 0.5 + vol_factor * 0.3 + min(1.0, mom_factor_up * 10.0) * 0.2
        squeeze_score_up = min(1.0, max(0.0, squeeze_score_up))

        # Bearish (DOWN reversal)
        rsi_factor_down = max(0.0, (rsi - 70.0) / 30.0)
        mom_factor_down = max(0.0, -mom) if mom < 0 else 0.0
        squeeze_score_down = rsi_factor_down * 0.5 + vol_factor * 0.3 + min(1.0, mom_factor_down * 10.0) * 0.2
        squeeze_score_down = min(1.0, max(0.0, squeeze_score_down))

        return squeeze_score_up, squeeze_score_down

    # ──────────────────────────────────────────────────────────────────────────
    # Gate 2: Pending Signal Check (Order Flow Proxy Confirmation)
    # ──────────────────────────────────────────────────────────────────────────
    def check_and_update_pending(self) -> Optional[str]:
        """
        Gate 2 state machine.
        Checks for confirmation using RSI, price close, and the Closing Location Value (CLV).

        Returns:
          "up" or "down"  — confirmed signal, fire trade
          None            — no confirmed signal this bar
        """
        if self._pending is None:
            return None

        rsi_now, _, _ = self.calculate_technical_indicators()
        
        close_now = self.closes[-1]
        high_now  = self.highs[-1]
        low_now   = self.lows[-1]
        
        # Closing Location Value (CLV) proxy
        clv = 0.0
        if high_now > low_now:
            clv = ((close_now - low_now) - (high_now - close_now)) / (high_now - low_now)

        direction = self._pending["direction"]
        rsi_trigger = self._pending["rsi_trigger"]
        close_trigger = self._pending["close_trigger"]

        confirmed = False
        if direction == "up":
            # RSI recovering + price higher + positive order flow (CLV >= CLV_THRESHOLD)
            confirmed = (rsi_now > rsi_trigger) and (close_now > close_trigger) and (clv >= self.CLV_THRESHOLD)
        else:
            # RSI declining + price lower + negative order flow (CLV <= -CLV_THRESHOLD)
            confirmed = (rsi_now < rsi_trigger) and (close_now < close_trigger) and (clv <= -self.CLV_THRESHOLD)

        # Always clear pending after one bar
        self._pending = None

        if confirmed:
            return direction
        return None

    def set_pending(self, direction: str) -> None:
        """Records a pending signal for confirmation on the next bar."""
        rsi_now, _, _ = self.calculate_technical_indicators()
        self._pending = {
            "direction": direction,
            "rsi_trigger": rsi_now,
            "close_trigger": self.closes[-1],
        }

    # ──────────────────────────────────────────────────────────────────────────
    # Log-Grid Sizing and Pricing
    # ──────────────────────────────────────────────────────────────────────────
    def generate_log_grid(
        self,
        T: float,
        market_prices: List[float],
        reversal_direction: str,
        paths: int = 5000
    ) -> Dict[str, Any]:
        """Prices and sizes across the probability grid using the Bates model."""
        reversal_direction = reversal_direction.lower()
        squeeze_up, squeeze_down = self.get_squeeze_scores()

        if reversal_direction == "up":
            score = squeeze_up
            lam_adj = self.lam_base * (1.0 + 4.0 * score)
            mu_j_adj = self.mu_j_base + 0.15 * score
        else:
            score = squeeze_down
            lam_adj = self.lam_base * (1.0 + 4.0 * score)
            mu_j_adj = self.mu_j_base - 0.15 * score

        # Bates pricing
        bates = BatesEngine(
            S0=self.S0,
            v0=self.sigma**2,
            kappa=self.kappa,
            theta=self.sigma**2,
            xi=self.xi,
            rho=self.rho,
            lam=lam_adj,
            mu_j=mu_j_adj,
            sigma_j=self.sigma_j,
            r=0.0
        )
        prob_st_up, _ = bates.price_binary_up(
            T=T,
            strike=self.S0,
            n_paths=paths,
            n_steps=10
        )
        fair_prob = prob_st_up if reversal_direction == "up" else (1.0 - prob_st_up)

        grid_buckets = {}
        total_risk = 0.0

        for price_bucket in market_prices:
            edge = fair_prob - price_bucket

            if edge <= 0:
                grid_buckets[f"{int(price_bucket*100)}% bucket"] = {
                    "fair_prob": float(fair_prob),
                    "edge": float(edge),
                    "size_usd": 0.0,
                    "expected_payout": 0.0,
                    "price_bucket": price_bucket
                }
                continue

            multiplier = 1.0 / price_bucket
            weight = math.log(multiplier) * edge
            raw_size = self.risk_capital * 0.10 * weight
            max_size_cap = self.risk_capital * 0.15
            size_usd = min(max_size_cap, raw_size)

            grid_buckets[f"{int(price_bucket*100)}% bucket"] = {
                "fair_prob": float(fair_prob),
                "edge": float(edge),
                "size_usd": float(size_usd),
                "expected_payout": float(multiplier),
                "price_bucket": price_bucket
            }
            total_risk += size_usd

        # Capped standard risk at 3% of allocated base
        max_risk_allowed = self.risk_capital * 0.03
        if total_risk > max_risk_allowed:
            scale_factor = max_risk_allowed / total_risk
            for bucket in grid_buckets.keys():
                grid_buckets[bucket]["size_usd"] *= scale_factor
            total_risk = max_risk_allowed

        expected_multiplier = 0.0
        if total_risk > 0:
            weighted_payout = sum(
                info["size_usd"] * info["expected_payout"]
                for info in grid_buckets.values() if info["size_usd"] > 0
            )
            expected_multiplier = weighted_payout / total_risk

        return {
            "buckets": grid_buckets,
            "total_risk": float(total_risk),
            "expected_portfolio_multiplier": float(expected_multiplier),
            "squeeze_score": float(score),
            "reversal_direction": reversal_direction
        }

    # ──────────────────────────────────────────────────────────────────────────
    # Generate limit order execution parameters
    # ──────────────────────────────────────────────────────────────────────────
    def get_scale_out_orders(self, grid_buckets: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Constructs explicit limit sell scale-out order profiles for the active buckets.
        
        Args:
            grid_buckets: "buckets" output dictionary from generate_log_grid
            
        Returns:
            List of order specifications containing targets and contract quantities.
        """
        orders = []
        for bucket, details in grid_buckets.items():
            sz_risk = details["size_usd"]
            if sz_risk <= 0:
                continue
            
            pb = details["price_bucket"]
            N = sz_risk / pb  # Number of contracts bought
            
            # Target 1 Order
            q_t1 = self.scale1_pct * N
            p_t1 = self.scale1_mult * pb
            
            # Target 2 Order
            q_t2 = self.scale2_pct * N
            p_t2 = self.scale2_mult * pb
            
            orders.append({
                "bucket": bucket,
                "price_bucket": pb,
                "total_contracts": N,
                "target1": {
                    "limit_price": float(min(1.00, p_t1)),
                    "contracts": float(q_t1)
                },
                "target2": {
                    "limit_price": float(min(1.00, p_t2)),
                    "contracts": float(q_t2),
                    "active": p_t2 <= 1.00
                },
                "settlement_pct": float(1.0 - self.scale1_pct - self.scale2_pct)
            })
            
        return orders
