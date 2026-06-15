# F Systematica

**Fully Autonomous Multi-Agent HMM Trading System**

Built on top of the proven HMM Jump Hybrid strategy.

## Status
🔴 Phase 1 — In Planning

## Quick Start
```bash
python main.py --paper   # Paper trading mode
python main.py --live    # Live mode (requires config.yaml: live_mode: true)
```

## Agents
| Agent | Role |
|---|---|
| `MarketDataAgent` | Live OHLCV fetcher (1m/5m/15m) |
| `RegimeEngine` | HMM 4-state classifier |
| `SignalAgent` | Entry/exit signal generation |
| `ExecutionAgent` | Order routing + P&L tracking |
| `RiskGuardAgent` | Drawdown kill-switch |
| `ReportingAgent` | Daily MD performance reports |

## Performance Baseline (Backtest)
- **Symbol**: BTC, 1 Year, 5m intervals
- **Return**: $10,000 → $9.76M
- **Win Rate**: 52.95%
- **Max Drawdown**: $7,070

See `implementation_plan.md` for full build roadmap.
