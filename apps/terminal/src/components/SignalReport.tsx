import { useState, useEffect, useCallback } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, CartesianGrid, ReferenceLine,
} from 'recharts'
import type { ModelName, Trade } from '../types'
import { CANONICAL_MODEL_NAMES, MODEL_LABELS, MODEL_COLORS, normalizeModel } from '../types'

const API = '/api'


interface ModelReport {
  model: ModelName
  total_trades: number
  wins: number
  losses: number
  win_rate: number
  net_pnl: number
  best_trade: Trade | null
  worst_trade: Trade | null
  recent_trades: Trade[]
}

interface LiveSignal {
  timestamp: number
  asset: string
  model: ModelName
  direction: 'UP' | 'DOWN' | 'FLAT'
  strength: number
  regime: string
  zscore: number
  ofi: number
  vpin: number
}

interface ReportData {
  models: ModelReport[]
  live_signals: LiveSignal[]
  total_journal_trades: number
}

// Paper Trade types (mirrored from PaperTrade.tsx)
interface PaperRecord {
  id: string
  marketKey: string
  question: string
  side: 'yes' | 'no'
  entryPrice: number
  shares: number
  size: number
  entryTime: number
  source: 'manual' | 'signal' | 'backtest'
  model?: ModelName
  exitPrice: number
  exitTime: number
  pnl: number
  exitReason: 'manual' | 'stop' | 'take_profit' | 'rollover' | 'signal'
}

interface PaperLifetime {
  totalPnl: number
  wins: number
  count: number
  maxDrawdown: number
  peakPnl: number
}

// Build an equity curve from a list of ordered trades
function buildEquity(trades: Trade[]) {
  let equity = 0
  return trades.slice().reverse().map((t, i) => {
    equity += t.net_pnl
    return { i: i + 1, equity: +equity.toFixed(2) }
  })
}

