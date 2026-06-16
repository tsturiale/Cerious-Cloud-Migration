"""
backtest_runner.py
Runs all 3 F Systematica strategies against local CSV portfolio data.
Supports: BTC, ETH, SOL, XRP — 1-minute CSV files.

Usage:
    python backtest_runner.py                         # All 4 symbols, 1 year
    python backtest_runner.py --symbols BTC ETH       # Specific symbols
    python backtest_runner.py --start 2024-01-01      # Date range
    python backtest_runner.py --warmup 300            # Custom warm-up bars
"""

import sys
import os
import argparse
import logging
import yaml
import pandas as pd
import numpy as np
import time
from datetime import datetime

# ─── Path setup ───────────────────────────────────────────────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.abspath(os.path.join(_HERE, os.pardir))
sys.path.insert(0, _HERE)  # F Systematica root

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(os.path.join(_HERE, "reports", "backtest.log"), mode="w", encoding="utf-8")
    ]
)
logger = logging.getLogger("BacktestRunner")
os.makedirs(os.path.join(_HERE, "reports"), exist_ok=True)

# ─── F Systematica imports ────────────────────────────────────────────────────
from core.state_store import StateStore, BarState
from agents.atr_engine import ATREngine
from agents.market_data_agent import MarketDataAgent, compute_vwap
from agents.hmm_regime_engine import HMMRegimeEngine
from agents.strategy_alpha import StrategyAlpha
from agents.strategy_beta import StrategyBeta
from agents.strategy_gamma import StrategyGamma
from agents.risk_guard_agent import RiskGuardAgent
from agents.reporting_agent import ReportingAgent


