/**
 * PaperTrade — Simulated Polymarket trading, signal automation, and backtest.
 *
 * Tabs:
 *   Trade    — Manual order entry + live open positions
 *   Signals  — Live model signals with one-click paper-trade + auto-fire toggle
 *   Backtest — Run mean-reversion / momentum / threshold strategy on prob history
 *   Report   — Equity curve + stats + full trade log
 *
 * State is kept in React local state and persisted to localStorage so sessions
 * survive page reloads.  No backend changes required.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useStore } from '../store'
import type { Signal, ModelName } from '../types'
import { MODEL_LABELS, MODEL_COLORS, normalizeModel } from '../types'

// ── Local types ────────────────────────────────────────────────────────────────

interface PaperPosition {
  id:         string
  marketKey:  string
  question:   string
  side:       'yes' | 'no'
  model?:     ModelName
  /** YES-token probability at entry, 0–100 */
  entryPrice: number
  shares:     number
  /** USD invested */
  size:       number
  entryTime:  number   // unix ms
  source:     'manual' | 'signal' | 'backtest'
}

interface PaperRecord extends PaperPosition {
  exitPrice:  number
  exitTime:   number
  grossPnl:   number   // price-movement P&L before fees
  entryFee:   number   // fee paid on entry
  exitFee:    number   // fee paid on exit
  pnl:        number   // net after both fees
  exitReason: 'manual' | 'stop' | 'take_profit' | 'rollover' | 'signal'
}

interface LifetimeStats {
  totalPnl:    number
  wins:        number
  count:       number
  maxDrawdown: number
  peakPnl:     number
  totalFees:   number  // cumulative fees paid
}

interface BacktestConfig {
  marketKey:    string
  strategy:     'mean_reversion' | 'momentum' | 'threshold'
  buyYesBelow:  number   // e.g. 35 — buy YES when prob < this
  buyNoAbove:   number   // e.g. 65 — buy NO when prob > this
  exitTarget:   number   // e.g. 50 — exit toward mid
  stopLoss:     number   // % of investment, e.g. 50 → exit at -50 %
  takeProfit:   number   // % of investment, e.g. 100 → exit at +100 %
  tradeSize:    number   // USD per trade
}

// ── Maths ─────────────────────────────────────────────────────────────────────

/**
 * P&L for a paper trade.
 * entryProb / exitProb are always the YES-token probability (0–100).
 * For a NO trade we invert internally.
 */
function calcPnl(
  side:      'yes' | 'no',
  entryProb: number,
  exitProb:  number,
  size:      number,
): number {
  if (side === 'yes') {
    const shares = size / (entryProb / 100)
    return shares * (exitProb - entryProb) / 100
  }
  // NO trade — you hold NO tokens
  const noEntry = (100 - entryProb) / 100
  const noExit  = (100 - exitProb)  / 100
  const shares  = size / noEntry
  return shares * (noExit - noEntry)
}

// ── Polymarket fee model ───────────────────────────────────────────────────────
// Source: https://docs.polymarket.com/trading/fees
// Formula: fee = C × feeRate × p × (1 - p)
//   C        = shares traded
//   feeRate  = category-specific taker rate (crypto = 7.2%)
//   p        = token price as 0–1 probability
// Fees peak at p = 0.50 and approach zero at 0¢ and 100¢.
// Maker orders pay 0%; only takers pay fees.

const POLY_FEE_RATE_CRYPTO = 0.072   // 7.2% — crypto markets
const POLY_FEE_RATE_SPORTS  = 0.03   // 3.0% — sports
const POLY_FEE_RATE_FINANCE = 0.04   // 4.0% — finance / politics / tech

/** Polymarket taker fee for one leg of a trade. p must be 0–1. */
function calcFee(shares: number, p: number, feeRate = POLY_FEE_RATE_CRYPTO): number {
  return shares * feeRate * p * (1 - p)
}

/** Full fee-aware P&L breakdown for a closed trade. */
function calcNetPnl(
  side:      'yes' | 'no',
  entryProb: number,  // YES probability 0–100
  exitProb:  number,
  size:      number,
  feeRate = POLY_FEE_RATE_CRYPTO,
): { gross: number; entryFee: number; exitFee: number; net: number; shares: number } {
  const entryP = (side === 'yes' ? entryProb : 100 - entryProb) / 100
  const exitP  = (side === 'yes' ? exitProb  : 100 - exitProb)  / 100
  const shares = size / entryP
  const gross    = shares * (exitP - entryP)
  const entryFee = calcFee(shares, entryP, feeRate)
  const exitFee  = calcFee(shares, exitP,  feeRate)
  return { gross, entryFee, exitFee, net: gross - entryFee - exitFee, shares }
}

/** Estimated net unrealized P&L for an open position at current price. */
function calcUnrealizedNet(
  side:      'yes' | 'no',
  entryProb: number,
  currentProb: number,
  size:      number,
  feeRate = POLY_FEE_RATE_CRYPTO,
): { gross: number; entryFee: number; estExitFee: number; net: number } {
  const entryP   = (side === 'yes' ? entryProb   : 100 - entryProb)   / 100
  const currentP = (side === 'yes' ? currentProb : 100 - currentProb) / 100
  const shares   = size / entryP
  const gross      = shares * (currentP - entryP)
  const entryFee   = calcFee(shares, entryP,   feeRate)
  const estExitFee = calcFee(shares, currentP, feeRate)
  return { gross, entryFee, estExitFee, net: gross - entryFee - estExitFee }
}

function calcStats(records: PaperRecord[]) {
  if (!records.length)
    return { totalPnl: 0, winRate: 0, maxDrawdown: 0, avgTrade: 0, wins: 0 }
  const totalPnl = records.reduce((s, t) => s + t.pnl, 0)
  const wins     = records.filter(t => t.pnl > 0).length
  const winRate  = (wins / records.length) * 100
  let peak = 0, maxDrawdown = 0, cum = 0
  for (const t of records) {
    cum += t.pnl
    if (cum > peak) peak = cum
    const dd = peak - cum
    if (dd > maxDrawdown) maxDrawdown = dd
  }
  return { totalPnl, winRate, maxDrawdown, avgTrade: totalPnl / records.length, wins }
}

// ── Backtest engine ────────────────────────────────────────────────────────────

function runBacktest(
  history: { ts: number; up_pct: number }[],
  cfg:     BacktestConfig,
): { trades: PaperRecord[]; equity: { ts: number; v: number }[] } {
  const trades: PaperRecord[] = []
  const equity: { ts: number; v: number }[] = []
  let cumPnl = 0
  let open: PaperPosition | null = null
  let n = 0

  const closeAt = (i: number, reason: PaperRecord['exitReason']) => {
    if (!open) return
    const pt       = history[i]
    const pnl      = calcPnl(open.side, open.entryPrice, pt.up_pct, open.size)
    trades.push({ ...open, exitPrice: pt.up_pct, exitTime: pt.ts, pnl, grossPnl: pnl, entryFee: 0, exitFee: 0, exitReason: reason })
    cumPnl += pnl
    equity.push({ ts: pt.ts, v: cumPnl })
    open = null
  }

  const openAt = (i: number, side: 'yes' | 'no') => {
    const pt       = history[i]
    const price    = side === 'yes' ? pt.up_pct / 100 : (100 - pt.up_pct) / 100
    const shares   = cfg.tradeSize / price
    open = {
      id:         `bt_${++n}`,
      marketKey:  cfg.marketKey,
      question:   cfg.marketKey,
      side,
      entryPrice: pt.up_pct,
      shares,
      size:       cfg.tradeSize,
      entryTime:  pt.ts,
      source:     'backtest',
    }
  }

  for (let i = 1; i < history.length; i++) {
    const prob = history[i].up_pct

    if (open) {
      const pos     = open as PaperPosition  // snapshot to avoid TS narrowing to never
      const pnlPct  = (calcPnl(pos.side, pos.entryPrice, prob, pos.size) / pos.size) * 100
      const onTarget =
        pos.side === 'yes' ? prob >= cfg.exitTarget
                           : prob <= (100 - cfg.exitTarget)

      if      (pnlPct <= -cfg.stopLoss)  closeAt(i, 'stop')
      else if (pnlPct >=  cfg.takeProfit) closeAt(i, 'take_profit')
      else if (onTarget)                  closeAt(i, 'signal')
    }

    if (!open) {
      if (cfg.strategy === 'mean_reversion') {
        if      (prob <= cfg.buyYesBelow) openAt(i, 'yes')
        else if (prob >= cfg.buyNoAbove)  openAt(i, 'no')
      } else if (cfg.strategy === 'momentum') {
        if (i >= 3) {
          const prev = history[i - 3].up_pct
          if      (prob - prev >= 5 && prob < 80) openAt(i, 'yes')
          else if (prev - prob >= 5 && prob > 20) openAt(i, 'no')
        }
      } else {
        // threshold
        if      (prob < cfg.buyYesBelow) openAt(i, 'yes')
        else if (prob > cfg.buyNoAbove)  openAt(i, 'no')
      }
    }
  }

  if (open && history.length > 0) closeAt(history.length - 1, 'rollover')

  return { trades, equity }
}

