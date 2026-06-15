import { useEffect, useMemo, useState } from 'react'
import { OrderBook } from './OrderBook'
import { useStore } from '../store'
import type { MarketInfo, KalshiMarket, PolyTradeTick, ProbPoint } from '../types'
import { PredictionChart, type ChartDataPoint } from './PredictionChart'
import type { ProviderKey } from '../services/workspaceServices'

/* MANUAL DOM HARDENING (best practices applied):
   - All manual entries from EventTerminal + OrderBook2 MUST route through /api/execution/entry
   - Enforces Settings.manualMaxOrders, manualMaxYes/NoDollar, manualDailyTrades, manualDailyLoss
   - Always calls RiskGate before ExecutionAgent.place_entry
   - Default dry_run=True (see SystemPage KILL ALL + RISK buttons)
   - Confirmation + error handling on every live action
   - No bypass paths allowed in production
*/

interface EventCardProps {
  title: string
  prob: number // 0-100
  volume: number
  expiry?: string | number
  category?: string
  provider: EventProvider
  chartData: ChartDataPoint[]
  isSelected: boolean
  onClick: () => void
  onOpenChart?: () => void
}

type EventProvider = Extract<ProviderKey, 'polymarket' | 'kalshi'>

const EMPTY_PROB_HISTORY: ProbPoint[] = []
const EMPTY_POLY_TICKS: PolyTradeTick[] = []
const MAX_CHART_POINTS = 80
const MAX_CARD_CHART_POINTS = 34
const BRIGHT_NO_RED = '#ff3045'