def load_config(cfg_path: str = None) -> dict:
    cfg_path = cfg_path or os.path.join(_HERE, "core", "config.yaml")
    with open(cfg_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


class FSystematicaBacktest:
    """
    Full F Systematica backtest engine.
    Runs bar-by-bar through CSV data, emitting to all 3 strategies simultaneously.
    """

    def __init__(self, cfg: dict, symbols: list, start: str = None,
                 end: str = None, warmup_bars: int = 300):
        self.cfg = cfg
        self.symbols = symbols
        self.start = start
        self.end = end
        self.warmup_bars = warmup_bars
        self.data_dir = os.getenv("CERIOUS_CRYPTO_DATA_DIR", os.path.join(_PROJECT_ROOT, "data", "crypto"))

        # ── Initialize all agents ─────────────────────────────────────────────
        self.store = StateStore()
        self.store.portfolio.bankroll = cfg.get("capital", {}).get("initial_bankroll", 10000.0)
        self.store.portfolio.peak_bankroll = self.store.portfolio.bankroll

        from agents.exit_agent import ExitAgent
        self.exit_agent = ExitAgent(cfg, self.store, None)
        from agents.execution_agent import ExecutionAgent
        self.execution_agent = ExecutionAgent(cfg, self.store, self.exit_agent)
        self.exit_agent.execution_agent = self.execution_agent

        self.atr_engine = ATREngine(cfg, self.store)
        self.hmm_engine = HMMRegimeEngine(cfg, self.store)

        self.alpha = StrategyAlpha(symbols, cfg, self.store, self.atr_engine, self.execution_agent)
        self.beta = StrategyBeta(symbols, cfg, self.store, self.atr_engine, self.execution_agent)
        self.gamma = StrategyGamma(symbols, cfg, self.store, self.execution_agent)

        self.risk = RiskGuardAgent(cfg, self.store)
        report_dir = os.path.join(_HERE, "reports")
        self.reporter = ReportingAgent(cfg, self.store, output_dir=report_dir)

        # Market data agent (backtest mode)
        self.data_agent = MarketDataAgent(
            symbols=symbols, cfg=cfg, store=self.store, data_dir=self.data_dir
        )

        self._bar_count = 0
        self._start_time = None

    def _process_bar(self, symbol: str, row: pd.Series):
        """Process a single 1-minute bar through the full agent pipeline."""
        high = float(row.get("high", 0))
        low = float(row.get("low", 0))
        close = float(row.get("close", 0))
        volume = float(row.get("volume", 0))
        ts = pd.Timestamp(row.get("timestamp", pd.Timestamp.now()))

        # 1. Automatic Management (SL/TP/TS/Scale-out)
        # Check if High/Low hit any triggers during this bar
        bar_for_mgmt = BarState(symbol=symbol, high=high, low=low, close=close, timestamp=ts.timestamp())
        self.exit_agent.process_exits() # Global check across symbols/tf in store

        # 2. Update ATR
        atr_state = self.atr_engine.update(symbol, high, low, close)

        # 3. Update HMM
        self.hmm_engine.on_bar(symbol, high, low, close, volume, ts)

        # 4. Build BarState and push to store
        hist = self.store.get_bar_history(symbol, "1m", n=15)
        vwap = compute_vwap(hist) if hist else close
        bar = BarState(
            symbol=symbol, tf="1m",
            open=float(row.get("open", close)),
            high=high, low=low, close=close, volume=volume,
            vwap=vwap, timestamp=ts.timestamp()
        )
        self.store.update_bar(symbol, "1m", bar)

        # 5. Run strategies (only after warm-up) to open NEW positions
        if atr_engine_warm := self.atr_engine.is_warm(symbol):
            self.alpha.on_bar(symbol, bar)
            self.beta.on_bar(symbol, bar)
            self.gamma.on_bar(symbol, bar)

        # Increment bar count for this symbol tracking
        self._bar_count += 1

        # 6. Risk check after every bar
        self.risk.check()

    def run(self):
        """Main backtest loop."""
        self._start_time = time.time()
        logger.info(
            f"F Systematica Backtest Starting"
        )
        logger.info(f"Symbols: {self.symbols}")
        logger.info(f"Period:  {self.start or 'all'} -> {self.end or 'all'}")
        logger.info(f"Capital: ${self.cfg['capital']['initial_bankroll']:,.2f}")
        logger.info(f"Warmup:  {self.warmup_bars} bars")

        # Load all CSV data
        self.data_agent.load_backtest_data(start=self.start, end=self.end)

        # Get loaded dataframes
        dfs = {
            sym: self.data_agent.get_backtest_df(sym)
            for sym in self.symbols
            if self.data_agent.get_backtest_df(sym) is not None
        }

        if not dfs:
            logger.error("No data loaded! Check CSV paths.")
            return

        # Build unified time-aligned iteration
        # Convert to dictionary records for speed (iloc is slow in a loop)
        data_records = {
            sym: df.to_dict('records') for sym, df in dfs.items()
        }
        min_len = min(len(recs) for recs in data_records.values())
        logger.info(f"Running {min_len} bars per symbol ({min_len/60/24:.1f} trading days)")

        # Warm-up phase & HMM Precomputation
        for sym in self.symbols:
            if sym in dfs:
                df = dfs[sym]
                # Precompute HMM for the whole set (Ultimate speed optimization)
                self.hmm_engine.precompute_regimes(sym, df)
                
                # Seed ATR for warm-up
                warmup_df = df.head(self.warmup_bars)
                self.atr_engine.seed_from_df(sym, warmup_df)
            else:
                logger.warning(f"Symbol {sym} data not found, skipping HMM/ATR seeding.")

        # Main loop
        prev_day = None
        report_every = 50000   # bars between progress prints
        total_processed = 0

        for i in range(min_len):
            for sym in self.symbols:
                if sym not in data_records:
                    continue
                row = data_records[sym][i]

                # Day boundary reset
                ts = row.get("timestamp")
                if not isinstance(ts, pd.Timestamp):
                    ts = pd.Timestamp(ts)
                
                if prev_day is not None and ts.date() != prev_day:
                    self.risk.reset_for_new_day()
                prev_day = ts.date()

                self._process_bar(sym, row)
                total_processed += 1

            if total_processed % report_every == 0:
                snap = self.store.get_portfolio_snapshot()
                elapsed = time.time() - self._start_time
                bars_per_sec = total_processed / max(elapsed, 0.001)
                logger.info(
                    f"[{i}/{min_len}] "
                    f"Bank=${snap['bankroll']:,.0f} "
                    f"PnL=${snap['session_pnl']:,.0f} "
                    f"WR={snap['win_rate']:.1f}% "
                    f"DD={snap['drawdown_pct']:.2f}% "
                    f"({bars_per_sec:.0f} bars/s)"
                )

        # Final settlement of all remaining positions
        snap_final = self.store.get_bar(self.symbols[0], "1m")
        if snap_final:
            for sym in self.symbols:
                self.alpha.settle_positions(sym, snap_final.close, snap_final.timestamp)
                self.beta.settle_positions(sym, snap_final.close, snap_final.timestamp)
                self.gamma.settle_positions(sym, snap_final.close, snap_final.timestamp)

        # ── Final Report ──────────────────────────────────────────────────────
        elapsed = time.time() - self._start_time
        self._print_final_summary(elapsed, min_len)
        report_path = self.reporter.generate_report(
            symbol="+".join(self.symbols),
            session_label=f"{self.start or 'all'}_{self.end or 'end'}"
        )
        logger.info(f"Report saved: {report_path}")

    def _print_final_summary(self, elapsed: float, total_bars: int):
        snap = self.store.get_portfolio_snapshot()
        pnl_by_strat = self.store.strategy_pnl
        logger.info(f"\n{'='*60}")
        logger.info("F Systematica Backtest Complete")
        logger.info(f"{'='*60}")
        logger.info(f"Elapsed:       {elapsed:.1f}s ({total_bars/elapsed:.0f} bars/s)")
        logger.info(f"Total Bars:    {total_bars:,}")
        logger.info(f"Final Capital: ${snap['bankroll']:,.2f}")
        logger.info(f"Total PnL:     ${snap['session_pnl']:,.2f}")
        logger.info(f"Win Rate:      {snap['win_rate']:.2f}%")
        logger.info(f"Max Drawdown:  {snap['drawdown_pct']:.2f}%")
        logger.info(f"Trades:        {snap['trades_today']}")
        logger.info(f"  → Alpha:     ${pnl_by_strat.get('alpha', 0):,.2f}")
        logger.info(f"  → Beta:      ${pnl_by_strat.get('beta', 0):,.2f}")
        logger.info(f"  → Gamma:     ${pnl_by_strat.get('gamma', 0):,.2f}")
        logger.info(f"Kill Switch:   {snap['kill_switch_active']}")
        logger.info(f"{'='*60}\n")


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="F Systematica Backtest Runner")
    parser.add_argument("--symbols", nargs="+", default=["BTC", "ETH", "SOL", "XRP"],
                        help="Symbols to run (default: all 4)")
    parser.add_argument("--start", type=str, default=None,
                        help="Start date YYYY-MM-DD (default: all data)")
    parser.add_argument("--end", type=str, default=None,
                        help="End date YYYY-MM-DD (default: all data)")
    parser.add_argument("--warmup", type=int, default=300,
                        help="ATR+HMM warm-up bars (default: 300)")
    parser.add_argument("--config", type=str, default=None,
                        help="Path to config.yaml (default: core/config.yaml)")
    parser.add_argument("--alpha-only", action="store_true", help="Run Alpha strategy only")
    parser.add_argument("--beta-only", action="store_true", help="Run Beta strategy only")
    parser.add_argument("--gamma-only", action="store_true", help="Run Gamma strategy only")
    args = parser.parse_args()

    cfg = load_config(args.config)

    # Override strategy enables from CLI
    if args.alpha_only:
        cfg["alpha"]["enabled"] = True
        cfg["beta"]["enabled"] = False
        cfg["gamma"]["enabled"] = False
    elif args.beta_only:
        cfg["alpha"]["enabled"] = False
        cfg["beta"]["enabled"] = True
        cfg["gamma"]["enabled"] = False
    elif args.gamma_only:
        cfg["alpha"]["enabled"] = False
        cfg["beta"]["enabled"] = False
        cfg["gamma"]["enabled"] = True

    cfg["mode"]["backtest_mode"] = True
    cfg["mode"]["live_mode"] = False

    runner = FSystematicaBacktest(
        cfg=cfg,
        symbols=args.symbols,
        start=args.start,
        end=args.end,
        warmup_bars=args.warmup
    )
    runner.run()


if __name__ == "__main__":
    main()