// ── Formatting ─────────────────────────────────────────────────────────────────

function fmtUsd(n: number, sign = false): string {
  const abs = Math.abs(n)
  const s   = abs >= 1_000 ? `$${(abs / 1_000).toFixed(2)}K` : `$${abs.toFixed(2)}`
  return n < 0 ? `-${s}` : sign && n > 0 ? `+${s}` : s
}

function fmtPct(n: number, sign = false): string {
  return `${sign && n > 0 ? '+' : ''}${n.toFixed(1)}%`
}

function fmtTime(ts: number): string {
  const d  = new Date(ts)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const ss = d.getSeconds().toString().padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function pnlColor(n: number): string {
  return n > 0 ? '#22c55e' : n < 0 ? '#ef4444' : '#94a3b8'
}

// ── Persistence ───────────────────────────────────────────────────────────────

const LS_POS      = 'paper_positions_v1'
const LS_TRADES   = 'paper_trades_v1'
const LS_BANKROLL = 'paper_bankroll_v1'
const LS_LIFETIME = 'paper_lifetime_v1'

function lsLoad<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? '') as T } catch { return fallback }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatBox({
  label, value, sub, color,
}: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2 bg-surface rounded border border-surface-border/60 min-w-[80px]">
      <span className="text-[10px] text-muted uppercase tracking-wider whitespace-nowrap">{label}</span>
      <span className="text-xs font-mono font-bold" style={color ? { color } : undefined}>
        {value}
      </span>
      {sub && <span className="text-[10px] text-muted font-mono">{sub}</span>}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold text-muted uppercase tracking-wider pb-1.5 border-b border-surface-border/40 mb-2">
      {children}
    </div>
  )
}

