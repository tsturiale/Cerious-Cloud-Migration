import { useEffect, useState } from 'react'
import { useStore } from '../store'
import type { Asset, TimeFrame, MarketInfo, KalshiMarket, IbkrMarket } from '../types'
import { TIMEFRAME_LABELS } from '../types'
import { useCountdown, fmtCountdown, parseTimeWindow, PERIOD_SECS } from './RotationCountdown'

const ASSETS: Asset[] = ['ES', 'NQ', 'YM', 'RTY', 'CL', 'GC', 'ZM', 'ZS', 'ES_NQ', 'YM_ES', 'RTY_ES']
const TIMEFRAMES: TimeFrame[] = ['5min', '15min', '1h', '4h']

const ASSET_ICONS: Record<Asset, string> = {
  ES: 'ES', NQ: 'NQ', YM: 'YM', RTY: 'RT', CL: 'CL', GC: 'GC', ZM: 'ZM', ZS: 'ZS',
  ES_NQ: 'EN', YM_ES: 'YE', RTY_ES: 'RE',
  BTC: '₿', ETH: 'Ξ', SOL: '◎', XRP: '✕', HYPE: 'H', BNB: '⬣', DOGE: 'Ð',
  EVENT: '◈',
}

// ── Health polling ────────────────────────────────────────────────────────────

interface HealthState {
  clob_connected: boolean
  clob_age_s: number | null
  live_active: number
  total_active: number
  kraken_age_s: number | null
  ok: boolean
}

function useHealthPoll(intervalMs = 10_000): HealthState {
  const [health, setHealth] = useState<HealthState>({
    clob_connected: false, clob_age_s: null,
    live_active: 0, total_active: 0, kraken_age_s: null, ok: false,
  })

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const r = await fetch('/api/health')
        if (!r.ok || cancelled) return
        const d = await r.json()
        if (cancelled) return
        setHealth({
          clob_connected: d.clob_ws?.connected ?? false,
          clob_age_s: d.clob_ws?.last_msg_age_s ?? null,
          live_active: d.markets?.active_live ?? 0,
          total_active: (d.markets?.active_live ?? 0) + (d.markets?.active_non_live ?? 0),
          kraken_age_s: d.kraken_ws?.last_msg_age_s ?? null,
          ok: d.status === 'ok',
        })
      } catch { /* silently ignore */ }
    }
    poll()
    const t = setInterval(poll, intervalMs)
    return () => { cancelled = true; clearInterval(t) }
  }, [intervalMs])

  return health
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TF_SHORT: Record<string, string> = {
  '5min': '5m', '15min': '15m', '1h': '1h', '4h': '4h',
}

function formatVolume(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}

function formatVolumeFull(v: number): string {
  const n = Number.isFinite(v) ? v : 0
  return `$${Math.round(n).toLocaleString()}`
}

/** Compact price with context-appropriate decimals */
function fmtPrice(p: number): string {
  if (p >= 10_000) return p.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (p >= 1_000)  return p.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (p >= 100)    return p.toFixed(2)
  if (p >= 1)      return p.toFixed(3)
  return p.toFixed(4)
}

/** "3s" / "12s" / "1m 4s" / "stale" age label */

// ── Sub-components ────────────────────────────────────────────────────────────

