import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { DailyMetrics, MarketInfo, ModelName, Trade } from '../types'
import { MODEL_COLORS, MODEL_LABELS, normalizeModel } from '../types'

interface ModelReport {
  model: ModelName
  total_trades: number
  wins: number
  losses: number
  win_rate: number
  net_pnl: number
  recent_trades: Trade[]
}

interface LiveSignal {
  timestamp: number
  asset: string
  model: ModelName
  direction: 'UP' | 'DOWN' | 'FLAT'
  strength: number
  regime: string
}

interface PositionLike {
  position_id?: string
  asset?: string
  direction?: string
  size?: number
  unrealized_pnl?: number
  current_price?: number
  model?: string | null
}

interface HermesObservation {
  title?: string
  body?: string
  confidence?: number
  model?: string | null
  market?: string | null
  captured?: boolean
}

interface HermesStatus {
  connected: boolean
  mode: string
  status: string
  queue_depth: number
  active_agents: unknown[]
  learning_notes: unknown[]
  observations: HermesObservation[]
}

interface NoesisSymbolState {
  active: boolean
  sigma: number
  zscore: number
  pending?: 'up' | 'down' | null
}

interface SystemOverview {
  timestamp_ms: number
  demo?: {
    enabled: boolean
    label?: string
    disclaimer?: string
    period?: string
  }
  models: ModelReport[]
  live_signals: LiveSignal[]
  positions: PositionLike[]
  metrics: DailyMetrics | null
  journal: Trade[]
  daily: { date: string; net_pnl: number; trade_count: number; win_rate: number }[]
  markets: (MarketInfo & { provider?: string })[]
  market_summary: {
    count: number
    polymarket: number
    kalshi: number
    total_volume: number
  }
  prices: {
    BTC?: {
      last: number
      series: { timestamp: number; price: number; volume: number }[]
    }
  }
  health: {
    live_data: boolean
    book_fresh_ms: number | null
    open_positions: number
    journal_trades: number
  }
  hermes: HermesStatus
  noesis_state?: Record<string, NoesisSymbolState>
}

const emptyOverview: SystemOverview = {
  timestamp_ms: Date.now(),
  models: [],
  live_signals: [],
  positions: [],
  metrics: null,
  journal: [],
  daily: [],
  markets: [],
  market_summary: { count: 0, polymarket: 0, kalshi: 0, total_volume: 0 },
  prices: { BTC: { last: 0, series: [] } },
  health: { live_data: false, book_fresh_ms: null, open_positions: 0, journal_trades: 0 },
  hermes: {
    connected: false,
    mode: 'read_only_dataset_capture',
    status: 'disconnected',
    queue_depth: 0,
    active_agents: [],
    learning_notes: [],
    observations: [],
  },
}

