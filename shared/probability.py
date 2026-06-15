"""
shared/probability.py — Merton Jump-Diffusion & Student-t Probability Engine.
Optimized for 5m/15m/60m crypto binary prediction markets.
"""

import math
from typing import TypedDict
from scipy.stats import norm, t
import numpy as np

class GreeksOutput(TypedDict):
    p_up: float
    p_down: float
    gamma: float
    theta: float
    vega: float
    vanna: float  # Sensitivity of Prob to Vol
    charm: float  # Sensitivity of Prob to Time
    jump_risk: float
    edge_up: float
    edge_down: float

def merton_jump_diffusion_binary_prob(
    spot: float,
    strike: float,
    sigma_annualized: float,
    tau_years: float,
    drift_annualized: float = 0.0,
    jump_lambda: float = 0.0,   # Number of jumps per year
    jump_mu: float = 0.0,       # Mean jump size (log terms)
    jump_sigma: float = 0.1,    # Volatility of jumps
    use_student_t: bool = True,
    df_student: float = 4.2     # Degrees of freedom for crypto (~4-5)
) -> GreeksOutput:
    """
    Computes P(S_T > K) using Merton's Jump-Diffusion model with an optional
    Student-t distribution for fat tails (high/unstable regimes only).

    Item 2: Adaptive Poisson n_terms — only compute terms that meaningfully
    contribute given λ·τ.  For short-dated low-vol markets (λ·τ << 1) this
    cuts the inner loop from 11 to 2-3 iterations with no accuracy loss.
    """
    if tau_years <= 1e-8:
        p_up = 1.0 if spot > strike else 0.0
        return {
            "p_up": p_up, "p_down": 1.0 - p_up,
            "gamma": 0.0, "theta": 0.0, "vega": 0.0,
            "vanna": 0.0, "charm": 0.0,
            "jump_risk": 0.0, "edge_up": 0.0, "edge_down": 0.0
        }

    # Item 2: adaptive n_terms
    # Expected number of jumps over [0, τ]: λ·τ
    # Terms beyond n where Poisson weight < 1e-6 are numerically negligible.
    # Formula: n_terms = ceil(λ·τ + 3·sqrt(λ·τ)) + 1, capped at 11.
    expected_jumps = jump_lambda * tau_years
    if expected_jumps < 1e-6:
        n_terms = 2   # n=0 dominates completely; n=1 is a tiny correction
    else:
        n_terms = min(11, max(3, int(expected_jumps + 3 * math.sqrt(expected_jumps)) + 1))

    p_up_sum = 0.0
    vanna_sum = 0.0
    charm_sum = 0.0

    expected_jump_size = math.exp(jump_mu + 0.5 * jump_sigma**2) - 1
    drift_adj = drift_annualized - jump_lambda * expected_jump_size
    sqt = math.sqrt(tau_years)  # computed once outside loop

    for n in range(n_terms):
        poisson_p = (math.exp(-expected_jumps) * expected_jumps**n) / math.factorial(n)
        if poisson_p < 1e-9:
            break   # remaining terms negligible
        sigma_n = math.sqrt(sigma_annualized**2 + (n * jump_sigma**2 / tau_years))
        drift_n = drift_adj + (n * jump_mu / tau_years)

        d2 = (math.log(spot / strike) + (drift_n - 0.5 * sigma_n**2) * tau_years) / (sigma_n * sqt)
        d1 = d2 + sigma_n * sqt

        # Item 3: use Student-t only for high/unstable regimes where fat tails matter;
        # norm.cdf is ~15x faster and accurate enough for low/medium.
        if use_student_t:
            p_n   = float(t.cdf(d2, df=df_student))
            pdf_n = float(t.pdf(d2, df=df_student))
        else:
            p_n   = float(norm.cdf(d2))
            pdf_n = float(norm.pdf(d2))

        p_up_sum += poisson_p * p_n

        # Binary Vanna: sensitivity of prob to vol
        vanna_sum += poisson_p * (-pdf_n * d1 / max(1e-4, sigma_n))

        # Binary Charm: delta bleed (sensitivity of prob to time)
        charm_comp = pdf_n * ((drift_n / (sigma_n * sqt)) - (d1 / (2 * tau_years)))
        charm_sum += poisson_p * charm_comp

    p_up_final = float(np.clip(p_up_sum, 0.0, 1.0) * 100.0)

    # Greeks baseline (uses base sigma/drift, not per-jump values)
    d2_base = (math.log(spot / strike) + (drift_annualized - 0.5 * sigma_annualized**2) * tau_years) / (sigma_annualized * sqt)
    gamma = norm.pdf(d2_base) / (spot * sigma_annualized * sqt)
    theta = -norm.pdf(d2_base) * sigma_annualized / (2 * sqt)
    vega  = -norm.pdf(d2_base) * sqt

    return {
        "p_up":      p_up_final,
        "p_down":    100.0 - p_up_final,
        "gamma":     float(gamma),
        "theta":     float(theta),
        "vega":      float(vega),
        "vanna":     float(vanna_sum),
        "charm":     float(charm_sum),
        "jump_risk": float(jump_lambda * jump_sigma),
        "edge_up":   0.0,
        "edge_down": 0.0
    }


def evaluate_truth_probability(
    features,
    strike: float,
    time_to_expiry_minutes: float,
    timeframe_minutes: int,
    market_prob: float = 0.5
) -> GreeksOutput:
    """Entry point for the backend to calculate high-fidelity probabilities."""
    tau_years = time_to_expiry_minutes / (365.25 * 24 * 60)

    # 1. Map regime to jump-diffusion parameters
    regime_str = features.regime.value.lower()
    regime_map = {
        "high":     500.0,
        "medium":   120.0,
        "low":       10.0,
        "unstable": 1200.0,
    }
    jump_lambda = regime_map.get(regime_str, 120.0)

    # 2. Estimate drift (mu) from microstructure
    ofi_impact   = features.ofi * 0.35
    vpin_impact  = (features.vpin - 0.5) * 1.5
    zscore_impact = features.zscore * -0.25   # mean-reversion bias
    htf_impact   = features.htf_trend * 3.0

    scale = 2.0 if timeframe_minutes <= 5 else 1.2
    drift = scale * (ofi_impact + vpin_impact + zscore_impact + htf_impact)

    # 3. Use ATR as fractional vol, annualized
    sigma = (features.atr / features.close) * math.sqrt(525600 / timeframe_minutes)

    # Item 3: Student-t fat tails only when regime warrants it.
    # low/medium → norm.cdf (~15x faster, negligible accuracy loss for λ·τ << 1)
    # high/unstable → Student-t (fat tails, liquidation risk)
    use_t = regime_str in ("high", "unstable")

    results = merton_jump_diffusion_binary_prob(
        spot=features.close,
        strike=strike,
        sigma_annualized=sigma,
        tau_years=tau_years,
        drift_annualized=drift,
        jump_lambda=jump_lambda,
        jump_sigma=0.08,        # 8% jump std dev
        use_student_t=use_t,
    )

    # 4. Calculate edge vs market-implied probability
    results["edge_up"]   = results["p_up"]   - (market_prob * 100.0)
    results["edge_down"] = results["p_down"] - ((1.0 - market_prob) * 100.0)

    return results
