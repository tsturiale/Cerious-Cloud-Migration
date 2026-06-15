"""
terminal/backend/core/hybrid_jump_binomial.py
=============================================
Hybrid Jump-Diffusion Binomial Tree pricing engine.
Optimized with NumPy to achieve sub-20ms pricing on CPU.

Supports:
1. Fast Hybrid SDE MC: Vectorized terminal-time simulation.
2. Discrete Lattice Sim: Step-by-step path-wise binomial simulation with log-normal jumps.
"""

import numpy as np
from typing import Tuple, Optional


class HybridJumpBinomialEngine:
    """
    A class that simulates Merton Jump-Diffusion paths using either:
    - An exact terminal SDE simulation (fast hybrid).
    - A step-by-step path-wise binomial lattice simulation.
    """

    def __init__(
        self,
        S0: float,
        r: float,
        sigma: float,
        lam: float,
        mu_j: float,
        sigma_j: float,
        T: float,
        n_steps: int = 30
    ):
        """
        Args:
            S0: Initial spot price.
            r: Annualized risk-free rate / drift.
            sigma: Annualized diffusion volatility.
            lam: Annualized jump intensity (lambda).
            mu_j: Mean of the log-jump size distribution.
            sigma_j: Standard deviation of the log-jump size distribution.
            T: Time to expiration in years.
            n_steps: Number of steps for the discrete lattice simulation.
        """
        self.S0 = S0
        self.r = r
        self.sigma = sigma
        self.lam = lam
        self.mu_j = mu_j
        self.sigma_j = sigma_j
        self.T = T
        self.n_steps = n_steps
        self.dt = T / max(1, n_steps)
        
        # Expected jump size factor: E[Y - 1] where Y = e^(Normal(mu_j, sigma_j^2))
        self.k = np.exp(mu_j + 0.5 * (sigma_j ** 2)) - 1.0

    def price_binary_up_mc_hybrid(
        self,
        threshold: float,
        n_paths: int = 50000,
        seed: Optional[int] = None
    ) -> Tuple[float, float]:
        """
        Calculates P(S_T > threshold) using exact terminal SDE simulation (fast hybrid).
        Returns a tuple: (probability_pct, standard_error_pct).
        """
        if self.T <= 0:
            prob = 100.0 if self.S0 > threshold else 0.0
            return prob, 0.0

        if seed is not None:
            np.random.seed(seed)

        # Risk-neutral drift adjustment
        mu_adj = self.r - 0.5 * (self.sigma ** 2) - self.lam * self.k

        # 1. Diffusion component (Wiener process)
        diffusion = self.sigma * np.sqrt(self.T) * np.random.normal(size=n_paths)

        # 2. Jump component
        # Number of jumps per path
        N = np.random.poisson(self.lam * self.T, size=n_paths)

        # Vectorized sum of log-jumps
        log_jump_sum = np.zeros(n_paths)
        has_jumps = N > 0
        if np.any(has_jumps):
            n_jumps = N[has_jumps]
            # Since the sum of n_jumps independent normal variables N(mu_j, sigma_j^2)
            # is normally distributed as N(n_jumps * mu_j, n_jumps * sigma_j^2)
            log_jump_sum[has_jumps] = np.random.normal(
                loc=n_jumps * self.mu_j,
                scale=np.sqrt(n_jumps) * self.sigma_j
            )

        # 3. Terminal stock prices
        log_ST = np.log(self.S0) + mu_adj * self.T + diffusion + log_jump_sum
        ST = np.exp(log_ST)

        # Payoff: 1 if ST > threshold else 0
        payoff = (ST > threshold).astype(float)
        price_pct = float(np.mean(payoff) * 100.0)
        se_pct = float(np.std(payoff) / np.sqrt(n_paths) * 100.0)

        return price_pct, se_pct

    def price_binary_up_lattice_sim(
        self,
        threshold: float,
        n_paths: int = 50000,
        seed: Optional[int] = None
    ) -> Tuple[float, float]:
        """
        Calculates P(S_T > threshold) using a discrete step-by-step path-wise binomial tree simulation.
        At each step, price changes by a CRR step or a log-normal jump.
        Returns a tuple: (probability_pct, standard_error_pct).
        """
        if self.T <= 0 or self.n_steps <= 0:
            prob = 100.0 if self.S0 > threshold else 0.0
            return prob, 0.0

        if seed is not None:
            np.random.seed(seed)

        dt = self.dt
        
        # CRR factors
        u = np.exp(self.sigma * np.sqrt(dt))
        d = np.exp(-self.sigma * np.sqrt(dt))
        
        # Risk-neutral probability of up move in diffusion step
        # E[S_{t+dt}/S_t] = (p_up * u + (1 - p_up) * d) * (1 + lambda * k * dt) = exp(r * dt)
        # So: p_up = (exp(r * dt) / (1 + lambda * k * dt) - d) / (u - d)
        num = np.exp(self.r * dt) / (1.0 + self.lam * self.k * dt) - d
        p_up = num / (u - d)
        p_up = np.clip(p_up, 0.0, 1.0)
        
        # Jump probability per step
        p_jump = self.lam * dt
        p_jump = np.clip(p_jump, 0.0, 1.0)

        # Generate paths step-by-step to simulate lattice diffusion + jump
        # To optimize speed, we generate binomial and Poisson jumps for all steps at once
        # shape: (n_steps, n_paths)
        rand_up = np.random.rand(self.n_steps, n_paths) < p_up
        rand_jump = np.random.rand(self.n_steps, n_paths) < p_jump
        
        # Step returns: Pre-fill with diffusion returns
        log_u = np.log(u)
        log_d = np.log(d)
        step_returns = np.where(rand_up, log_u, log_d)
        
        # Add jumps only where they occur (sparse generation)
        n_jumps = np.sum(rand_jump)
        if n_jumps > 0:
            jump_vals = np.random.normal(self.mu_j, self.sigma_j, size=n_jumps)
            step_returns[rand_jump] += jump_vals
        
        # Sum log returns over time steps
        log_ST = np.log(self.S0) + np.sum(step_returns, axis=0)
        ST = np.exp(log_ST)

        # Payoff
        payoff = (ST > threshold).astype(float)
        price_pct = float(np.mean(payoff) * 100.0)
        se_pct = float(np.std(payoff) / np.sqrt(n_paths) * 100.0)

        return price_pct, se_pct


