"""
shared/journal.py — SQLite-backed trade journal.

Persists every closed Trade and provides query helpers for analytics.
Schema is created on first use; migrations are append-only.

Thread/async safe: all writes go through a single asyncio.Lock.
Use Journal.open(path) as an async context manager.

Tables:
  trades       — one row per closed trade
  model_stats  — materialized per-model stats snapshot (updated on each write)
  daily_pnl    — daily P&L rollups
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator, Optional

from shared.types import (
    DailyMetrics, Direction, ModelName, ModelStats, Regime, Trade,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_CREATE_TRADES = """
CREATE TABLE IF NOT EXISTS trades (
    trade_id          TEXT PRIMARY KEY,
    market_id         TEXT NOT NULL,
    asset             TEXT NOT NULL,
    direction         TEXT NOT NULL,
    model             TEXT,
    regime            TEXT NOT NULL,
    entry_time        TEXT NOT NULL,
    exit_time         TEXT NOT NULL,
    entry_price       REAL NOT NULL,
    exit_price        REAL NOT NULL,
    size              REAL NOT NULL,
    raw_pnl           REAL NOT NULL,
    fees              REAL NOT NULL,
    slippage          REAL NOT NULL,
    net_pnl           REAL NOT NULL,
    win               INTEGER NOT NULL,
    signal_strength   REAL DEFAULT 0.0,
    is_copy           INTEGER DEFAULT 0,
    master_trade_id   TEXT,
    master_entry_price REAL,
    copy_divergence   REAL
);
"""

_CREATE_TRADES_IDX = """
CREATE INDEX IF NOT EXISTS idx_trades_asset_time ON trades (asset, entry_time);
CREATE INDEX IF NOT EXISTS idx_trades_model ON trades (model);
CREATE INDEX IF NOT EXISTS idx_trades_date ON trades (date(entry_time));
"""

_INSERT_TRADE = """
INSERT INTO trades (
    trade_id, market_id, asset, direction, model, regime,
    entry_time, exit_time, entry_price, exit_price, size,
    raw_pnl, fees, slippage, net_pnl, win,
    signal_strength, is_copy, master_trade_id, master_entry_price, copy_divergence
) VALUES (
    :trade_id, :market_id, :asset, :direction, :model, :regime,
    :entry_time, :exit_time, :entry_price, :exit_price, :size,
    :raw_pnl, :fees, :slippage, :net_pnl, :win,
    :signal_strength, :is_copy, :master_trade_id, :master_entry_price, :copy_divergence
)
"""


def _trade_to_row(t: Trade) -> dict:
    return {
        "trade_id": t.trade_id,
        "market_id": t.market_id,
        "asset": t.asset,
        "direction": t.direction.value,
        "model": t.model.value if t.model else None,
        "regime": t.regime.value,
        "entry_time": t.entry_time.isoformat(),
        "exit_time": t.exit_time.isoformat(),
        "entry_price": t.entry_price,
        "exit_price": t.exit_price,
        "size": t.size,
        "raw_pnl": t.raw_pnl,
        "fees": t.fees,
        "slippage": t.slippage,
        "net_pnl": t.net_pnl,
        "win": int(t.win),
        "signal_strength": t.signal_strength,
        "is_copy": int(t.is_copy),
        "master_trade_id": t.master_trade_id,
        "master_entry_price": t.master_entry_price,
        "copy_divergence": t.copy_divergence,
    }


def _row_to_trade(row: sqlite3.Row) -> Trade:
    return Trade(
        trade_id=row["trade_id"],
        market_id=row["market_id"],
        asset=row["asset"],
        direction=Direction(row["direction"]),
        model=ModelName(row["model"]) if row["model"] else None,
        regime=Regime(row["regime"]),
        entry_time=datetime.fromisoformat(row["entry_time"]),
        exit_time=datetime.fromisoformat(row["exit_time"]),
        entry_price=row["entry_price"],
        exit_price=row["exit_price"],
        size=row["size"],
        raw_pnl=row["raw_pnl"],
        fees=row["fees"],
        slippage=row["slippage"],
        net_pnl=row["net_pnl"],
        win=bool(row["win"]),
        signal_strength=row["signal_strength"] or 0.0,
        is_copy=bool(row["is_copy"]),
        master_trade_id=row["master_trade_id"],
        master_entry_price=row["master_entry_price"],
        copy_divergence=row["copy_divergence"],
    )


# ---------------------------------------------------------------------------
# Journal class
# ---------------------------------------------------------------------------

class Journal:
    """
    Async-safe SQLite trade journal.

    Example:
        async with Journal.open("trades.db") as journal:
            await journal.record(trade)
            stats = await journal.model_stats()
    """

    def __init__(self, db_path: str | Path) -> None:
        self._path = Path(db_path)
        self._lock = asyncio.Lock()
        self._conn: Optional[sqlite3.Connection] = None

    # ------------------------------------------------------------------
    # Context manager
    # ------------------------------------------------------------------

    @classmethod
    @asynccontextmanager
    async def open(cls, db_path: str | Path) -> AsyncIterator["Journal"]:
        journal = cls(db_path)
        await journal._init()
        try:
            yield journal
        finally:
            journal.close()

    async def _init(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self._path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(_CREATE_TRADES + _CREATE_TRADES_IDX)
        self._conn.commit()
        logger.info("Journal opened at %s", self._path)

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------

    async def record(self, trade: Trade) -> None:
        """Insert one closed trade.  Silently ignores duplicates."""
        async with self._lock:
            if self._conn is None:
                raise RuntimeError("Journal is not open")
            try:
                self._conn.execute(_INSERT_TRADE, _trade_to_row(trade))
                self._conn.commit()
                logger.debug("Recorded trade %s net_pnl=%.2f", trade.trade_id, trade.net_pnl)
            except sqlite3.IntegrityError:
                logger.debug("Duplicate trade %s — skipped", trade.trade_id)

    async def record_many(self, trades: list[Trade]) -> None:
        async with self._lock:
            if self._conn is None:
                raise RuntimeError("Journal is not open")
            self._conn.executemany(_INSERT_TRADE, [_trade_to_row(t) for t in trades])
            self._conn.commit()

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------

    async def get_all(
        self,
        asset: Optional[str] = None,
        model: Optional[ModelName] = None,
        since: Optional[datetime] = None,
        until: Optional[datetime] = None,
        is_copy: Optional[bool] = None,
        limit: int = 1000,
    ) -> list[Trade]:
        filters, params = [], []
        if asset:
            filters.append("asset = ?")
            params.append(asset)
        if model:
            filters.append("model = ?")
            params.append(model.value)
        if since:
            filters.append("entry_time >= ?")
            params.append(since.isoformat())
        if until:
            filters.append("entry_time <= ?")
            params.append(until.isoformat())
        if is_copy is not None:
            filters.append("is_copy = ?")
            params.append(int(is_copy))

        where = ("WHERE " + " AND ".join(filters)) if filters else ""
        sql = f"SELECT * FROM trades {where} ORDER BY entry_time DESC LIMIT {limit}"

        async with self._lock:
            if self._conn is None:
                return []
            rows = self._conn.execute(sql, params).fetchall()
        return [_row_to_trade(r) for r in rows]

    async def model_stats(
        self,
        since: Optional[datetime] = None,
    ) -> list[ModelStats]:
        """Return per-model performance stats."""
        where = ""
        params: list = []
        if since:
            where = "WHERE entry_time >= ?"
            params.append(since.isoformat())

        sql = f"""
        SELECT
            model,
            COUNT(*)                                          AS trade_count,
            SUM(win)                                          AS win_count,
            AVG(CAST(win AS REAL))                            AS win_rate,
            AVG(CASE WHEN win = 1 THEN net_pnl ELSE NULL END) AS avg_win,
            AVG(CASE WHEN win = 0 THEN net_pnl ELSE NULL END) AS avg_loss,
            SUM(net_pnl)                                      AS total_pnl
        FROM trades
        {where}
        GROUP BY model
        """
        async with self._lock:
            if self._conn is None:
                return []
            rows = self._conn.execute(sql, params).fetchall()

        stats = []
        for r in rows:
            avg_win = r["avg_win"] or 0.0
            avg_loss = abs(r["avg_loss"] or 0.0)
            profit_factor = (avg_win / avg_loss) if avg_loss > 1e-12 else 0.0
            stats.append(ModelStats(
                model=ModelName(r["model"]) if r["model"] else ModelName.KC_REVERSION,
                trade_count=r["trade_count"],
                win_count=r["win_count"],
                win_rate=r["win_rate"] or 0.0,
                avg_win=avg_win,
                avg_loss=avg_loss,
                profit_factor=profit_factor,
                total_pnl=r["total_pnl"] or 0.0,
            ))
        return stats

    async def daily_pnl(
        self,
        since: Optional[datetime] = None,
        days: int = 30,
    ) -> list[dict]:
        """Return daily P&L rollups as list of {date, net_pnl, trade_count, win_rate}."""
        where = ""
        params: list = []
        if since:
            where = "WHERE entry_time >= ?"
            params.append(since.isoformat())

        sql = f"""
        SELECT
            date(entry_time) AS date,
            SUM(net_pnl)     AS net_pnl,
            COUNT(*)         AS trade_count,
            AVG(CAST(win AS REAL)) AS win_rate
        FROM trades
        {where}
        GROUP BY date(entry_time)
        ORDER BY date DESC
        LIMIT {days}
        """
        async with self._lock:
            if self._conn is None:
                return []
            rows = self._conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    async def today_count(self) -> int:
        """Number of trades completed today (UTC date)."""
        sql = "SELECT COUNT(*) FROM trades WHERE date(entry_time) = date('now')"
        async with self._lock:
            if self._conn is None:
                return 0
            return self._conn.execute(sql).fetchone()[0]

    async def today_pnl(self) -> float:
        """Net P&L for today (UTC)."""
        sql = "SELECT COALESCE(SUM(net_pnl), 0) FROM trades WHERE date(entry_time) = date('now')"
        async with self._lock:
            if self._conn is None:
                return 0.0
            return float(self._conn.execute(sql).fetchone()[0])

    async def export_csv(self, path: str | Path) -> None:
        """Export all trades to a CSV file."""
        import csv
        trades = await self.get_all(limit=100_000)
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", newline="") as f:
            if not trades:
                return
            writer = csv.DictWriter(f, fieldnames=_trade_to_row(trades[0]).keys())
            writer.writeheader()
            writer.writerows(_trade_to_row(t) for t in trades)
        logger.info("Exported %d trades to %s", len(trades), path)


# ---------------------------------------------------------------------------
# Trade factory helper (used by order engine to build Trade on close)
# ---------------------------------------------------------------------------

def build_trade(
    *,
    market_id: str,
    asset: str,
    direction: Direction,
    model: Optional[ModelName],
    regime: Regime,
    entry_time: datetime,
    exit_time: datetime,
    entry_price: float,
    exit_price: float,
    size_usd: float,
    fee_rate: float = 0.02,
    slippage_bps: float = 3.0,
    signal_strength: float = 0.0,
    is_copy: bool = False,
    master_trade_id: Optional[str] = None,
    master_entry_price: Optional[float] = None,
) -> Trade:
    """Compute P&L components and build a Trade record."""
    # Polymarket binary: UP wins at $1.00, DOWN wins at $1.00
    # Raw P&L = (exit_price - entry_price) / entry_price * size_usd
    raw_pnl = (exit_price - entry_price) / entry_price * size_usd
    fees = fee_rate * size_usd
    slippage = (slippage_bps / 10_000) * size_usd
    net_pnl = raw_pnl - fees - slippage

    return Trade(
        trade_id=str(uuid.uuid4()),
        market_id=market_id,
        asset=asset,
        direction=direction,
        model=model,
        regime=regime,
        entry_time=entry_time,
        exit_time=exit_time,
        entry_price=entry_price,
        exit_price=exit_price,
        size=size_usd,
        raw_pnl=raw_pnl,
        fees=fees,
        slippage=slippage,
        net_pnl=net_pnl,
        win=exit_price > entry_price,
        signal_strength=signal_strength,
        is_copy=is_copy,
        master_trade_id=master_trade_id,
        master_entry_price=master_entry_price,
        copy_divergence=(
            abs(entry_price - master_entry_price) if master_entry_price else None
        ),
    )
