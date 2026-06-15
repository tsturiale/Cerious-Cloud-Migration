"""
terminal/backend/core/merton_binary_engine.py
=============================================
Standalone, drop-in ready Merton Jump-Diffusion Monte Carlo binary options pricing engine.
Optimized with NumPy to achieve sub-100ms pricing on CPU (100k paths).
Includes edge detection and is calibrated for BTC-like volatility & jump parameters.
"""

import numpy as np
from typing import Dict, Any, Tuple


def price_binary_up(
    spot: float,
    strike: float,
    volatility: float,
    time_to_expiry_mins: float,
    drift_annualized: float = 0.0,
    jump_lambda: float = 120.0,
    jump_mu: float = 0.0,
    jump_sigma: float = 0.02,
    paths: int = 100000
) -> float:
    """
    Simulates the terminal price under Merton Jump-Diffusion SDE in a single step
    and returns the risk-neutral probability of the UP contract (spot_T > strike) in percentage.

    SDE: dS_t = mu * S_t * dt + sigma * S_t * dW_t + S_t * (J_t - 1) * dN_t
    """
    if time_to_expiry_mins <= 0:
        return 100.0 if spot > strike else 0.0

    tau = time_to_expiry_mins / 525960.0  # minutes to years (365.25 * 24 * 60)

    # 1. Poisson jumps
    jumps_count = np.random.poisson(jump_lambda * tau, size=paths)

    # 2. Sum of log jump sizes (Normally distributed if jumps occur)
    log_jump_sum = np.zeros(paths)
    has_jumps = jumps_count > 0
    if np.any(has_jumps):
        n_jumps = jumps_count[has_jumps]
        log_jump_sum[has_jumps] = np.random.normal(
            loc=n_jumps * jump_mu,
            scale=np.sqrt(n_jumps) * jump_sigma
        )

    # 3. Diffusion part (Wiener process)
    diffusion = np.random.normal(
        loc=0.0,
        scale=volatility * np.sqrt(tau),
        size=paths
    )

    # 4. Risk-neutral drift adjustment (Martingale condition)
    # E[e^Y - 1] where Y ~ N(jump_mu, jump_sigma^2)
    expected_jump_size = np.exp(jump_mu + 0.5 * jump_sigma**2) - 1.0
    drift_adj = drift_annualized - 0.5 * (volatility**2) - jump_lambda * expected_jump_size

    # 5. Simulate terminal prices
    log_spot_T = np.log(spot) + drift_adj * tau + diffusion + log_jump_sum
    spot_T = np.exp(log_spot_T)

    # 6. Calculate probability of settling above strike
    prob_up = float(np.mean(spot_T > strike) * 100.0)
    return prob_up


def price_binary_down(
    spot: float,
    strike: float,
    volatility: float,
    time_to_expiry_mins: float,
    drift_annualized: float = 0.0,
    jump_lambda: float = 120.0,
    jump_mu: float = 0.0,
    jump_sigma: float = 0.02,
    paths: int = 100000
) -> float:
    """
    Returns the risk-neutral probability of the DOWN contract (spot_T <= strike) in percentage.
    """
    prob_up = price_binary_up(
        spot=spot,
        strike=strike,
        volatility=volatility,
        time_to_expiry_mins=time_to_expiry_mins,
        drift_annualized=drift_annualized,
        jump_lambda=jump_lambda,
        jump_mu=jump_mu,
        jump_sigma=jump_sigma,
        paths=paths
    )
    return 100.0 - prob_up


def compare_to_market(
    model_prob: float,
    market_price_cents: float
) -> Dict[str, float]:
    """
    Calculates the statistical edge for the UP (YES) and DOWN (NO) contracts.

    Args:
        model_prob: Model's probability of YES contract (0.0 to 100.0).
        market_price_cents: Market price of YES contract in cents (0.0 to 100.0).
    """
    edge_yes = model_prob - market_price_cents
    edge_no = (100.0 - model_prob) - (100.0 - market_price_cents)
    
    return {
        "edge_yes": float(edge_yes),
        "edge_no": float(edge_no)
    }