function MarketCard({ market }: { market: MarketInfo }) {
  const activeKey          = useStore(s => s.activeMarketKey)
  const setActiveMarketKey = useStore(s => s.setActiveMarketKey)
  const cryptoPrices       = useStore(s => s.cryptoPrices)
  const isActive           = activeKey === market.key

  const upHigh   = market.up_pct > market.down_pct
  const tfShort  = TF_SHORT[market.timeframe] ?? market.timeframe

  // Countdown — always tracked, only displayed when active
  const secs      = useCountdown(market.expiry_ts)
  const totalSecs = PERIOD_SECS[market.timeframe] ?? 300
  const barPct    = Math.max(0, Math.min(100, (secs / totalSecs) * 100))
  const urgent    = isActive && secs <= 30

  // Live spot price from Dome/Binance (updated every 5 s via CryptoPriceStrip)
  const spotPrice = cryptoPrices[market.asset]?.price ?? 0

  // Price-to-beat: prefer authoritative price_to_beat, fallback to start_price
  const ptbRaw = market.price_to_beat ?? market.start_price
  const ptb = typeof ptbRaw === 'number' && ptbRaw > 0 ? ptbRaw : null

  const isAbovePtb = ptb != null && spotPrice > 0 ? spotPrice >= ptb : null
  const delta      = ptb != null && spotPrice > 0 ? spotPrice - ptb : null
  const deltaPct   = ptb != null && spotPrice > 0 ? ((spotPrice - ptb) / ptb) * 100 : null

  return (
    <div className="space-y-0.5">
      <button
        onClick={() => setActiveMarketKey(isActive ? null : market.key)}
        className={`w-full text-left px-2 py-1.5 rounded transition-all border ${isActive
          ? 'border-accent/60 bg-accent/10'
          : 'border-surface-border/50 hover:border-surface-border hover:bg-surface-hover'
        }`}
      >
        {/* Row 1: Asset icon + probs */}
        <div className="flex items-center justify-between gap-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-bold text-slate-300 w-4">{ASSET_ICONS[market.asset]}</span>
            <span className="text-xs font-semibold text-slate-200">{market.asset}</span>
            {market.live ? (
              <span className="text-2xs px-0.5 rounded bg-up/15 text-up font-mono">LIVE</span>
            ) : (
              <span className="text-2xs px-0.5 rounded bg-surface text-muted font-mono">N/A</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <div className="flex flex-col items-end">
              <span className={`text-2xs font-mono font-bold px-1 py-0.5 rounded ${upHigh ? 'bg-up/20 text-up' : 'bg-surface text-up/70'}`}>
                ▲ {market.up_pct.toFixed(1)}%
              </span>
              {market.truth_up_pct != null && (
                <span className="text-[9px] font-mono text-accent -mt-0.5" title="Truth Engine probability">
                  {market.truth_up_pct.toFixed(1)}%
                </span>
              )}
            </div>
            <div className="flex flex-col items-end">
              <span className={`text-2xs font-mono font-bold px-1 py-0.5 rounded ${!upHigh ? 'bg-down/20 text-down' : 'bg-surface text-down/70'}`}>
                ▼ {market.down_pct.toFixed(1)}%
              </span>
              {market.truth_down_pct != null && (
                <span className="text-[9px] font-mono text-slate-400 -mt-0.5" title="Truth Engine probability">
                  {market.truth_down_pct.toFixed(1)}%
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Row 2: Spot price + PTB */}
        <div className="flex items-center justify-between gap-1 mt-1">
          {/* Spot price */}
          <div className="flex flex-col items-start">
            <span className="text-[8px] font-mono text-muted/50 leading-none">SPOT</span>
            <span className="text-[11px] font-bold font-mono tabular-nums text-slate-200">
              {spotPrice > 0 ? `$${fmtPrice(spotPrice)}` : '—'}
            </span>
          </div>

          {/* PTB with above/below indicator */}
          {ptb != null ? (
            <div className="flex flex-col items-end">
              <span className="text-[8px] font-mono text-cyan-400/60 leading-none">PTB</span>
              <span className="text-[11px] font-semibold font-mono tabular-nums text-cyan-400">
                ${fmtPrice(ptb)}
              </span>
            </div>
          ) : (
            <span className="text-[9px] font-mono text-muted/30 italic">no PTB</span>
          )}

          {/* Delta badge — above/below PTB */}
          {isAbovePtb != null && delta != null && deltaPct != null && (
            <div
              className="flex flex-col items-center px-1 py-0.5 rounded"
              style={{
                background: isAbovePtb ? 'rgba(0,212,164,0.12)' : 'rgba(255,71,87,0.12)',
                border: `1px solid ${isAbovePtb ? 'rgba(0,212,164,0.3)' : 'rgba(255,71,87,0.3)'}`,
              }}
            >
              <span
                className="text-[9px] font-bold font-mono leading-none"
                style={{ color: isAbovePtb ? '#00d4a4' : '#ff4757' }}
              >
                {isAbovePtb ? '▲' : '▼'}
              </span>
              <span
                className="text-[8px] font-mono tabular-nums leading-none"
                style={{ color: isAbovePtb ? '#00d4a4cc' : '#ff4757cc' }}
              >
                {Math.abs(deltaPct).toFixed(2)}%
              </span>
            </div>
          )}
        </div>

        {/* Row 3: Volume + timeframe + countdown */}
        <div className="flex items-center justify-between mt-1">
          <span className="text-2xs text-muted font-mono" title={formatVolume(market.volume)}>
            {formatVolumeFull(market.volume)}
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-2xs font-mono text-muted/50">{tfShort}</span>
            {isActive && market.live && (
              <span className={`text-2xs font-mono font-bold tabular-nums
                ${urgent ? 'text-amber-400' : 'text-accent/80'}`}>
                {fmtCountdown(secs)}
              </span>
            )}
          </div>
        </div>

        {/* Row 4: Draining countdown bar (active) or static rail */}
        <div className="mt-1 h-[2px] w-full rounded-full bg-surface-border overflow-hidden">
          {isActive && market.live ? (
            <div
              className={`h-full rounded-full transition-all duration-1000 ease-linear
                ${urgent ? 'bg-amber-400' : 'bg-accent/70'}`}
              style={{ width: `${barPct}%` }}
            />
          ) : (
            <div className="h-full w-full rounded-full bg-accent/30" />
          )}
        </div>
      </button>

      {/* NEXT UP — staged market preview, shown only on the active card */}
      {isActive && market.live && market.staged_market && (
        <div className="ml-1 px-2 py-1 rounded bg-surface border border-accent/15">
          <div className="flex items-center gap-1 text-[9px] font-mono text-accent/50 font-bold uppercase tracking-wider mb-0.5">
            <span>▸ NEXT UP</span>
          </div>
          <div className="flex items-center justify-between gap-1">
            <span className="text-[9px] font-mono text-slate-400 truncate">
              {parseTimeWindow(market.staged_market.question)}
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[9px] font-mono text-up font-semibold">
                ▲{market.staged_market.up_pct.toFixed(1)}%
              </span>
              <span className="text-[9px] font-mono text-down font-semibold">
                ▼{market.staged_market.down_pct.toFixed(1)}%
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Status header ─────────────────────────────────────────────────────────────

function DataSourceHeader({ health, usingLiveData }: {
  health: HealthState
  usingLiveData: boolean
}) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  if (!usingLiveData) {
    return (
      <div className="px-2 pt-1.5 pb-1 flex items-center gap-1.5">
        <div className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse" />
        <span className="text-2xs font-mono text-warn">No Live Markets</span>
      </div>
    )
  }

  const clobOk = health.clob_connected && (health.clob_age_s === null || health.clob_age_s < 60)
  const krakenOk = health.kraken_age_s !== null && health.kraken_age_s < 30
  const allOk = clobOk && krakenOk && health.live_active > 0

  // Dot color: green = fully live, yellow = partial, red = no data
  const dotClass = allOk
    ? 'bg-up animate-pulse'
    : health.live_active > 0
      ? 'bg-warn animate-pulse'
      : 'bg-down'

  return (
    <div className="px-2 pt-1.5 pb-1 flex flex-col gap-0.5">
      {/* Main status row */}
      <div className="flex items-center gap-1.5">
        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotClass}`} />
        <span className="text-2xs font-mono text-muted">
          Polymarket Live
        </span>
        <span className={`ml-auto text-2xs font-mono font-semibold ${health.live_active === health.total_active ? 'text-up' : 'text-warn'
          }`}>
          {health.live_active}/{health.total_active}
        </span>
      </div>
      {/* WS telemetry row — MKT age only, CLOB moved to header */}
      <div className="flex items-center gap-2 pl-3">
        {health.kraken_age_s !== null && (
          <span className={`text-2xs font-mono ${krakenOk ? 'text-muted/60' : 'text-warn'}`}>
            MKT {Math.round(health.kraken_age_s)}s
          </span>
        )}
      </div>
    </div>
  )
}

// ── Kalshi + IBKR market lists ────────────────────────────────────────────────

function formatProb(p: number): string {
  return `${(p * 100).toFixed(0)}¢`
}

function KalshiMarketList({ markets }: { markets: KalshiMarket[] }) {
  const activeKey = useStore(s => s.activeMarketKey)
  const setActiveMarketKey = useStore(s => s.setActiveMarketKey)
  const liveMarkets = useStore(s => s.markets)

  const wsKalshi = liveMarkets.filter(m => (m as any).provider === 'kalshi')

  if (wsKalshi.length > 0) {
    const byCategory = wsKalshi.reduce<Record<string, typeof wsKalshi>>((acc, m) => {
      const cat = m.category || 'Other'
      ;(acc[cat] ??= []).push(m)
      return acc
    }, {})

    return (
      <div className="flex flex-col h-full overflow-y-auto">
        <div className="px-2 pt-1.5 pb-1 flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
          <span className="text-2xs font-mono text-muted">Kalshi</span>
          <span className="ml-auto text-2xs font-mono text-violet-400">{wsKalshi.length}</span>
        </div>
        {Object.entries(byCategory).map(([cat, items]) => (
          <div key={cat} className="border-t border-surface-border/50">
            <div className="px-2 py-1 flex items-center gap-2">
              <span className="text-2xs font-semibold text-muted uppercase tracking-wider">{cat}</span>
              <div className="flex-1 h-px bg-surface-border/30" />
            </div>
            <div className="px-1.5 pb-1.5 space-y-1">
              {items.map(m => {
                const isActive = activeKey === m.key
                const yes = (m.up_pct ?? 50) / 100
                const no = (m.down_pct ?? 50) / 100
                return (
                  <button
                    key={m.key}
                    onClick={() => setActiveMarketKey(isActive ? null : m.key)}
                    className={`w-full text-left px-2 py-1.5 rounded border transition-all ${
                      isActive
                        ? 'border-violet-500/60 bg-violet-500/10'
                        : 'border-surface-border/50 hover:border-surface-border hover:bg-surface-hover'
                    }`}
                  >
                    <div className="text-2xs text-slate-300 leading-tight mb-1 line-clamp-2">{m.question}</div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1">
                        <span className="text-2xs font-mono font-bold px-1 py-0.5 rounded bg-up/20 text-up">
                          Y {formatProb(yes)}
                        </span>
                        <span className="text-2xs font-mono font-bold px-1 py-0.5 rounded bg-down/10 text-down/80">
                          N {formatProb(no)}
                        </span>
                      </div>
                      <span className="text-2xs font-mono text-muted" title={formatVolume(m.volume)}>
                        {formatVolumeFull(m.volume)}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (markets.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-2 pt-1.5 pb-1 flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-violet-400/60" />
          <span className="text-2xs font-mono text-muted">Kalshi Markets</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-2xs text-muted font-mono">
          No markets — add API key in Settings
        </div>
      </div>
    )
  }

  const byCategory = markets.reduce<Record<string, KalshiMarket[]>>((acc, m) => {
    const cat = m.category || 'Other'
    ;(acc[cat] ??= []).push(m)
    return acc
  }, {})

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-2 pt-1.5 pb-1 flex items-center gap-1.5">
        <div className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
        <span className="text-2xs font-mono text-muted">Kalshi</span>
        <span className="ml-auto text-2xs font-mono text-violet-400">{markets.length}</span>
      </div>
      {Object.entries(byCategory).map(([cat, items]) => (
        <div key={cat} className="border-t border-surface-border/50">
          <div className="px-2 py-1 flex items-center gap-2">
            <span className="text-2xs font-semibold text-muted uppercase tracking-wider">{cat}</span>
            <div className="flex-1 h-px bg-surface-border/30" />
          </div>
          <div className="px-1.5 pb-1.5 space-y-1">
            {items.map(m => {
              const isActive = activeKey === m.id
              return (
                <button
                  key={m.id}
                  onClick={() => setActiveMarketKey(isActive ? null : m.id)}
                  className={`w-full text-left px-2 py-1.5 rounded border transition-all ${
                    isActive
                      ? 'border-violet-500/60 bg-violet-500/10'
                      : 'border-surface-border/50 hover:border-surface-border hover:bg-surface-hover'
                  }`}
                >
                  <div className="text-2xs text-slate-300 leading-tight mb-1 line-clamp-2">{m.title}</div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <span className="text-2xs font-mono font-bold px-1 py-0.5 rounded bg-up/20 text-up">
                        Y {formatProb(m.yes_price)}
                      </span>
                      <span className="text-2xs font-mono font-bold px-1 py-0.5 rounded bg-down/10 text-down/80">
                        N {formatProb(m.no_price)}
                      </span>
                    </div>
                    <span className="text-2xs font-mono text-muted" title={formatVolume(m.volume)}>
                      {formatVolumeFull(m.volume)}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

function IbkrMarketList({ markets }: { markets: IbkrMarket[] }) {
  const activeKey = useStore(s => s.activeMarketKey)
  const setActiveMarketKey = useStore(s => s.setActiveMarketKey)
  const liveMarkets = useStore(s => s.markets)

  const wsIbkr = liveMarkets.filter(m => (m as any).provider === 'forecasttrader')

  if (wsIbkr.length > 0) {
    const byCategory = wsIbkr.reduce<Record<string, typeof wsIbkr>>((acc, m) => {
      const cat = m.category || 'Other'
      ;(acc[cat] ??= []).push(m)
      return acc
    }, {})

    return (
      <div className="flex flex-col h-full overflow-y-auto">
        <div className="px-2 pt-1.5 pb-1 flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-2xs font-mono text-muted">IBKR ForecastTrader</span>
          <span className="ml-auto text-2xs font-mono text-emerald-400">{wsIbkr.length}</span>
        </div>
        {Object.entries(byCategory).map(([cat, items]) => (
          <div key={cat} className="border-t border-surface-border/50">
            <div className="px-2 py-1 flex items-center gap-2">
              <span className="text-2xs font-semibold text-muted uppercase tracking-wider">{cat}</span>
              <div className="flex-1 h-px bg-surface-border/30" />
            </div>
            <div className="px-1.5 pb-1.5 space-y-1">
              {items.map(m => {
                const isActive = activeKey === m.key
                const yes = (m.up_pct ?? 50) / 100
                const no = (m.down_pct ?? 50) / 100
                return (
                  <button
                    key={m.key}
                    onClick={() => setActiveMarketKey(isActive ? null : m.key)}
                    className={`w-full text-left px-2 py-1.5 rounded border transition-all ${
                      isActive
                        ? 'border-emerald-500/60 bg-emerald-500/10'
                        : 'border-surface-border/50 hover:border-surface-border hover:bg-surface-hover'
                    }`}
                  >
                    <div className="text-2xs text-slate-300 leading-tight mb-1 line-clamp-2">{m.question}</div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1">
                        <span className="text-2xs font-mono font-bold px-1 py-0.5 rounded bg-up/20 text-up">
                          Y {formatProb(yes)}
                        </span>
                        <span className="text-2xs font-mono font-bold px-1 py-0.5 rounded bg-down/10 text-down/80">
                          N {formatProb(no)}
                        </span>
                      </div>
                      <span className="text-2xs font-mono text-muted" title={formatVolume(m.volume)}>
                        {formatVolumeFull(m.volume)}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (markets.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-2 pt-1.5 pb-1 flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400/60" />
          <span className="text-2xs font-mono text-muted">IBKR ForecastTrader</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-2xs text-muted font-mono">
          No markets — add API key in Settings
        </div>
      </div>
    )
  }

  const byCategory = markets.reduce<Record<string, IbkrMarket[]>>((acc, m) => {
    const cat = m.category || 'Other'
    ;(acc[cat] ??= []).push(m)
    return acc
  }, {})

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-2 pt-1.5 pb-1 flex items-center gap-1.5">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-2xs font-mono text-muted">IBKR ForecastTrader</span>
        <span className="ml-auto text-2xs font-mono text-emerald-400">{markets.length}</span>
      </div>
      {Object.entries(byCategory).map(([cat, items]) => (
        <div key={cat} className="border-t border-surface-border/50">
          <div className="px-2 py-1 flex items-center gap-2">
            <span className="text-2xs font-semibold text-muted uppercase tracking-wider">{cat}</span>
            <div className="flex-1 h-px bg-surface-border/30" />
          </div>
          <div className="px-1.5 pb-1.5 space-y-1">
            {items.map(m => {
              const isActive = activeKey === m.conid
              return (
                <button
                  key={m.conid}
                  onClick={() => setActiveMarketKey(isActive ? null : m.conid)}
                  className={`w-full text-left px-2 py-1.5 rounded border transition-all ${
                    isActive
                      ? 'border-emerald-500/60 bg-emerald-500/10'
                      : 'border-surface-border/50 hover:border-surface-border hover:bg-surface-hover'
                  }`}
                >
                  <div className="text-2xs text-slate-300 leading-tight mb-1 line-clamp-2">{m.title}</div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <span className="text-2xs font-mono font-bold px-1 py-0.5 rounded bg-up/20 text-up">
                        Y {formatProb(m.yes_price)}
                      </span>
                      <span className="text-2xs font-mono font-bold px-1 py-0.5 rounded bg-down/10 text-down/80">
                        N {formatProb(m.no_price)}
                      </span>
                    </div>
                    <span className="text-2xs font-mono text-muted" title={formatVolume(m.volume)}>
                      {formatVolumeFull(m.volume)}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Truth Engine panel (bottom of MarketNav) ─────────────────────────────────

function TruthEngineFooter() {
  const market = useStore(s => s.markets.find(m => m.key === s.activeMarketKey))
  const [collapsed, setCollapsed] = useState(false)

  if (!market || market.truth_up_pct == null) return null

  const upPct   = market.truth_up_pct   ?? 0
  const dnPct   = market.truth_down_pct ?? 0
  const gamma   = market.gamma   ?? null
  const theta   = market.theta   ?? null
  const vega    = market.vega    ?? null
  const vanna   = market.vanna   ?? null
  const charm   = market.charm   ?? null
  const edgeUp  = market.edge_up  ?? null
  const edgeDn  = market.edge_down ?? null
  const truthFeatureSource = market.truth_feature_source ?? '1m_fallback'
  const is20sDriven = truthFeatureSource === '20s'

  const mktUpPct = market.up_pct ?? 0
  const bias = upPct - mktUpPct          // positive = model says more likely UP than market

  return (
    <div className="shrink-0 border-t border-surface-border bg-surface-card/30">
      {/* Header */}
      <button
        className="w-full flex items-center justify-between px-2 py-1 hover:bg-surface-hover transition-colors"
        onClick={() => setCollapsed(c => !c)}
      >
        <span className="text-[9px] font-bold uppercase tracking-widest text-accent/80">⬡ Truth Engine</span>
        <div className="flex items-center gap-1.5">
          <span className="text-[8px] font-mono text-muted/50">{market.asset} {market.timeframe}</span>
          <span
            className={`text-[8px] font-mono px-1 py-0.5 rounded border ${
              is20sDriven
                ? 'text-cyan-300 border-cyan-400/40 bg-cyan-500/10'
                : 'text-amber-300 border-amber-400/40 bg-amber-500/10'
            }`}
            title={is20sDriven ? 'Truth Engine source: 20-second features' : 'Truth Engine source: 1-minute fallback features'}
          >
            {is20sDriven ? '20s' : '1m fb'}
          </span>
          <span className="text-[8px] text-muted/40">{collapsed ? '▲' : '▼'}</span>
        </div>
      </button>

      {!collapsed && (
        <div className="px-2 pb-2 space-y-1.5">
          {/* Truth UP / DN probabilities */}
          <div className="grid grid-cols-2 gap-1">
            <div className="flex flex-col items-center rounded px-1 py-0.5 border border-up/20 bg-up/8">
              <span className="text-[7px] text-muted/50 uppercase leading-none">Truth UP</span>
              <span className="text-[13px] font-black tabular-nums leading-snug text-up">{upPct.toFixed(1)}%</span>
            </div>
            <div className="flex flex-col items-center rounded px-1 py-0.5 border border-down/20 bg-down/8">
              <span className="text-[7px] text-muted/50 uppercase leading-none">Truth DN</span>
              <span className="text-[13px] font-black tabular-nums leading-snug text-down">{dnPct.toFixed(1)}%</span>
            </div>
          </div>

          {/* Edge vs market */}
          <div className="flex items-center justify-between px-1">
            <span className="text-[8px] text-muted/60 font-mono">vs mkt</span>
            <span className={`text-[9px] font-bold font-mono tabular-nums ${
              Math.abs(bias) < 1 ? 'text-muted/50' : bias > 0 ? 'text-up' : 'text-down'
            }`}>
              {bias >= 0 ? '+' : ''}{bias.toFixed(1)}%
            </span>
            <span className="text-[8px] text-muted/60 font-mono">
              {edgeUp != null && edgeDn != null
                ? `e↑${edgeUp.toFixed(2)} e↓${edgeDn.toFixed(2)}`
                : ''}
            </span>
          </div>

          {/* Greeks grid: Γ Θ ν Λ Ch */}
          <div className="grid grid-cols-5 gap-0.5">
            {([
              { sym: 'Γ',  val: gamma },
              { sym: 'Θ',  val: theta },
              { sym: 'ν',  val: vega  },
              { sym: 'Λ',  val: vanna },
              { sym: 'Ch', val: charm },
            ] as { sym: string; val: number | null }[]).map(({ sym, val }) => (
              <div key={sym} className="flex flex-col items-center bg-surface/50 rounded py-0.5">
                <span className="text-[7px] text-muted/40 font-mono leading-none">{sym}</span>
                <span className="text-[8px] font-mono tabular-nums leading-none text-slate-300">
                  {val != null ? val.toFixed(3) : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

export function MarketNav() {
  const markets = useStore(s => s.markets)
  const usingLiveData = useStore(s => s.usingLiveData)
  const marketProvider = useStore(s => s.marketProvider)
  const kalshiMarkets = useStore(s => s.kalshiMarkets)
  const ibkrMarkets = useStore(s => s.ibkrMarkets)
  const health = useHealthPoll(10_000)

  if (marketProvider === 'kalshi') {
    return <KalshiMarketList markets={kalshiMarkets} />
  }
  if (marketProvider === 'forecasttrader') {
    return <IbkrMarketList markets={ibkrMarkets} />
  }

  const byTimeframe: Record<TimeFrame, MarketInfo[]> = {
    '20sec': [],
    '5min': [], '15min': [], '1h': [], '4h': [],
    'event': [],
  }

  for (const m of markets) {
    if (m.timeframe in byTimeframe) {
      byTimeframe[m.timeframe as TimeFrame].push(m)
    }
  }

  for (const tf of TIMEFRAMES) {
    byTimeframe[tf].sort((a, b) =>
      ASSETS.indexOf(a.asset as Asset) - ASSETS.indexOf(b.asset as Asset)
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Scrollable market cards */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <DataSourceHeader health={health} usingLiveData={usingLiveData} />

        {TIMEFRAMES.map(tf => {
          const group = byTimeframe[tf]
          return (
            <div key={tf} className="border-t border-surface-border/50">
              <div className="px-2 py-1 flex items-center gap-2">
                <span className="text-2xs font-semibold text-muted uppercase tracking-wider">
                  {TIMEFRAME_LABELS[tf]}
                </span>
                <div className="flex-1 h-px bg-surface-border/30" />
              </div>
              <div className="px-1.5 pb-1.5 space-y-1.5">
                {group.length === 0 ? (
                  <div className="text-2xs text-muted font-mono px-1 py-2 text-center">
                    {usingLiveData ? `No live ${TIMEFRAME_LABELS[tf]}` : 'Fetching...'}
                  </div>
                ) : (
                  group.map(m => (
                    <MarketCard key={m.key} market={m} />
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Truth Engine — pinned at bottom */}
      <TruthEngineFooter />
    </div>
  )
}