def price_hybrid_binary_up(
    spot: float,
    strike: float,
    volatility: float,
    time_to_expiry_mins: float,
    drift_annualized: float = 0.0,
    jump_lambda: float = 120.0,
    jump_mu: float = 0.0,
    jump_sigma: float = 0.02,
    paths: int = 50000,
    n_steps: int = 30,
    use_lattice_sim: bool = False,
    seed: Optional[int] = 42
) -> float:
    """
    Convenience wrapper to price the binary UP option using HybridJumpBinomialEngine.
    Returns probability in percentage (0.0 to 100.0).
    """
    if time_to_expiry_mins <= 0:
        return 100.0 if spot > strike else 0.0

    T = time_to_expiry_mins / 525960.0  # minutes to years

    engine = HybridJumpBinomialEngine(
        S0=spot,
        r=drift_annualized,
        sigma=volatility,
        lam=jump_lambda,
        mu_j=jump_mu,
        sigma_j=jump_sigma,
        T=T,
        n_steps=n_steps
    )

    if use_lattice_sim:
        prob, _ = engine.price_binary_up_lattice_sim(threshold=strike, n_paths=paths, seed=seed)
    else:
        prob, _ = engine.price_binary_up_mc_hybrid(threshold=strike, n_paths=paths, seed=seed)

    return prob


def price_hybrid_binary_down(
    spot: float,
    strike: float,
    volatility: float,
    time_to_expiry_mins: float,
    drift_annualized: float = 0.0,
    jump_lambda: float = 120.0,
    jump_mu: float = 0.0,
    jump_sigma: float = 0.02,
    paths: int = 50000,
    n_steps: int = 30,
    use_lattice_sim: bool = False,
    seed: Optional[int] = 42
) -> float:
    """
    Convenience wrapper to price the binary DOWN option using HybridJumpBinomialEngine.
    Returns probability in percentage (0.0 to 100.0).
    """
    prob_up = price_hybrid_binary_up(
        spot=spot,
        strike=strike,
        volatility=volatility,
        time_to_expiry_mins=time_to_expiry_mins,
        drift_annualized=drift_annualized,
        jump_lambda=jump_lambda,
        jump_mu=jump_mu,
        jump_sigma=jump_sigma,
        paths=paths,
        n_steps=n_steps,
        use_lattice_sim=use_lattice_sim,
        seed=seed
    )
    return 100.0 - prob_up