// Sparkline for a model card
function SparkLine({ trades, pnl }: { trades: Trade[]; pnl: number }) {
  const data = buildEquity(trades)
  if (data.length < 2) {
    return (
      <div className="h-14 flex items-center justify-center text-muted text-2xs font-mono">
        No trades yet
      </div>
    )
  }
  const color = pnl >= 0 ? '#00d4a4' : '#ff4757'
  return (
    <ResponsiveContainer width="100%" height={56}>
      <AreaChart data={data} margin={{ top: 2, right: 2, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`sg-${pnl}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.25} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <ReferenceLine y={0} stroke="#2d3748" strokeDasharray="3 2" />
        <Area
          type="monotone"
          dataKey="equity"
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#sg-${pnl})`}
          dot={false}
          isAnimationActive={false}
        />
        <Tooltip
          content={({ active, payload }: any) => {
            if (!active || !payload?.length) return null
            const v = payload[0].value as number
            return (
              <div className="bg-surface-panel border border-surface-border rounded px-1.5 py-1 font-mono text-2xs">
                <span className={v >= 0 ? 'text-up' : 'text-down'}>${v.toFixed(2)}</span>
              </div>
            )
          }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

// Strength ring gauge
function StrengthRing({ strength }: { strength: number }) {
  const pct = Math.min(strength / 3, 1)
  const radius = 14
  const circumference = 2 * Math.PI * radius
  const strokeDash = circumference * pct
  return (
    <svg width="36" height="36" className="rotate-[-90deg]">
      <circle cx="18" cy="18" r={radius} fill="none" stroke="#1e2d4e" strokeWidth="3" />
      <circle
        cx="18" cy="18" r={radius}
        fill="none"
        stroke={strength >= 2 ? '#00d4a4' : strength >= 1 ? '#f59e0b' : '#64748b'}
        strokeWidth="3"
        strokeDasharray={`${strokeDash} ${circumference - strokeDash}`}
        strokeLinecap="round"
      />
      <text
        x="18" y="18"
        textAnchor="middle"
        dominantBaseline="central"
        fill="white"
        fontSize="9"
        fontFamily="monospace"
        transform="rotate(90, 18, 18)"
      >
        {strength.toFixed(1)}
      </text>
    </svg>
  )
}

// Per-model card
function ModelCard({
  report,
  liveSignals,
  onClick,
  selected,
  paperTradesForModel,
}: {
  report: ModelReport
  liveSignals: LiveSignal[]
  onClick: () => void
  selected: boolean
  paperTradesForModel: PaperRecord[]
}) {
  const color = MODEL_COLORS[report.model] ?? '#64748b'
  const label = MODEL_LABELS[report.model] ?? report.model
  const liveForModel = liveSignals.filter(s => s.model === report.model)
  const strongestLive = liveForModel.sort((a, b) => b.strength - a.strength)[0]

  const paperCount = paperTradesForModel.length
  const paperWins = paperTradesForModel.filter(t => t.pnl > 0).length
  const paperLosses = paperCount - paperWins
  const paperWr = paperCount > 0 ? (paperWins / paperCount) * 100 : 0
  const paperPnl = paperTradesForModel.reduce((s, t) => s + t.pnl, 0)
  const mappedPaperTrades = paperTradesForModel.map(t => ({ net_pnl: t.pnl } as any))

  return (
    <button
      onClick={onClick}
      className={`text-left rounded-xl border transition-all duration-200 p-4 flex flex-col gap-3
        ${selected
          ? 'border-accent/60 bg-accent/5 shadow-[0_0_24px_-4px_rgba(0,212,164,0.25)]'
          : 'border-surface-border bg-surface-panel hover:border-accent/30 hover:bg-surface-hover'
        }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <div
            className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-0.5"
            style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}60` }}
          />
          <div>
            <div className="text-xs font-bold text-slate-200 leading-tight">{label}</div>
            <div className="text-2xs text-muted font-mono mt-0.5">{report.model}</div>
          </div>
        </div>
        {strongestLive && (
          <div className="flex flex-col items-end gap-1">
            <span className={`tag text-2xs ${strongestLive.direction === 'UP' ? 'tag-up' : 'tag-down'}`}>
              {strongestLive.direction}
            </span>
            <StrengthRing strength={strongestLive.strength} />
          </div>
        )}
        {!strongestLive && (
          <span className="text-2xs text-muted font-mono px-1.5 py-0.5 rounded border border-surface-border">
            IDLE
          </span>
        )}
      </div>

      {/* Paper Stats row */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-surface rounded-lg p-2">
          <div className="text-2xs text-muted mb-0.5">Trades</div>
          <div className="text-sm font-mono font-bold text-slate-200">
            {paperCount}
          </div>
        </div>
        <div className="bg-surface rounded-lg p-2">
          <div className="text-2xs text-muted mb-0.5">Win Rate</div>
          <div className={`text-sm font-mono font-bold ${paperWr >= 50 ? 'text-up' : 'text-down'}`}>
            {paperCount > 0 ? `${paperWr.toFixed(0)}%` : '—'}
          </div>
        </div>
        <div className="bg-surface rounded-lg p-2">
          <div className="text-2xs text-muted mb-0.5">Net PnL</div>
          <div className={`text-sm font-mono font-bold ${paperPnl >= 0 ? 'text-up' : 'text-down'}`}>
            {paperPnl >= 0 ? '+' : ''}${paperPnl.toFixed(2)}
          </div>
        </div>
      </div>

      {/* Win/Loss bar */}
      {paperCount > 0 && (
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-surface">
            <div
              className="h-full bg-up rounded-full"
              style={{ width: `${paperWr}%` }}
            />
          </div>
          <span className="text-2xs font-mono text-up">{paperWins}W</span>
          <span className="text-2xs font-mono text-muted">/</span>
          <span className="text-2xs font-mono text-down">{paperLosses}L</span>
        </div>
      )}

      {/* Active assets */}
      {liveForModel.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {liveForModel.map((s, i) => (
            <span key={i} className="text-2xs font-mono bg-surface px-1.5 py-0.5 rounded border border-surface-border text-slate-400">
              {s.asset}
            </span>
          ))}
        </div>
      )}

      {/* Sparkline */}
      <SparkLine trades={mappedPaperTrades} pnl={paperPnl} />
    </button>
  )
}

// Trade table for a selected model
function TradeTable({ trades, model }: { trades: Trade[]; model: ModelName | null }) {
  const displayTrades = model
    ? trades.filter(t => t.model === model)
    : trades

  if (displayTrades.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-muted text-xs font-mono">
        {model ? `No trades attributed to ${MODEL_LABELS[model]}` : 'No trades recorded'}
      </div>
    )
  }

  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-surface-panel z-10">
          <tr>
            {['Time', 'Asset', 'Dir', 'Model', 'Entry', 'Exit', 'Size', 'Net PnL', 'W/L'].map(h => (
              <th key={h} className="th">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayTrades.map((t, i) => (
            <tr key={i} className="table-row">
              <td className="td text-muted">{new Date(t.entry_time).toLocaleTimeString()}</td>
              <td className="td font-semibold">{t.asset}</td>
              <td className="td">
                <span className={`tag ${t.direction === 'UP' ? 'tag-up' : 'tag-down'}`}>
                  {t.direction}
                </span>
              </td>
              <td className="td">
                {t.model ? (
                  <span
                    className="text-2xs font-mono px-1.5 py-0.5 rounded"
                    style={{
                      backgroundColor: `${MODEL_COLORS[t.model]}22`,
                      color: MODEL_COLORS[t.model],
                    }}
                  >
                    {MODEL_LABELS[t.model]?.split(' ')[0] ?? t.model}
                  </span>
                ) : (
                  <span className="text-muted text-2xs">—</span>
                )}
              </td>
              <td className="td font-mono">{Math.max(0, Math.min(100, t.entry_price)).toFixed(1)}%</td>
              <td className="td font-mono">{Math.max(0, Math.min(100, t.exit_price)).toFixed(1)}%</td>
              <td className="td font-mono">${t.size.toFixed(0)}</td>
              <td className={`td font-mono font-semibold ${t.net_pnl >= 0 ? 'text-up' : 'text-down'}`}>
                {t.net_pnl >= 0 ? '+' : ''}${t.net_pnl.toFixed(2)}
              </td>
              <td className="td">
                <span className={`tag ${t.win ? 'tag-up' : 'tag-down'}`}>
                  {t.win ? 'W' : 'L'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Model comparison bar chart
const ACTIVE_MODELS: readonly ModelName[] = CANONICAL_MODEL_NAMES

function ComparisonChart({ models, paperTrades }: { models: ModelReport[]; paperTrades: PaperRecord[] }) {
  const modelMap = Object.fromEntries(models.map(m => [m.model, m]))

  const data = ACTIVE_MODELS.map(modelKey => {
    const m = modelMap[modelKey]
    const livePnl   = m?.net_pnl ?? 0
    const liveCount = m?.total_trades ?? 0
    const paperForModel = paperTrades.filter(t => t.model === modelKey)
    const paperPnl  = paperForModel.reduce((s, t) => s + t.pnl, 0)
    const paperCount = paperForModel.length
    return {
      label:      (MODEL_LABELS[modelKey] ?? modelKey).split(' ')[0],
      pnl:        livePnl + paperPnl,
      livePnl,
      paperPnl,
      color:      MODEL_COLORS[modelKey],
      trades:     liveCount + paperCount,
      paperCount,
    }
  })

  const allZero = data.every(d => d.pnl === 0)

  // Dynamic height: 36px per bar + padding
  const chartHeight = Math.max(data.length * 36 + 16, 80)

  return (
    <div className="bg-surface-panel border border-surface-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-semibold text-slate-300">PnL Comparison — All Models</div>
        <div className="flex items-center gap-3 text-[10px] font-mono text-muted">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-accent inline-block" />Paper</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-slate-500 inline-block" />Live</span>
        </div>
      </div>
      {allZero ? (
        <div className="flex items-center justify-center h-24 text-muted text-xs font-mono">
          No closed trades yet
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={chartHeight}>
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 60, left: 72, bottom: 0 }}>
            <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="#1e2d4e" />
            <XAxis
              type="number"
              tick={{ fill: '#4a5568', fontSize: 10 }}
              tickFormatter={v => `$${v >= 0 ? '+' : ''}${v.toFixed(0)}`}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="label"
              tick={{ fill: '#94a3b8', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={70}
            />
            <ReferenceLine x={0} stroke="#334155" />
            <Tooltip
              content={({ active, payload }: any) => {
                if (!active || !payload?.length) return null
                const d = payload[0].payload
                return (
                  <div className="bg-surface-panel border border-surface-border rounded px-2 py-1.5 text-xs font-mono space-y-0.5">
                    <div className="text-slate-300 font-semibold">{d.label}</div>
                    <div className={d.pnl >= 0 ? 'text-up' : 'text-down'}>
                      Total: {d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(2)}
                    </div>
                    {d.paperPnl !== 0 && <div className="text-accent">Paper: {d.paperPnl >= 0 ? '+' : ''}${d.paperPnl.toFixed(2)} ({d.paperCount})</div>}
                    {d.livePnl  !== 0 && <div className="text-muted">Live: {d.livePnl >= 0 ? '+' : ''}${d.livePnl.toFixed(2)}</div>}
                    <div className="text-muted">{d.trades} trades</div>
                  </div>
                )
              }}
            />
            <Bar dataKey="pnl" radius={[0, 3, 3, 0]}>
              {data.map((entry, index) => (
                <Cell
                  key={index}
                  fill={entry.pnl >= 0 ? entry.color : '#ef4444'}
                  opacity={0.85}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

export function SignalReport() {
  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedModel, setSelectedModel] = useState<ModelName | null>(null)
  const [filterAsset, setFilterAsset] = useState('ALL')

  // Paper Trade data from localStorage
  const [paperTrades, setPaperTrades] = useState<PaperRecord[]>([])
  const [paperLifetime, setPaperLifetime] = useState<PaperLifetime | null>(null)

  useEffect(() => {
    const loadPaper = () => {
      try {
        const raw = JSON.parse(localStorage.getItem('paper_trades_v1') ?? '[]') as PaperRecord[]
        const trades = raw.map(t => t.model ? { ...t, model: normalizeModel(t.model) } : t)
        // Write canonical model names back so localStorage stays clean
        const hasStale = raw.some((t, i) => t.model && t.model !== trades[i].model)
        if (hasStale) localStorage.setItem('paper_trades_v1', JSON.stringify(trades))
        const lifetime = JSON.parse(localStorage.getItem('paper_lifetime_v1') ?? 'null') as PaperLifetime | null
        setPaperTrades(trades)
        setPaperLifetime(lifetime)
      } catch {}
    }
    loadPaper()
    const t = setInterval(loadPaper, 8000)
    return () => clearInterval(t)
  }, [])

  const load = useCallback(async () => {
    try {
      const [reportRes] = await Promise.all([
        fetch(`${API}/report/signals`),
      ])
      if (reportRes.ok) {
        const d = await reportRes.json()
        setData(d)
      }
    } catch {
      // silently retry
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 8000) // update every 8s
    return () => clearInterval(t)
  }, [load])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-xs font-mono">
        <span className="animate-pulse">Loading signal report…</span>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full text-down text-xs font-mono">
        Failed to load report — is the backend running?
      </div>
    )
  }

  const totalTrades = data.total_journal_trades
  const totalPnl = data.models.reduce((s, m) => s + m.net_pnl, 0)
  const totalWins = data.models.reduce((s, m) => s + m.wins, 0)
  const overallWR = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : '—'
  const liveCount = data.live_signals.length

  // Flatten all trades for the table
  const allTrades: Trade[] = data.models.flatMap(m => m.recent_trades)
  const uniqueTrades = Array.from(
    new Map(allTrades.map(t => [t.trade_id, t])).values()
  ).sort((a, b) => b.entry_time - a.entry_time)

  const filteredTrades = filterAsset === 'ALL'
    ? uniqueTrades
    : uniqueTrades.filter(t => t.asset === filterAsset)

  const filteredPaperTrades = paperTrades.filter(t => {
    if (selectedModel && t.model !== selectedModel) return false
    if (filterAsset !== 'ALL' && !t.marketKey.toUpperCase().includes(filterAsset)) return false
    return true
  })

  // Calculate stats dynamically from the filtered history list.
  const displayPaperStats = (selectedModel || filterAsset !== 'ALL') ? (() => {
    if (filteredPaperTrades.length === 0) return null
    const count = filteredPaperTrades.length
    const wins = filteredPaperTrades.filter(t => t.pnl > 0).length
    const totalPnl = filteredPaperTrades.reduce((s, t) => s + t.pnl, 0)
    let peak = 0, maxDd = 0, cum = 0
    for (let i = filteredPaperTrades.length - 1; i >= 0; i--) {
      cum += filteredPaperTrades[i].pnl
      if (cum > peak) peak = cum
      const dd = peak - cum
      if (dd > maxDd) maxDd = dd
    }
    return { count, wins, totalPnl, maxDrawdown: maxDd }
  })() : (paperLifetime || null)

  return (
    <div className="flex flex-col h-full overflow-hidden bg-surface">
      {/* Page Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-surface-border bg-surface-panel shrink-0">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-sm font-bold text-slate-200 tracking-wide">Signal Generator Report</h1>
            <p className="text-2xs text-muted font-mono">Per-model performance breakdown • updates every 8s</p>
          </div>
        </div>

        {/* Summary pills */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            <span className="text-2xs font-mono text-muted">{liveCount} live signal{liveCount !== 1 ? 's' : ''}</span>
          </div>
          <div className="h-3 w-px bg-surface-border" />
          <span className="text-2xs font-mono text-muted">{totalTrades} closed trades</span>
          <div className="h-3 w-px bg-surface-border" />
          <span className="text-2xs font-mono text-slate-300">{overallWR}% WR</span>
          <div className="h-3 w-px bg-surface-border" />
          <span className={`text-xs font-mono font-bold ${totalPnl >= 0 ? 'text-up' : 'text-down'}`}>
            {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-8">

        {/* ════════════════════════════════════════════════════════════
            PAPER TRADING REPORT
            ════════════════════════════════════════════════════════════ */}
        <div className="space-y-4">
          {/* Section header */}
          <div className="flex items-center gap-3">
            <span className="px-2 py-0.5 rounded text-[10px] font-bold tracking-widest uppercase bg-amber-400/15 text-amber-300 border border-amber-400/30">
              Paper
            </span>
            <span className="text-xs font-semibold text-slate-300">Paper Trading Report</span>
            <div className="flex-1 h-px bg-amber-400/15" />
            {displayPaperStats && (
              <span className={`text-xs font-mono font-bold ${displayPaperStats.totalPnl >= 0 ? 'text-up' : 'text-down'}`}>
                {displayPaperStats.totalPnl >= 0 ? '+' : ''}${displayPaperStats.totalPnl.toFixed(2)} net
              </span>
            )}
          </div>

          {/* Model cards */}
          <section className="rounded-xl border border-amber-400/15 bg-amber-400/[0.03] p-4 space-y-3">
            <div className="text-2xs font-semibold text-amber-300/70 uppercase tracking-widest">
              Signal Generators — Paper Performance
            </div>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
              {ACTIVE_MODELS.map(modelKey => {
                const backendReport = data.models.find(r => r.model === modelKey) ?? {
                  model: modelKey as ModelName,
                  total_trades: 0, wins: 0, losses: 0, win_rate: 0,
                  net_pnl: 0, best_trade: null, worst_trade: null, recent_trades: [],
                }
                return (
                  <ModelCard
                    key={modelKey}
                    report={backendReport}
                    liveSignals={data.live_signals}
                    selected={selectedModel === modelKey}
                    paperTradesForModel={paperTrades.filter(t => t.model === modelKey)}
                    onClick={() => setSelectedModel(
                      selectedModel === modelKey ? null : modelKey as ModelName
                    )}
                  />
                )
              })}
            </div>
            {selectedModel && (
              <p className="text-2xs text-muted font-mono text-center">
                Filtered to <span className="text-accent">{MODEL_LABELS[selectedModel]}</span> — click card again to clear
              </p>
            )}
          </section>

          {/* PnL comparison chart */}
          <ComparisonChart
            models={data.models.filter(r => r.model !== 'flow_toxicity' && r.model !== 'low_vol_accum')}
            paperTrades={paperTrades}
          />

          {/* Paper trade stats + log */}
          <section className="rounded-xl border border-amber-400/15 bg-surface-panel overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-amber-400/15 bg-amber-400/[0.04]">
              <div>
                <div className="text-xs font-semibold text-amber-200">
                  Paper Trade Log
                  {selectedModel && <span className="ml-2 font-mono text-2xs text-muted font-normal">— {MODEL_LABELS[selectedModel]}</span>}
                </div>
                <div className="text-2xs text-muted font-mono mt-0.5">Simulated positions from localStorage · auto-synced every 8s</div>
              </div>
              <div className="flex items-center gap-3">
                <select
                  value={filterAsset}
                  onChange={e => setFilterAsset(e.target.value)}
                  className="input-field w-20 py-0.5 text-2xs"
                >
                  {['ALL', 'BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'BNB', 'DOGE', 'POL'].map(a => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
                {selectedModel && (
                  <button
                    onClick={() => setSelectedModel(null)}
                    className="text-2xs font-mono text-muted hover:text-slate-300 px-2 py-0.5 rounded border border-surface-border transition-colors"
                  >
                    Clear filter
                  </button>
                )}
              </div>
            </div>

            {!displayPaperStats && filteredPaperTrades.length === 0 ? (
              <div className="flex items-center justify-center h-24 text-muted text-xs font-mono">
                No paper trades yet — place trades on the Paper Trade tab
              </div>
            ) : (
              <div className="p-4 space-y-4">
                {displayPaperStats && (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[
                      { label: 'Total Trades', value: displayPaperStats.count.toString(), color: 'text-slate-200' },
                      {
                        label: 'Win Rate',
                        value: displayPaperStats.count > 0
                          ? `${((displayPaperStats.wins / displayPaperStats.count) * 100).toFixed(1)}%`
                          : '—',
                        color: displayPaperStats.count > 0 && (displayPaperStats.wins / displayPaperStats.count) >= 0.5
                          ? 'text-up' : 'text-down',
                      },
                      {
                        label: 'Net PnL',
                        value: `${displayPaperStats.totalPnl >= 0 ? '+' : ''}$${displayPaperStats.totalPnl.toFixed(2)}`,
                        color: displayPaperStats.totalPnl >= 0 ? 'text-up' : 'text-down',
                      },
                      {
                        label: 'Max Drawdown',
                        value: `$${displayPaperStats.maxDrawdown.toFixed(2)}`,
                        color: 'text-down',
                      },
                    ].map(stat => (
                      <div key={stat.label} className="bg-surface rounded-lg p-3">
                        <div className="text-2xs text-muted mb-1">{stat.label}</div>
                        <div className={`text-sm font-mono font-bold ${stat.color}`}>{stat.value}</div>
                      </div>
                    ))}
                  </div>
                )}
                {filteredPaperTrades.length > 0 && (
                  <div className="overflow-auto max-h-64">
                    <table className="w-full border-collapse">
                      <thead className="sticky top-0 bg-surface-panel z-10">
                        <tr>
                          {['Time', 'Market', 'Side', 'Model', 'Source', 'Entry', 'Exit', 'Size', 'PnL', 'Reason'].map(h => (
                            <th key={h} className="th">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredPaperTrades.slice(0, 50).map((t, i) => (
                          <tr key={i} className="table-row">
                            <td className="td text-muted">{new Date(t.exitTime).toLocaleTimeString()}</td>
                            <td className="td text-muted max-w-[120px] truncate" title={t.question}>{t.marketKey}</td>
                            <td className="td">
                              <span className={`tag ${t.side === 'yes' ? 'tag-up' : 'tag-down'}`}>{t.side.toUpperCase()}</span>
                            </td>
                            <td className="td text-2xs font-mono text-slate-300">
                              {t.model ? (MODEL_LABELS[t.model] || t.model) : '—'}
                            </td>
                            <td className="td">
                              <span className="text-2xs font-mono text-slate-400 capitalize">{t.source}</span>
                            </td>
                            <td className="td font-mono">{t.entryPrice.toFixed(1)}¢</td>
                            <td className="td font-mono">{t.exitPrice.toFixed(1)}¢</td>
                            <td className="td font-mono">${t.size.toFixed(0)}</td>
                            <td className={`td font-mono font-semibold ${t.pnl >= 0 ? 'text-up' : 'text-down'}`}>
                              {t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}
                            </td>
                            <td className="td">
                              <span className="text-2xs font-mono text-slate-400 capitalize">
                                {t.exitReason.replace('_', ' ')}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        {/* ════════════════════════════════════════════════════════════
            LIVE DATA REPORT
            ════════════════════════════════════════════════════════════ */}
        <div className="space-y-4">
          {/* Section header */}
          <div className="flex items-center gap-3">
            <span className="px-2 py-0.5 rounded text-[10px] font-bold tracking-widest uppercase bg-accent/15 text-accent border border-accent/30 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse inline-block" />
              Live
            </span>
            <span className="text-xs font-semibold text-slate-300">Live Data Report</span>
            <div className="flex-1 h-px bg-accent/15" />
            <span className="text-2xs font-mono text-muted">{liveCount} active signal{liveCount !== 1 ? 's' : ''}</span>
          </div>

          {/* Live signals status */}
          {data.live_signals.length > 0 && (
            <section className="rounded-xl border border-accent/15 bg-accent/[0.03] p-4 space-y-3">
              <div className="text-2xs font-semibold text-accent/70 uppercase tracking-widest">
                Live Signal State
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {data.live_signals.map((sig, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between bg-surface rounded-lg px-3 py-2 border border-surface-border"
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: MODEL_COLORS[sig.model] ?? '#64748b' }} />
                      <div>
                        <div className="text-2xs font-mono text-slate-300">{sig.asset} — {MODEL_LABELS[sig.model] ?? sig.model}</div>
                        <div className="text-2xs text-muted">z={sig.zscore.toFixed(2)} · str={sig.strength.toFixed(1)}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className={`tag ${sig.direction === 'UP' ? 'tag-up' : 'tag-down'}`}>{sig.direction}</span>
                      <span className={`text-2xs font-mono capitalize ${
                        sig.regime === 'low' ? 'text-emerald-400' : sig.regime === 'high' ? 'text-down' : 'text-warn'
                      }`}>{sig.regime}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Live journal trade log */}
          <section className="rounded-xl border border-accent/15 bg-surface-panel overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-accent/15 bg-accent/[0.04]">
              <div>
                <div className="text-xs font-semibold text-accent/90">
                  Live Journal Trades
                  {selectedModel && <span className="ml-2 font-mono text-2xs text-muted font-normal">— {MODEL_LABELS[selectedModel]}</span>}
                  <span className="ml-2 text-muted font-mono text-2xs font-normal">
                    ({(selectedModel ? filteredTrades.filter(t => t.model === selectedModel) : filteredTrades).length} entries)
                  </span>
                </div>
                <div className="text-2xs text-muted font-mono mt-0.5">Real positions tracked by the backend engine</div>
              </div>
              <span className={`text-xs font-mono font-bold ${totalPnl >= 0 ? 'text-up' : 'text-down'}`}>
                {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} net
              </span>
            </div>
            <TradeTable trades={filteredTrades} model={selectedModel} />
          </section>
        </div>

      </div>
    </div>
  )
}
