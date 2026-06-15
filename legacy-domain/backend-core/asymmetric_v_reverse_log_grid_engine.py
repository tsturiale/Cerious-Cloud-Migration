"""
terminal/backend/core/asymmetric_v_reverse_log_grid_engine.py
=============================================================
Asymmetric Log-Grid V-Reversal pricing and trading engine.
Designed for high-convexity tail risk harvesting in binary prediction markets.
"""

import numpy as np
import math
from typing import Dict, Any, List, Tuple, Optional
from datetime import datetime

from terminal.backend.core.merton_binary_engine import price_binary_up
from terminal.backend.core.bates_engine import BatesEngine


class AsymmetricVReverseLogGridEngine:
    """
    Asymmetric Log-Grid V-Reversal Engine.
    Detects short-term spot exhaustion (volume climax, RSI oversold/overbought, momentum rollover),
    calculates fair probability using an dynamically-scaled Merton Jump-Diffusion pricer,
    and sizes binary prediction market contract orders logarithmically to ensure high-convexity payouts.
    """

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
        """
        Args:
            S0: Current spot asset price.
            sigma: Short-term annualized asset volatility.
            lam_base: Base jump intensity parameter (annual expected jump count).
            mu_j_base: Base log-jump size mean.
            sigma_j: Log-jump size standard deviation.
            risk_capital: Risk capital budget per trading cycle.
            engine_type: Pricing model ("bates" or "merton").
            kappa: Volatility mean reversion speed (Bates only).
            xi: Volatility of volatility (Bates only).
            rho: Spot-variance correlation (Bates only).
        """
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
        
    def update_spot(self, spot_candle: Dict[str, Any]) -> None:
        """
        Appends the latest spot candle and maintains rolling history (max 200 candles).
        Expected format: {"close": float, "volume": float, "high": float, "low": float}
        """
        self.candles.append(spot_candle)
        if len(self.candles) > 200:
            self.candles.pop(0)
            
        # Update current spot price
        self.S0 = spot_candle["close"]

    def calculate_technical_indicators(self) -> Tuple[float, float, float]:
        """
        Computes RSI (14-period), Volume Climax, and Momentum Rollover.
        Returns: (RSI, volume_climax, momentum_rollover)
        """
        if len(self.candles) < 2:
            return 50.0, 1.0, 0.0

        closes = np.array([c["close"] for c in self.candles])
        volumes = np.array([c["volume"] for c in self.candles])

        # 1. RSI (14-period)
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

        # 2. Volume Climax (current volume vs 20-period average)
        volume_climax = 1.0
        if len(volumes) >= 21:
            avg_vol = np.mean(volumes[-21:-1])
            volume_climax = volumes[-1] / max(1e-8, avg_vol)
        elif len(volumes) >= 2:
            avg_vol = np.mean(volumes[:-1])
            volume_climax = volumes[-1] / max(1e-8, avg_vol)

        # 3. Momentum Rollover
        # Slope of short-term ROC vs intermediate-term ROC
        momentum_rollover = 0.0
        if len(closes) >= 10:
            roc_short = (closes[-1] - closes[-3]) / closes[-3]
            roc_long = (closes[-3] - closes[-10]) / closes[-10]
            # Rollover is positive if short term is turning up while long term is down
            # or negative if short term is turning down while long term is up
            momentum_rollover = float(roc_short - roc_long)
            
        return rsi, volume_climax, momentum_rollover

    def get_squeeze_scores(self) -> Tuple[float, float]:
        """
        Computes directional squeeze score (0.0 to 1.0) for both UP and DOWN reversal trades.
        Returns: (squeeze_score_up, squeeze_score_down)
        """
        rsi, vol_climax, mom = self.calculate_technical_indicators()

        # Bullish Squeeze (UP reversal of a dip)
        rsi_factor_up = max(0.0, (30.0 - rsi) / 30.0)  # scales up as RSI drops below 30
        vol_factor = min(1.0, max(0.0, (vol_climax - 1.0) / 2.5))  # scales up from 1.0x to 3.5x average volume
        mom_factor_up = max(0.0, mom) if mom > 0 else 0.0
        
        squeeze_score_up = rsi_factor_up * 0.5 + vol_factor * 0.3 + min(1.0, mom_factor_up * 10.0) * 0.2
        squeeze_score_up = min(1.0, max(0.0, squeeze_score_up))

        # Bearish Squeeze (DOWN reversal of a rip)
        rsi_factor_down = max(0.0, (rsi - 70.0) / 30.0)  # scales up as RSI exceeds 70
        mom_factor_down = max(0.0, -mom) if mom < 0 else 0.0

        squeeze_score_down = rsi_factor_down * 0.5 + vol_factor * 0.3 + min(1.0, mom_factor_down * 10.0) * 0.2
        squeeze_score_down = min(1.0, max(0.0, squeeze_score_down))

        return squeeze_score_up, squeeze_score_down

    def generate_log_grid(
        self,
        T: float,
        market_prices: List[float],
        reversal_direction: str,
        paths: int = 50000
    ) -> Dict[str, Any]:
        """
        Calculates fair probabilities using MJD pricing (adjusted by squeeze scores)
        and sizes trades logarithmically across the probability grid.

        Args:
            T: Time to contract expiration in years (e.g. 5 mins / 525960).
            market_prices: List of low-probability market prices in decimals (e.g. [0.05, 0.10, 0.15, 0.20]).
            reversal_direction: "up" (expecting spot to rally) or "down" (expecting spot to drop).
            paths: Number of Monte Carlo simulation paths.
        """
        reversal_direction = reversal_direction.lower()
        squeeze_up, squeeze_down = self.get_squeeze_scores()
        
        # 1. Adjust MJD parameters based on Squeeze Score
        if reversal_direction == "up":
            score = squeeze_up
            # Scale jump intensity up under squeeze conditions
            lam_adj = self.lam_base * (1.0 + 4.0 * score)
            # Shift jump expectation positive
            mu_j_adj = self.mu_j_base + 0.15 * score
        else:
            score = squeeze_down
            lam_adj = self.lam_base * (1.0 + 4.0 * score)
            # Shift jump expectation negative
            mu_j_adj = self.mu_j_base - 0.15 * score

        time_mins = T * 525960.0
        
        # 2. Compute pricing probability of YES contract settling in-the-money
        # If reversal is UP, YES is S_T > S0. If reversal is DOWN, YES is S_T < S0.
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
            # Fallback to Merton Jump-Diffusion (MJD)
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
        
        # 3. Size logarithmically across market price buckets
        # Sizing formula: size_i = risk_capital * fraction * log(1/p_i) * edge_i
        grid_buckets = {}
        total_risk = 0.0
        
        for price_bucket in market_prices:
            # Reversal direction is the "cheap" side
            # Edge = model probability - market price
            edge = fair_prob - price_bucket
            
            if edge <= 0:
                grid_buckets[f"{int(price_bucket*100)}% bucket"] = {
                    "fair_prob": float(fair_prob),
                    "edge": float(edge),
                    "size_usd": 0.0,
                    "expected_payout": 0.0
                }
                continue
                
            # Logarithmic sizer: log(1/price_bucket) represents convexity
            # edge * log(1/price) acts as a fractional Kelly multiplier
            multiplier = 1.0 / price_bucket
            weight = math.log(multiplier) * edge
            
            # Sizing multiplier: 0.10 fractional Kelly scaling
            raw_size = self.risk_capital * 0.10 * weight
            
            # Cap size based on available capital per bucket
            max_size_cap = self.risk_capital * 0.15
            size_usd = min(max_size_cap, raw_size)
            
            grid_buckets[f"{int(price_bucket*100)}% bucket"] = {
                "fair_prob": float(fair_prob),
                "edge": float(edge),
                "size_usd": float(size_usd),
                "expected_payout": float(multiplier)
            }
            total_risk += size_usd

        # 4. Enforce global portfolio risk constraint (max 3% total risk of capital per cycle)
        max_risk_allowed = self.risk_capital * 0.03
        if total_risk > max_risk_allowed:
            scale_factor = max_risk_allowed / total_risk
            for bucket in grid_buckets.keys():
                grid_buckets[bucket]["size_usd"] *= scale_factor
            total_risk = max_risk_allowed

        # 5. Expected portfolio multiplier (weighted payouts)
        expected_multiplier = 0.0
        if total_risk > 0:
            weighted_payout = sum(
                info["size_usd"] * info["expected_payout"] 
                for info in grid_buckets.values() if info["size_usd"] > 0
            )
            expected_multiplier = weighted_payout / total_risk
            
        summary = {
            "buckets": grid_buckets,
            "total_risk": float(total_risk),
            "expected_portfolio_multiplier": float(expected_multiplier),
            "squeeze_score": float(score),
            "reversal_direction": reversal_direction
        }
        
        return summary

    def execute_grid_trades(self, grid_summary: Dict[str, Any]) -> None:
        """
        Executes prediction market orders across the log-grid and takes
        corresponding spot hedges to facilitate short-squeezes.
        """
        direction = grid_summary["reversal_direction"]
        total_risk = grid_summary["total_risk"]
        
        if total_risk <= 0:
            print("  [EXECUTION] No trade edge detected. Standing down.")
            return

        print(f"  [EXECUTION] === Triggering Log-Grid V-Reversal Execution === ")
        print(f"  [EXECUTION] Reversal Direction: {direction.upper()} | Squeeze Score: {grid_summary['squeeze_score']:.2f}")
        print(f"  [EXECUTION] Total PM Capital Risked: ${total_risk:.2f} USD")
        
        for bucket, details in grid_summary["buckets"].items():
            size = details["size_usd"]
            if size > 0:
                print(f"  [EXECUTION] Buying cheap {direction.upper()} contracts on {bucket}: Size = ${size:.2f} USD at payout = {details['expected_payout']:.1f}x")

        # Optional Spot Squeeze leg: small long on bottoms, short on tops
        spot_leg_size = total_risk * 1.5  # Sized relative to PM risk
        if direction == "up":
            print(f"  [EXECUTION] Spot Leg: BUY SPOT ${spot_leg_size:.2f} USD to force late shorts to cover.")
        else:
            print(f"  [EXECUTION] Spot Leg: SELL/SHORT SPOT ${spot_leg_size:.2f} USD to squeeze late buyers.")
            
    def backtest_on_historical_spot(self, spot_df: Any, pm_resolution_df: Optional[Any] = None) -> Dict[str, Any]:
        """
        Backtests the engine on historical spot DataFrame (columns: close, volume, high, low).
        Matches entries and calculates cumulative PnL.
        """
        pnl = 0.0
        trades_count = 0
        wins_count = 0
        total_risk_committed = 0.0
        
        # Drawdown tracking
        equity = self.risk_capital
        peak = equity
        max_dd_usd = 0.0
        max_dd_pct = 0.0
        
        self.candles = []
        trades_log = []
        
        # Convert dataframe columns to NumPy arrays to optimize access speed (100x speedup)
        closes = spot_df["close"].values
        volumes = spot_df["volume"].values
        highs = spot_df["high"].values if "high" in spot_df.columns else closes
        lows = spot_df["low"].values if "low" in spot_df.columns else closes
        timestamps = spot_df.index
        
        # Slices candles and iterates
        for i in range(len(spot_df)):
            candle = {
                "close": float(closes[i]),
                "volume": float(volumes[i]),
                "high": float(highs[i]),
                "low": float(lows[i])
            }
            self.update_spot(candle)
            
            # Need history to detect reversal
            if len(self.candles) < 21:
                continue
                
            sq_up, sq_down = self.get_squeeze_scores()
            
            # Trigger reversal entry on extreme squeeze score (> 0.70)
            if sq_up >= 0.70 or sq_down >= 0.70:
                direction = "up" if sq_up >= sq_down else "down"
                
                # Check if there is a remaining bar history to resolve contract (simulate 5-minute bars)
                # Ensure we have at least 5 bars ahead to evaluate contract payoff
                if i + 5 >= len(spot_df):
                    break
                    
                grid = self.generate_log_grid(
                    T=5.0/525960.0,
                    market_prices=[0.05, 0.10, 0.15, 0.20],
                    reversal_direction=direction,
                    paths=5000
                )
                
                if grid["total_risk"] <= 0:
                    continue
                    
                trades_count += 1
                total_risk_committed += grid["total_risk"]
                
                # Settle 5 minutes later (5 rows down in 1-min data)
                settle_close = closes[i + 5]
                
                # Payoff condition
                win_condition = (settle_close > self.S0) if direction == "up" else (settle_close <= self.S0)
                
                # Calculate trade payout
                trade_loss = grid["total_risk"]
                trade_gain = 0.0
                
                if win_condition:
                    wins_count += 1
                    # Settle YES/NO contracts at 1.00 USD
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
                    "pnl": float(trade_pnl),
                    "risk": float(trade_loss),
                    "win": 1 if win_condition else 0
                })
                    
        return {
            "total_trades": trades_count,
            "wins": wins_count,
            "win_rate": (wins_count / trades_count) if trades_count > 0 else 0.0,
            "total_risk_committed_usd": total_risk_committed,
            "net_pnl_usd": pnl,
            "max_drawdown_usd": max_dd_usd,
            "max_drawdown_pct": max_dd_pct,
            "trades_log": trades_log
        }

    def simulate_squeeze_scenario(self, direction: str = "up") -> Dict[str, Any]:
        """
        Simulates a synthetic V-reversal short squeeze to evaluate engine sizing and output.
        """
        direction = direction.lower()
        # Create a synthetic series of candles
        # Dip phase
        candles = []
        base_price = 100000.0
        
        # 14 candles drifting down with low-to-medium volume
        for i in range(14):
            base_price -= 500.0
            candles.append({
                "close": base_price,
                "volume": 100.0 + i * 5,
                "high": base_price + 100,
                "low": base_price - 100
            })
            
        # Exhaustion climax candle (huge drop, massive volume)
        climax_price = base_price - 2500.0
        candles.append({
            "close": climax_price,
            "volume": 1500.0,  # Climax volume (15x average)
            "high": climax_price + 100,
            "low": climax_price - 2000
        })
        
        # Initialize engine and feed candles
        engine = AsymmetricVReverseLogGridEngine(
            S0=100000.0,
            sigma=0.35,
            lam_base=10.0,
            mu_j_base=-0.05,
            sigma_j=0.25,
            risk_capital=10000.0
        )
        
        for c in candles:
            engine.update_spot(c)
            
        # Get grid
        grid = engine.generate_log_grid(
            T=5.0/525960.0,
            market_prices=[0.05, 0.10, 0.15, 0.20],
            reversal_direction=direction,
            paths=10000
        )
        
        return grid
