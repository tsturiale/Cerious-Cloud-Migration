import numpy as np
import math
from typing import Tuple

class BatesEngine:
    """
    Bates Model Engine (Heston Stochastic Volatility + Merton Jump-Diffusion Hybrid).
    Used for pricing short-term binary options in prediction markets.
    """
    def __init__(
        self,
        S0: float,
        v0: float,
        kappa: float,
        theta: float,
        xi: float,
        rho: float,
        lam: float,
        mu_j: float,
        sigma_j: float,
        r: float = 0.0
    ):
        self.S0 = S0
        self.v0 = v0
        self.kappa = kappa
        self.theta = theta
        self.xi = xi
        self.rho = rho
        self.lam = lam
        self.mu_j = mu_j
        self.sigma_j = sigma_j
        self.r = r

    def price_binary_up(self, T: float, strike: float = None, n_paths: int = 50000, n_steps: int = 10) -> Tuple[float, float]:
        """
        Prices a binary UP contract (pays $1 if S_T > strike).
        Returns: (probability_estimate, standard_error)
        """
        if strike is None:
            strike = self.S0

        # Discretization step
        dt = T / n_steps
        sqrt_dt = math.sqrt(dt)

        # Pre-compute jump parameters
        # Risk-neutral jump expectation adjustment
        k_j = math.exp(self.mu_j + 0.5 * self.sigma_j**2) - 1.0
        drift_adj = self.r - self.lam * k_j

        # Simulate paths using Euler-Maruyama
        S = np.full(n_paths, self.S0, dtype=np.float64)
        v = np.full(n_paths, self.v0, dtype=np.float64)

        for _ in range(n_steps):
            v_pos = np.maximum(v, 0.0)
            
            # Correlated brownian motions
            Z1 = np.random.normal(0.0, 1.0, n_paths)
            Z2 = np.random.normal(0.0, 1.0, n_paths)
            Zv = Z1
            Zs = self.rho * Z1 + math.sqrt(1.0 - self.rho**2) * Z2

            # 1. Update volatility path
            v = v + self.kappa * (self.theta - v_pos) * dt + self.xi * np.sqrt(v_pos) * sqrt_dt * Zv
            v = np.maximum(v, 1e-8)  # Reflection boundary

            # 2. Simulate jumps
            # Jumps drawn from a Poisson distribution
            jumps = np.random.poisson(self.lam * dt, n_paths)
            
            # Log-jump sizes
            log_jump_sum = np.zeros(n_paths, dtype=np.float64)
            has_jumps = jumps > 0
            if np.any(has_jumps):
                # Sum of log-normal jumps J ~ N(jumps * mu_j, jumps * sigma_j^2)
                n_jumps = jumps[has_jumps]
                log_jump_sum[has_jumps] = np.random.normal(
                    n_jumps * self.mu_j,
                    np.sqrt(n_jumps) * self.sigma_j
                )

            # 3. Update stock price path
            S = S * np.exp((drift_adj - 0.5 * v_pos) * dt + np.sqrt(v_pos) * sqrt_dt * Zs + log_jump_sum)

        # Payoff calculation (pays $1 if S_T > strike)
        payoffs = (S > strike).astype(np.float64)
        prob = float(np.mean(payoffs))
        se = float(np.std(payoffs) / math.sqrt(n_paths))

        return prob, se

    def price_binary_down(self, T: float, strike: float = None, n_paths: int = 50000, n_steps: int = 10) -> Tuple[float, float]:
        """
        Prices a binary DOWN contract (pays $1 if S_T <= strike).
        Returns: (probability_estimate, standard_error)
        """
        prob_up, se = self.price_binary_up(T=T, strike=strike, n_paths=n_paths, n_steps=n_steps)
        return 1.0 - prob_up, se
