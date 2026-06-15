"""
agents/reporting_agent.py
Generates daily performance .md reports matching the .test.md format.
Optionally syncs to Google Sheets (reuses existing GoogleSheetConnector pattern).
"""

import os
import logging
import time
from datetime import datetime
from typing import Dict, List

from core.state_store import StateStore

logger = logging.getLogger("ReportingAgent")


class ReportingAgent:
    """
    Generates .md performance reports after each backtest or trading session.
    Output matches the .test.md table format for consistency with existing tools.
    """

    def __init__(self, cfg: dict, store: StateStore, output_dir: str = None):
        self.cfg = cfg
        self.store = store
        rep_cfg = cfg.get("reporting", {})
        self.output_dir = output_dir or rep_cfg.get("output_dir", "reports")
        self.gs_enabled = rep_cfg.get("google_sheets_enabled", False)
        self.gs_sheet_name = rep_cfg.get("google_sheet_name", "ASYM_Edge_Execution")
        self.credentials_path = rep_cfg.get("credentials_path", "")

        self._gs_connector = None
        if self.gs_enabled and self.credentials_path and os.path.exists(self.credentials_path):
            try:
                self._init_sheets()
            except Exception as e:
                logger.warning(f"Google Sheets init failed: {e} — running without Sheets.")

    def _init_sheets(self):
        """Initialize Google Sheets connector (reuses existing gspread pattern)."""
        import sys
        data_dir = r"C:\Users\trade\OneDrive\Desktop\Crypto Data"
        if data_dir not in sys.path:
            sys.path.insert(0, data_dir)
        try:
            import gspread
            from oauth2client.service_account import ServiceAccountCredentials
            scope = ["https://spreadsheets.google.com/feeds", "https://www.googleapis.com/auth/drive"]
            creds = ServiceAccountCredentials.from_json_keyfile_name(self.credentials_path, scope)
            client = gspread.authorize(creds)
            self._gs_connector = client.open(self.gs_sheet_name).get_worksheet(0)
            logger.info(f"Google Sheets connected: {self.gs_sheet_name}")
        except Exception as e:
            logger.warning(f"Sheets unavailable: {e}")

    def generate_report(self, symbol: str = "Portfolio", session_label: str = None) -> str:
        """
        Generate a markdown performance report and write to output_dir.
        Returns the filepath.
        """
        now = datetime.now()
        label = session_label or now.strftime("%Y-%m-%d")
        os.makedirs(self.output_dir, exist_ok=True)
        filepath = os.path.join(self.output_dir, f"{symbol}_{label}_report.md")

        snap = self.store.get_portfolio_snapshot()
        alpha_trades = self.store.strategy_trades.get("alpha", [])
        beta_trades = self.store.strategy_trades.get("beta", [])
        gamma_trades = self.store.strategy_trades.get("gamma", [])
        all_trades = alpha_trades + beta_trades + gamma_trades

        total_trades = len(all_trades)
        total_pnl = sum(t.get("pnl", 0) for t in all_trades)
        wins = [t for t in all_trades if t.get("pnl", 0) > 0]
        win_rate = len(wins) / max(total_trades, 1) * 100
        initial_bankroll = self.cfg.get("capital", {}).get("initial_bankroll", 10000.0)
        final_bankroll = snap["bankroll"]

        # Per-strategy stats
        def strat_stats(trades) -> dict:
            if not trades:
                return {"count": 0, "win_rate": 0, "pnl": 0}
            wins_st = [t for t in trades if t.get("pnl", 0) > 0]
            return {
                "count": len(trades),
                "win_rate": round(len(wins_st) / len(trades) * 100, 2),
                "pnl": round(sum(t.get("pnl", 0) for t in trades), 2),
            }

        st_alpha = strat_stats(alpha_trades)
        st_beta = strat_stats(beta_trades)
        st_gamma = strat_stats(gamma_trades)

        # Per-symbol stats
        symbol_stats: Dict[str, dict] = {}
        for t in all_trades:
            sym = t.get("symbol", "?")
            if sym not in symbol_stats:
                symbol_stats[sym] = {"count": 0, "wins": 0, "pnl": 0.0}
            symbol_stats[sym]["count"] += 1
            symbol_stats[sym]["pnl"] += t.get("pnl", 0)
            if t.get("pnl", 0) > 0:
                symbol_stats[sym]["wins"] += 1

        # Recent trades (last 10)
        recent = sorted(all_trades, key=lambda t: t.get("entry_time", 0))[-10:]

        lines = [
            f"# F Systematica Performance Report",
            f"Generated on: {now.strftime('%Y-%m-%d %H:%M:%S')}",
            f"",
            f"## Summary Statistics",
            f"| Metric | Value |",
            f"|--------|-------|",
            f"| **Symbol** | {symbol} |",
            f"| **Session** | {label} |",
            f"| **Initial Bankroll** | ${initial_bankroll:,.2f} |",
            f"| **Final Bankroll** | ${final_bankroll:,.2f} |",
            f"| **Total Profit** | **${total_pnl:,.2f}** |",
            f"| **Total Trades** | {total_trades} |",
            f"| **Win Rate** | {win_rate:.2f}% |",
            f"| **Max Drawdown** | {snap['drawdown_pct']:.2f}% |",
            f"",
            f"## Performance by Strategy",
            f"| Strategy | Count | WinRate | TotalPNL |",
            f"| --- | --- | --- | --- |",
            f"| Alpha (Momentum) | {st_alpha['count']} | {st_alpha['win_rate']}% | ${st_alpha['pnl']:,.2f} |",
            f"| Beta (Reversion) | {st_beta['count']} | {st_beta['win_rate']}% | ${st_beta['pnl']:,.2f} |",
            f"| Gamma (Arbitrage) | {st_gamma['count']} | {st_gamma['win_rate']}% | ${st_gamma['pnl']:,.2f} |",
            f"",
            f"## Performance by Symbol",
            f"| Symbol | Count | WinRate | TotalPNL |",
            f"| --- | --- | --- | --- |",
        ]
        for sym, stats in symbol_stats.items():
            wr = round(stats["wins"] / max(stats["count"], 1) * 100, 2)
            lines.append(f"| {sym} | {stats['count']} | {wr}% | ${stats['pnl']:,.2f} |")

        lines += [
            f"",
            f"## Recent Trades Sample",
            f"| time | symbol | strategy | side | pnl | win |",
            f"| --- | --- | --- | --- | --- | --- |",
        ]
        for t in recent:
            ts = datetime.fromtimestamp(t.get("entry_time", 0)).strftime("%Y-%m-%d %H:%M") if t.get("entry_time") else "?"
            win = t.get("pnl", 0) > 0
            lines.append(f"| {ts} | {t.get('symbol','?')} | {t.get('strategy','?')} | "
                         f"{t.get('side','?')} | ${t.get('pnl',0):.2f} | {win} |")

        content = "\n".join(lines)
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)

        logger.info(f"Report written: {filepath}")

        # Push summary to Google Sheets
        if self._gs_connector:
            try:
                self._gs_connector.append_row([
                    label, symbol, f"${final_bankroll:,.2f}",
                    f"${total_pnl:,.2f}", total_trades,
                    f"{win_rate:.2f}%", f"{snap['drawdown_pct']:.2f}%"
                ])
            except Exception as e:
                logger.warning(f"Sheets append failed: {e}")

        return filepath

    def print_live_summary(self):
        """Print a concise one-line live status to console."""
        snap = self.store.get_portfolio_snapshot()
        strat_pnl = self.store.strategy_pnl
        logger.info(
            f"[REPORT] Bank=${snap['bankroll']:,.2f} | "
            f"PnL=${snap['session_pnl']:,.2f} | "
            f"DD={snap['drawdown_pct']:.2f}% | WR={snap['win_rate']:.1f}% | "
            f"α=${strat_pnl.get('alpha',0):,.2f} β=${strat_pnl.get('beta',0):,.2f} γ=${strat_pnl.get('gamma',0):,.2f}"
        )