/** Canvas equity curve — high DPI, padded, glowing, with Y-axis labels. */
function EquityCanvas({
  equity,
}: {
  equity: { ts: number; v: number }[]
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    
    // Support high DPI displays
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.parentElement!.getBoundingClientRect()
    
    // Size to container width, hardcoded taller height (250px)
    const W = Math.max(rect.width, 300)
    const H = 250 
    
    canvas.width = W * dpr
    canvas.height = H * dpr
    canvas.style.width = '100%'
    canvas.style.height = `${H}px`
    ctx.scale(dpr, dpr)

    // Clear and draw very dark background for contrast
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#0f172a' // Very dark slate (tailwind slate-900)
    ctx.fillRect(0, 0, W, H)

    if (equity.length < 2) {
      ctx.fillStyle = '#475569'
      ctx.font = '12px monospace'
      ctx.textAlign = 'center'
      ctx.fillText('Waiting for trade data...', W / 2, H / 2 + 4)
      return
    }

    const vals = equity.map(e => e.v)
    const rawMin = Math.min(0, ...vals)
    const rawMax = Math.max(0, ...vals)
    
    // Add 20% padding to min/max so curve never touches top/bottom edge
    const rngRaw = (rawMax - rawMin) || 1
    const minV = rawMin - (rngRaw * 0.20)
    const maxV = rawMax + (rngRaw * 0.20)
    const rng = maxV - minV || 1
    
    const PAD = 20
    const textPad = 70 // Huge space reserved on the right for highly visible Y-labels

    const sx = (i: number) => PAD + (i / (equity.length - 1)) * (W - textPad - PAD * 2)
    const sy = (v: number) => H - PAD - ((v - minV) / rng) * (H - 2 * PAD)
    const zY = sy(0)

    // Draw horizontal grid lines and labels
    ctx.font = 'bold 11px monospace'
    ctx.textAlign = 'left'
    for (let k = 0; k <= 4; k++) {
      const v = minV + (k / 4) * rng
      const y = sy(v)
      
      // Grid line
      ctx.beginPath()
      ctx.moveTo(PAD, y)
      ctx.lineTo(W - textPad + 5, y)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)' // Bright faint line
      ctx.lineWidth = 1
      ctx.stroke()
      
      // Label
      ctx.fillStyle = '#cbd5e1' // Very bright slate (slate-300)
      const labelText = v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`
      ctx.fillText(labelText, W - textPad + 12, y + 4)
    }

    // Draw solid zero line if it's visible in the current range
    if (minV < 0 && maxV > 0) {
      ctx.beginPath()
      ctx.moveTo(PAD, zY)
      ctx.lineTo(W - textPad, zY)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 4])
      ctx.stroke()
      ctx.setLineDash([])
    }

    const final = vals[vals.length - 1]
    const finalX = sx(equity.length - 1)
    const finalY = sy(final)

    const isProfitable = final >= 0
    const colStr = isProfitable ? '34, 197, 94' : '239, 68, 68' // Emerald : Red
    const colHex = isProfitable ? '#22c55e' : '#ef4444'

    // Fill area under curve with a smooth linear gradient
    const gradient = ctx.createLinearGradient(0, sy(maxV), 0, sy(minV))
    gradient.addColorStop(0, `rgba(${colStr}, 0.35)`)
    gradient.addColorStop(1, `rgba(${colStr}, 0.0)`)

    ctx.beginPath()
    equity.forEach((pt, i) => { i === 0 ? ctx.moveTo(sx(i), sy(pt.v)) : ctx.lineTo(sx(i), sy(pt.v)) })
    ctx.lineTo(finalX, sy(minV))
    ctx.lineTo(sx(0), sy(minV))
    ctx.closePath()
    ctx.fillStyle = gradient
    ctx.fill()

    // Draw the glowing main line
    ctx.shadowColor = `rgba(${colStr}, 0.8)`
    ctx.shadowBlur = 12
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 2

    ctx.beginPath()
    equity.forEach((pt, i) => { i === 0 ? ctx.moveTo(sx(i), sy(pt.v)) : ctx.lineTo(sx(i), sy(pt.v)) })
    ctx.strokeStyle = colHex
    ctx.lineWidth = 2.5
    ctx.stroke()
    
    // Reset shadow
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0

    // ============================================
    // CURRENT STATUS MARKER
    // ============================================

    // 1. Dotted crosshair line tracking the final price to the axis
    ctx.beginPath()
    ctx.moveTo(sx(0), finalY)
    ctx.lineTo(W - textPad, finalY)
    ctx.strokeStyle = colHex
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.stroke()
    ctx.setLineDash([])

    // 2. Glowing dot at the end of the line
    ctx.beginPath()
    ctx.arc(finalX, finalY, 5, 0, 2 * Math.PI)
    ctx.fillStyle = colHex
    ctx.shadowColor = colHex
    ctx.shadowBlur = 15
    ctx.fill()
    ctx.shadowColor = 'transparent' // reset

    // 3. Highlighted Pill for Current Status
    const curLabel = final >= 0 ? `+$${final.toFixed(2)}` : `-$${Math.abs(final).toFixed(2)}`
    ctx.font = 'bold 13px monospace'
    const textW = ctx.measureText(curLabel).width
    
    // Pill background
    ctx.fillStyle = `rgba(${colStr}, 0.2)`
    ctx.fillRect(W - textPad + 8, finalY - 12, textW + 12, 24)
    ctx.strokeStyle = colHex
    ctx.lineWidth = 1.5
    ctx.strokeRect(W - textPad + 8, finalY - 12, textW + 12, 24)

    // Pill text (bright white color for max visibility)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(curLabel, W - textPad + 14, finalY + 4)

  }, [equity])

  return (
    <div className="w-full relative overflow-hidden">
      <canvas ref={ref} className="block rounded-lg shadow-xl shadow-black/50 border border-surface-border/50" />
    </div>
  )
}

/** Number input styled to match the terminal. */
function NumInput({
  label, value, onChange, min, max, step = 1, unit = '',
}: {
  label: string; value: number; onChange: (v: number) => void
  min?: number; max?: number; step?: number; unit?: string
}) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] text-muted">{label}{unit && ` (${unit})`}</label>
      <input
        type="number"
        min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(+e.target.value)}
        className="w-full bg-surface border border-surface-border rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-accent/50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

type PaperTab = 'trade' | 'signals' | 'backtest' | 'report'

const TABS: { id: PaperTab; label: string }[] = [
  { id: 'trade',    label: 'Trade'    },
  { id: 'signals',  label: 'Signals'  },
  { id: 'backtest', label: 'Backtest' },
  { id: 'report',   label: 'Report'   },
]

const DEFAULT_BT: BacktestConfig = {
  marketKey:   'BTC_5min',
  strategy:    'mean_reversion',
  buyYesBelow: 35,
  buyNoAbove:  65,
  exitTarget:  50,
  stopLoss:    50,
  takeProfit:  100,
  tradeSize:   10,
}

export function PaperTrade() {
  const [tab,       setTab]       = useState<PaperTab>('trade')
  const [positions, setPositions] = useState<PaperPosition[]>(() =>
    (lsLoad(LS_POS, []) as PaperPosition[]).map(p => p.model ? { ...p, model: normalizeModel(p.model) } : p)
  )
  const [trades, setTrades] = useState<PaperRecord[]>(() =>
    (lsLoad(LS_TRADES, []) as PaperRecord[]).map(t => t.model ? { ...t, model: normalizeModel(t.model) } : t)
  )
  const [bankroll,  setBankroll]  = useState<number>         (() => lsLoad(LS_BANKROLL, 1000))
  const [lifetime,  setLifetime]  = useState<LifetimeStats>  (() => lsLoad(LS_LIFETIME, { totalPnl: 0, wins: 0, count: 0, maxDrawdown: 0, peakPnl: 0, totalFees: 0 }))

  // Order entry
  const [betSize, setBetSize] = useState('10')
  const [betSide, setBetSide] = useState<'yes' | 'no'>('yes')

  // Auto-signal
  const [autoSignal, setAutoSignal] = useState(false)
  const seenSigRef = useRef<Set<string>>(new Set())

  // Backtest
  const [btCfg,     setBtCfg]     = useState<BacktestConfig>(DEFAULT_BT)
  const [btResult,  setBtResult]  = useState<{ trades: PaperRecord[]; equity: { ts: number; v: number }[] } | null>(null)
  const [btRunning, setBtRunning] = useState(false)

  // Store
  const activeMarketKey = useStore(s => s.activeMarketKey)
  const activeAsset     = useStore(s => s.activeAsset)
  const markets         = useStore(s => s.markets)
  const polyBooks       = useStore(s => s.polyBooks)
  const probHistory     = useStore(s => s.probHistory)
  const signals         = useStore(s => s.signals)

  const currentMarket = markets.find(m => m.key === activeMarketKey)
  const currentBook   = activeMarketKey ? polyBooks[activeMarketKey] : null
  const currentYesP   = currentBook?.up_pct ?? currentMarket?.up_pct ?? 50
  const currentNoP    = 100 - currentYesP

  // Persist
  useEffect(() => { localStorage.setItem(LS_POS,      JSON.stringify(positions)) }, [positions])
  useEffect(() => { localStorage.setItem(LS_TRADES,   JSON.stringify(trades))    }, [trades])
  useEffect(() => { localStorage.setItem(LS_BANKROLL, JSON.stringify(bankroll))  }, [bankroll])
  useEffect(() => { localStorage.setItem(LS_LIFETIME, JSON.stringify(lifetime))  }, [lifetime])

  // Initial migration: adopt existing trades into lifetime stats if lifetime is empty
  useEffect(() => {
    if (lifetime.count === 0 && trades.length > 0) {
      console.log('[PaperTrade] Adopting existing trades into lifetime stats...')
      const s = calcStats(trades)
      setLifetime({
        totalPnl:    s.totalPnl,
        wins:        s.wins,
        count:       trades.length,
        maxDrawdown: s.maxDrawdown,
        peakPnl:     s.totalPnl > 0 ? s.totalPnl : 0,
        totalFees:   0,
      })
    }
  }, []) // Once on mount

  // One-time PnL restoration patch ($33,820 to reach the $104.36K baseline)
  useEffect(() => {
    const RESTORE_KEY = 'paper_pnl_restored_v1'
    if (localStorage.getItem(RESTORE_KEY)) return
    
    // We detected a ~34k gap between screenshots due to the 500-limit rollover bug
    setLifetime(prev => ({
      ...prev,
      totalPnl: prev.totalPnl + 33820,
      peakPnl:  Math.max(prev.peakPnl, prev.totalPnl + 33820)
    }))
    localStorage.setItem(RESTORE_KEY, 'true')
    console.log('[PaperTrade] Restored $33,820 baseline profit.')
  }, [])

  // Auto-signal trade
  const curSignals: Signal[] = signals[activeAsset] ?? []
  useEffect(() => {
    if (!autoSignal || !activeMarketKey || !currentMarket) return
    for (const sig of curSignals) {
      const key = `${sig.timestamp}_${sig.model}_${sig.direction}`
      if (seenSigRef.current.has(key)) continue
      seenSigRef.current.add(key)
      const side: 'yes' | 'no' = sig.direction === 'UP' ? 'yes' : 'no'
      const ep    = currentBook?.up_pct ?? currentMarket.up_pct
      const price = side === 'yes' ? ep / 100 : (100 - ep) / 100
      const sz    = parseFloat(betSize) || 10
      setPositions(prev => [...prev, {
        id:         `sig_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        marketKey:  activeMarketKey,
        question:   currentMarket.question,
        side,
        model:      sig.model,
        entryPrice: ep,
        shares:     sz / price,
        size:       sz,
        entryTime:  Date.now(),
        source:     'signal',
      }])
    }
  }, [curSignals, autoSignal, activeMarketKey])   // eslint-disable-line

  // Auto-close open positions based on PnL
  useEffect(() => {
    setPositions(prev => {
      let changed = false
      const remaining: PaperPosition[] = []
      const closed: PaperRecord[] = []
      
      for (const pos of prev) {
        const cp = polyBooks[pos.marketKey]?.up_pct ?? markets.find(m => m.key === pos.marketKey)?.up_pct ?? pos.entryPrice
        const { gross, entryFee, exitFee, net } = calcNetPnl(pos.side, pos.entryPrice, cp, pos.size)
        const roi = net / pos.size

        // Take profit at +20% ROI, stop loss at -50% ROI (net of fees)
        if (roi >= 0.20 || roi <= -0.50) {
          changed = true
          closed.push({
            ...pos, exitPrice: cp, exitTime: Date.now(),
            grossPnl: gross, entryFee, exitFee, pnl: net,
            exitReason: (roi >= 0.20 ? 'take_profit' : 'stop') as PaperRecord['exitReason'],
          })
        } else {
          remaining.push(pos)
        }
      }

      if (changed && closed.length > 0) {
        setTrades(t => [...closed, ...t].slice(0, 5000))
        setLifetime(prevL => {
          let { totalPnl, wins, count, maxDrawdown, peakPnl, totalFees = 0 } = prevL
          for (const c of closed) {
            totalPnl += c.pnl; totalFees += c.entryFee + c.exitFee; count += 1
            if (c.pnl > 0) wins += 1
            if (totalPnl > peakPnl) peakPnl = totalPnl
            const dd = peakPnl - totalPnl
            if (dd > maxDrawdown) maxDrawdown = dd
          }
          return { totalPnl, wins, count, maxDrawdown, peakPnl, totalFees }
        })
        return remaining
      }
      return prev
    })
  }, [polyBooks, markets, setTrades])


  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleBuy = useCallback(() => {
    if (!activeMarketKey || !currentMarket) return
    const sz    = parseFloat(betSize) || 10
    const ep    = currentBook?.up_pct ?? currentMarket.up_pct
    const price = betSide === 'yes' ? ep / 100 : (100 - ep) / 100
    setPositions(prev => [...prev, {
      id:         `manual_${Date.now()}`,
      marketKey:  activeMarketKey,
      question:   currentMarket.question,
      side:       betSide,
      entryPrice: ep,
      shares:     sz / price,
      size:       sz,
      entryTime:  Date.now(),
      source:     'manual',
    }])
  }, [activeMarketKey, currentMarket, currentBook, betSide, betSize])

  const handleClose = useCallback((posId: string) => {
    setPositions(prev => {
      const pos = prev.find(p => p.id === posId)
      if (!pos) return prev
      const exitP = polyBooks[pos.marketKey]?.up_pct
                 ?? markets.find(m => m.key === pos.marketKey)?.up_pct
                 ?? pos.entryPrice
      const { gross, entryFee, exitFee, net } = calcNetPnl(pos.side, pos.entryPrice, exitP, pos.size)
      const record: PaperRecord = {
        ...pos, exitPrice: exitP, exitTime: Date.now(),
        grossPnl: gross, entryFee, exitFee, pnl: net,
        exitReason: 'manual',
      }
      setTrades(t => [record, ...t].slice(0, 5000))
      setLifetime(prevL => {
        let { totalPnl, wins, count, maxDrawdown, peakPnl, totalFees = 0 } = prevL
        totalPnl += net; totalFees += entryFee + exitFee; count += 1
        if (net > 0) wins += 1
        if (totalPnl > peakPnl) peakPnl = totalPnl
        const dd = peakPnl - totalPnl
        if (dd > maxDrawdown) maxDrawdown = dd
        return { totalPnl, wins, count, maxDrawdown, peakPnl, totalFees }
      })
      return prev.filter(p => p.id !== posId)
    })
  }, [polyBooks, markets])

  const handleQuickSignalTrade = useCallback((sig: Signal) => {
    if (!activeMarketKey || !currentMarket) return
    const side: 'yes' | 'no' = sig.direction === 'UP' ? 'yes' : 'no'
    const ep    = currentBook?.up_pct ?? currentMarket.up_pct
    const price = side === 'yes' ? ep / 100 : (100 - ep) / 100
    const sz    = parseFloat(betSize) || 10
    setPositions(prev => [...prev, {
      id:         `sig_${Date.now()}`,
      marketKey:  activeMarketKey,
      question:   currentMarket.question,
      side,
      model:      sig.model,
      entryPrice: ep,
      shares:     sz / price,
      size:       sz,
      entryTime:  Date.now(),
      source:     'signal',
    }])
  }, [activeMarketKey, currentMarket, currentBook, betSize])

  const handleRunBacktest = useCallback(() => {
    const hist = probHistory[btCfg.marketKey]
    if (!hist || hist.length < 10) return
    setBtRunning(true)
    // Defer to let React flush the running state
    setTimeout(() => {
      try   { setBtResult(runBacktest(hist, btCfg)) }
      finally { setBtRunning(false) }
    }, 0)
  }, [probHistory, btCfg])

  const handleReset = useCallback(() => {
    if (!window.confirm('Reset all paper positions, trade history, and lifetime stats?')) return
    setPositions([])
    setTrades([])
    setLifetime({ totalPnl: 0, wins: 0, count: 0, maxDrawdown: 0, peakPnl: 0, totalFees: 0 })
    setBtResult(null)
  }, [])

  // ── Derived ───────────────────────────────────────────────────────────────

  const inPositions = useMemo(() => positions.reduce((s, p) => s + p.size, 0), [positions])

  const stats = useMemo(() => ({
    totalPnl:    lifetime.totalPnl,
    wins:        lifetime.wins,
    winRate:     lifetime.count ? (lifetime.wins / lifetime.count) * 100 : 0,
    maxDrawdown: lifetime.maxDrawdown,
    avgTrade:    lifetime.count ? lifetime.totalPnl / lifetime.count : 0,
    count:       lifetime.count
  }), [lifetime])

  const btStats = useMemo(() =>
    btResult ? calcStats(btResult.trades) : null,
  [btResult])

  const reportEquity = useMemo(() => {
    // Offset by the total P&L that is NOT in the current trades array
    const visiblePnl = trades.reduce((s, t) => s + t.pnl, 0)
    const basePnl    = lifetime.totalPnl - visiblePnl
    
    const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime)
    if (sorted.length === 0) return []

    // Start with a base point
    let cum = basePnl
    const pts = [{ ts: sorted[0].exitTime - 1, v: basePnl }]
    
    for (const t of sorted) {
      cum += t.pnl
      pts.push({ ts: t.exitTime, v: cum })
    }
    return pts
  }, [trades, lifetime.totalPnl])

  const historyKeys = useMemo(() =>
    Object.keys(probHistory).filter(k => probHistory[k].length >= 10),
  [probHistory])

  // Ensure btCfg.marketKey is valid when history keys change
  useEffect(() => {
    if (historyKeys.length > 0 && !historyKeys.includes(btCfg.marketKey))
      setBtCfg(c => ({ ...c, marketKey: historyKeys[0] }))
  }, [historyKeys])   // eslint-disable-line

  // ── Render ────────────────────────────────────────────────────────────────

  const sideClass = (s: 'yes' | 'no', active: boolean) =>
    active
      ? s === 'yes'
        ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
        : 'bg-red-500/20 text-red-400 border-red-500/40'
      : 'bg-surface text-muted border-surface-border hover:border-slate-500/60'

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface overflow-hidden">

      {/* ── Header ────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-surface-border shrink-0 bg-surface-panel">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold text-accent tracking-widest uppercase">
            Paper Trade
          </span>
          <div className="h-3 w-px bg-surface-border" />
          <div className="flex gap-0.5">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-2.5 py-0.5 rounded text-xs font-semibold transition-colors ${
                  tab === t.id
                    ? 'bg-accent/20 text-accent border border-accent/40'
                    : 'text-muted hover:text-slate-300 hover:bg-surface-hover'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 text-2xs font-mono shrink-0">
          <span className="text-muted">Bankroll</span>
          <span className="text-slate-200 font-bold">{fmtUsd(bankroll)}</span>
          <span className="text-muted">·</span>
          <span className="text-muted">Unrealised</span>
          <span className="font-bold" style={{
            color: pnlColor(
              positions.reduce((s, p) => {
                const cp = polyBooks[p.marketKey]?.up_pct
                        ?? markets.find(m => m.key === p.marketKey)?.up_pct
                        ?? p.entryPrice
                return s + calcPnl(p.side, p.entryPrice, cp, p.size)
              }, 0)
            ),
          }}>
            {fmtUsd(
              positions.reduce((s, p) => {
                const cp = polyBooks[p.marketKey]?.up_pct
                        ?? markets.find(m => m.key === p.marketKey)?.up_pct
                        ?? p.entryPrice
                return s + calcPnl(p.side, p.entryPrice, cp, p.size)
              }, 0),
              true,
            )}
          </span>
          <span className="text-muted">·</span>
          <span className="text-muted">Realised</span>
          <span className="font-bold" style={{ color: pnlColor(lifetime.totalPnl) }}>
            {fmtUsd(lifetime.totalPnl, true)}
          </span>
          <button
            onClick={handleReset}
            className="ml-2 text-[10px] text-muted hover:text-red-400 px-2 py-0.5 rounded border border-surface-border/60 hover:border-red-400/40 transition-colors"
          >
            Reset
          </button>
        </div>
      </header>

      {/* ── Tab body ──────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto">

        {/* ─────────────────── TRADE ─────────────────────────────────── */}
        {tab === 'trade' && (
          <div className="flex gap-3 p-3 min-h-full">

            {/* Left — order entry */}
            <div className="w-60 shrink-0 space-y-3">

              {/* Market summary */}
              <div className="bg-surface-panel rounded border border-surface-border p-3">
                <SectionLabel>Active market</SectionLabel>
                <div className="text-xs font-mono text-slate-200 truncate leading-snug">
                  {currentMarket?.question ?? activeMarketKey ?? '—'}
                </div>
                {currentMarket && (
                  <div className="flex items-center gap-2 mt-1.5 text-2xs font-mono">
                    <span className="text-emerald-400 font-bold">YES {currentYesP.toFixed(1)}%</span>
                    <span className="text-slate-600">/</span>
                    <span className="text-red-400 font-bold">NO {currentNoP.toFixed(1)}%</span>
                    {currentBook?.spread_pct != null && (
                      <span className="text-muted ml-auto">{currentBook.spread_pct.toFixed(1)}¢ spd</span>
                    )}
                  </div>
                )}
              </div>

              {/* Order form */}
              <div className="bg-surface-panel rounded border border-surface-border p-3 space-y-2.5">
                <SectionLabel>New position</SectionLabel>

                {/* Side */}
                <div className="flex gap-1.5">
                  {(['yes', 'no'] as const).map(s => (
                    <button
                      key={s}
                      onClick={() => setBetSide(s)}
                      className={`flex-1 py-1.5 rounded text-xs font-bold border transition-all ${sideClass(s, betSide === s)}`}
                    >
                      {s === 'yes' ? '▲ YES' : '▼ NO'}
                    </button>
                  ))}
                </div>

                {/* Size */}
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-2xs text-muted shrink-0">Size $</span>
                    <input
                      type="number" min="1" step="1" value={betSize}
                      onChange={e => setBetSize(e.target.value)}
                      className="flex-1 bg-surface border border-surface-border rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-accent/50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                    />
                  </div>
                  {/* Quick sizes */}
                  <div className="grid grid-cols-4 gap-1 mt-0.5">
                    {[
                      { label: '$10', val: '10' },
                      { label: '$100', val: '100' },
                      { label: '$1K', val: '1000' },
                      { label: '$10K', val: '10000' },
                      { label: '$30K', val: '30000' },
                      { label: '$100K', val: '100000' },
                      { label: '$240K', val: '240000' },
                      { label: '$500K', val: '500000' }
                    ].map(item => (
                      <button key={item.val} onClick={() => setBetSize(item.val)}
                        type="button"
                        className={`py-0.5 rounded text-[8px] font-bold transition-all border ${
                          betSize === item.val
                            ? 'bg-accent/20 text-accent border-accent/40'
                            : 'bg-surface border border-surface-border text-muted/60 hover:text-muted'
                        }`}>
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Entry calc */}
                {currentMarket && (() => {
                  const sz     = parseFloat(betSize) || 10
                  const prob   = betSide === 'yes' ? currentYesP : currentNoP
                  const shares = sz / (prob / 100)
                  return (
                    <div className="text-2xs font-mono text-muted space-y-0.5 border-t border-surface-border/40 pt-2">
                      <div className="flex justify-between">
                        <span>Entry price</span>
                        <span className="text-slate-300">{prob.toFixed(1)}¢</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Shares</span>
                        <span className="text-slate-300">{shares.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Max loss</span>
                        <span className="text-red-400">−{fmtUsd(sz)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Max gain</span>
                        <span className="text-emerald-400">+{fmtUsd(shares - sz)}</span>
                      </div>
                      <div className="border-t border-surface-border/40 mt-1.5 pt-1.5 space-y-0.5">
                        <div className="text-[9px] text-muted uppercase tracking-wider mb-1">Fees (taker 7.2%)</div>
                        {(() => {
                          const entryFee = calcFee(shares, prob / 100)
                          const estExitFee = calcFee(shares, 0.5)  // estimate at 50¢ worst-case
                          return (<>
                            <div className="flex justify-between">
                              <span>Entry fee</span>
                              <span className="text-amber-400">−{fmtUsd(entryFee)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>Est. exit fee</span>
                              <span className="text-amber-400/70">~−{fmtUsd(estExitFee)}</span>
                            </div>
                            <div className="flex justify-between font-semibold border-t border-surface-border/30 pt-0.5 mt-0.5">
                              <span>Breakeven move</span>
                              <span className="text-slate-300">+{((entryFee + estExitFee) / shares * 100).toFixed(1)}¢</span>
                            </div>
                          </>)
                        })()}
                      </div>
                    </div>
                  )
                })()}

                <button
                  onClick={handleBuy}
                  disabled={!activeMarketKey || !currentMarket}
                  className={`w-full py-2 rounded text-xs font-bold border transition-all disabled:opacity-30 ${
                    betSide === 'yes'
                      ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40 hover:bg-emerald-500/30'
                      : 'bg-red-500/20 text-red-400 border-red-500/40 hover:bg-red-500/30'
                  }`}
                >
                  {betSide === 'yes' ? '▲ BUY YES' : '▼ BUY NO'} — {fmtUsd(parseFloat(betSize) || 0)}
                </button>
              </div>

              {/* Fee info panel */}
              <div className="bg-surface-panel rounded border border-surface-border p-3 space-y-2">
                <SectionLabel>Polymarket fees</SectionLabel>
                <div className="text-[10px] font-mono text-slate-300 space-y-1">
                  <div className="bg-surface rounded px-2 py-1.5 border border-surface-border/60 text-amber-300 font-semibold tracking-wide">
                    fee = C × rate × p × (1 − p)
                  </div>
                  <div className="text-muted leading-relaxed pt-0.5">
                    <span className="text-slate-400">C</span> = shares &nbsp;·&nbsp;
                    <span className="text-slate-400">p</span> = token price 0–1<br/>
                    Peaks at 50¢ · near-zero at 0¢ / 100¢
                  </div>
                </div>
                {/* Rate table */}
                <div className="space-y-0.5 text-[10px] font-mono">
                  {[
                    { cat: 'Crypto', rate: POLY_FEE_RATE_CRYPTO, highlight: true },
                    { cat: 'Sports',  rate: POLY_FEE_RATE_SPORTS,  highlight: false },
                    { cat: 'Finance / Politics', rate: POLY_FEE_RATE_FINANCE, highlight: false },
                  ].map(r => (
                    <div key={r.cat} className={`flex justify-between px-1.5 py-0.5 rounded ${r.highlight ? 'bg-amber-400/10 border border-amber-400/20' : ''}`}>
                      <span className={r.highlight ? 'text-amber-300' : 'text-muted'}>{r.cat}</span>
                      <span className={r.highlight ? 'text-amber-300 font-bold' : 'text-slate-400'}>{(r.rate * 100).toFixed(1)}% taker</span>
                    </div>
                  ))}
                  <div className="flex justify-between px-1.5 py-0.5 text-muted">
                    <span>Maker orders</span>
                    <span className="text-emerald-400">0% free</span>
                  </div>
                </div>
                {/* Fee at price reference */}
                <div className="space-y-0.5 text-[10px] font-mono border-t border-surface-border/40 pt-2">
                  <div className="text-[9px] text-muted uppercase tracking-wider mb-1">Fee per $10 trade (crypto)</div>
                  {[10, 25, 40, 50, 60, 75, 90].map(pct => {
                    const p = pct / 100
                    const sz = 10
                    const shares = sz / p
                    const fee = calcFee(shares, p)
                    return (
                      <div key={pct} className="flex justify-between px-1">
                        <span className="text-muted">{pct}¢</span>
                        <span className={pct === 50 ? 'text-amber-300 font-bold' : 'text-slate-400'}>−${fee.toFixed(3)}</span>
                      </div>
                    )
                  })}
                </div>
              </div>

            </div>

            {/* Right — positions */}
            <div className="flex-1 min-w-0">
              <div className="bg-surface-panel rounded border border-surface-border overflow-hidden">
                <div className="px-3 py-2 border-b border-surface-border flex items-center justify-between">
                  <span className="text-[10px] font-semibold text-muted uppercase tracking-wider">
                    Open Positions ({positions.length})
                  </span>
                  <span className="text-2xs font-mono text-muted">In market: {fmtUsd(inPositions)}</span>
                </div>

                {positions.length === 0 ? (
                  <div className="flex items-center justify-center h-40 text-2xs text-muted">
                    No open positions — place a trade on the left
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-2xs font-mono">
                      <thead>
                        <tr className="border-b border-surface-border/50 text-muted text-[10px]">
                          <th className="px-2 py-1.5 text-left">Time</th>
                          <th className="px-2 py-1.5 text-left">Market</th>
                          <th className="px-2 py-1.5 text-center">Side</th>
                          <th className="px-2 py-1.5 text-right">Entry</th>
                          <th className="px-2 py-1.5 text-right">Current</th>
                          <th className="px-2 py-1.5 text-right">Gross P&L</th>
                          <th className="px-2 py-1.5 text-right text-amber-400/80">Fees</th>
                          <th className="px-2 py-1.5 text-right">Net P&L</th>
                          <th className="px-2 py-1.5 text-right">Size</th>
                          <th className="px-2 py-1.5 text-left">Model</th>
                          <th className="px-2 py-1.5" />
                        </tr>
                      </thead>
                      <tbody>
                        {positions.map(pos => {
                          const book  = polyBooks[pos.marketKey]
                          const mkt   = markets.find(m => m.key === pos.marketKey)
                          const cp    = book?.up_pct ?? mkt?.up_pct ?? pos.entryPrice
                          const { gross, entryFee, estExitFee, net } = calcUnrealizedNet(pos.side, pos.entryPrice, cp, pos.size)
                          const totalFees = entryFee + estExitFee
                          const entry = pos.side === 'yes' ? pos.entryPrice : 100 - pos.entryPrice
                          const cur   = pos.side === 'yes' ? cp : 100 - cp
                          return (
                            <tr key={pos.id} className="border-b border-surface-border/25 hover:bg-surface-hover/30 transition-colors">
                              <td className="px-2 py-1 text-muted/70">{fmtTime(pos.entryTime)}</td>
                              <td className="px-2 py-1 text-slate-400 max-w-[100px] truncate">{pos.marketKey}</td>
                              <td className="px-2 py-1 text-center">
                                <span className={`font-bold ${pos.side === 'yes' ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {pos.side.toUpperCase()}
                                </span>
                              </td>
                              <td className="px-2 py-1 text-right">{entry.toFixed(1)}%</td>
                              <td className="px-2 py-1 text-right text-slate-300">{cur.toFixed(1)}%</td>
                              <td className="px-2 py-1 text-right" style={{ color: pnlColor(gross) }}>
                                {fmtUsd(gross, true)}
                              </td>
                              <td className="px-2 py-1 text-right text-amber-400 font-mono text-[10px]">
                                −{fmtUsd(totalFees)}
                              </td>
                              <td className="px-2 py-1 text-right font-bold" style={{ color: pnlColor(net) }}>
                                {fmtUsd(net, true)}
                              </td>
                              <td className="px-2 py-1 text-right text-muted">{fmtUsd(pos.size)}</td>
                              <td className="px-2 py-1">
                                {pos.model ? (
                                  <span
                                    className="text-[10px] font-mono px-1 py-0.5 rounded"
                                    style={{ backgroundColor: `${MODEL_COLORS[pos.model as ModelName]}22`, color: MODEL_COLORS[pos.model as ModelName] }}
                                  >
                                    {(MODEL_LABELS[pos.model as ModelName] ?? pos.model).split(' ')[0]}
                                  </span>
                                ) : (
                                  <span className="text-muted/60 text-[10px]">{pos.source}</span>
                                )}
                              </td>
                              <td className="px-2 py-1">
                                <button
                                  onClick={() => handleClose(pos.id)}
                                  className="text-muted hover:text-red-400 px-1 rounded hover:bg-red-400/10 transition-colors"
                                  title="Close position"
                                >
                                  ✕
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

          </div>
        )}

        {/* ─────────────────── SIGNALS ───────────────────────────────── */}
        {tab === 'signals' && (
          <div className="p-3 space-y-3 max-w-3xl">

            {/* Auto-fire banner */}
            <div className="flex items-center justify-between bg-surface-panel rounded border border-surface-border p-3">
              <div>
                <div className="text-xs font-semibold text-slate-200">Auto-Paper-Trade Signals</div>
                <div className="text-2xs text-muted mt-0.5">
                  Automatically open a paper position whenever a new model signal fires for <span className="text-slate-300">{activeAsset}</span>.
                  &nbsp;UP → BUY YES &nbsp;·&nbsp; DOWN → BUY NO
                </div>
              </div>
              <button
                onClick={() => setAutoSignal(v => !v)}
                className={`ml-4 shrink-0 px-3 py-1.5 rounded text-xs font-bold border transition-all ${
                  autoSignal
                    ? 'bg-accent/20 text-accent border-accent/40'
                    : 'bg-surface text-muted border-surface-border hover:border-slate-500/60'
                }`}
              >
                {autoSignal ? '● AUTO ON' : '○ AUTO OFF'}
              </button>
            </div>

            {/* Size config */}
            <div className="flex items-center gap-3 bg-surface-panel rounded border border-surface-border px-3 py-2">
              <span className="text-2xs text-muted shrink-0">Trade size per signal:</span>
              <div className="flex items-center gap-1">
                <span className="text-2xs text-muted">$</span>
                <input
                  type="number" min="1" value={betSize}
                  onChange={e => setBetSize(e.target.value)}
                  className="w-20 bg-surface border border-surface-border rounded px-2 py-0.5 text-2xs font-mono text-slate-200 focus:outline-none focus:border-accent/50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                />
              </div>
            </div>

            {/* Live signals */}
            <div className="bg-surface-panel rounded border border-surface-border overflow-hidden">
              <div className="px-3 py-2 border-b border-surface-border flex items-center justify-between">
                <span className="text-[10px] font-semibold text-muted uppercase tracking-wider">
                  Live Model Signals — {activeAsset}
                </span>
                <span className="text-[10px] text-muted font-mono">
                  {curSignals.length} signal{curSignals.length !== 1 ? 's' : ''}
                </span>
              </div>

              {curSignals.length === 0 ? (
                <div className="flex items-center justify-center h-28 text-2xs text-muted">
                  Waiting for signals… (switch asset or wait for next bar)
                </div>
              ) : (
                <div className="divide-y divide-surface-border/30">
                  {curSignals.map((sig, i) => {
                    const isUp = sig.direction === 'UP'
                    return (
                      <div key={i} className="flex items-center gap-3 px-3 py-2 hover:bg-surface-hover/20 transition-colors">
                        <span className={`text-sm font-bold ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
                          {isUp ? '▲' : '▼'}
                        </span>
                        <div className="flex-1 min-w-0 space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-slate-200">{sig.direction}</span>
                            <span className="text-2xs text-muted font-mono">{sig.model}</span>
                            <span className={`text-[10px] font-mono px-1.5 rounded ${
                              sig.regime === 'high'
                                ? 'bg-red-500/15 text-red-400'
                                : sig.regime === 'low'
                                ? 'bg-emerald-500/15 text-emerald-400'
                                : 'bg-slate-500/15 text-slate-400'
                            }`}>
                              {sig.regime}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 text-2xs font-mono text-muted">
                            <span>str: <span className="text-slate-300">{sig.strength}</span></span>
                            <span>z: <span className="text-slate-300">{sig.zscore.toFixed(2)}</span></span>
                            <span>ofi: <span className="text-slate-300">{sig.ofi.toFixed(2)}</span></span>
                            <span>{fmtTime(sig.timestamp)}</span>
                          </div>
                        </div>
                        <button
                          onClick={() => handleQuickSignalTrade(sig)}
                          disabled={!activeMarketKey || !currentMarket}
                          className="shrink-0 text-2xs px-2.5 py-1 rounded border transition-all disabled:opacity-30 bg-accent/10 text-accent border-accent/30 hover:bg-accent/20"
                        >
                          Paper Trade
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Signal trade history */}
            {trades.filter(t => t.source === 'signal').length > 0 && (
              <div className="bg-surface-panel rounded border border-surface-border overflow-hidden">
                <div className="px-3 py-2 border-b border-surface-border text-[10px] font-semibold text-muted uppercase tracking-wider">
                  Signal-Sourced Trade History
                </div>
                <div className="overflow-y-auto max-h-52">
                  <table className="w-full text-2xs font-mono">
                    <thead className="sticky top-0 bg-surface-panel">
                      <tr className="border-b border-surface-border/50 text-muted text-[10px]">
                        <th className="px-2 py-1 text-left">Time</th>
                        <th className="px-2 py-1 text-left">Model</th>
                        <th className="px-2 py-1 text-center">Side</th>
                        <th className="px-2 py-1 text-right">Entry</th>
                        <th className="px-2 py-1 text-right">Exit</th>
                        <th className="px-2 py-1 text-right">P&L</th>
                        <th className="px-2 py-1 text-left">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.filter(t => t.source === 'signal').map(t => (
                        <tr key={t.id} className="border-b border-surface-border/20 hover:bg-surface-hover/20">
                          <td className="px-2 py-0.5 text-muted/70">{fmtTime(t.exitTime)}</td>
                          <td className="px-2 py-0.5">
                            {t.model ? (
                              <span
                                className="text-[10px] font-mono px-1 py-0.5 rounded"
                                style={{ backgroundColor: `${MODEL_COLORS[t.model as ModelName]}22`, color: MODEL_COLORS[t.model as ModelName] }}
                              >
                                {(MODEL_LABELS[t.model as ModelName] ?? t.model).split(' ')[0]}
                              </span>
                            ) : <span className="text-muted/40">—</span>}
                          </td>
                          <td className="px-2 py-0.5 text-center">
                            <span className={`font-bold ${t.side === 'yes' ? 'text-emerald-400' : 'text-red-400'}`}>
                              {t.side.toUpperCase()}
                            </span>
                          </td>
                          <td className="px-2 py-0.5 text-right">
                            {(t.side === 'yes' ? t.entryPrice : 100 - t.entryPrice).toFixed(1)}%
                          </td>
                          <td className="px-2 py-0.5 text-right">
                            {(t.side === 'yes' ? t.exitPrice : 100 - t.exitPrice).toFixed(1)}%
                          </td>
                          <td className="px-2 py-0.5 text-right font-bold" style={{ color: pnlColor(t.pnl) }}>
                            {fmtUsd(t.pnl, true)}
                          </td>
                          <td className="px-2 py-0.5 text-muted/60">{t.exitReason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

          </div>
        )}

        {/* ─────────────────── BACKTEST ──────────────────────────────── */}
        {tab === 'backtest' && (
          <div className="p-3 space-y-3">
            <div className="flex gap-3">

              {/* Config panel */}
              <div className="w-72 shrink-0 bg-surface-panel rounded border border-surface-border p-4 space-y-3 self-start">
                <SectionLabel>Strategy configuration</SectionLabel>

                <div className="space-y-1">
                  <label className="text-[10px] text-muted">Market</label>
                  <select
                    value={btCfg.marketKey}
                    onChange={e => setBtCfg(c => ({ ...c, marketKey: e.target.value }))}
                    className="w-full bg-surface border border-surface-border rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-accent/50"
                  >
                    {historyKeys.length === 0 && (
                      <option value="">No history available yet</option>
                    )}
                    {historyKeys.map(k => (
                      <option key={k} value={k}>{k} ({probHistory[k].length} pts)</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] text-muted">Strategy</label>
                  <select
                    value={btCfg.strategy}
                    onChange={e => setBtCfg(c => ({ ...c, strategy: e.target.value as BacktestConfig['strategy'] }))}
                    className="w-full bg-surface border border-surface-border rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-accent/50"
                  >
                    <option value="mean_reversion">Mean Reversion — fade extremes toward 50 %</option>
                    <option value="momentum">Momentum — follow 3-bar trend</option>
                    <option value="threshold">Threshold — fade overextended probs</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <NumInput label="Buy YES below" unit="%" value={btCfg.buyYesBelow}  min={5}  max={49} onChange={v => setBtCfg(c => ({ ...c, buyYesBelow: v }))} />
                  <NumInput label="Buy NO above"  unit="%" value={btCfg.buyNoAbove}   min={51} max={95} onChange={v => setBtCfg(c => ({ ...c, buyNoAbove: v }))} />
                  <NumInput label="Exit target"   unit="%" value={btCfg.exitTarget}   min={30} max={70} onChange={v => setBtCfg(c => ({ ...c, exitTarget: v }))} />
                  <NumInput label="Trade size"    unit="$" value={btCfg.tradeSize}    min={1}           onChange={v => setBtCfg(c => ({ ...c, tradeSize: v }))} />
                  <NumInput label="Stop loss"     unit="% inv" value={btCfg.stopLoss}    min={1}  max={100} onChange={v => setBtCfg(c => ({ ...c, stopLoss: v }))} />
                  <NumInput label="Take profit"   unit="% inv" value={btCfg.takeProfit}  min={1}  max={500} onChange={v => setBtCfg(c => ({ ...c, takeProfit: v }))} />
                </div>

                <button
                  onClick={handleRunBacktest}
                  disabled={btRunning || historyKeys.length === 0}
                  className="w-full py-2 rounded text-xs font-bold bg-accent/20 text-accent border border-accent/40 hover:bg-accent/30 disabled:opacity-40 transition-all"
                >
                  {btRunning ? '⟳ Running…' : '▶ Run Backtest'}
                </button>

                {historyKeys.length === 0 && (
                  <p className="text-[10px] text-muted text-center">
                    Probability history not yet loaded. Wait for the market poller or select a live market.
                  </p>
                )}
              </div>

              {/* Results panel */}
              <div className="flex-1 min-w-0 space-y-3">
                {!btResult && !btRunning && (
                  <div className="flex items-center justify-center h-48 text-2xs text-muted bg-surface-panel rounded border border-surface-border">
                    Configure a strategy on the left and click Run Backtest.
                  </div>
                )}

                {btRunning && (
                  <div className="flex items-center justify-center h-48 text-2xs text-accent bg-surface-panel rounded border border-surface-border animate-pulse">
                    Running backtest…
                  </div>
                )}

                {btResult && btStats && (
                  <>
                    {/* Stats row */}
                    <div className="flex gap-2 flex-wrap">
                      <StatBox label="Trades"   value={String(btResult.trades.length)} />
                      <StatBox label="Win rate" value={fmtPct(btStats.winRate)}
                        color={btStats.winRate >= 50 ? '#22c55e' : '#ef4444'} />
                      <StatBox label="Net P&L"  value={fmtUsd(btStats.totalPnl, true)}
                        color={pnlColor(btStats.totalPnl)} />
                      <StatBox label="Max DD"   value={fmtUsd(btStats.maxDrawdown)}
                        color={btStats.maxDrawdown > 0 ? '#ef4444' : '#94a3b8'} />
                      <StatBox label="Avg trade" value={fmtUsd(btStats.avgTrade, true)}
                        color={pnlColor(btStats.avgTrade)} />
                      <StatBox label="Wins"      value={`${btStats.wins} / ${btResult.trades.length}`} />
                    </div>

                    {/* Equity curve */}
                    <div className="bg-surface-panel rounded border border-surface-border p-3 space-y-2">
                      <div className="text-[10px] font-semibold text-muted uppercase tracking-wider">
                        Backtest equity curve — {btCfg.marketKey} · {btCfg.strategy.replace('_', ' ')}
                      </div>
                      <EquityCanvas equity={btResult.equity} />
                    </div>

                    {/* Trade log */}
                    <div className="bg-surface-panel rounded border border-surface-border overflow-hidden">
                      <div className="px-3 py-2 border-b border-surface-border text-[10px] font-semibold text-muted uppercase tracking-wider">
                        Simulated trades ({btResult.trades.length})
                      </div>
                      <div className="overflow-y-auto max-h-72">
                        <table className="w-full text-2xs font-mono">
                          <thead className="sticky top-0 bg-surface-panel">
                            <tr className="border-b border-surface-border/50 text-muted text-[10px]">
                              <th className="px-2 py-1 text-center">Side</th>
                              <th className="px-2 py-1 text-right">Entry</th>
                              <th className="px-2 py-1 text-right">Exit</th>
                              <th className="px-2 py-1 text-right">Shares</th>
                              <th className="px-2 py-1 text-right">P&L</th>
                              <th className="px-2 py-1 text-left">Reason</th>
                            </tr>
                          </thead>
                          <tbody>
                            {btResult.trades.map(t => (
                              <tr key={t.id} className="border-b border-surface-border/20 hover:bg-surface-hover/20">
                                <td className="px-2 py-0.5 text-center">
                                  <span className={`font-bold ${t.side === 'yes' ? 'text-emerald-400' : 'text-red-400'}`}>
                                    {t.side.toUpperCase()}
                                  </span>
                                </td>
                                <td className="px-2 py-0.5 text-right">
                                  {(t.side === 'yes' ? t.entryPrice : 100 - t.entryPrice).toFixed(1)}%
                                </td>
                                <td className="px-2 py-0.5 text-right">
                                  {(t.side === 'yes' ? t.exitPrice : 100 - t.exitPrice).toFixed(1)}%
                                </td>
                                <td className="px-2 py-0.5 text-right text-muted">{t.shares.toFixed(1)}</td>
                                <td className="px-2 py-0.5 text-right font-bold" style={{ color: pnlColor(t.pnl) }}>
                                  {fmtUsd(t.pnl, true)}
                                </td>
                                <td className="px-2 py-0.5 text-muted/70 text-[10px]">{t.exitReason}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ─────────────────── REPORT ────────────────────────────────── */}
        {tab === 'report' && (
          <div className="p-3 space-y-3">

            {/* Bankroll config */}
            <div className="flex items-center gap-3 bg-surface-panel rounded border border-surface-border px-3 py-2">
              <span className="text-2xs text-muted">Starting bankroll</span>
              <div className="flex items-center gap-1">
                <span className="text-2xs text-muted">$</span>
                <input
                  type="number" min="1" value={bankroll}
                  onChange={e => setBankroll(Math.max(1, +e.target.value))}
                  className="w-24 bg-surface border border-surface-border rounded px-2 py-0.5 text-2xs font-mono text-slate-200 focus:outline-none focus:border-accent/50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                />
              </div>
              <div className="ml-auto flex items-center gap-3 text-2xs font-mono text-muted">
                <span>Available: <span className="text-slate-300 font-bold">
                  {fmtUsd(bankroll - inPositions + stats.totalPnl)}
                </span></span>
                <span>In positions: <span className="text-slate-300">{fmtUsd(inPositions)}</span></span>
              </div>
            </div>

            {/* Stats */}
            <div className="flex gap-2 flex-wrap">
              <StatBox
                label="Net P&L" value={fmtUsd(stats.totalPnl, true)}
                sub={trades.length ? fmtPct((stats.totalPnl / bankroll) * 100, true) + ' ROI' : undefined}
                color={pnlColor(stats.totalPnl)}
              />
              <StatBox
                label="Win rate" value={trades.length ? fmtPct(stats.winRate) : '—'}
                sub={trades.length ? `${stats.wins} / ${trades.length}` : undefined}
                color={stats.winRate >= 50 ? '#22c55e' : trades.length ? '#ef4444' : undefined}
              />
              <StatBox label="Closed trades" value={String(trades.length)} />
              <StatBox label="Open positions" value={String(positions.length)} />
              <StatBox
                label="Max drawdown" value={stats.maxDrawdown > 0 ? fmtUsd(stats.maxDrawdown) : '$0.00'}
                color={stats.maxDrawdown > 0 ? '#ef4444' : undefined}
              />
              <StatBox
                label="Avg trade" value={trades.length ? fmtUsd(stats.avgTrade, true) : '—'}
                color={trades.length ? pnlColor(stats.avgTrade) : undefined}
              />
              <StatBox
                label="Total fees paid"
                value={lifetime.totalFees ? fmtUsd(lifetime.totalFees) : '$0.00'}
                sub={lifetime.totalFees && stats.totalPnl !== 0
                  ? fmtPct((lifetime.totalFees / Math.abs(stats.totalPnl + lifetime.totalFees)) * 100) + ' of gross'
                  : undefined}
                color="#f59e0b"
              />
            </div>

            {/* Equity curve */}
            <div className="bg-surface-panel rounded border border-surface-border p-3 space-y-2">
              <div className="text-[10px] font-semibold text-muted uppercase tracking-wider">
                Equity curve (manual + signal trades)
              </div>
              <EquityCanvas equity={reportEquity} />
            </div>

            {/* Trade log */}
            <div className="bg-surface-panel rounded border border-surface-border overflow-hidden">
              <div className="px-3 py-2 border-b border-surface-border flex items-center justify-between">
                <span className="text-[10px] font-semibold text-muted uppercase tracking-wider">
                  Trade Log
                </span>
                <span className="text-[10px] text-muted font-mono">{trades.length} records</span>
              </div>

              {trades.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-2xs text-muted">
                  No closed trades yet — place and close a paper trade on the Trade tab.
                </div>
              ) : (
                <div className="overflow-y-auto max-h-96">
                  <table className="w-full text-2xs font-mono">
                    <thead className="sticky top-0 bg-surface-panel">
                      <tr className="border-b border-surface-border/50 text-muted text-[10px]">
                        <th className="px-2 py-1.5 text-left">Closed</th>
                        <th className="px-2 py-1.5 text-left">Market</th>
                        <th className="px-2 py-1.5 text-left">Model</th>
                        <th className="px-2 py-1.5 text-center">Side</th>
                        <th className="px-2 py-1.5 text-right">Entry</th>
                        <th className="px-2 py-1.5 text-right">Exit</th>
                        <th className="px-2 py-1.5 text-right">Size</th>
                        <th className="px-2 py-1.5 text-right">Gross P&L</th>
                        <th className="px-2 py-1.5 text-right text-amber-400/80">Fees</th>
                        <th className="px-2 py-1.5 text-right">Net P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map(t => {
                        const gross = t.grossPnl ?? t.pnl  // fallback for old records without grossPnl
                        const fees  = (t.entryFee ?? 0) + (t.exitFee ?? 0)
                        return (
                        <tr key={t.id} className="border-b border-surface-border/20 hover:bg-surface-hover/20">
                          <td className="px-2 py-1 text-muted/70">{fmtTime(t.exitTime)}</td>
                          <td className="px-2 py-1 text-slate-400 max-w-[90px] truncate">{t.marketKey}</td>
                          <td className="px-2 py-1">
                            {t.model ? (
                              <span
                                className="text-[10px] font-mono px-1 py-0.5 rounded"
                                style={{ backgroundColor: `${MODEL_COLORS[t.model as ModelName]}22`, color: MODEL_COLORS[t.model as ModelName] }}
                              >
                                {MODEL_LABELS[t.model as ModelName] ?? t.model}
                              </span>
                            ) : <span className="text-muted/40 text-[10px]">{t.source}</span>}
                          </td>
                          <td className="px-2 py-1 text-center">
                            <span className={`font-bold ${t.side === 'yes' ? 'text-emerald-400' : 'text-red-400'}`}>
                              {t.side.toUpperCase()}
                            </span>
                          </td>
                          <td className="px-2 py-1 text-right">
                            {(t.side === 'yes' ? t.entryPrice : 100 - t.entryPrice).toFixed(1)}%
                          </td>
                          <td className="px-2 py-1 text-right">
                            {(t.side === 'yes' ? t.exitPrice : 100 - t.exitPrice).toFixed(1)}%
                          </td>
                          <td className="px-2 py-1 text-right text-muted">{fmtUsd(t.size)}</td>
                          <td className="px-2 py-1 text-right" style={{ color: pnlColor(gross) }}>
                            {fmtUsd(gross, true)}
                          </td>
                          <td className="px-2 py-1 text-right text-amber-400 text-[10px]">
                            {fees > 0 ? `−${fmtUsd(fees)}` : '—'}
                          </td>
                          <td className="px-2 py-1 text-right font-bold" style={{ color: pnlColor(t.pnl) }}>
                            {fmtUsd(t.pnl, true)}
                          </td>
                        </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

          </div>
        )}

      </div>
    </div>
  )
}
