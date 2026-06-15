"""
terminal/backend/core/asymmetric_v_reverse_log_grid_engine_v2.py
================================================================
Asymmetric Log-Grid V-Reversal Engine — VERSION 2

Changes from V1:
  Gate 1 — HTF Trend Gate:
      Derives a pseudo-4h trend from 240 1m candles (EMA slope).
      UP reversals blocked in downtrend. DOWN reversals blocked in uptrend.

  Gate 2 — 1-Bar Momentum Confirmation:
      On squeeze trigger, set a "pending" flag instead of immediately firing.
      Fire only if the NEXT bar confirms: RSI improving + price moves toward reversal.
      Eliminates falling-knife and rising-knife entries.

  Gate 3 — Volume Climax Quality:
      Requires vol ≥ 2.5× 20-period average AND current bar is the
      local volume peak over the last 10 bars. Eliminates weak volume signals.
"""

import numpy as np
import math
from typing import Dict, Any, List, Tuple, Optional
from datetime import datetime

from terminal.backend.core.merton_binary_engine import price_binary_up
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


class AsymmetricVReverseLogGridEngineV2:
    """
    Asymmetric Log-Grid V-Reversal Engine — V2

    Adds three entry-quality gates on top of the V1 squeeze-score trigger:
      1. HTF Trend Gate   — derived from 240-bar EMA slope (pseudo 4h)
      2. Momentum Delay   — 1-bar confirmation before firing
      3. Volume Quality   — requires 2.5× average + local peak
    """

    # ── Gate thresholds (tunable) ──────────────────────────────────────────
    SQUEEZE_THRESHOLD: float = 0.70          # Same as V1
    VOL_CLIMAX_MIN: float = 2.50             # Gate 3: minimum volume ratio
    HTF_BARS: int = 240                      # Gate 1: bars defining "4h" at 1m
    HTF_SLOPE_NEUTRAL_BAND: float = 0.003    # ±0.3% slope = neutral (no block)

    def __init__(
        self,
        S0: float,
        sigma: float,
        lam_base: float = 8.0,
        mu_j_base: float = -0.045,
        sigma_j: float = 0.28,
        risk_capital: float = 10000.0,
        engine_type: str = "bates",
        kappa: float = 3.5,
        xi: float = 0.55,
        rho: float = -0.75
    ):
        self.S0 = S0
        self.sigma = sigma
        self.lam_base = lam_base
        self.mu_j_base = mu_j_base
        self.sigma_j = sigma_j
        self.risk_capital = risk_capital
        self.engine_type = engine_type.lower()
        self.kappa = kappa
        self.xi = xi
        self.rho = rho

        # Rolling candle history
        self.candles: List[Dict[str, Any]] = []

        # Gate 2 — pending signal state
        self._pending: Optional[Dict[str, Any]] = None  # {direction, rsi_trigger, close_trigger}

    # ──────────────────────────────────────────────────────────────────────────
    # Spot update
    # ──────────────────────────────────────────────────────────────────────────
    def update_spot(self, spot_candle: Dict[str, Any]) -> None:
        """Appends latest 1m candle. Keeps rolling 500-bar history."""
        self.candles.append(spot_candle)
        if len(self.candles) > 500:
            self.candles.pop(0)
        self.S0 = spot_candle["close"]

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
        closes = np.array([c["close"] for c in self.candles])
        if len(closes) < self.HTF_BARS:
            return 0.0  # Not enough history → neutral, don't block

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

        Gate 3 changes:
          - volume_climax is 0.0 unless vol ≥ 2.5× avg AND it's the local peak
            in the last 10 bars. Otherwise the engine treats it as no climax.

        Returns: (RSI, volume_climax, momentum_rollover)
        """
        if len(self.candles) < 2:
            return 50.0, 1.0, 0.0

        closes = np.array([c["close"] for c in self.candles])
        volumes = np.array([c["volume"] for c in self.candles])

        # ── RSI (14-period Wilder smoothing) ──────────────────────────────────
        rsi = 50.0
        if len(closes) >= 15:
            deltas = np.diff(closes)
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
        if len(volumes) >= 21:
            avg_vol = np.mean(volumes[-21:-1])
            raw_ratio = volumes[-1] / max(1e-8, avg_vol)
            is_local_peak = volumes[-1] >= np.max(volumes[-11:-1])  # Highest of last 10
            is_strong = raw_ratio >= self.VOL_CLIMAX_MIN

            if is_strong and is_local_peak:
                # Pass through scaled climax (same shape as V1 vol_factor input)
                volume_climax = raw_ratio
            # else: 0.0 → vol_factor will be 0 → no climax contribution
        elif len(volumes) >= 2:
            # Insufficient history; keep volume_climax = 0.0 (conservative)
            volume_climax = 0.0

        # ── Momentum Rollover ─────────────────────────────────────────────────
        momentum_rollover = 0.0
        if len(closes) >= 10:
            roc_short = (closes[-1] - closes[-3]) / closes[-3]
            roc_long = (closes[-3] - closes[-10]) / closes[-10]
            momentum_rollover = float(roc_short - roc_long)

        return rsi, volume_climax, momentum_rollover

    # ──────────────────────────────────────────────────────────────────────────
    # Squeeze Scores
    # ──────────────────────────────────────────────────────────────────────────
    def get_squeeze_scores(self) -> Tuple[float, float]:
        """
        Directional squeeze scores (0–1) using the V3-gate volume climax.
        The volume_climax value from calculate_technical_indicators() is already
        zero unless it passes Gate 3 quality requirements.
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
    # Gate 2: Pending Signal Check (1-bar Momentum Confirmation)
    # ──────────────────────────────────────────────────────────────────────────
    def _check_and_update_pending(self) -> Optional[str]:
        """
        Gate 2 state machine.

        Call AFTER update_spot() on each bar.

        If a pending signal exists, checks whether this bar confirms:
          - UP pending: current RSI > rsi_trigger (improving) AND current close > close_trigger
          - DOWN pending: current RSI < rsi_trigger (improving) AND current close < close_trigger

        Returns:
          "up" or "down"  — confirmed signal, fire trade
          None            — no confirmed signal this bar
        """
        if self._pending is None:
            return None

        rsi_now, _, _ = self.calculate_technical_indicators()
        close_now = self.candles[-1]["close"]
        direction = self._pending["direction"]
        rsi_trigger = self._pending["rsi_trigger"]
        close_trigger = self._pending["close_trigger"]

        confirmed = False
        if direction == "up":
            # RSI recovering upward + price higher than trigger close
            confirmed = (rsi_now > rsi_trigger) and (close_now > close_trigger)
        else:
            # RSI recovering downward (falling) + price lower than trigger close
            confirmed = (rsi_now < rsi_trigger) and (close_now < close_trigger)

        # Always clear pending after one bar (fire or cancel — no multi-bar wait)
        self._pending = None

        if confirmed:
            return direction
        return None

    def _set_pending(self, direction: str) -> None:
        """Records a pending signal for confirmation on the next bar."""
        rsi_now, _, _ = self.calculate_technical_indicators()
        self._pending = {
            "direction": direction,
            "rsi_trigger": rsi_now,
            "close_trigger": self.candles[-1]["close"],
        }

    # ──────────────────────────────────────────────────────────────────────────
    # Log-Grid Pricing (same as V1)
    # ──────────────────────────────────────────────────────────────────────────
    def generate_log_grid(
        self,
        T: float,
        market_prices: List[float],
        reversal_direction: str,
        paths: int = 50000
    ) -> Dict[str, Any]:
        """Prices and sizes across the probability grid. Identical to V1."""
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

        time_mins = T * 525960.0

        if self.engine_type == "bates":
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
        else:
            prob_st_up = price_binary_up(
                spot=self.S0,
                strike=self.S0,
                volatility=self.sigma,
                time_to_expiry_mins=time_mins,
                drift_annualized=0.0,
                jump_lambda=lam_adj,
                jump_mu=mu_j_adj,
                jump_sigma=self.sigma_j,
                paths=paths
            )
            fair_prob = (prob_st_up / 100.0) if reversal_direction == "up" else (1.0 - prob_st_up / 100.0)

        grid_buckets = {}
        total_risk = 0.0

        for price_bucket in market_prices:
            edge = fair_prob - price_bucket

            if edge <= 0:
                grid_buckets[f"{int(price_bucket*100)}% bucket"] = {
                    "fair_prob": float(fair_prob),
                    "edge": float(edge),
                    "size_usd": 0.0,
                    "expected_payout": 0.0
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
                "expected_payout": float(multiplier)
            }
            total_risk += size_usd

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
    # Backtest (V2 — all 3 gates active)
    # ──────────────────────────────────────────────────────────────────────────
    def backtest_on_historical_spot(
        self,
        spot_df: Any,
        pm_resolution_df: Optional[Any] = None
    ) -> Dict[str, Any]:
        """
        Backtests the V2 engine on historical 1m spot DataFrame.

        Gate flow per bar:
          1. update_spot()
          2. Check Gate 2 first: if pending signal → try confirmation → fire if yes
          3. Check Gate 1 (HTF trend) to allow/block direction
          4. Check squeeze scores against threshold
          5. Check Gate 3 (volume quality) — embedded in squeeze scores
          6. If all pass → set pending (Gate 2), don't fire yet
        """
        pnl = 0.0
        trades_count = 0
        wins_count = 0
        total_risk_committed = 0.0

        equity = self.risk_capital
        peak = equity
        max_dd_usd = 0.0
        max_dd_pct = 0.0

        self.candles = []
        self._pending = None
        trades_log = []

        closes = spot_df["close"].values
        volumes = spot_df["volume"].values
        highs = spot_df["high"].values if "high" in spot_df.columns else closes
        lows = spot_df["low"].values if "low" in spot_df.columns else closes
        timestamps = spot_df.index

        # Track gate skip stats
        skips_htf = 0
        skips_no_squeeze = 0
        pending_sets = 0

        for i in range(len(spot_df)):
            candle = {
                "close": float(closes[i]),
                "volume": float(volumes[i]),
                "high": float(highs[i]),
                "low": float(lows[i])
            }
            self.update_spot(candle)

            # ── Minimum history guard ─────────────────────────────────────
            if len(self.candles) < 21:
                continue

            # ── Gate 2: Check if there's a confirmed pending signal ───────
            confirmed_direction = self._check_and_update_pending()

            if confirmed_direction is not None:
                # Confirmed entry — price the grid and fire
                if i + 5 >= len(spot_df):
                    break

                grid = self.generate_log_grid(
                    T=5.0 / 525960.0,
                    market_prices=[0.05, 0.10, 0.15, 0.20],
                    reversal_direction=confirmed_direction,
                    paths=5000
                )

                if grid["total_risk"] <= 0:
                    continue

                trades_count += 1
                total_risk_committed += grid["total_risk"]

                settle_close = closes[i + 5]
                current_close = self.candles[-1]["close"]
                win_condition = (
                    (settle_close > current_close) if confirmed_direction == "up"
                    else (settle_close <= current_close)
                )

                trade_loss = grid["total_risk"]
                trade_gain = 0.0

                if win_condition:
                    wins_count += 1
                    for bucket, details in grid["buckets"].items():
                        size = details["size_usd"]
                        if size > 0:
                            trade_gain += size * details["expected_payout"]
                    trade_pnl = trade_gain - trade_loss
                else:
                    trade_pnl = -trade_loss

                pnl += trade_pnl
                equity += trade_pnl
                peak = max(peak, equity)
                dd_usd = peak - equity
                dd_pct = dd_usd / peak if peak > 0 else 0.0
                max_dd_usd = max(max_dd_usd, dd_usd)
                max_dd_pct = max(max_dd_pct, dd_pct)

                trades_log.append({
                    "timestamp": str(timestamps[i]),
                    "direction": confirmed_direction,
                    "pnl": float(trade_pnl),
                    "risk": float(trade_loss),
                    "win": 1 if win_condition else 0
                })
                continue  # Done for this bar

            # ── No confirmed pending — check for new trigger ──────────────
            sq_up, sq_down = self.get_squeeze_scores()

            if sq_up < self.SQUEEZE_THRESHOLD and sq_down < self.SQUEEZE_THRESHOLD:
                skips_no_squeeze += 1
                continue

            # Preferred direction
            direction = "up" if sq_up >= sq_down else "down"

            # ── Gate 1: HTF Trend Filter ──────────────────────────────────
            htf = self.get_htf_trend()
            if direction == "up" and htf < 0:
                # UP reversal blocked — HTF is bearish
                skips_htf += 1
                continue
            if direction == "down" and htf > 0:
                # DOWN reversal blocked — HTF is bullish
                skips_htf += 1
                continue

            # ── All gates pass → set pending for Gate 2 confirmation ──────
            self._set_pending(direction)
            pending_sets += 1

        return {
            "total_trades": trades_count,
            "wins": wins_count,
            "win_rate": (wins_count / trades_count) if trades_count > 0 else 0.0,
            "total_risk_committed_usd": total_risk_committed,
            "net_pnl_usd": pnl,
            "max_drawdown_usd": max_dd_usd,
            "max_drawdown_pct": max_dd_pct,
            "trades_log": trades_log,
            "gate_stats": {
                "pending_sets": pending_sets,
                "skips_htf": skips_htf,
                "skips_no_squeeze": skips_no_squeeze,
            }
        }
