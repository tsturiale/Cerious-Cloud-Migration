import { Activity, AlertTriangle, Gauge, Target, Timer, TrendingDown, TrendingUp, Zap } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { useStore } from '../store'
import type { Asset } from '../types'
import { PredictionChart, type ChartDataPoint } from './PredictionChart'

type Tone = 'up' | 'down' | 'warn' | 'accent' | 'neutral'

export type PtbRunwayProduct = {
  provider: string
  symbol: string
  label: string
  subtitle: string
  marketKey?: string
  asset?: Asset
  yes?: number
  no?: number
  truthYes?: number
  truthNo?: number
  spot?: number
  priceToBeat?: number
  expiryTs?: number
}

const EDGE_ACTIONABLE = 12
const EDGE_WATCH = 5
const BRIGHT_RED = '#ff3045'
const BRIGHT_GREEN = '#00d4a4'
const BRIGHT_AMBER = '#f6c343'
const EMPTY_PROB_HISTORY: Array<{ ts: number; up_pct: number }> = []

function clamp(n: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n))
}

function fmtCents(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return '-'
  return `${n.toFixed(1)}c`
}

function fmtSigned(n: number | null | undefined, suffix = 'pp') {
  if (n == null || !Number.isFinite(n)) return '-'
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)} ${suffix}`
}

function fmtPrice(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return '-'
  if (Math.abs(n) >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  if (Math.abs(n) >= 1) return `$${n.toFixed(4)}`
  return `$${n.toFixed(5)}`
}

function fmtTime(ms: number) {
  if (!Number.isFinite(ms)) return '--:--'
  if (ms <= 0) return 'expired'
  const total = Math.floor(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function fmtChartTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function tonePanel(tone: Tone) {
  if (tone === 'up') {
    return {
      bg: 'rgba(0, 212, 164, 0.16)',
      border: 'rgba(0, 212, 164, 0.70)',
      fill: BRIGHT_GREEN,
      text: '#d9fff5',
      label: BRIGHT_GREEN,
    }
  }
  if (tone === 'down') {
    return {
      bg: 'rgba(255, 48, 69, 0.20)',
      border: 'rgba(255, 48, 69, 0.82)',
      fill: BRIGHT_RED,
      text: '#ffe8eb',
      label: '#ff6b78',
    }
  }
  if (tone === 'warn') {
    return {
      bg: 'rgba(246, 195, 67, 0.18)',
      border: 'rgba(246, 195, 67, 0.74)',
      fill: BRIGHT_AMBER,
      text: '#fff5d6',
      label: BRIGHT_AMBER,
    }
  }
  if (tone === 'accent') {
    return {
      bg: 'rgba(58, 237, 255, 0.12)',
      border: 'rgba(58, 237, 255, 0.58)',
      fill: '#3aedff',
      text: '#e4fbff',
      label: '#3aedff',
    }
  }
  return {
    bg: 'rgba(71, 85, 105, 0.20)',
    border: 'rgba(148, 163, 184, 0.40)',
    fill: '#94a3b8',
    text: '#e2e8f0',
    label: '#cbd5e1',
  }
}

function StudyCard({
  label,
  value,
  detail,
  tone,
  icon,
  meter,
}: {
  label: string
  value: string
  detail: string
  tone: Tone
  icon: ReactNode
  meter: number
}) {
  const panel = tonePanel(tone)
  return (
    <div className="rounded border p-2" style={{ backgroundColor: panel.bg, borderColor: panel.border }}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide" style={{ color: panel.label }}>
          {icon}
          {label}
        </span>
        <span className="font-mono text-[11px] font-black" style={{ color: panel.text }}>{value}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-black/35">
        <div className="h-full rounded-full" style={{ width: `${clamp(meter)}%`, backgroundColor: panel.fill }} />
      </div>
      <p className="mt-1 text-[10px] leading-snug" style={{ color: panel.text }}>{detail}</p>
    </div>
  )
}

function ProbabilityArena({
  marketYes,
  truthYes,
  side,
}: {
  marketYes: number
  truthYes: number
  side: 'YES' | 'NO'
}) {
  const lo = Math.min(marketYes, truthYes)
  const hi = Math.max(marketYes, truthYes)
  const marketX = clamp(marketYes)
  const truthX = clamp(truthYes)
  const favorable = side === 'YES' ? truthYes > marketYes : truthYes < marketYes

  return (
    <div
      className="rounded border p-3"
      style={{
        borderColor: favorable ? 'rgba(0, 212, 164, 0.62)' : 'rgba(255, 48, 69, 0.76)',
        background: favorable
          ? 'linear-gradient(90deg, rgba(0, 212, 164, 0.18), rgba(6, 10, 18, 0.96) 58%)'
          : 'linear-gradient(90deg, rgba(255, 48, 69, 0.22), rgba(6, 10, 18, 0.96) 58%)',
      }}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-100">Truth vs Market</span>
        <span className="rounded px-2 py-0.5 font-mono text-[10px] font-black" style={{ backgroundColor: favorable ? 'rgba(0, 212, 164, 0.22)' : 'rgba(255, 48, 69, 0.28)', color: favorable ? '#d9fff5' : '#ffe8eb' }}>
          {favorable ? 'mispricing in your favor' : 'no favorable spread'}
        </span>
      </div>
      <div className="relative h-24 rounded border border-surface-border bg-[#05070b] px-3 py-5">
        <div className="absolute left-3 right-3 top-1/2 h-2 -translate-y-1/2 rounded-full bg-surface-card" />
        <div
          className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full"
          style={{
            left: `calc(12px + ${lo}% * (100% - 24px) / 100)`,
            width: `calc(${hi - lo}% * (100% - 24px) / 100)`,
            backgroundColor: favorable ? 'rgba(0, 212, 164, 0.46)' : 'rgba(255, 48, 69, 0.56)',
          }}
        />
        {[0, 25, 50, 75, 100].map(tick => (
          <div key={tick} className="absolute top-[58px] text-[9px] font-mono text-muted" style={{ left: `calc(12px + ${tick}% * (100% - 24px) / 100)`, transform: 'translateX(-50%)' }}>
            {tick}
          </div>
        ))}
        <div className="absolute top-[26px] h-7 w-px bg-slate-300" style={{ left: `calc(12px + ${marketX}% * (100% - 24px) / 100)` }}>
          <span className="absolute -left-7 -top-5 rounded border border-surface-border bg-surface px-1.5 py-0.5 text-[9px] font-bold text-slate-200">MKT {fmtCents(marketYes)}</span>
        </div>
        <div className="absolute top-[18px] h-11 w-px bg-accent" style={{ left: `calc(12px + ${truthX}% * (100% - 24px) / 100)` }}>
          <span className="absolute -left-8 -top-5 rounded border border-accent/50 bg-accent/15 px-1.5 py-0.5 text-[9px] font-bold text-accent">TRUTH {fmtCents(truthYes)}</span>
        </div>
      </div>
    </div>
  )
}

function PtbRunway({
  spot,
  ptb,
  msLeft,
}: {
  spot: number | null
  ptb: number | null
  msLeft: number
}) {
  const delta = spot != null && ptb != null ? spot - ptb : null
  const above = (delta ?? 0) >= 0
  const deltaPct = spot != null && ptb ? (delta! / ptb) * 100 : null
  const center = ptb ?? spot ?? 1
  const span = Math.max(Math.abs(delta ?? 0) * 2.5, center * 0.001)
  const min = center - span
  const max = center + span
  const spotX = spot != null ? clamp(((spot - min) / (max - min)) * 100) : 50
  const ptbX = ptb != null ? clamp(((ptb - min) / (max - min)) * 100) : 50

  return (
    <div className="rounded border border-surface-border bg-surface-card/70 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-accent">
          <Target size={12} /> PTB Runway
        </span>
        <span className={`font-mono text-[10px] font-bold ${above ? 'text-up' : 'text-down'}`}>
          {delta == null ? 'waiting for PTB' : `${above ? 'above' : 'below'} by ${fmtPrice(Math.abs(delta))}`}
        </span>
      </div>
      <div className="relative h-14 rounded border border-surface-border bg-[#05070b] px-3">
        <div className="absolute left-3 right-3 top-1/2 h-1 -translate-y-1/2 rounded bg-surface-border" />
        <div className="absolute top-3 h-8 w-px bg-slate-400" style={{ left: `calc(12px + ${ptbX}% * (100% - 24px) / 100)` }}>
          <span className="absolute -left-8 -top-3 text-[9px] font-bold text-slate-300">PTB</span>
        </div>
        <div className={`absolute top-2 h-10 w-px ${above ? 'bg-up' : 'bg-down'}`} style={{ left: `calc(12px + ${spotX}% * (100% - 24px) / 100)` }}>
          <span className={`absolute -left-9 top-9 text-[9px] font-bold ${above ? 'text-up' : 'text-down'}`}>SPOT</span>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px]">
        <div><span className="text-muted">spot </span><span className="font-bold text-slate-100">{fmtPrice(spot)}</span></div>
        <div><span className="text-muted">ptb </span><span className="font-bold text-slate-100">{fmtPrice(ptb)}</span></div>
        <div><span className="text-muted">left </span><span className="font-bold text-warn">{fmtTime(msLeft)}</span></div>
      </div>
      {deltaPct != null && <div className="mt-1 font-mono text-[10px] text-muted">distance: {fmtSigned(deltaPct, '%')}</div>}
    </div>
  )
}

function StrengthThermometer({
  label,
  value,
  side,
  orientation = 'horizontal',
}: {
  label: string
  value: number
  side: 'YES' | 'NO'
  orientation?: 'horizontal' | 'vertical'
}) {
  const pct = clamp((Math.abs(value) / EDGE_ACTIONABLE) * 100)
  const actionable = Math.abs(value) >= EDGE_ACTIONABLE
  const watch = Math.abs(value) >= EDGE_WATCH
  const panel = tonePanel(actionable ? 'up' : watch ? 'warn' : 'down')

  if (orientation === 'vertical') {
    return (
      <div className="flex h-full min-h-[220px] items-stretch gap-3 rounded border p-3" style={{ backgroundColor: panel.bg, borderColor: panel.border }}>
        <div className="flex w-12 flex-col items-center justify-between">
          <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: panel.text }}>Strong</span>
          <div className="relative h-36 w-5 overflow-hidden rounded-full border border-surface-border bg-surface-card">
            <div className="absolute bottom-0 left-0 right-0" style={{ height: `${pct}%`, backgroundColor: panel.fill }} />
            <div className="absolute left-0 right-0 top-[58%] border-t border-dashed border-warn/70" />
            <div className="absolute left-0 right-0 top-[25%] border-t border-dashed border-up/70" />
          </div>
          <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: panel.text }}>Flat</span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <div className="text-[10px] font-bold uppercase tracking-wide" style={{ color: panel.label }}>{label}</div>
          <div className="font-mono text-3xl font-black" style={{ color: panel.text }}>{side}</div>
          <div className="font-mono text-xl font-black" style={{ color: panel.text }}>{fmtSigned(value)}</div>
          <p className="mt-2 text-[11px] leading-relaxed" style={{ color: panel.text }}>
            Strength normalizes the best edge against the actionable threshold. The dashed bands mark watch and action zones.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded border p-3" style={{ backgroundColor: panel.bg, borderColor: panel.border }}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: panel.label }}>{label}</span>
        <span className="font-mono text-[12px] font-black" style={{ color: panel.text }}>
          {side} {fmtSigned(value)}
        </span>
      </div>
      <div className="relative h-5 overflow-hidden rounded-full border border-surface-border bg-surface-card">
        <div className="h-full" style={{ width: `${pct}%`, backgroundColor: panel.fill }} />
        <div className="absolute inset-y-0 left-[42%] border-l border-dashed border-warn/70" />
        <div className="absolute inset-y-0 left-full -ml-px border-l border-up/70" />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px]" style={{ color: panel.text }}>
        <span>0</span>
        <span>watch</span>
        <span>action</span>
      </div>
    </div>
  )
}

export function PtbRunwayChart({
  product,
  controls,
}: {
  product?: PtbRunwayProduct
  controls?: ReactNode
}) {
  const activeAsset = useStore(s => s.activeAsset)
  const activeMarketKey = useStore(s => s.activeMarketKey)
  const markets = useStore(s => s.markets)
  const selectedAsset = product?.asset ?? activeAsset
  const selectedMarketKey = product?.marketKey ?? activeMarketKey
  const bars = useStore(s => s.bars[selectedAsset])
  const ticks = useStore(s => s.ticks[selectedAsset])

  const market = selectedMarketKey
    ? markets.find(m => m.key === selectedMarketKey) ?? markets.find(m => m.asset === selectedAsset)
    : markets.find(m => m.asset === selectedAsset)
  const probHistoryMap = useStore(s => s.probHistory)
  const probHistory = selectedMarketKey ? (probHistoryMap[selectedMarketKey] ?? EMPTY_PROB_HISTORY) : EMPTY_PROB_HISTORY
  const lastBar = bars[bars.length - 1]
  const lastTick = ticks[ticks.length - 1]
  const spot = product?.spot ?? lastTick?.price ?? lastBar?.close ?? null
  const ptb = product?.priceToBeat ?? market?.price_to_beat ?? market?.start_price ?? market?.resolution_price ?? null
  const marketYes = product?.yes ?? market?.up_pct ?? 50
  const truthYes = product?.truthYes ?? market?.truth_up_pct ?? marketYes
  const edgeYes = market?.edge_up ?? (truthYes - marketYes)
  const edgeNo = market?.edge_down ?? ((100 - truthYes) - (100 - marketYes))
  const side = edgeYes >= edgeNo ? 'YES' : 'NO'
  const bestEdge = side === 'YES' ? edgeYes : edgeNo
  const msLeft = product?.expiryTs ? product.expiryTs - Date.now() : market?.expiry_ts ? market.expiry_ts - Date.now() : Number.NaN
  const probabilityData = useMemo<ChartDataPoint[]>(() => {
    const historical = probHistory
      .slice(-72)
      .map(point => ({ time: fmtChartTime(point.ts), yesPrice: point.up_pct }))

    if (historical.length >= 2) return historical

    const base = clamp(marketYes)
    const truthBias = clamp(truthYes) - base
    const now = Date.now()

    return [5, 4, 3, 2, 1, 0].map(step => {
      const drift = truthBias * ((5 - step) / 5)
      const wave = Math.sin(step * 1.15) * 2.2
      return {
        time: fmtChartTime(now - step * 60_000),
        yesPrice: clamp(base + drift + wave),
      }
    })
  }, [marketYes, probHistory, truthYes])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
      {controls && <div className="border-b border-surface-border bg-surface-panel p-2">{controls}</div>}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_220px] gap-3 overflow-hidden p-3">
      <div className="min-h-0 overflow-y-auto">
        <div className="mb-3">
          <div className="text-[10px] font-bold uppercase tracking-wide text-accent">PTB Runway</div>
          <div className="truncate text-lg font-black text-slate-100">{product?.label ?? market?.key ?? selectedAsset}</div>
          <div className="truncate text-[11px] text-muted">{product?.subtitle ?? market?.question ?? 'Waiting for market selection'}</div>
        </div>
        <PtbRunway spot={spot} ptb={ptb} msLeft={msLeft} />
        <div className="mt-3">
          <PredictionChart data={probabilityData} height={190} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded border border-surface-border bg-surface-card p-3">
            <div className="text-[10px] font-bold uppercase text-muted">Market YES</div>
            <div className="font-mono text-2xl font-black text-slate-100">{fmtCents(marketYes)}</div>
          </div>
          <div className="rounded border border-surface-border bg-surface-card p-3">
            <div className="text-[10px] font-bold uppercase text-muted">Truth YES</div>
            <div className="font-mono text-2xl font-black text-accent">{fmtCents(truthYes)}</div>
          </div>
        </div>
      </div>
      <StrengthThermometer label="Edge Strength" value={bestEdge} side={side} orientation="vertical" />
      </div>
    </div>
  )
}

export function PtbOpportunityVisual() {
  const activeAsset = useStore(s => s.activeAsset)
  const activeMarketKey = useStore(s => s.activeMarketKey)
  const markets = useStore(s => s.markets)
  const bars = useStore(s => s.bars[activeAsset])
  const ticks = useStore(s => s.ticks[activeAsset])

  const market = markets.find(m => m.key === activeMarketKey) ?? markets.find(m => m.asset === activeAsset)
  const lastBar = bars[bars.length - 1]
  const lastTick = ticks[ticks.length - 1]
  const spot = lastTick?.price ?? lastBar?.close ?? null
  const ptb = market?.price_to_beat ?? market?.start_price ?? market?.resolution_price ?? null
  const marketYes = market?.up_pct ?? 50
  const truthYes = market?.truth_up_pct ?? marketYes
  const edgeYes = market?.edge_up ?? (truthYes - marketYes)
  const edgeNo = market?.edge_down ?? ((100 - truthYes) - (100 - marketYes))
  const side = edgeYes >= edgeNo ? 'YES' : 'NO'
  const bestEdge = side === 'YES' ? edgeYes : edgeNo
  const status = bestEdge >= EDGE_ACTIONABLE ? 'Actionable' : bestEdge >= EDGE_WATCH ? 'Watch' : 'No edge'
  const statusTone: Tone = bestEdge >= EDGE_ACTIONABLE ? 'up' : bestEdge >= EDGE_WATCH ? 'warn' : 'neutral'
  const msLeft = market?.expiry_ts ? market.expiry_ts - Date.now() : Number.NaN
  const gamma = Math.abs(market?.gamma ?? 0)
  const theta = market?.theta ?? 0
  const vanna = Math.abs(market?.vanna ?? 0)
  const charm = market?.charm ?? 0
  const volatility = market?.volatility ?? 0
  const zscore = market?.zscore ?? 0
  const fragile = vanna > 0.01 || volatility > 0.035
  const decayHelp = side === 'YES' ? charm >= 0 : charm <= 0

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#05070b]">
      <div
        className="border-b p-3"
        style={{
          background:
            statusTone === 'up'
              ? 'linear-gradient(135deg, rgba(0, 212, 164, 0.24), rgba(8, 12, 20, 0.98) 62%)'
              : statusTone === 'warn'
                ? 'linear-gradient(135deg, rgba(246, 195, 67, 0.24), rgba(8, 12, 20, 0.98) 62%)'
                : 'linear-gradient(135deg, rgba(255, 48, 69, 0.28), rgba(8, 12, 20, 0.98) 62%)',
          borderColor:
            statusTone === 'up'
              ? 'rgba(0, 212, 164, 0.62)'
              : statusTone === 'warn'
                ? 'rgba(246, 195, 67, 0.62)'
                : 'rgba(255, 48, 69, 0.72)',
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-100">PTB Opportunity Map</div>
            <div className="mt-1 truncate text-xs font-bold text-slate-100">{market?.key ?? activeAsset}</div>
            <div className="truncate text-[10px] text-slate-300">{market?.question ?? 'Waiting for market selection'}</div>
          </div>
          <div
            className="rounded border px-3 py-2 text-right"
            style={{
              backgroundColor: tonePanel(statusTone === 'neutral' ? 'down' : statusTone).bg,
              borderColor: tonePanel(statusTone === 'neutral' ? 'down' : statusTone).border,
            }}
          >
            <div className="text-[9px] font-bold uppercase tracking-wide text-slate-100">Opportunity</div>
            <div className="font-mono text-lg font-black" style={{ color: tonePanel(statusTone === 'neutral' ? 'down' : statusTone).text }}>{status}</div>
            <div className="font-mono text-[11px] text-slate-200">{side} {fmtSigned(bestEdge)}</div>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="grid gap-3">
          <ProbabilityArena marketYes={marketYes} truthYes={truthYes} side={side} />
          <StrengthThermometer label="Action Strength" value={bestEdge} side={side} />
          <PtbRunway spot={spot} ptb={ptb} msLeft={msLeft} />
        </div>

        <div className="mt-3 grid gap-2">
          <StudyCard
            label="Edge"
            value={`${side} ${fmtSigned(bestEdge)}`}
            detail="Truth probability minus market-implied probability. This is the primary mispricing signal."
            tone={statusTone}
            icon={side === 'YES' ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            meter={(bestEdge / EDGE_ACTIONABLE) * 100}
          />
          <StudyCard
            label="Gamma"
            value={gamma.toFixed(4)}
            detail="Acceleration risk near PTB. Higher gamma means small spot changes can quickly reprice the binary."
            tone={gamma > 0.02 ? 'warn' : 'accent'}
            icon={<Zap size={12} />}
            meter={(gamma / 0.05) * 100}
          />
          <StudyCard
            label="Theta"
            value={theta.toFixed(4)}
            detail="Time decay pressure. In short windows, decay can turn a small edge into a closing edge."
            tone={Math.abs(theta) > 0.005 ? 'down' : 'neutral'}
            icon={<Timer size={12} />}
            meter={(Math.abs(theta) / 0.015) * 100}
          />
          <StudyCard
            label="Vanna"
            value={(market?.vanna ?? 0).toFixed(4)}
            detail={fragile ? 'Fragility warning: this edge may depend on volatility staying elevated.' : 'Vol sensitivity is contained, so the edge is less volatility-fragile.'}
            tone={fragile ? 'warn' : 'up'}
            icon={<AlertTriangle size={12} />}
            meter={(vanna / 0.03) * 100}
          />
          <StudyCard
            label="Charm"
            value={charm.toFixed(4)}
            detail={decayHelp ? 'Delta bleed is aligned with the selected side.' : 'Delta bleed is working against the selected side.'}
            tone={decayHelp ? 'up' : 'warn'}
            icon={<Gauge size={12} />}
            meter={(Math.abs(charm) / 0.08) * 100}
          />
          <StudyCard
            label="Regime"
            value={`${(volatility * 100).toFixed(2)}% vol`}
            detail={`Z-score ${zscore.toFixed(2)}. ATR and volatility gate whether the opportunity is structural or noisy.`}
            tone={volatility > 0.035 ? 'warn' : volatility > 0.02 ? 'accent' : 'neutral'}
            icon={<Activity size={12} />}
            meter={(volatility / 0.08) * 100}
          />
        </div>

        <div className="mt-3 rounded border border-surface-border bg-surface-card/70 p-3">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-accent">Decision Narrative</div>
          <div className="grid gap-2 text-[11px] leading-relaxed text-slate-300">
            <p>
              <span className="font-bold text-slate-100">1. Mispricing:</span> {side} is favored because its truth edge is {fmtSigned(bestEdge)} versus market price.
            </p>
            <p>
              <span className="font-bold text-slate-100">2. PTB context:</span> spot is {spot != null && ptb != null ? (spot >= ptb ? 'above' : 'below') : 'waiting for'} the price-to-beat with {fmtTime(msLeft)} remaining.
            </p>
            <p>
              <span className="font-bold text-slate-100">3. Risk filter:</span> {fragile ? 'Vanna/volatility says this edge is fragile.' : 'Vanna/volatility does not currently flag the edge as fragile.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
