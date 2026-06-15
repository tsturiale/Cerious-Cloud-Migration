"""
main.py — F Systematica Entry Point

Usage:
    python main.py --paper          # Live Binance data, paper execution
    python main.py --backtest       # Run against local CSV portfolio data
    python main.py --live           # Live Polymarket execution (requires config.yaml live_mode: true)

Backtest quick-start:
    python main.py --backtest --symbols BTC ETH --start 2024-01-01
"""

import sys
import os
import argparse
import logging
import yaml

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

# ─── Logging ──────────────────────────────────────────────────────────────────
os.makedirs(os.path.join(_HERE, "reports"), exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(os.path.join(_HERE, "reports", "f_systematica.log"), mode="a", encoding="utf-8")
    ]
)
logger = logging.getLogger("FSystematica")


def load_config(path: str = None) -> dict:
    path = path or os.path.join(_HERE, "core", "config.yaml")
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def run_backtest(cfg: dict, symbols: list, start: str, end: str, warmup: int):
    from backtest_runner import FSystematicaBacktest
    runner = FSystematicaBacktest(cfg=cfg, symbols=symbols, start=start, end=end, warmup_bars=warmup)
    runner.run()


def run_paper(cfg: dict, symbols: list):
    """Live Binance data, paper execution mode."""
    from core.state_store import StateStore, BarState
    from agents.atr_engine import ATREngine
    from agents.market_data_agent import MarketDataAgent, compute_vwap
    from agents.hmm_regime_engine import HMMRegimeEngine
    from agents.strategy_alpha import StrategyAlpha
    from agents.strategy_beta import StrategyBeta
    from agents.strategy_gamma import StrategyGamma
    from agents.strategy_theta_sniper import StrategyThetaSniper
    from agents.risk_guard_agent import RiskGuardAgent
    from agents.reporting_agent import ReportingAgent

    store = StateStore()
    store.portfolio.bankroll = cfg["capital"]["initial_bankroll"]
    store.portfolio.peak_bankroll = store.portfolio.bankroll

    from agents.exit_agent import ExitAgent
    exit_agent = ExitAgent(cfg, store, None) # execution_agent assigned below
    from agents.execution_agent import ExecutionAgent
    execution_agent = ExecutionAgent(cfg, store, exit_agent)
    exit_agent.execution_agent = execution_agent
    exit_agent.start() # Start 2s heartbeat

    atr_engine = ATREngine(cfg, store)
    hmm_engine = HMMRegimeEngine(cfg, store)
    alpha = StrategyAlpha(symbols, cfg, store, atr_engine, execution_agent)
    beta = StrategyBeta(symbols, cfg, store, atr_engine, execution_agent)
    gamma = StrategyGamma(symbols, cfg, store, execution_agent)
    theta_sniper = StrategyThetaSniper(symbols, cfg, store, atr_engine, execution_agent)
    risk = RiskGuardAgent(cfg, store)
    reporter = ReportingAgent(cfg, store, output_dir=os.path.join(_HERE, "reports"))

    def on_bar(symbol, bar: BarState):
        # 1. Intra-bar management (Scale-outs, SL, TS)
        exit_agent.process_exits()
        
        # 2. Engines
        atr_engine.update(symbol, bar.high, bar.low, bar.close)
        hmm_engine.on_bar(symbol, bar.high, bar.low, bar.close, bar.volume,
                          __import__("pandas").Timestamp.fromtimestamp(bar.timestamp))
        
        # 3. Strategy logic
        if atr_engine.is_warm(symbol):
            alpha.on_bar(symbol, bar)
            beta.on_bar(symbol, bar)
            gamma.on_bar(symbol, bar)
            theta_sniper.on_bar(symbol, bar)
        risk.check()

    data_agent = MarketDataAgent(
        symbols=symbols, cfg=cfg, store=store,
        on_bar_callback=on_bar
    )

    logger.info("F Systematica PAPER mode starting...")
    data_agent.run_live()


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="F Systematica — 3-Strategy HMM Trading Agent System"
    )
    mode_grp = parser.add_mutually_exclusive_group(required=True)
    mode_grp.add_argument("--paper", action="store_true", help="Paper trading (live Binance data)")
    mode_grp.add_argument("--backtest", action="store_true", help="Backtest against CSV data")
    mode_grp.add_argument("--live", action="store_true", help="Live execution (Polymarket)")

    parser.add_argument("--symbols", nargs="+", default=["BTC", "ETH", "SOL", "XRP"])
    parser.add_argument("--start", type=str, default=None, help="Backtest start: YYYY-MM-DD")
    parser.add_argument("--end", type=str, default=None, help="Backtest end: YYYY-MM-DD")
    parser.add_argument("--warmup", type=int, default=300, help="Warm-up bars (default: 300)")
    parser.add_argument("--config", type=str, default=None)
    args = parser.parse_args()

    cfg = load_config(args.config)

    print(f"""
==============================================
    F  S Y S T E M A T I C A
  3-Strategy HMM Agent System
  Alpha (35%) . Beta (35%) . Gamma (30%)
==============================================
Mode:    {'BACKTEST' if args.backtest else 'PAPER' if args.paper else 'LIVE'}
Symbols: {', '.join(args.symbols)}
Capital: ${cfg['capital']['initial_bankroll']:,.0f}
""")

    if args.backtest:
        cfg["mode"]["backtest_mode"] = True
        cfg["mode"]["live_mode"] = False
        run_backtest(cfg, args.symbols, args.start, args.end, args.warmup)

    elif args.paper:
        cfg["mode"]["backtest_mode"] = False
        cfg["mode"]["live_mode"] = False
        run_paper(cfg, args.symbols)

    elif args.live:
        if not cfg.get("mode", {}).get("live_mode", False):
            logger.error("live_mode is not enabled in config.yaml. Set `live_mode: true` first.")
            sys.exit(1)
        run_paper(cfg, args.symbols)  # Same as paper but live_mode=True routes to Polymarket


if __name__ == "__main__":
    main()
