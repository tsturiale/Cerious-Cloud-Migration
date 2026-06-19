/**
 * PerformanceDashboard — main Performance tab.
 * Sections: 3-col type cards → KPI strip → equity curve canvas
 *           → breakdown tables → recent trades → JournalNotes
 */
import { useRef, useEffect, useMemo, useState } from 'react'
import type { Trade, DailyMetrics, JournalNote, DailyPerf } from '../types'
import { MODEL_LABELS } from '../types'
import { JournalNotes } from './JournalNotes'

interface Props {
  trades:  Trade[]
  metrics: DailyMetrics | null
  daily:   DailyPerf[]
  notes:   JournalNote[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function usd(n: number) {
  const s = Math.abs(n).toFixed(2)
  return (n >= 0 ? '+$' : '-$') + s
}
/** Format an entry/exit price. Binary market probabilities are 0-100, so
 *  display them as "65.4%". Spot prices > 100 are shown as a plain number. */
function fmtPrice(p: number): string {
  const clamped = Math.max(0, Math.min(100, p))
  return `${clamped.toFixed(1)}%`
}
function wrColor(wr: number | string) {
  const v = typeof wr === 'string' ? parseFloat(wr) : wr
  if (isNaN(v)) return 'text-muted'
  if (v >= 60) return 'text-emerald-400'
  if (v >= 40) return 'text-amber-400'
  return 'text-red-400'
}
function holdTime(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60)   return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

// Segment trades into Manual / Algo / Copy
function segmentTrades(trades: Trade[]) {
  return {
    manual: trades.filter(t => !t.is_copy && !t.model),
    algo:   trades.filter(t => !!t.model),
    copy:   trades.filter(t => t.is_copy),
  }
}

function tradeStats(ts: Trade[]) {
  const wins = ts.filter(t => t.win).length
  const net  = ts.reduce((s, t) => s + t.net_pnl, 0)
  const avg  = ts.length ? net / ts.length : 0
  const best = ts.reduce((b, t) => Math.max(b, t.net_pnl), -Infinity)
  const wr   = ts.length ? wins / ts.length * 100 : 0
  return { count: ts.length, wins, wr, net, avg, best: ts.length ? best : 0 }
}

// ── Type card ─────────────────────────────────────────────────────────────────
function TypeCard({ label, stats, color }: {
  label: string
  stats: ReturnType<typeof tradeStats>
  color: string
}) {
  return (
    <div className={`flex flex-col gap-1 p-3 rounded border ${color} bg-surface relative overflow-hidden`}>
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-current to-transparent opacity-60" />
      <span className="text-2xs font-bold tracking-widest uppercase text-muted">{label}</span>
      <div className="flex items-baseline gap-2">
        <span className="text-lg font-mono font-bold text-slate-200">{stats.count}</span>
        <span className="text-2xs text-muted font-mono">trades</span>
      </div>
      <div className="flex gap-3 flex-wrap">
        <span className={`text-xs font-mono font-bold ${wrColor(stats.wr)}`}>
          {stats.count ? stats.wr.toFixed(1) : '—'}% WR
        </span>
        <span
          className={`text-xs font-mono font-semibold ${stats.net >= 0 ? 'text-emerald-400' : 'text-red-400'}`}
          style={{ textShadow: stats.net >= 0 ? '0 0 8px rgba(0,212,164,0.5)' : '0 0 8px rgba(255,71,87,0.5)' }}
        >
          {usd(stats.net)}
        </span>
      </div>
      <div className="flex gap-3 text-2xs font-mono text-muted flex-wrap">
        <span>Avg {usd(stats.avg)}</span>
        <span>Best {stats.count ? usd(stats.best) : '—'}</span>
      </div>
    </div>
  )
}

// ── Equity curve canvas ───────────────────────────────────────────────────────
function EquityCurve({ trades }: { trades: Trade[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [show, setShow] = useState({ manual: true, algo: true, copy: true })
  const { manual, algo, copy } = segmentTrades(trades)

  function buildCurve(ts: Trade[]) {
    let eq = 0
    return ts
      .slice()
      .sort((a, b) => a.exit_time - b.exit_time)
      .map(t => { eq += t.net_pnl; return eq })
  }

  useEffect(() => {
    const cvs = canvasRef.current
    if (!cvs) return
    const ctx = cvs.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const W = cvs.clientWidth, H = cvs.clientHeight
    cvs.width = W * dpr; cvs.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    const curves: { data: number[]; color: string; active: boolean }[] = [
      { data: buildCurve(manual), color: '#00d4a4', active: show.manual },
      { data: buildCurve(algo),   color: '#60a5fa', active: show.algo   },
      { data: buildCurve(copy),   color: '#a855f7', active: show.copy   },
    ]

    const allPoints = curves.filter(c => c.active).flatMap(c => c.data)
    if (!allPoints.length) {
      ctx.fillStyle = '#4a5568'
      ctx.font = '11px Cascadia Mono, Consolas, monospace'
      ctx.textAlign = 'center'
      ctx.fillText('No trades yet', W / 2, H / 2)
      return
    }

    const maxV = Math.max(...allPoints, 1)
    const minV = Math.min(...allPoints, -1)
    const PL = 8, PR = 48, PT = 8, PB = 20
    const pW = W - PL - PR, pH = H - PT - PB
    const xOf = (i: number, n: number) => PL + (n <= 1 ? 0 : i / (n - 1)) * pW
    const yOf = (v: number) => PT + pH * (1 - (v - minV) / (maxV - minV))

    // Zero line
    const y0 = yOf(0)
    ctx.beginPath()
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = '#2d3a4e'
    ctx.lineWidth = 1
    ctx.moveTo(PL, y0); ctx.lineTo(PL + pW, y0)
    ctx.stroke(); ctx.setLineDash([])

    for (const { data, color, active } of curves) {
      if (!active || data.length < 2) continue
      // Fill
      ctx.beginPath()
      ctx.moveTo(xOf(0, data.length), yOf(data[0]))
      for (let i = 1; i < data.length; i++) ctx.lineTo(xOf(i, data.length), yOf(data[i]))
      ctx.lineTo(xOf(data.length - 1, data.length), y0)
      ctx.lineTo(xOf(0, data.length), y0)
      ctx.closePath()
      ctx.globalAlpha = 0.08
      ctx.fillStyle = color
      ctx.fill()
      ctx.globalAlpha = 1
      // Line
      ctx.beginPath()
      ctx.moveTo(xOf(0, data.length), yOf(data[0]))
      for (let i = 1; i < data.length; i++) ctx.lineTo(xOf(i, data.length), yOf(data[i]))
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.stroke()
      // Last value label
      const last = data[data.length - 1]
      ctx.fillStyle = color
      ctx.font = 'bold 9px Cascadia Mono, Consolas, monospace'
      ctx.textAlign = 'left'
      ctx.fillText((last >= 0 ? '+$' : '-$') + Math.abs(last).toFixed(0), PL + pW + 4, yOf(last) + 3)
    }
  }, [trades, show, manual, algo, copy])

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 px-1">
        <span className="text-2xs text-muted font-mono uppercase tracking-widest">Equity Curve</span>
        <div className="flex gap-1 ml-auto">
          {([
            { key: 'manual' as const, label: 'Manual', color: '#00d4a4' },
            { key: 'algo'   as const, label: 'Algo',   color: '#60a5fa' },
            { key: 'copy'   as const, label: 'Copy',   color: '#a855f7' },
          ]).map(({ key, label, color }) => (
            <button key={key}
              onClick={() => setShow(s => ({ ...s, [key]: !s[key] }))}
              className="px-1.5 py-0.5 rounded text-2xs font-mono font-bold border transition-opacity"
              style={{
                color, borderColor: color,
                opacity: show[key] ? 1 : 0.3,
                backgroundColor: show[key] ? `${color}15` : 'transparent',
              }}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <canvas ref={canvasRef} className="w-full rounded bg-[#080d19]" style={{ height: 140 }} />
    </div>
  )
}

// ── Breakdown tables ──────────────────────────────────────────────────────────
function BreakdownTables({ trades }: { trades: Trade[] }) {
  const byAsset = useMemo(() => {
    const m: Record<string, Trade[]> = {}
    for (const t of trades) { (m[t.asset] ??= []).push(t) }
    return Object.entries(m).map(([asset, ts]) => {
      const wins = ts.filter(t => t.win).length
      const net  = ts.reduce((s, t) => s + t.net_pnl, 0)
      return { asset, count: ts.length, wr: ts.length ? wins / ts.length * 100 : 0, net }
    }).sort((a, b) => b.net - a.net)
  }, [trades])

  const byModel = useMemo(() => {
    const m: Record<string, Trade[]> = {}
    for (const t of trades.filter(t => !!t.model)) { (m[t.model!] ??= []).push(t) }
    return Object.entries(m).map(([model, ts]) => {
      const wins = ts.filter(t => t.win).length
      const net  = ts.reduce((s, t) => s + t.net_pnl, 0)
      return { model, count: ts.length, wr: ts.length ? wins / ts.length * 100 : 0, net }
    }).sort((a, b) => b.net - a.net)
  }, [trades])

  const byRegime = useMemo(() => {
    const m: Record<string, Trade[]> = {}
    for (const t of trades) { (m[t.regime ?? 'unknown'] ??= []).push(t) }
    return Object.entries(m).map(([regime, ts]) => {
      const wins = ts.filter(t => t.win).length
      const net  = ts.reduce((s, t) => s + t.net_pnl, 0)
      return { regime, count: ts.length, wr: ts.length ? wins / ts.length * 100 : 0, net }
    }).sort((a, b) => b.count - a.count)
  }, [trades])

  const regimeColor: Record<string, string> = { low: 'text-emerald-400', medium: 'text-amber-400', high: 'text-red-400' }

  const TH = ({ children }: { children: string }) => (
    <th className="px-2 py-1 text-left text-2xs font-bold text-muted uppercase tracking-wide border-b border-surface-border">{children}</th>
  )
  const TD = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
    <td className={`px-2 py-1 text-2xs font-mono border-b border-surface-border/40 ${className}`}>{children}</td>
  )

  return (
    <div className="grid grid-cols-3 gap-2">
      {/* Per-Asset */}
      <div className="bg-surface rounded border border-surface-border overflow-auto">
        <div className="px-2 py-1 text-2xs font-bold text-muted uppercase tracking-widest border-b border-surface-border">By Asset</div>
        <table className="w-full">
          <thead><tr><TH>Asset</TH><TH>Trades</TH><TH>WR%</TH><TH>P&L</TH></tr></thead>
          <tbody>
            {byAsset.map(r => (
              <tr key={r.asset} className="hover:bg-surface-hover">
                <TD className="font-bold text-amber-400">{r.asset}</TD>
                <TD>{r.count}</TD>
                <TD className={wrColor(r.wr)}>{r.wr.toFixed(1)}%</TD>
                <TD className={r.net >= 0 ? 'text-emerald-400' : 'text-red-400'}>{usd(r.net)}</TD>
              </tr>
            ))}
            {!byAsset.length && <tr><td colSpan={4} className="px-2 py-2 text-2xs text-muted text-center">No data</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Per-Model */}
      <div className="bg-surface rounded border border-surface-border overflow-auto">
        <div className="px-2 py-1 text-2xs font-bold text-muted uppercase tracking-widest border-b border-surface-border">By Model (Algo)</div>
        <table className="w-full">
          <thead><tr><TH>Model</TH><TH>Trades</TH><TH>WR%</TH><TH>P&L</TH></tr></thead>
          <tbody>
            {byModel.map(r => (
              <tr key={r.model} className="hover:bg-surface-hover">
                <TD className="text-accent">
                  {MODEL_LABELS[r.model as keyof typeof MODEL_LABELS]?.split(' ').slice(0, 2).join(' ') ?? r.model}
                </TD>
                <TD>{r.count}</TD>
                <TD className={wrColor(r.wr)}>{r.wr.toFixed(1)}%</TD>
                <TD className={r.net >= 0 ? 'text-emerald-400' : 'text-red-400'}>{usd(r.net)}</TD>
              </tr>
            ))}
            {!byModel.length && <tr><td colSpan={4} className="px-2 py-2 text-2xs text-muted text-center">No algo trades</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Per-Regime */}
      <div className="bg-surface rounded border border-surface-border overflow-auto">
        <div className="px-2 py-1 text-2xs font-bold text-muted uppercase tracking-widest border-b border-surface-border">By Regime</div>
        <table className="w-full">
          <thead><tr><TH>Regime</TH><TH>Trades</TH><TH>WR%</TH><TH>P&L</TH></tr></thead>
          <tbody>
            {byRegime.map(r => (
              <tr key={r.regime} className="hover:bg-surface-hover">
                <TD className={regimeColor[r.regime] ?? 'text-slate-400'}>{r.regime}</TD>
                <TD>{r.count}</TD>
                <TD className={wrColor(r.wr)}>{r.wr.toFixed(1)}%</TD>
                <TD className={r.net >= 0 ? 'text-emerald-400' : 'text-red-400'}>{usd(r.net)}</TD>
              </tr>
            ))}
            {!byRegime.length && <tr><td colSpan={4} className="px-2 py-2 text-2xs text-muted text-center">No data</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Recent trades table ───────────────────────────────────────────────────────
function RecentTrades({ trades }: { trades: Trade[] }) {
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'MANUAL' | 'ALGO' | 'COPY'>('ALL')
  const [assetFilter, setAssetFilter] = useState('ALL')
  const ASSETS = ['ALL', 'BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'BNB', 'DOGE']

  const filtered = useMemo(() => {
    return trades
      .slice()
      .sort((a, b) => b.exit_time - a.exit_time)
      .slice(0, 50)
      .filter(t => {
        if (assetFilter !== 'ALL' && t.asset !== assetFilter) return false
        if (typeFilter === 'MANUAL' && (t.is_copy || !!t.model)) return false
        if (typeFilter === 'ALGO'   && !t.model)   return false
        if (typeFilter === 'COPY'   && !t.is_copy) return false
        return true
      })
  }, [trades, typeFilter, assetFilter])

  const typeBadge = (t: Trade) => {
    if (t.is_copy) return <span className="px-1 py-0.5 rounded text-2xs font-bold bg-purple-500/20 text-purple-400 border border-purple-500/30">COPY</span>
    if (t.model)   return <span className="px-1 py-0.5 rounded text-2xs font-bold bg-accent/20 text-accent border border-accent/30">ALGO</span>
    return           <span className="px-1 py-0.5 rounded text-2xs font-bold bg-slate-500/20 text-slate-400 border border-slate-500/30">MANUAL</span>
  }

  return (
    <div className="flex flex-col gap-1 flex-1 min-h-0">
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        <span className="text-2xs text-muted font-mono uppercase tracking-widest">Recent Trades (last 50)</span>
        <div className="flex gap-1 ml-auto flex-wrap">
          {(['ALL', 'MANUAL', 'ALGO', 'COPY'] as const).map(f => (
            <button key={f} onClick={() => setTypeFilter(f)}
              className={`px-1.5 py-0.5 rounded text-2xs font-mono font-bold border transition-colors ${
                typeFilter === f ? 'bg-accent/20 text-accent border-accent/40' : 'text-muted border-surface-border hover:text-slate-300'
              }`}>{f}</button>
          ))}
          <div className="w-px h-4 bg-surface-border self-center" />
          <select value={assetFilter} onChange={e => setAssetFilter(e.target.value)}
            className="bg-surface border border-surface-border rounded px-1 py-0.5 text-2xs font-mono text-slate-300">
            {ASSETS.map(a => <option key={a}>{a}</option>)}
          </select>
        </div>
      </div>
      <div className="overflow-auto rounded border border-surface-border flex-1" style={{ minHeight: 180 }}>
        <table className="w-full text-left border-collapse">
          <thead className="sticky top-0 bg-surface-panel">
            <tr>
              {['Time', 'Asset', 'Dir', 'Type', 'Model', 'Entry', 'Exit', 'Size', 'P&L', 'W/L'].map(h => (
                <th key={h} className="px-2 py-1 text-2xs font-bold text-muted uppercase tracking-wide border-b border-surface-border whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((t, i) => (
              <tr key={i} className="hover:bg-surface-hover border-b border-surface-border/30">
                <td className="px-2 py-0.5 text-2xs font-mono text-muted whitespace-nowrap">{new Date(t.exit_time).toLocaleString()}</td>
                <td className="px-2 py-0.5 text-2xs font-mono font-bold text-amber-400">{t.asset}</td>
                <td className="px-2 py-0.5">
                  <span className={`px-1 py-0.5 rounded text-2xs font-bold ${t.direction === 'UP' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>{t.direction}</span>
                </td>
                <td className="px-2 py-0.5">{typeBadge(t)}</td>
                <td className="px-2 py-0.5 text-2xs font-mono text-muted">
                  {t.model ? MODEL_LABELS[t.model]?.split(' ').slice(0, 2).join(' ') ?? t.model : '—'}
                </td>
                <td className="px-2 py-0.5 text-2xs font-mono">{fmtPrice(t.entry_price)}</td>
                <td className="px-2 py-0.5 text-2xs font-mono">{fmtPrice(t.exit_price)}</td>
                <td className="px-2 py-0.5 text-2xs font-mono">${t.size.toFixed(0)}</td>
                <td
                  className={`px-2 py-0.5 text-2xs font-mono font-bold ${t.net_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}
                  style={{ textShadow: t.net_pnl >= 0 ? '0 0 6px rgba(0,212,164,0.4)' : '0 0 6px rgba(255,71,87,0.4)' }}
                >
                  {usd(t.net_pnl)}
                </td>
                <td className="px-2 py-0.5">
                  <span className={`px-1 py-0.5 rounded text-2xs font-bold ${t.win ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>{t.win ? 'W' : 'L'}</span>
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr><td colSpan={10} className="px-2 py-4 text-2xs text-muted text-center font-mono">No trades match current filter</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────
export function PerformanceDashboard({ trades, metrics, daily, notes }: Props) {
  const { manual, algo, copy } = segmentTrades(trades)
  const manualStats = tradeStats(manual)
  const algoStats   = tradeStats(algo)
  const copyStats   = tradeStats(copy)

  // KPI strip
  const allWins = trades.filter(t => t.win).reduce((s, t) => s + t.net_pnl, 0)
  const allLoss = trades.filter(t => !t.win).reduce((s, t) => s + Math.abs(t.net_pnl), 0)
  const profitFactor = allLoss > 0 ? (allWins / allLoss).toFixed(2) : allWins > 0 ? '∞' : '—'
  const bestDay  = daily.length ? Math.max(...daily.map(d => d.net_pnl)) : null
  const worstDay = daily.length ? Math.min(...daily.map(d => d.net_pnl)) : null
  const avgHold  = trades.length
    ? holdTime(trades.reduce((s, t) => s + (t.exit_time - t.entry_time), 0) / trades.length)
    : '—'

  const KPI = ({ label, value, color = 'text-slate-300' }: { label: string; value: string; color?: string }) => (
    <div className="flex flex-col items-center gap-0.5 px-3 py-2 bg-surface rounded border border-surface-border">
      <span className="text-2xs text-muted font-mono uppercase tracking-widest">{label}</span>
      <span
        className={`text-sm font-mono font-bold ${color}`}
        style={{
          textShadow: color.includes('emerald') ? '0 0 10px rgba(0,212,164,0.5)' : color.includes('red') ? '0 0 10px rgba(255,71,87,0.5)' : undefined
        }}
      >
        {value}
      </span>
    </div>
  )

  const pfVal = parseFloat(profitFactor as string)

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Top fixed sections */}
      <div className="shrink-0 overflow-y-auto p-3 gap-3 flex flex-col" style={{ maxHeight: '55%' }}>
        {/* 3-col type cards */}
        <div className="grid grid-cols-3 gap-3">
          <TypeCard label="Manual" stats={manualStats} color="border-slate-600" />
          <TypeCard label="Algo"   stats={algoStats}   color="border-accent/40" />
          <TypeCard label="Copy"   stats={copyStats}   color="border-purple-500/40" />
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-6 gap-2">
          <KPI label="Sharpe"        value={metrics ? metrics.sharpe.toFixed(2) : '—'} color={metrics && metrics.sharpe >= 1 ? 'text-emerald-400' : 'text-amber-400'} />
          <KPI label="Max DD"        value={metrics ? `-$${Math.abs(metrics.max_drawdown).toFixed(2)}` : '—'} color="text-red-400" />
          <KPI label="Profit Factor" value={String(profitFactor)} color={!isNaN(pfVal) && pfVal >= 1.5 ? 'text-emerald-400' : 'text-amber-400'} />
          <KPI label="Best Day"      value={bestDay  !== null ? usd(bestDay)  : '—'} color="text-emerald-400" />
          <KPI label="Worst Day"     value={worstDay !== null ? usd(worstDay) : '—'} color="text-red-400" />
          <KPI label="Avg Hold"      value={avgHold} />
        </div>

        {/* Equity curve */}
        <EquityCurve trades={trades} />

        {/* Breakdown tables */}
        <BreakdownTables trades={trades} />
      </div>

      {/* Recent trades — fills remaining height */}
      <div className="flex-1 min-h-0 px-3 pb-1 flex flex-col border-t border-surface-border/40">
        <RecentTrades trades={trades} />
      </div>

      {/* Journal notes pinned at bottom */}
      <div className="shrink-0 px-3 pb-3">
        <JournalNotes notes={notes} />
      </div>
    </div>
  )
}
