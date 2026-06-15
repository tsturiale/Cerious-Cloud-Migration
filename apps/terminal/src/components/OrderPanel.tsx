/**
 * OrderPanel — simplified execution panel below the order book.
 *
 * Layout:
 *   Size input + quick-fill buttons
 *   Limit price overrides (YES ¢ | NO ¢)  ← auto-populated when a DOM level is clicked
 *   BUY  row: [MKT YES] [MKT NO]  /  [LMT YES] [LMT NO]
 *   SELL row: [MKT YES] [MKT NO]  /  [LMT YES] [LMT NO]
 *   Live price footer
 *   Fills table (session fills for this market)
 */

import { useState, useEffect, useMemo } from 'react'
import toast from 'react-hot-toast'
import { useStore } from '../store'
import { loadSettings } from './Settings'
import type { Asset, PolyTradeTick } from '../types'

interface Props { asset: Asset }

const YES_COL = '#00d4a4'
const NO_COL  = '#ff4757'
const API     = '/api'
const EMPTY: PolyTradeTick[] = []

type OrderSide = 'buy' | 'sell'
type OrderType = 'market' | 'limit'
type Outcome   = 'yes' | 'no'

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`
}
function fmtDollar(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

export function OrderPanel({ asset }: Props) {
  const [size,     setSize]     = useState('100')
  const [yesLimit, setYesLimit] = useState('')
  const [noLimit,  setNoLimit]  = useState('')
  const [placing,  setPlacing]  = useState<string | null>(null)

  const book          = useStore(s => s.polyBooks[s.activeMarketKey ?? ''] ?? null)
  const market        = useStore(s => s.markets.find(m => m.key === s.activeMarketKey) ?? null)
  const metrics       = useStore(s => s.metrics)
  const activeKey     = useStore(s => s.activeMarketKey)
  const fills         = useStore(s => (activeKey ? s.fills[activeKey] : undefined) ?? EMPTY)
  const positions     = useStore(s => s.positions)
  const bookClick     = useStore(s => s.bookClickPrice)
  const setBookClick  = useStore(s => s.setBookClickPrice)

  const maxPositions  = loadSettings().manualMaxOrders
  const posCount      = metrics?.concurrent_positions ?? positions.length
  const yesPositions  = positions.filter(p => p.direction === 'UP')
  const noPositions   = positions.filter(p => p.direction === 'DOWN')
  const yesShares     = yesPositions.reduce((sum, p) => sum + p.size, 0)
  const noShares      = noPositions.reduce((sum, p)  => sum + p.size, 0)
  const sharesTotal   = yesShares + noShares
  const yesPnl        = yesPositions.reduce((sum, p) => sum + p.unrealized_pnl, 0)
  const noPnl         = noPositions.reduce((sum, p)  => sum + p.unrealized_pnl, 0)

  // When a DOM level is clicked, pre-fill the matching limit input
  useEffect(() => {
    if (!bookClick) return
    if (bookClick.outcome === 'yes') setYesLimit(String(bookClick.cents))
    else                             setNoLimit(String(bookClick.cents))
    setBookClick(null)
  }, [bookClick])

  const isDeadzone = useMemo(() => {
    if (!market) return false
    const tf = market.timeframe
    if (tf !== '5min' && tf !== '15min') return false
    
    const now = Date.now()
    const tfDurMs = tf === '5min' ? 300_000 : 900_000
    const deadzoneMs = tf === '5min' ? 60_000 : 180_000
    
    // Period start relative to current expiry
    if (market.expiry_ts) {
      const pStart = market.expiry_ts - tfDurMs
      return (now >= pStart) && (now < pStart + deadzoneMs)
    }
    
    // Fallback to wall-clock alignment
    const tfSec = (tf === '5min' ? 5 : 15) * 60
    const pStartWall = Math.floor(now / 1000 / tfSec) * tfSec * 1000
    return (now >= pStartWall) && (now < pStartWall + deadzoneMs)
  }, [market])

  const blocked = metrics?.at_trade_limit || metrics?.at_loss_limit || posCount >= maxPositions || isDeadzone

  // Live prices (0–1 scale)
  const yesBid = book?.best_bid  ?? (market ? market.up_pct   / 100 : 0.5)
  const yesAsk = book?.best_ask  ?? (market ? market.up_pct   / 100 : 0.5)
  const noAsk  = 1 - yesBid
  const noBid  = 1 - yesAsk

  const yesLive = market ? market.up_pct   : (yesBid + yesAsk) / 2 * 100
  const noLive  = market ? market.down_pct : (noAsk + noBid)   / 2 * 100

  function marketPrice(side: OrderSide, outcome: Outcome): number {
    if (outcome === 'yes') return side === 'buy' ? yesAsk : yesBid
    else                   return side === 'buy' ? noAsk  : noBid
  }

  function limitPrice(outcome: Outcome): number | null {
    const raw = outcome === 'yes' ? yesLimit : noLimit
    const v   = parseFloat(raw)
    if (!raw || isNaN(v) || v <= 0 || v >= 100) return null
    return v / 100
  }

  async function placeOrder(side: OrderSide, type: OrderType, outcome: Outcome) {
    const btnKey   = `${side}-${type}-${outcome}`
    const direction = outcome === 'yes' ? 'UP' : 'DOWN'
    const price     = type === 'limit' ? limitPrice(outcome) : marketPrice(side, outcome)

    if (price === null) {
      toast.error('Enter a valid limit price (1–99¢)', {
        style: { background: '#0f1629', color: '#ff4757', border: '1px solid #ff4757' },
      })
      return
    }
    if (blocked) return
    setPlacing(btnKey)

    try {
      const resp = await fetch(`${API}/order`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset, direction, side,
          size:         parseFloat(size) || 100,
          price,
          partial_exit: false,
          market_key:   activeKey,
        }),
      })
      const data = await resp.json()
      if (resp.ok) {
        const label   = `${side.toUpperCase()} ${type.toUpperCase()} ${outcome.toUpperCase()}`
        const fillCol = outcome === 'yes' ? YES_COL : NO_COL
        toast.success(
          `FILL ✓  ${label}\n${(price * 100).toFixed(1)}¢  ·  $${size}`,
          {
            duration: 5000,
            position: 'top-center',
            style: {
              background: '#0a1628', color: '#e2e8f0',
              border: `2px solid ${fillCol}`,
              fontSize: '13px', fontFamily: 'JetBrains Mono, monospace',
              padding: '12px 20px', minWidth: '260px', whiteSpace: 'pre-line',
            },
            iconTheme: { primary: fillCol, secondary: '#0a1628' },
          }
        )
      } else {
        toast.error(data.error ?? 'Order failed', {
          style: { background: '#0f1629', color: '#ff4757', border: '1px solid #ff4757' },
        })
      }
    } catch {
      toast.error('Network error', { style: { background: '#0f1629', color: '#ff4757', border: '1px solid #ff4757' } })
    } finally {
      setPlacing(null)
    }
  }

  async function quickExit(outcome: Outcome, pct: number) {
    const posSize = outcome === 'yes' ? yesShares : noShares
    const exitSize = Math.round(posSize * pct / 100)
    if (exitSize <= 0) return
    const btnKey = `quick-exit-${outcome}-${pct}`
    setPlacing(btnKey)
    const price     = marketPrice('sell', outcome)
    const direction = outcome === 'yes' ? 'UP' : 'DOWN'
    const fillCol   = outcome === 'yes' ? YES_COL : NO_COL
    try {
      const resp = await fetch(`${API}/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset, direction, side: 'sell',
          size:         exitSize,
          price,
          partial_exit: pct < 100,
          market_key:   activeKey,
        }),
      })
      const data = await resp.json()
      if (resp.ok) {
        toast.success(
          `EXIT ${pct}% ${outcome.toUpperCase()}\n${(price * 100).toFixed(1)}¢  ·  $${exitSize}`,
          {
            duration: 5000, position: 'top-center',
            style: {
              background: '#0a1628', color: '#e2e8f0',
              border: `2px solid ${fillCol}`, fontSize: '13px',
              fontFamily: 'JetBrains Mono, monospace',
              padding: '12px 20px', minWidth: '260px', whiteSpace: 'pre-line',
            },
            iconTheme: { primary: fillCol, secondary: '#0a1628' },
          }
        )
      } else {
        toast.error(data.error ?? 'Exit failed', {
          style: { background: '#0f1629', color: '#ff4757', border: '1px solid #ff4757' },
        })
      }
    } catch {
      toast.error('Network error', { style: { background: '#0f1629', color: '#ff4757', border: '1px solid #ff4757' } })
    } finally {
      setPlacing(null)
    }
  }

  function btnCls(side: OrderSide, type: OrderType, outcome: Outcome) {
    const key       = `${side}-${type}-${outcome}`
    const isLoading = placing === key
    const isMarket  = type === 'market'
    const base = 'flex-1 rounded text-[10px] font-bold font-mono uppercase tracking-wide transition-all py-1.5 px-1 disabled:opacity-40 disabled:cursor-not-allowed'
    if (isLoading)               return `${base} opacity-60 cursor-wait`
    if (side === 'buy'  && isMarket)  return `${base} text-black`
    if (side === 'buy'  && !isMarket) return `${base} border`
    if (side === 'sell' && isMarket)  return `${base} border-2`
    return `${base} border opacity-80`
  }
  function btnStyle(side: OrderSide, type: OrderType, outcome: Outcome): React.CSSProperties {
    const col = outcome === 'yes' ? YES_COL : NO_COL
    if (side === 'buy'  && type === 'market') return { background: col, color: '#000' }
    if (side === 'buy'  && type === 'limit')  return { borderColor: col, color: col }
    if (side === 'sell' && type === 'market') return { borderColor: col, color: col, borderWidth: 2, background: `${col}15` }
    return { borderColor: `${col}60`, color: `${col}90` }
  }

  // Fills table — newest first
  const recentFills = useMemo(
    () => [...fills].sort((a, b) => b.timestamp - a.timestamp).slice(0, 20),
    [fills]
  )

  return (
    <div className="flex flex-col h-full font-mono text-[11px] bg-surface overflow-hidden">

      {/* ── Live positions stats bar ────────────────────────────────────── */}
      <div className="shrink-0 px-2 py-1 border-b border-surface-border/60 bg-black/20 grid grid-cols-4 gap-px">
        {/* Positions */}
        <div className="flex flex-col items-center py-0.5">
          <span className="text-[7px] text-muted/40 uppercase tracking-wider leading-none mb-0.5">Pos</span>
          <span className={`text-[12px] font-black tabular-nums leading-none ${posCount >= maxPositions ? 'text-red-400' : 'text-accent'}`}>
            {posCount}<span className="text-[9px] text-muted/40">/{maxPositions}</span>
          </span>
        </div>
        {/* Shares */}
        <div className="flex flex-col items-center border-x border-surface-border/40 py-0.5">
          <span className="text-[7px] text-muted/40 uppercase tracking-wider leading-none mb-0.5">Shares</span>
          <span className="text-[12px] font-black tabular-nums leading-none text-slate-200">
            {sharesTotal >= 1000 ? `${(sharesTotal / 1000).toFixed(1)}K` : sharesTotal.toFixed(0)}
          </span>
        </div>
        {/* YES P&L */}
        <div className="flex flex-col items-center border-r border-surface-border/40 py-0.5">
          <span className="text-[7px] uppercase tracking-wider leading-none mb-0.5 font-bold" style={{ color: `${YES_COL}80` }}>Y P&amp;L</span>
          <span className="text-[11px] font-black tabular-nums leading-none" style={{ color: yesPnl >= 0 ? YES_COL : NO_COL }}>
            {yesPnl >= 0 ? '+' : ''}{yesPnl.toFixed(2)}
          </span>
        </div>
        {/* NO P&L */}
        <div className="flex flex-col items-center py-0.5">
          <span className="text-[7px] uppercase tracking-wider leading-none mb-0.5 font-bold" style={{ color: `${NO_COL}80` }}>N P&amp;L</span>
          <span className="text-[11px] font-black tabular-nums leading-none" style={{ color: noPnl >= 0 ? YES_COL : NO_COL }}>
            {noPnl >= 0 ? '+' : ''}{noPnl.toFixed(2)}
          </span>
        </div>
      </div>

      {/* ── Size ─────────────────────────────────────────────────────────── */}
      <div className="shrink-0 px-2 pt-2 pb-1 border-b border-surface-border/60">
        <div className="flex items-center gap-1 mb-1">
          <span className="text-[9px] text-muted/60 uppercase tracking-wider w-8">Size</span>
          <div className="relative flex-1">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted/50 text-[10px]">$</span>
            <input
              type="number"
              value={size}
              onChange={e => setSize(e.target.value)}
              min="1" max="10000000" step="1"
              className="w-full bg-surface-card border border-surface-border rounded pl-5 pr-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-accent/60"
            />
          </div>
          {/* Positions count badge */}
          <div className="shrink-0 flex flex-col items-center px-1.5 py-0.5 rounded border border-surface-border bg-surface-card/60 min-w-[36px]">
            <span className="text-[7px] text-muted/50 uppercase leading-none">Pos</span>
            <span className={`text-[11px] font-black tabular-nums leading-tight ${
              posCount >= maxPositions ? 'text-red-400' : 'text-accent'
            }`}>
              {posCount}<span className="text-[8px] text-muted/40">/{maxPositions}</span>
            </span>
          </div>
        </div>
        {/* Row 1: small sizes */}
        <div className="flex gap-1 mb-1">
          {['5', '10', '15', '25', '50'].map(s => (
            <button key={s} onClick={() => setSize(s)}
              className={`flex-1 py-0.5 rounded text-[8px] font-bold transition-all ${
                size === s
                  ? 'bg-accent/20 text-accent border border-accent/40'
                  : 'bg-surface-card border border-surface-border text-muted/50 hover:text-muted'
              }`}>
              ${s}
            </button>
          ))}
        </div>
        {/* Row 2: larger sizes */}
        <div className="flex gap-1 mb-1">
          {['100', '200', '300', '500', '1000'].map(s => (
            <button key={s} onClick={() => setSize(s)}
              className={`flex-1 py-0.5 rounded text-[8px] font-bold transition-all ${
                size === s
                  ? 'bg-accent/20 text-accent border border-accent/40'
                  : 'bg-surface-card border border-surface-border text-muted/60 hover:text-muted'
              }`}>
              {s === '1000' ? '1K' : `$${s}`}
            </button>
          ))}
        </div>
        {/* Row 3: high-notional sizes */}
        <div className="flex gap-1 mb-1.5">
          {[
            { label: '10K', val: '10000' },
            { label: '30K', val: '30000' },
            { label: '100K', val: '100000' },
            { label: '240K', val: '240000' },
            { label: '500K', val: '500000' }
          ].map(item => (
            <button key={item.val} onClick={() => setSize(item.val)}
              className={`flex-1 py-0.5 rounded text-[8px] font-bold transition-all ${
                size === item.val
                  ? 'bg-accent/20 text-accent border border-accent/40'
                  : 'bg-surface-card border border-surface-border text-muted/60 hover:text-muted'
              }`}>
              {item.label}
            </button>
          ))}
        </div>

        {/* Row 3: quick exit % — YES and NO */}
        <div className="border-t border-surface-border/40 pt-1.5">
          <div className="text-[7px] text-muted/40 uppercase tracking-wider mb-1">Quick Exit</div>
          <div className="flex items-center gap-1 mb-1">
            <span className="text-[8px] font-bold w-6 shrink-0 tabular-nums" style={{ color: YES_COL }}>YES</span>
            {[25, 50, 75, 100].map(pct => (
              <button key={pct}
                onClick={() => quickExit('yes', pct)}
                disabled={yesShares <= 0 || !!placing}
                className="flex-1 py-0.5 rounded text-[8px] font-bold transition-all border disabled:opacity-25 hover:bg-white/5"
                style={{ borderColor: `${YES_COL}50`, color: YES_COL }}>
                {pct}%
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[8px] font-bold w-6 shrink-0 tabular-nums" style={{ color: NO_COL }}>NO</span>
            {[25, 50, 75, 100].map(pct => (
              <button key={pct}
                onClick={() => quickExit('no', pct)}
                disabled={noShares <= 0 || !!placing}
                className="flex-1 py-0.5 rounded text-[8px] font-bold transition-all border disabled:opacity-25 hover:bg-white/5"
                style={{ borderColor: `${NO_COL}50`, color: NO_COL }}>
                {pct}%
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Limit price inputs ──────────────────────────────────────────── */}
      <div className="shrink-0 px-2 py-1.5 border-b border-surface-border/60">
        <div className="text-[9px] text-muted/50 uppercase tracking-wider mb-1">Limit Price Override (¢)</div>
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <div className="text-[8px] font-bold mb-0.5" style={{ color: YES_COL }}>YES</div>
            <div className="relative">
              <input
                type="number"
                value={yesLimit}
                onChange={e => setYesLimit(e.target.value)}
                min="1" max="99" step="0.5"
                placeholder={yesLive.toFixed(1)}
                className="w-full bg-surface-card border border-surface-border rounded px-2 py-1 text-[11px] text-slate-200 focus:outline-none"
                style={{ borderColor: yesLimit ? `${YES_COL}60` : undefined }}
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-muted/40">¢</span>
            </div>
          </div>
          <div>
            <div className="text-[8px] font-bold mb-0.5" style={{ color: NO_COL }}>NO</div>
            <div className="relative">
              <input
                type="number"
                value={noLimit}
                onChange={e => setNoLimit(e.target.value)}
                min="1" max="99" step="0.5"
                placeholder={noLive.toFixed(1)}
                className="w-full bg-surface-card border border-surface-border rounded px-2 py-1 text-[11px] text-slate-200 focus:outline-none"
                style={{ borderColor: noLimit ? `${NO_COL}60` : undefined }}
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-muted/40">¢</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Order buttons ──────────────────────────────────────────────── */}
      <div className="shrink-0 px-2 py-1.5 flex flex-col gap-1.5 border-b border-surface-border/60">

        {/* BUY */}
        <div>
          <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400 mb-1">Buy</div>
          <div className="flex gap-1 mb-1">
            {(['yes', 'no'] as Outcome[]).map(o => (
              <button key={o} className={btnCls('buy','market',o)} style={btnStyle('buy','market',o)}
                disabled={!!placing || blocked} onClick={() => placeOrder('buy','market',o)}>
                {placing === `buy-market-${o}` ? '…' : `MKT ${o.toUpperCase()}`}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {(['yes', 'no'] as Outcome[]).map(o => (
              <button key={o} className={btnCls('buy','limit',o)} style={btnStyle('buy','limit',o)}
                disabled={!!placing || blocked} onClick={() => placeOrder('buy','limit',o)}>
                {placing === `buy-limit-${o}` ? '…' : `LMT ${o.toUpperCase()}`}
              </button>
            ))}
          </div>
        </div>

        <div className="h-px bg-surface-border/40" />

        {/* SELL */}
        <div>
          <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400 mb-1">Sell</div>
          <div className="flex gap-1 mb-1">
            {(['yes', 'no'] as Outcome[]).map(o => (
              <button key={o} className={btnCls('sell','market',o)} style={btnStyle('sell','market',o)}
                disabled={!!placing || blocked} onClick={() => placeOrder('sell','market',o)}>
                {placing === `sell-market-${o}` ? '…' : `MKT ${o.toUpperCase()}`}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {(['yes', 'no'] as Outcome[]).map(o => (
              <button key={o} className={btnCls('sell','limit',o)} style={btnStyle('sell','limit',o)}
                disabled={!!placing || blocked} onClick={() => placeOrder('sell','limit',o)}>
                {placing === `sell-limit-${o}` ? '…' : `LMT ${o.toUpperCase()}`}
              </button>
            ))}
          </div>
        </div>

        {blocked && (
          <div className="rounded p-1.5 text-[9px] font-mono border"
            style={{ background: `${NO_COL}10`, borderColor: `${NO_COL}40`, color: NO_COL }}>
            {isDeadzone ? '⏳ DEADZONE: Wait for session stability' :
             metrics?.at_trade_limit ? '⛔ Daily trade limit' :
             metrics?.at_loss_limit  ? '⛔ Daily loss limit'  :
                                       '⛔ Max positions open'}
          </div>
        )}
      </div>

      {/* ── Live price footer ───────────────────────────────────────────── */}
      <div className="shrink-0 px-2 py-1 border-b border-surface-border/50 flex items-center justify-between bg-black/20">
        <div className="flex flex-col items-center flex-1">
          <span className="text-[7px] uppercase tracking-widest" style={{ color: `${YES_COL}80` }}>YES</span>
          <span className="text-[13px] font-black tabular-nums leading-tight" style={{ color: YES_COL }}>
            {yesLive.toFixed(1)}¢
          </span>
        </div>
        <div className="flex flex-col items-center shrink-0">
          {book && (
            <>
              <span className="text-[7px] text-muted/40 uppercase">sprd</span>
              <span className="text-[9px] text-muted/50 tabular-nums font-mono">
                {((yesAsk - yesBid) * 100).toFixed(1)}¢
              </span>
            </>
          )}
        </div>
        <div className="flex flex-col items-center flex-1">
          <span className="text-[7px] uppercase tracking-widest" style={{ color: `${NO_COL}80` }}>NO</span>
          <span className="text-[13px] font-black tabular-nums leading-tight" style={{ color: NO_COL }}>
            {noLive.toFixed(1)}¢
          </span>
        </div>
      </div>

      {/* ── Fills table ─────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="shrink-0 px-2 py-1 flex items-center justify-between border-b border-surface-border/40 bg-surface-card/30">
          <span className="text-[9px] font-bold uppercase tracking-wider text-accent/80">Fills</span>
          <span className="text-[8px] text-muted/40 tabular-nums">{fills.length}</span>
        </div>
        {recentFills.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-[9px] text-muted/40 font-mono">
            {activeKey ? 'no fills yet' : '—'}
          </div>
        ) : (
          <>
            {/* Column headers */}
            <div className="shrink-0 grid grid-cols-4 px-2 py-[3px] border-b border-surface-border/30 bg-surface-card/20">
              <span className="text-[7px] text-muted/40 uppercase">Time</span>
              <span className="text-[7px] text-muted/40 uppercase text-center">Side</span>
              <span className="text-[7px] text-muted/40 uppercase text-right">Price</span>
              <span className="text-[7px] text-muted/40 uppercase text-right">Size</span>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
              <div className="divide-y divide-surface-border/20">
                {recentFills.map((fill, i) => {
                  const isYes = fill.side === 'yes'
                  const col   = isYes ? YES_COL : NO_COL
                  return (
                    <div key={`${fill.timestamp}-${i}`} className="grid grid-cols-4 px-2 py-[4px] items-center hover:bg-white/[0.02]">
                      <span className="text-[8px] text-muted/50 tabular-nums font-mono">{fmtTime(fill.timestamp)}</span>
                      <div className="flex justify-center">
                        <span className="text-[8px] font-bold px-1 rounded-sm" style={{ color: col, background: `${col}20` }}>
                          {isYes ? 'YES' : 'NO'}
                        </span>
                      </div>
                      <span className="text-[9px] font-bold tabular-nums text-right" style={{ color: col }}>
                        {(fill.price ?? 50).toFixed(1)}¢
                      </span>
                      <span className="text-[9px] tabular-nums text-right text-slate-300">
                        {fmtDollar(fill.size ?? 0)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </div>

    </div>
  )
}