function money(value: number | undefined, compact = false) {
  const n = Number(value ?? 0)
  if (compact && Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (compact && Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function pct(value: number | undefined) {
  return `${Number(value ?? 0).toFixed(1)}%`
}

function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/10 bg-[#07111f]/72 shadow-2xl shadow-black/30 backdrop-blur-xl ${className}`}>
      {children}
    </section>
  )
}

function PanelTitle({ title, kicker }: { title: string; kicker?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
      <span className="text-[11px] font-black uppercase tracking-[0.22em] text-slate-100">{title}</span>
      {kicker && <span className="text-[10px] font-bold uppercase tracking-widest text-accent">{kicker}</span>}
    </div>
  )
}

function StatusDot({ active }: { active: boolean }) {
  return <span className={`h-2 w-2 rounded-full ${active ? 'bg-accent shadow-[0_0_12px_#00d4a4]' : 'bg-red-400 shadow-[0_0_12px_#ff4757]'}`} />
}

export function SystemPage() {
  const [data, setData] = useState<SystemOverview>(emptyOverview)
  const [error, setError] = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState<ModelName>('noesis_v3')

  const loadOverview = async () => {
    const response = await fetch('/api/system/overview')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    setData({ ...emptyOverview, ...payload })
    setError(null)
  }

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        if (!cancelled) await loadOverview()
      } catch (exc) {
        if (!cancelled) setError(exc instanceof Error ? exc.message : 'System overview unavailable')
      }
    }
    load()
    const id = window.setInterval(load, 5_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  const handleToggleSymbol = async (symbol: string) => {
    if (!data.noesis_state) return
    const currentState = data.noesis_state[symbol]
    if (!currentState) return

    const currentActive = Object.entries(data.noesis_state)
      .filter(([name, val]) => name === symbol ? !val.active : val.active)
      .map(([name]) => name)

    // Optimistically update
    setData(prev => {
      if (!prev.noesis_state) return prev
      return {
        ...prev,
        noesis_state: {
          ...prev.noesis_state,
          [symbol]: {
            ...prev.noesis_state[symbol],
            active: !prev.noesis_state[symbol].active
          }
        }
      }
    })

    try {
      const res = await fetch('/api/settings/symbols', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active_symbols: currentActive })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (exc) {
      console.error('Failed to update active symbols:', exc)
      // Rollback
      setData(prev => {
        if (!prev.noesis_state) return prev
        return {
          ...prev,
          noesis_state: {
            ...prev.noesis_state,
            [symbol]: {
              ...prev.noesis_state[symbol],
              active: !prev.noesis_state[symbol].active
            }
          }
        }
      })
    }
  }

  const equity = useMemo(() => {
    let running = 0
    return data.journal.slice().reverse().map((trade, index) => {
      running += Number(trade.net_pnl ?? 0)
      return { index: index + 1, equity: Number(running.toFixed(2)) }
    })
  }, [data.journal])

  const modelMap = useMemo(() => {
    const map = new Map<ModelName, ModelReport>()
    data.models.forEach(model => map.set(normalizeModel(model.model), model))
    return map
  }, [data.models])

  const strongestSignal = data.live_signals
    .slice()
    .sort((a, b) => Number(b.strength ?? 0) - Number(a.strength ?? 0))[0]

  const pnl = Number(data.metrics?.net_pnl ?? 0)
  const btcSeries = data.prices.BTC?.series ?? []
  const hermesObservations = data.hermes.observations.length
    ? data.hermes.observations
    : [{ title: 'Edge learner standing by', body: 'Hermes will show read-only strategy notes here when connected.', confidence: 0, captured: false }]

  return (
    <div className="h-full overflow-auto bg-[#030711] text-slate-100">
      <div className="min-h-full bg-[radial-gradient(circle_at_top_left,rgba(0,212,164,0.20),transparent_32%),radial-gradient(circle_at_top_right,rgba(59,130,246,0.18),transparent_34%),linear-gradient(135deg,#040812_0%,#081527_52%,#02050b_100%)] p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[11px] font-black uppercase tracking-[0.32em] text-accent">QuantSwarm System</div>
            <h1 className="mt-1 text-2xl font-black tracking-tight text-white">Model Command Center</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-black uppercase tracking-widest text-accent">
              <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_12px_#00d4a4]" />
              PRODUCTION ALGO ACTIVE
            </div>

            {/* HARDENED EXECUTION LAYER — System Command Center (best practices: confirmation, error handling, dry-run awareness) */}
            <div className="flex items-center gap-2 rounded-full border border-red-500/40 bg-red-950/40 px-3 py-1 text-xs font-black uppercase tracking-widest text-red-300">
              <span className="px-1">EXEC</span>
              <button
                onClick={async () => {
                  if (!window.confirm('⚠️ EMERGENCY CLOSE ALL OPEN POSITIONS? Irreversible. Only use in live mode if needed.')) return
                  try {
                    const res = await fetch('/api/execution/emergency-close', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
                    if (res.ok) {
                      const data = await res.json().catch(() => ({}))
                      alert('Emergency close executed. Positions: ' + (data.closed_count ?? 'unknown'))
                      // refresh overview
                      loadOverview().catch(() => {})
                    } else {
                      alert('Emergency close failed: HTTP ' + res.status)
                    }
                  } catch (e) {
                    alert('Network error calling emergency close: ' + (e instanceof Error ? e.message : e))
                  }
                }}
                className="rounded bg-red-600 px-3 py-1 text-[10px] font-black text-white hover:bg-red-700 active:bg-red-800"
                title="Hard stop — closes all via ExecutionAgent.emergency_close_all()"
              >
                KILL ALL
              </button>
              <button
                onClick={async () => {
                  try {
                    const res = await fetch('/api/execution/risk')
                    if (res.ok) {
                      const risk = await res.json()
                      alert('Current Risk Snapshot:\n' + JSON.stringify(risk, null, 2).slice(0, 400))
                    } else {
                      alert('Risk endpoint error: ' + res.status)
                    }
                  } catch (e) {
                    alert('Failed to fetch risk: ' + (e instanceof Error ? e.message : String(e)))
                  }
                }}
                className="rounded border border-white/20 bg-white/5 px-3 py-1 text-[10px] font-black text-slate-300 hover:bg-white/10"
                title="Fetch live risk from /api/execution/risk (enforces manual limits + regime)"
              >
                RISK
              </button>
              <span className="ml-1 text-[9px] text-red-400/70">DRY_RUN default</span>
            </div>

            <div className="flex items-center gap-3 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-bold uppercase tracking-widest text-slate-300">
              <StatusDot active={!error} />
              {error ? `Overview stale: ${error}` : `Live ${new Date(data.timestamp_ms).toLocaleTimeString()}`}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-4">
          <Panel>
            <PanelTitle title="Wallet" kicker="paper + algo" />
            <div className="p-4">
              <div className={`text-5xl font-black tracking-tight ${pnl >= 0 ? 'text-accent' : 'text-red-400'}`}>{money(pnl)}</div>
              {data.demo?.enabled && <div className="mt-1 text-[10px] font-black uppercase tracking-[0.24em] text-yellow-200">Last 30 days pro forma</div>}
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-white/5 p-2">
                  <div className="text-lg font-black">{data.metrics?.trade_count ?? 0}</div>
                  <div className="text-[9px] uppercase tracking-widest text-slate-400">fills</div>
                </div>
                <div className="rounded-xl bg-white/5 p-2">
                  <div className="text-lg font-black text-accent">{pct(data.metrics?.win_rate)}</div>
                  <div className="text-[9px] uppercase tracking-widest text-slate-400">win rate</div>
                </div>
                <div className="rounded-xl bg-white/5 p-2">
                  <div className="text-lg font-black">{data.positions.length}</div>
                  <div className="text-[9px] uppercase tracking-widest text-slate-400">open</div>
                </div>
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelTitle title="BTC Price" kicker={money(data.prices.BTC?.last)} />
            <div className="h-44 p-3">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={btcSeries}>
                  <CartesianGrid stroke="#20304d" strokeDasharray="3 3" />
                  <XAxis dataKey="timestamp" hide />
                  <YAxis hide domain={['dataMin', 'dataMax']} />
                  <Tooltip contentStyle={{ background: '#07111f', border: '1px solid #1e3356', color: '#fff' }} />
                  <Line type="monotone" dataKey="price" stroke="#00d4a4" strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel>
            <PanelTitle title="Open Positions" kicker={`${data.positions.length} active`} />
            <div className="max-h-44 overflow-auto p-3">
              {data.positions.length === 0 && <div className="py-10 text-center text-xs text-slate-500">No open positions</div>}
              {data.positions.slice(0, 7).map((pos, index) => (
                <div key={pos.position_id ?? index} className="mb-1.5 grid grid-cols-[40px_1fr_64px] items-center gap-2 rounded-lg border border-white/5 bg-white/[0.04] px-2 py-1.5 text-xs">
                  <span className="font-black text-white">{pos.asset ?? '--'}</span>
                  <span className={pos.direction === 'UP' ? 'text-accent' : 'text-red-400'}>{pos.direction ?? 'FLAT'} / {pos.model ?? 'manual'}</span>
                  <span className={`text-right font-mono ${Number(pos.unrealized_pnl ?? 0) >= 0 ? 'text-accent' : 'text-red-400'}`}>{money(pos.unrealized_pnl)}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel>
            <PanelTitle title="Hermes" kicker={data.hermes.status} />
            <div className="p-4">
              <div className="flex items-center gap-2 text-sm font-black uppercase tracking-widest">
                <StatusDot active={data.hermes.connected} />
                {data.hermes.connected ? 'Edge agent online' : 'Disconnected'}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <div className="rounded-xl bg-white/5 p-3">
                  <div className="text-2xl font-black">{data.hermes.queue_depth}</div>
                  <div className="text-[9px] uppercase tracking-widest text-slate-400">queue</div>
                </div>
                <div className="rounded-xl bg-white/5 p-3">
                  <div className="text-2xl font-black">{data.hermes.learning_notes.length}</div>
                  <div className="text-[9px] uppercase tracking-widest text-slate-400">notes</div>
                </div>
              </div>
              <div className="mt-3 rounded-xl border border-accent/20 bg-accent/10 px-3 py-2 text-[11px] text-slate-300">
                Read-only learning mode. No autonomous execution.
              </div>
            </div>
          </Panel>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-[1fr_360px]">
          <Panel className="overflow-hidden">
            <PanelTitle title="Strategy Decision Tree" kicker={strongestSignal ? `${strongestSignal.asset} ${strongestSignal.direction}` : 'waiting'} />
            <div className="relative min-h-[430px] p-5">
              <div className="absolute inset-0 opacity-30 [background-image:linear-gradient(#1e3356_1px,transparent_1px),linear-gradient(90deg,#1e3356_1px,transparent_1px)] [background-size:38px_38px]" />
              <div className="relative grid grid-cols-1 gap-3 lg:grid-cols-[180px_1fr_180px]">
                <div className="flex flex-col justify-center gap-3">
                  <Node title="Tick Feed" value={`${data.market_summary.count} markets`} color="#38bdf8" />
                  <Node title="Scan Poly/Kalshi" value={money(data.market_summary.total_volume, true)} color="#00d4a4" />
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:col-span-1">
                  {/* Left Column: Running Systems Dashboard & Details */}
                  <div className="rounded-2xl border border-white/10 bg-[#050b15]/90 p-4 shadow-xl flex flex-col justify-between min-h-[400px]">
                    <div>
                      <div className="border-b border-white/10 pb-2.5 mb-3 text-xs font-black uppercase tracking-widest text-slate-300">
                        Running Systems (3)
                      </div>
                      
                      <div className="space-y-2 mb-4">
                        {(['noesis_v3', 'v18', 'v20_hybrid'] as const).map(modelKey => {
                          const isSelected = selectedModel === modelKey
                          const mStats = modelMap.get(modelKey)
                          const color = MODEL_COLORS[modelKey] ?? '#00d4a4'
                          const label = MODEL_LABELS[modelKey] ?? modelKey
                          
                          return (
                            <button
                              key={modelKey}
                              onClick={() => setSelectedModel(modelKey)}
                              className={`w-full flex items-center justify-between rounded-xl p-2.5 text-left text-xs border transition-all ${
                                isSelected 
                                  ? 'bg-white/[0.08] border-white/20 shadow-lg shadow-black/20' 
                                  : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.05]'
                              }`}
                            >
                              <div className="flex items-center gap-2.5">
                                <span 
                                  className="h-2.5 w-2.5 rounded-full shadow-[0_0_8px_currentColor]"
                                  style={{ color }}
                                />
                                <span className="font-black text-white">{label}</span>
                              </div>
                              <div className="flex items-center gap-3 font-mono text-[10px]">
                                <span className="text-slate-400">WR: <span className="font-bold text-slate-200">{pct(mStats?.win_rate)}</span></span>
                                <span className="text-slate-400">PnL: <span className={`font-bold ${Number(mStats?.net_pnl ?? 0) >= 0 ? 'text-accent' : 'text-red-400'}`}>{money(mStats?.net_pnl, true)}</span></span>
                              </div>
                            </button>
                          )
                        })}
                      </div>

                      {/* Selected System Details Cockpit */}
                      <div className="border-t border-white/10 pt-3.5">
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">System Specs</span>
                          <span className="rounded-full bg-accent/25 px-2 py-0.5 text-[9px] font-black text-accent">ACTIVE ON CHECKED</span>
                        </div>

                        {selectedModel === 'noesis_v3' && (
                          <div className="space-y-2 text-[11px] text-slate-300">
                            <div className="flex justify-between">
                              <span className="text-slate-400">Bates Model Engine</span>
                              <span className="font-bold text-accent">ON</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Resolution Target</span>
                              <span className="font-bold text-white">15-Minute Contracts</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Risk Gating (Half Kelly)</span>
                              <span className="font-bold text-white">0.5 Fractional</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Order Flow Gating</span>
                              <span className="font-bold text-white">CLV Proxy Gate 2</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Target 1 TP Offset</span>
                              <span className="font-bold text-white">+250% (40% weight)</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Target 2 TP Offset</span>
                              <span className="font-bold text-white">+500% (30% weight)</span>
                            </div>
                          </div>
                        )}

                        {selectedModel === 'v18' && (
                          <div className="space-y-2 text-[11px] text-slate-300">
                            <div className="flex justify-between">
                              <span className="text-slate-400">Gaussian CDF Projection</span>
                              <span className="font-bold text-accent">ON</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Resolution Target</span>
                              <span className="font-bold text-white">15-Minute Contracts</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Risk Gating (Half Kelly)</span>
                              <span className="font-bold text-white">0.5 Fractional</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Stop Loss Window</span>
                              <span className="font-bold text-white">Minutes 9-13 (50% SL)</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Trigger Level</span>
                              <span className="font-bold text-white">&gt;= 60.0% probability</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Linear Vol Blend</span>
                              <span className="font-bold text-white">EWMA Vol + 15m ATR</span>
                            </div>
                          </div>
                        )}

                        {selectedModel === 'v20_hybrid' && (
                          <div className="space-y-2 text-[11px] text-slate-300">
                            <div className="flex justify-between">
                              <span className="text-slate-400">Hybrid Jump-Lattice (1k/30)</span>
                              <span className="font-bold text-accent">ON</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Resolution Target</span>
                              <span className="font-bold text-white">15-Minute Contracts</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Risk Gating (Half Kelly)</span>
                              <span className="font-bold text-white">0.5 Fractional</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Stop Loss Window</span>
                              <span className="font-bold text-white">Minutes 9-13 (50% SL)</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Trigger Level</span>
                              <span className="font-bold text-white">&gt;= 75.0% probability</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Volatility Regime Scaling</span>
                              <span className="font-bold text-white">Adaptive Params (0/1/2)</span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right Column: Symbol Checkbox Settings Panel */}
                  <div className="rounded-2xl border border-white/10 bg-[#050b15]/90 p-4 shadow-xl">
                    <div className="border-b border-white/10 pb-2.5 mb-3 text-xs font-black uppercase tracking-widest text-slate-300">
                      Symbol settings & exec check
                    </div>
                    
                    <div className="max-h-[300px] overflow-auto space-y-2 pr-1">
                      {data.noesis_state && Object.entries(data.noesis_state).map(([symbol, state]) => (
                        <div key={symbol} className="flex items-center justify-between rounded-xl bg-white/[0.03] hover:bg-white/[0.06] p-2 text-xs border border-white/5 transition-all">
                          <div className="flex items-center gap-3">
                            <input
                              type="checkbox"
                              checked={state.active}
                              onChange={() => handleToggleSymbol(symbol)}
                              className="h-4 w-4 rounded border-white/20 bg-slate-900 text-accent focus:ring-accent accent-accent"
                            />
                            <span className="font-black text-white">{symbol}</span>
                          </div>
                          
                          <div className="flex items-center gap-3.5">
                            <span className="font-mono text-[10px] text-slate-400">
                              v:{pct(state.sigma * 100)} z:{state.zscore > 0 ? '+' : ''}{state.zscore.toFixed(1)}
                            </span>
                            {state.pending ? (
                              <span className={`animate-pulse rounded-full px-1.5 py-0.5 text-[9px] font-black ${state.pending === 'up' ? 'bg-[#00d4a4]/20 text-[#00d4a4]' : 'bg-red-500/20 text-red-300'}`}>
                                PEND_{state.pending.toUpperCase()}
                              </span>
                            ) : (
                              <span className={`h-1.5 w-1.5 rounded-full ${state.active ? 'bg-accent' : 'bg-slate-600'}`} />
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex flex-col justify-center gap-3">
                  <Node title="Limit Fill" value={`${data.metrics?.trades_remaining ?? 0} left`} color="#facc15" />
                  <Node title="Resolve" value={pnl >= 0 ? `PnL ${money(pnl, true)}` : `Draw ${money(pnl, true)}`} color={pnl >= 0 ? '#00d4a4' : '#ff4757'} />
                </div>
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelTitle title="Hermes Learning Feed" kicker={data.hermes.mode.replaceAll('_', ' ')} />
            <div className="max-h-[486px] overflow-auto p-3">
              {hermesObservations.slice(0, 8).map((obs, index) => (
                <div key={`${obs.title ?? 'obs'}-${index}`} className="mb-2 rounded-xl border border-white/10 bg-white/[0.045] p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-xs font-black uppercase tracking-wider text-white">{obs.title ?? 'Hermes observation'}</div>
                    <span className={`rounded-full px-2 py-0.5 text-[9px] font-black ${obs.captured ? 'bg-accent/20 text-accent' : 'bg-white/10 text-slate-400'}`}>
                      {obs.captured ? 'captured' : 'review'}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-slate-400">{obs.body ?? 'Waiting for edge-learning notes.'}</p>
                  <div className="mt-2 flex flex-wrap gap-1 text-[10px] uppercase tracking-wider text-slate-500">
                    <span>{obs.model ?? 'all models'}</span>
                    <span>{obs.market ?? 'all markets'}</span>
                    <span>{pct((obs.confidence ?? 0) * 100)}</span>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-3">
          <Panel>
            <PanelTitle title="Equity Curve" kicker={`${data.journal.length} trades`} />
            <div className="h-52 p-3">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={equity}>
                  <CartesianGrid stroke="#20304d" strokeDasharray="3 3" />
                  <XAxis dataKey="index" hide />
                  <YAxis hide />
                  <Tooltip contentStyle={{ background: '#07111f', border: '1px solid #1e3356', color: '#fff' }} />
                  <Area type="monotone" dataKey="equity" stroke="#00d4a4" fill="#00d4a433" strokeWidth={2} dot={false} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel>
            <PanelTitle title="Trade Logs" kicker="live stream" />
            <div className="max-h-52 overflow-auto p-3 font-mono text-[11px]">
              {data.journal.length === 0 && <div className="py-12 text-center text-slate-500">No fills yet</div>}
              {data.journal.slice(0, 10).map(trade => (
                <div key={trade.trade_id} className="mb-1 grid grid-cols-[44px_1fr_66px] rounded-lg bg-white/[0.04] px-2 py-1.5">
                  <span className={trade.direction === 'UP' ? 'text-accent' : 'text-red-400'}>{trade.direction}</span>
                  <span className="truncate text-slate-300">{trade.asset} {trade.model ?? 'manual'}</span>
                  <span className={`text-right ${Number(trade.net_pnl) >= 0 ? 'text-accent' : 'text-red-400'}`}>{money(trade.net_pnl, true)}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel>
            <PanelTitle title="Market Health" kicker={data.health.live_data ? 'live' : 'warming'} />
            <div className="grid grid-cols-2 gap-2 p-3">
              <MetricCard label="Poly markets" value={`${data.market_summary.polymarket}`} />
              <MetricCard label="Kalshi markets" value={`${data.market_summary.kalshi}`} />
              <MetricCard label="Book fresh" value={data.health.book_fresh_ms == null ? '--' : `${Math.round(data.health.book_fresh_ms / 1000)}s`} />
              <MetricCard label="Volume" value={money(data.market_summary.total_volume, true)} />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.045] p-3">
      <div className="text-2xl font-black text-white">{value}</div>
      <div className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</div>
    </div>
  )
}

function Node({ title, value, color }: { title: string; value: string; color: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#050b15]/90 p-4 shadow-xl">
      <div className="text-[10px] font-black uppercase tracking-[0.22em]" style={{ color }}>{title}</div>
      <div className="mt-2 text-lg font-black text-white">{value}</div>
    </div>
  )
}