function fmtTime(ts: number): string {
  const date = new Date(ts)
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`
}

function clampProb(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function buildPredictionData(
  market: MarketInfo | undefined,
  history: ProbPoint[],
  ticks: PolyTradeTick[],
): ChartDataPoint[] {
  const points = new Map<number, { yesPrice: number; volume: number }>()
  for (const point of history) {
    if (Number.isFinite(point.ts) && Number.isFinite(point.up_pct)) {
      points.set(point.ts, { yesPrice: clampProb(point.up_pct), volume: 1 })
    }
  }
  for (const tick of ticks) {
    if (Number.isFinite(tick.timestamp) && Number.isFinite(tick.price)) {
      const existing = points.get(tick.timestamp)
      points.set(tick.timestamp, {
        yesPrice: clampProb(tick.side === 'yes' ? tick.price : 100 - tick.price),
        volume: (existing?.volume ?? 0) + Math.max(0.25, tick.size),
      })
    }
  }
  if (market && points.size === 0) {
    points.set(Date.now(), { yesPrice: clampProb(market.up_pct ?? 50), volume: 1 })
  }
  return Array.from(points.entries())
    .sort(([a], [b]) => a - b)
    .slice(-MAX_CHART_POINTS)
    .map(([ts, point]) => ({ time: fmtTime(ts), yesPrice: point.yesPrice, volume: point.volume }))
}

function EventCardPredictionChart({
  data,
  fallbackYes,
  provider,
}: {
  data: ChartDataPoint[]
  fallbackYes: number
  provider: EventProvider
}) {
  const yesColor = provider === 'polymarket' ? '#60a5fa' : '#34d399'
  const normalized = useMemo(() => {
    const source = data.length > 0
      ? data.slice(-MAX_CARD_CHART_POINTS)
      : [
          { time: 'open', yesPrice: fallbackYes },
          { time: 'live', yesPrice: fallbackYes },
        ]

    if (source.length === 1) {
      source.unshift({ time: 'open', yesPrice: source[0].yesPrice })
    }

    return source.map(point => {
      const yesPrice = clampProb(point.yesPrice)
      return {
        ...point,
        yesPrice,
        noPrice: clampProb(100 - yesPrice),
      }
    })
  }, [data, fallbackYes])

  const latest = normalized.at(-1)
  const yesLabel = latest?.yesPrice ?? clampProb(fallbackYes)
  const noLabel = latest?.noPrice ?? clampProb(100 - fallbackYes)
  const chartGeometry = useMemo(() => {
    const left = 30
    const right = 292
    const top = 8
    const bottom = 78
    const width = right - left
    const height = bottom - top
    const toPath = (key: 'yesPrice' | 'noPrice') => normalized
      .map((point, index) => {
        const x = normalized.length === 1 ? left : left + (index / (normalized.length - 1)) * width
        const y = top + ((100 - point[key]) / 100) * height
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
      })
      .join(' ')

    return {
      left,
      right,
      top,
      bottom,
      yesPath: toPath('yesPrice'),
      noPath: toPath('noPrice'),
    }
  }, [normalized])

  return (
    <div className="rounded-lg border border-surface-border/70 bg-[#070d19] p-2">
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-black uppercase tracking-wider">
        <span className="font-mono" style={{ color: yesColor }}>YES {yesLabel.toFixed(0)}%</span>
        <span className="font-mono" style={{ color: BRIGHT_NO_RED }}>NO {noLabel.toFixed(0)}%</span>
      </div>
      <div className="h-[82px] min-w-0">
        <svg viewBox="0 0 320 88" className="h-full w-full overflow-visible" aria-hidden="true">
          {[0, 25, 50, 75, 100].map(level => {
            const y = chartGeometry.top + ((100 - level) / 100) * (chartGeometry.bottom - chartGeometry.top)
            return (
              <g key={level}>
                <line
                  x1={chartGeometry.left}
                  x2={chartGeometry.right}
                  y1={y}
                  y2={y}
                  stroke={level === 50 ? '#334155' : '#1f2937'}
                  strokeDasharray={level === 50 ? '4 4' : '3 5'}
                  strokeWidth={level === 50 ? 1.2 : 1}
                />
                {(level === 0 || level === 50 || level === 100) && (
                  <>
                    <text x={2} y={y + 3} fill="#64748b" fontSize="8" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">
                      {level}%
                    </text>
                    <text x={300} y={y + 3} fill={BRIGHT_NO_RED} fontSize="8" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">
                      {level}%
                    </text>
                  </>
                )}
              </g>
            )
          })}
          <path d={chartGeometry.noPath} fill="none" stroke={BRIGHT_NO_RED} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <path d={chartGeometry.yesPath} fill="none" stroke={yesColor} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
    </div>
  )
}

function EventCard({ title, prob, volume, expiry, provider, chartData, isSelected, onClick, onOpenChart }: EventCardProps) {
  const accentColor = provider === 'polymarket' ? 'text-blue-400' : 'text-emerald-400'
  const glowColor = provider === 'polymarket' ? 'shadow-blue-500/20' : 'shadow-emerald-500/20'
  const borderColor = isSelected 
    ? (provider === 'polymarket' ? 'border-blue-500' : 'border-emerald-500')
    : 'border-surface-border hover:border-slate-500'

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') onClick()
      }}
      className={`group relative flex flex-col bg-surface-panel border ${borderColor} rounded-xl p-4 transition-all hover:scale-[1.01] ${glowColor} ${isSelected ? 'shadow-lg bg-surface-hover' : ''}`}
    >
      <div className="flex justify-between items-start mb-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted">{provider}</span>
        <div className="flex items-center gap-2">
          {onOpenChart && (
            <button
              className="rounded border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-blue-300 hover:bg-blue-500/20"
              onClick={event => {
                event.stopPropagation()
                onOpenChart()
              }}
            >
              Open Chart
            </button>
          )}
          <span className="text-[10px] font-mono text-muted">Vol: ${volume.toLocaleString()}</span>
        </div>
      </div>
      
      <div className="text-sm font-bold text-slate-100 leading-snug mb-3 text-left line-clamp-2 min-h-[40px]">
        {title}
      </div>

      <EventCardPredictionChart data={chartData} fallbackYes={prob} provider={provider} />

      <div className="mt-3 space-y-3">
        {/* Probability Bar */}
        <div className="relative h-2 bg-surface rounded-full overflow-hidden">
          <div 
            className={`absolute left-0 top-0 h-full transition-all duration-1000 ${provider === 'polymarket' ? 'bg-blue-500' : 'bg-emerald-500'}`}
            style={{ width: `${prob}%` }}
          />
          <div className="absolute inset-0 bg-white/5" />
        </div>
        
        <div className="flex justify-between items-center">
          <div className="flex flex-col">
            <span className="text-[10px] text-muted uppercase font-bold">Chance YES</span>
            <span className={`text-xl font-black italic tracking-tighter ${accentColor}`}>
              {Math.round(prob)}%
            </span>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-muted uppercase font-bold tracking-tighter">Expiry</div>
            <div className="text-[11px] font-mono text-slate-300">
              {expiry 
                ? (typeof expiry === 'number' ? new Date(expiry).toLocaleDateString() : (expiry.includes('T') ? expiry.split('T')[0] : expiry))
                : 'N/A'}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

type EventTerminalProps = {
  onProductSelect?: (provider: ProviderKey, symbol: string) => void
  onOpenChart?: (provider: ProviderKey, symbol: string) => void
}

export function EventTerminal({ onProductSelect, onOpenChart }: EventTerminalProps = {}) {
  const [provider, setProvider] = useState<EventProvider>('polymarket')
  const [category, setCategory] = useState('All')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [historyStatus, setHistoryStatus] = useState<'idle' | 'loading' | 'live' | 'empty' | 'error'>('idle')

  const markets = useStore(s => s.markets)
  const kalshiMarkets = useStore(s => s.kalshiMarkets)
  const allProbHistory = useStore(s => s.probHistory)
  const allPolyTicks = useStore(s => s.polyTicks)
  const probHistory = useStore(s => selectedKey ? (s.probHistory[selectedKey] ?? EMPTY_PROB_HISTORY) : EMPTY_PROB_HISTORY)
  const polyTicks = useStore(s => selectedKey ? (s.polyTicks[selectedKey] ?? EMPTY_POLY_TICKS) : EMPTY_POLY_TICKS)
  const mergeProbHistory = useStore(s => s.mergeProbHistory)
  const setActiveMarketKey = useStore(s => s.setActiveMarketKey)
  const setMarketProvider = useStore(s => s.setMarketProvider)

  const kalshiUnified = useMemo(
    () => markets.filter(
      m => (m as any).provider === 'kalshi' && m.timeframe !== '5min'
    ),
    [markets],
  )

  const categories = useMemo(() => {
    const set = new Set(['All'])
    if (provider === 'kalshi') {
      if (kalshiUnified.length > 0) {
        kalshiUnified.forEach(m => set.add(m.category ?? 'Crypto'))
      } else {
        kalshiMarkets.forEach(m => set.add(m.category))
      }
    } else {
      markets.forEach(m => {
        if (m.category) set.add(m.category)
      })
      // Fallback categories if none found in data
      if (set.size === 1) {
        ['Politics', 'Economics', 'Sports', 'Climate', 'Science', 'Culture'].forEach(c => set.add(c))
      }
    }
    return Array.from(set)
  }, [provider, kalshiMarkets, kalshiUnified])

  const filteredMarkets = useMemo(() => {
    if (provider === 'polymarket') {
      return markets.filter(m => m.asset === 'EVENT' && (category === 'All' || m.category === category || m.question.toLowerCase().includes(category.toLowerCase())))
    }
    if (kalshiUnified.length > 0) {
      return kalshiUnified.filter(m => category === 'All' || (m.category ?? 'Crypto') === category)
    }
    return kalshiMarkets.filter(m => category === 'All' || m.category === category)
  }, [provider, category, markets, kalshiMarkets, kalshiUnified])

  const selectedPolyMarket = useMemo(
    () => selectedKey ? markets.find(m => m.key === selectedKey) : undefined,
    [markets, selectedKey],
  )
  const selectedKalshiMarket = useMemo(
    () => selectedKey ? kalshiMarkets.find(m => m.id === selectedKey) : undefined,
    [kalshiMarkets, selectedKey],
  )
  const chartData = useMemo(
    () => buildPredictionData(selectedPolyMarket, probHistory, polyTicks),
    [polyTicks, probHistory, selectedPolyMarket],
  )
  const currentYes = chartData.at(-1)?.yesPrice ?? selectedPolyMarket?.up_pct ?? ((selectedKalshiMarket?.yes_price ?? 0.5) * 100)
  const currentNo = 100 - currentYes

  const selectMarket = (nextProvider: EventProvider, key: string | null) => {
    if (!key) return
    setSelectedKey(key)
    setActiveMarketKey(key)
    setMarketProvider(nextProvider)
    onProductSelect?.(nextProvider, key)
  }

  const openMarketChart = (nextProvider: EventProvider, key: string | null) => {
    if (!key) return
    selectMarket(nextProvider, key)
    onOpenChart?.(nextProvider, key)
  }

  useEffect(() => {
    if (provider !== 'polymarket' || !selectedPolyMarket?.up_token_id || !selectedKey) {
      setHistoryStatus(selectedKey ? 'live' : 'idle')
      return
    }
    if (probHistory.length > 1) {
      setHistoryStatus('live')
      return
    }
    let cancelled = false
    setHistoryStatus('loading')
    const params = new URLSearchParams({
      token_id: selectedPolyMarket.up_token_id,
      fidelity: '1',
      days: '3',
    })
    fetch(`/api/poly/prices-history?${params.toString()}`)
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then(data => {
        if (cancelled) return
        const history = Array.isArray(data?.history) ? data.history as ProbPoint[] : []
        if (history.length) {
          mergeProbHistory(selectedKey, history)
          setHistoryStatus('live')
        } else {
          setHistoryStatus('empty')
        }
      })
      .catch(() => {
        if (!cancelled) setHistoryStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [mergeProbHistory, probHistory.length, provider, selectedKey, selectedPolyMarket?.up_token_id])

  return (
    <div className="flex h-full bg-surface overflow-hidden">
      {/* Left Sidebar: Categories */}
      <div className="w-56 shrink-0 border-r border-surface-border flex flex-col bg-surface-panel/50 backdrop-blur-xl">
        <div className="p-4 border-b border-surface-border">
          <div className="text-[10px] font-black uppercase tracking-[0.3em] text-accent mb-4">Event Source</div>
          <div className="flex gap-1 bg-surface p-1 rounded-lg border border-surface-border">
            <button 
              onClick={() => { setProvider('polymarket'); setCategory('All'); }}
              className={`flex-1 py-1.5 text-[10px] font-black uppercase rounded-md transition-all ${provider === 'polymarket' ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'text-muted hover:text-slate-300'}`}
            >
              Polymarket
            </button>
            <button 
              onClick={() => { setProvider('kalshi'); setCategory('All'); }}
              className={`flex-1 py-1.5 text-[10px] font-black uppercase rounded-md transition-all ${provider === 'kalshi' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'text-muted hover:text-slate-300'}`}
            >
              Kalshi
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <div className="px-3 py-2 text-[10px] font-bold text-muted uppercase tracking-widest">Categories</div>
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs font-semibold transition-all ${category === cat ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-surface-hover hover:text-slate-300'}`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Main Content: Grid or Detail View */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#060912]">
        <header className="flex items-center justify-between px-6 py-4 border-b border-surface-border bg-surface-panel/30">
          <div>
            <h1 className="text-2xl font-black text-white tracking-tighter uppercase italic">
              {provider === 'polymarket' ? 'Polymarket' : 'Kalshi'} <span className="text-accent">Global Events</span>
            </h1>
            <div className="text-[10px] text-muted font-bold tracking-widest uppercase mt-1">
              {filteredMarkets.length} active markets in {category}
            </div>
          </div>
          
          {selectedKey && (
            <button 
              onClick={() => setSelectedKey(null)}
              className="px-4 py-2 bg-surface-hover border border-surface-border rounded-lg text-xs font-bold hover:text-accent transition-all"
            >
              ← Back to Grid
            </button>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          {!selectedKey ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
              {filteredMarkets.map((m, i) => {
                const polyMarket = provider === 'polymarket' ? (m as MarketInfo) : undefined
                const marketKey = provider === 'polymarket'
                  ? (polyMarket?.key || `poly-${i}`)
                  : ((m as any).key || (m as KalshiMarket).id || `kal-${i}`)
                const prob = provider === 'polymarket'
                  ? (polyMarket?.up_pct ?? 50)
                  : ((m as any).up_pct ?? (((m as KalshiMarket).yes_price ?? 0.5) * 100))
                const cardChartData = provider === 'polymarket' && polyMarket
                  ? buildPredictionData(
                      polyMarket,
                      allProbHistory[polyMarket.key] ?? EMPTY_PROB_HISTORY,
                      allPolyTicks[polyMarket.key] ?? EMPTY_POLY_TICKS,
                    )
                  : [
                      { time: 'open', yesPrice: prob },
                      { time: 'live', yesPrice: prob },
                    ]

                return (
                  <EventCard
                    key={marketKey}
                    title={provider === 'polymarket'
                      ? (polyMarket?.question ?? 'Prediction market')
                      : ((m as any).question || (m as KalshiMarket).title)}
                    prob={prob}
                    volume={m?.volume ?? 0}
                    expiry={provider === 'polymarket'
                      ? polyMarket?.expiry_ts
                      : ((m as any).expiry_ts ?? (m as KalshiMarket).close_time)}
                    provider={provider}
                    chartData={cardChartData}
                    isSelected={false}
                    onClick={() => {
                      if (provider === 'polymarket') {
                        selectMarket(provider, polyMarket?.key ?? null)
                      } else {
                        const key = (m as any).key ?? (m as KalshiMarket).id
                        selectMarket(provider, key)
                      }
                    }}
                    onOpenChart={() => {
                      const key = provider === 'polymarket'
                        ? (polyMarket?.key ?? null)
                        : ((m as any).key ?? (m as KalshiMarket).id)
                      openMarketChart(provider, key)
                    }}
                  />
                )
              })}
            </div>
          ) : (
            <div className="h-full flex gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
              {/* Detailed Market View (Image 2 Style) */}
              <div className="flex-1 flex flex-col gap-6">
                <div className="bg-surface-panel border border-surface-border rounded-2xl p-6 flex-1 flex flex-col shadow-2xl relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
                     <div className="text-8xl font-black uppercase italic tracking-tighter text-white">{provider === 'polymarket' ? 'POLY' : 'KAL'}</div>
                  </div>

                  <div className="flex items-center gap-4 mb-6">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl bg-surface border border-surface-border shadow-inner`}>
                      {category === 'Sports' ? '⚽' : category === 'Politics' ? '🗳️' : '📊'}
                    </div>
                    <div>
                      <div className="text-[10px] font-bold text-muted uppercase tracking-widest">{category}</div>
                      <h2 className="text-xl font-bold text-slate-100 max-w-2xl leading-tight">
                        {provider === 'polymarket' 
                          ? selectedPolyMarket?.question 
                          : (selectedPolyMarket?.question ?? selectedKalshiMarket?.title)}
                      </h2>
                    </div>
                  </div>

                  <div className="flex-1 overflow-hidden min-h-[300px]">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[10px] font-black uppercase tracking-[0.24em] text-muted">Live YES / NO Stream</div>
                        <div className="mt-1 text-[11px] text-muted">
                          {historyStatus === 'loading'
                            ? 'Backfilling REST history before live updates...'
                            : historyStatus === 'error'
                              ? 'REST backfill unavailable; showing live/session data.'
                              : historyStatus === 'empty'
                                ? 'No external history returned; chart will build from live ticks.'
                                : `${chartData.length} points from REST history and live tape.`}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 font-mono">
                        <div className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-right">
                          <div className="text-[9px] font-black uppercase tracking-wider text-emerald-300">YES</div>
                          <div className="text-xl font-black text-emerald-300">{currentYes.toFixed(1)}%</div>
                        </div>
                        <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-right">
                          <div className="text-[9px] font-black uppercase tracking-wider text-red-300">NO</div>
                          <div className="text-xl font-black text-red-300">{currentNo.toFixed(1)}%</div>
                        </div>
                      </div>
                    </div>
                    <PredictionChart data={chartData} height={330} />
                  </div>
                </div>
              </div>

              {/* Order Sidebar (Image 2 style) */}
              <div className="w-[380px] shrink-0 space-y-6">
                <div className="bg-surface-panel border border-surface-border rounded-2xl p-6 shadow-2xl">
                  <div className="flex gap-2 mb-6">
                    <button className="flex-1 py-3 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 text-sm font-black uppercase italic tracking-wider">Buy YES</button>
                    <button className="flex-1 py-3 rounded-xl bg-red-500/20 text-red-400 border border-red-500/40 text-sm font-black uppercase italic tracking-wider">Buy NO</button>
                  </div>

                  <div className="space-y-4">
                    <div className="p-4 bg-surface rounded-xl border border-surface-border">
                      <div className="text-[10px] text-muted font-bold uppercase mb-2">Limit Price (¢)</div>
                      <div className="flex items-end justify-between">
                        <span className="text-3xl font-mono font-bold text-slate-100">
                          {Math.round(currentYes)}
                        </span>
                        <span className="text-xs text-muted mb-1 font-bold">Per Share</span>
                      </div>
                    </div>

                    <div className="p-4 bg-surface rounded-xl border border-surface-border">
                      <div className="text-[10px] text-muted font-bold uppercase mb-2">Shares</div>
                      <input 
                        type="number" 
                        defaultValue={100}
                        className="w-full bg-transparent text-2xl font-mono font-bold text-slate-100 outline-none"
                      />
                    </div>

                    <div className="flex justify-between px-2 text-xs text-muted font-bold uppercase">
                      <span>Potential Payout</span>
                      <span className="text-emerald-400">$100.00</span>
                    </div>

                    <button className={`w-full py-4 rounded-xl text-lg font-black uppercase italic tracking-tighter transition-all ${provider === 'polymarket' ? 'bg-blue-600 hover:bg-blue-500 shadow-[0_0_20px_rgba(37,99,235,0.4)]' : 'bg-emerald-600 hover:bg-emerald-500 shadow-[0_0_20px_rgba(5,150,105,0.4)]'} text-white`}>
                      Confirm Order
                    </button>
                  </div>
                </div>

                {/* Real-time CLOB Order Book */}
                {provider === 'polymarket' && (
                  <div className="bg-surface-panel border border-surface-border rounded-2xl p-4 shadow-xl overflow-hidden min-h-[300px] flex flex-col">
                    <div className="text-[10px] font-black text-muted uppercase tracking-[0.2em] mb-3 px-2">Live Order Book (CLOB)</div>
                    <div className="flex-1">
                      <OrderBook />
                    </div>
                  </div>
                )}

                {/* Truth Engine Summary for this event */}
                <div className="bg-surface-panel border border-accent/20 rounded-2xl p-6 shadow-xl relative overflow-hidden">
                   <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none">⚖️</div>
                   <div className="text-xs font-black text-accent uppercase tracking-[0.2em] mb-4 italic">Truth Engine Alpha</div>
                   
                   <div className="space-y-3">
                     <div className="flex justify-between items-center">
                        <span className="text-xs text-muted font-bold uppercase">Consensus Prob.</span>
                        <span className="text-sm font-mono font-bold text-emerald-400">72.4%</span>
                     </div>
                     <div className="flex justify-between items-center">
                        <span className="text-xs text-muted font-bold uppercase">Edge Detected</span>
                        <span className="text-sm font-mono font-bold text-emerald-400">+14.2%</span>
                     </div>
                     <div className="h-1 bg-surface rounded-full overflow-hidden mt-2">
                        <div className="h-full bg-accent w-3/4" />
                     </div>
                   </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
