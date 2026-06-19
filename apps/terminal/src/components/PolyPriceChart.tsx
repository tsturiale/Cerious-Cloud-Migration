/**
 * PolyPriceChart — Period-anchored canvas price chart.
 *
 * X-axis: fixed window from period open (left) → expiry_ts (right).
 * Y-axis: dynamic, centered on live price.
 * Shows the full market session at a glance — where price is relative
 * to the event reference, how much time remains, and current momentum.
 */

import { useRef, useEffect, useCallback, useMemo, useState } from 'react'
import { useStore } from '../store'

// ── Period duration map ───────────────────────────────────────────────────────
const TF_MS: Record<string, number> = {
  '5min':  5  * 60_000,
  '15min': 15 * 60_000,
  '1h':    60 * 60_000,
  '4h':    4  * 60 * 60_000,
}

// ── Style constants ───────────────────────────────────────────────────────────
const GRID_COL    = 'rgba(30,45,78,0.5)'
const SETTLE_COL  = '#c0c7d1'
const SETTLE_CORE = '#f8fafc'
const PRICE_COL   = '#f97316'
const LABEL_COL   = '#4a5568'
const CURSOR_COL  = 'rgba(255,255,255,0.15)'
const EXPIRY_COL  = '#ff4757'
const FONT        = 'Cascadia Mono, Consolas, monospace'
const MAX_POINTS  = 72_000
const SAMPLE_MS   = 100

interface Pt { t: number; y: number }

function fmtMmSs(ms: number): string {
  const s = Math.round(ms / 1000)
  const m = Math.floor(Math.abs(s) / 60)
  const sec = Math.abs(s) % 60
  const sign = s < 0 ? '-' : ''
  return `${sign}${m}:${sec.toString().padStart(2, '0')}`
}

export function PolyPriceChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bufRef    = useRef<Pt[]>([])
  const rafRef    = useRef(0)
  const sampRef   = useRef<ReturnType<typeof setInterval> | null>(null)
  const assetRef  = useRef<string | null>(null)
  const condIdRef = useRef<string | undefined>(undefined)
  const lastSampleTsRef = useRef(0)

  const [, setTick] = useState(0)

  const activeAsset    = useStore(s => s.activeAsset)
  const activeMarketKey = useStore(s => s.activeMarketKey)
  const markets        = useStore(s => s.markets)
  const bars           = useStore(s => s.bars[activeAsset])

  // ── Active market ──────────────────────────────────────────────────────────
  const activeMarket = useMemo(
    () => markets.find(m => m.key === activeMarketKey && m.asset === activeAsset)
       ?? markets.find(m => m.asset === activeAsset),
    [markets, activeMarketKey, activeAsset],
  )

  // ── Period window ──────────────────────────────────────────────────────────
  const expiryMs    = activeMarket?.expiry_ts ?? 0          // already in ms
  const tfDurMs     = TF_MS[activeMarket?.timeframe ?? '5min'] ?? 300_000
  const periodStart = expiryMs > 0 ? expiryMs - tfDurMs : 0

  // ── Settlement / strike price ──────────────────────────────────────────────
  // Priority 1: backend-provided event reference.
  // Priority 2: open of bars inside the active market period (fallback estimate).
  // Priority 3: backend start_price, then settlement resolution_price.
  const settlementPrice = useMemo(() => {
    if (!activeMarket) return null
    if (activeMarket.price_to_beat) return activeMarket.price_to_beat
    if (bars?.length && activeMarket.expiry_ts) {
      const PERIOD_MS: Record<string, number> = {
        '5min': 5 * 60 * 1000, '15min': 15 * 60 * 1000,
        '1h': 60 * 60 * 1000,  '4h': 4 * 60 * 60 * 1000,
      }
      const periodMs = PERIOD_MS[activeMarket.timeframe] ?? 0
      if (periodMs) {
        const periodStartMs = activeMarket.expiry_ts - periodMs
        const periodEndMs = activeMarket.expiry_ts
        const inPeriod = bars
          .filter(b => b.timestamp >= periodStartMs && b.timestamp < periodEndMs)
          .sort((a, b) => a.timestamp - b.timestamp)
        if (inPeriod.length > 0 && inPeriod[0].open) return inPeriod[0].open
      }
    }
    if (activeMarket.start_price) return activeMarket.start_price
    if (activeMarket.resolution_price) return activeMarket.resolution_price
    return null
  }, [activeMarket, bars])

  const conditionId = activeMarket?.condition_id

  // ── Seed / Reset on asset change ───────────────────────────────────────────
  useEffect(() => {
    if (activeAsset !== assetRef.current) {
      assetRef.current = activeAsset
      if (bars.length > 0) {
        bufRef.current = bars.slice(-200).map(b => ({ t: b.timestamp, y: b.close }))
      } else {
        bufRef.current = []
      }
    }
  }, [activeAsset, bars])

  // ── Period rotation: trim to current period window ─────────────────────────
  useEffect(() => {
    if (!conditionId) return
    if (conditionId === condIdRef.current) return
    condIdRef.current = conditionId
    const cutoff = Date.now() - 2 * 60_000
    bufRef.current = bufRef.current.filter(p => p.t >= cutoff)
  }, [conditionId])

  // ── 100 ms live sampler ───────────────────────────────────────────────────
  useEffect(() => {
    sampRef.current = setInterval(() => {
      const s = useStore.getState()
      const asset = s.activeAsset
      const ticks = s.ticks[asset]
      const lastTick = ticks?.length > 0 ? ticks[ticks.length - 1] : null
      const currentBars = s.bars[asset]
      const lastBar = currentBars?.length > 0 ? currentBars[currentBars.length - 1] : null
      const price = lastTick ? lastTick.price : (lastBar?.close ?? 0)
      if (price === 0) return

      const now = Date.now()
      const buf = bufRef.current
      const last = buf.length > 0 ? buf[buf.length - 1] : null
      if (last && (now - last.t) < 80) return

      buf.push({ t: now, y: price })
      if (buf.length > MAX_POINTS) buf.splice(0, buf.length - MAX_POINTS)
      lastSampleTsRef.current = now
    }, SAMPLE_MS)

    const tickId = setInterval(() => setTick(n => n + 1), 1000)
    return () => {
      if (sampRef.current) clearInterval(sampRef.current)
      clearInterval(tickId)
    }
  }, [])

  // ── Draw loop ─────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const cvs = canvasRef.current
    if (!cvs) { rafRef.current = requestAnimationFrame(draw); return }
    const ctx = cvs.getContext('2d')
    if (!ctx) { rafRef.current = requestAnimationFrame(draw); return }

    const dpr  = window.devicePixelRatio || 1
    const rect = cvs.getBoundingClientRect()
    const W = rect.width
    const H = rect.height
    if (cvs.width !== Math.round(W * dpr) || cvs.height !== Math.round(H * dpr)) {
      cvs.width = Math.round(W * dpr)
      cvs.height = Math.round(H * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    const PT = 24, PB = 20, PL = 6, PR = 58
    const pW = W - PL - PR
    const pH = H - PT - PB

    const buf = bufRef.current
    const now = Date.now()

    // ── Time window: period start → expiry ──────────────────────────────────
    const state    = useStore.getState()
    const asset    = state.activeAsset
    const mktKey   = state.activeMarketKey
    const mkt      = state.markets.find(m => m.key === mktKey && m.asset === asset)
                  ?? state.markets.find(m => m.asset === asset)

    const expMs    = mkt?.expiry_ts ?? 0
    const tfDur    = TF_MS[mkt?.timeframe ?? '5min'] ?? 300_000
    const pStart   = expMs > 0 ? expMs - tfDur : (buf.length > 0 ? buf[0].t : now - tfDur)
    const tMin     = pStart
    const tMax     = expMs > 0 ? expMs : now + 30_000

    const xOf = (t: number) => PL + pW * Math.max(0, Math.min(1, (t - tMin) / (tMax - tMin)))
    
    // ── Deadzone Grayout ───────────────────────────────
    // First 1 min of 5min, first 3 min of 15min
    const timeframe = mkt?.timeframe ?? '5min'
    const deadzoneMs = timeframe === '5min' ? 60_000 : timeframe === '15min' ? 180_000 : 0
    if (deadzoneMs > 0) {
      const deadzoneEnd = tMin + deadzoneMs
      const dzX = xOf(deadzoneEnd)
      if (dzX > PL) {
        ctx.fillStyle = 'rgba(100, 116, 139, 0.25)' // Slate-500 with transparency
        ctx.fillRect(PL, PT, dzX - PL, pH)
        
        // Vertical boundary line
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.4)'
        ctx.lineWidth = 1
        ctx.setLineDash([2, 2])
        ctx.beginPath()
        ctx.moveTo(dzX, PT)
        ctx.lineTo(dzX, PT + pH)
        ctx.stroke()
        ctx.setLineDash([])

        // Subtle rotated label
        ctx.save()
        ctx.fillStyle = 'rgba(148, 163, 184, 0.4)'
        ctx.font = `bold 8px ${FONT}`
        ctx.textAlign = 'center'
        ctx.translate(PL + (dzX - PL) / 2, PT + pH / 2)
        ctx.rotate(-Math.PI / 2)
        ctx.fillText('DEADZONE', 0, 0)
        ctx.restore()
      }
    }

    // Filter buffer to the period window (+ small tail before start for context)
    const vis = buf.filter(p => p.t >= tMin - 5_000 && p.t <= tMax + 1_000)
    if (vis.length < 1) { rafRef.current = requestAnimationFrame(draw); return }

    // ── Current price ────────────────────────────────────────────────────────
    const barsList  = state.bars[asset]
    const latestBar = barsList[barsList.length - 1]
    const curP = latestBar?.close ?? (vis[vis.length - 1]?.y ?? 0)
    if (!curP) { rafRef.current = requestAnimationFrame(draw); return }

    const settle = settlementPrice ?? curP
    const visiblePrices = vis.map(p => p.y).filter(Number.isFinite)
    const scalePrices   = [...visiblePrices, curP, settle]
    const rawMin = Math.min(...scalePrices)
    const rawMax = Math.max(...scalePrices)
    const span   = Math.max(rawMax - rawMin, curP * 0.001)
    const pad    = Math.max(span * 0.18, curP * 0.0005)
    const yMin   = rawMin - pad
    const yMax   = rawMax + pad
    const yOf    = (v: number) => PT + pH * (1 - (v - yMin) / (yMax - yMin))

    // ── Y-axis grid ──────────────────────────────────────────────────────────
    const decimals = (asset === 'SOL' || asset === 'XRP') ? 3 : 2
    ctx.setLineDash([2, 5])
    ctx.strokeStyle = GRID_COL
    ctx.lineWidth   = 0.5
    const steps = 6
    for (let i = 0; i <= steps; i++) {
      const v  = yMin + (yMax - yMin) * (i / steps)
      const gy = yOf(v)
      ctx.beginPath(); ctx.moveTo(PL, gy); ctx.lineTo(PL + pW, gy); ctx.stroke()
      ctx.fillStyle  = LABEL_COL
      ctx.font       = `9px ${FONT}`
      ctx.textAlign  = 'left'
      ctx.fillText(
        '$' + v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
        PL + pW + 4, gy + 3
      )
    }
    ctx.setLineDash([])

    // ── X-axis time labels ───────────────────────────────────────────────────
    const periodMs = tMax - tMin
    // Pick ~4-6 label intervals
    const intervals = [30_000, 60_000, 120_000, 300_000, 600_000, 900_000]
    const targetTicks = 5
    const labelInterval = intervals.find(iv => periodMs / iv <= targetTicks + 1) ?? intervals[intervals.length - 1]

    ctx.fillStyle  = LABEL_COL
    ctx.font       = `8px ${FONT}`
    ctx.textAlign  = 'center'
    ctx.strokeStyle = GRID_COL
    ctx.lineWidth  = 0.4
    ctx.setLineDash([1, 4])

    const firstLabel = Math.ceil(tMin / labelInterval) * labelInterval
    for (let t = firstLabel; t <= tMax; t += labelInterval) {
      const x = xOf(t)
      if (x < PL + 10 || x > PL + pW - 5) continue
      ctx.beginPath(); ctx.moveTo(x, PT); ctx.lineTo(x, PT + pH); ctx.stroke()
      const d = new Date(t)
      ctx.fillText(
        `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`,
        x, PT + pH + 12
      )
    }
    ctx.setLineDash([])

    // ── Expiry boundary (right edge marker) ──────────────────────────────────
    if (expMs > 0) {
      const ex = xOf(expMs)
      if (ex >= PL && ex <= PL + pW) {
        ctx.strokeStyle = EXPIRY_COL
        ctx.lineWidth   = 1
        ctx.setLineDash([3, 3])
        ctx.globalAlpha = 0.5
        ctx.beginPath(); ctx.moveTo(ex, PT); ctx.lineTo(ex, PT + pH); ctx.stroke()
        ctx.globalAlpha = 1
        ctx.setLineDash([])
      }
    }

    // ── Now cursor (vertical line at current time) ────────────────────────────
    const nowX = xOf(now)
    if (nowX >= PL && nowX <= PL + pW) {
      ctx.strokeStyle = CURSOR_COL
      ctx.lineWidth   = 1.5
      ctx.setLineDash([])
      ctx.beginPath(); ctx.moveTo(nowX, PT); ctx.lineTo(nowX, PT + pH); ctx.stroke()
    }

    // Settlement / event-reference line.
    if (settlementPrice != null) {
      const sp = settlementPrice
      const sy = yOf(sp)

      ctx.setLineDash([])

      // Layer 1: wide outer glow (shadow)
      ctx.shadowColor = SETTLE_COL
      ctx.shadowBlur  = 14
      ctx.strokeStyle = SETTLE_COL
      ctx.lineWidth   = 2.5
      ctx.globalAlpha = 0.85
      ctx.beginPath(); ctx.moveTo(PL, sy); ctx.lineTo(PL + pW, sy); ctx.stroke()

      // Layer 2: bright core line
      ctx.shadowBlur  = 4
      ctx.strokeStyle = SETTLE_CORE
      ctx.lineWidth   = 1
      ctx.globalAlpha = 0.9
      ctx.beginPath(); ctx.moveTo(PL, sy); ctx.lineTo(PL + pW, sy); ctx.stroke()

      // Reset shadow
      ctx.shadowBlur  = 0
      ctx.shadowColor = 'transparent'
      ctx.globalAlpha = 1

      // Reference label tight against the glow line.
      ctx.shadowColor = SETTLE_COL
      ctx.shadowBlur  = 8
      ctx.fillStyle   = SETTLE_CORE
      ctx.font        = `bold 9px ${FONT}`
      ctx.textAlign   = 'left'
      const referenceLabel  = `REF $${sp.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 })}`
      ctx.fillText(referenceLabel, PL + 4, sy - 4)
      ctx.shadowBlur  = 0
      ctx.shadowColor = 'transparent'
    }

    // ── Price area ───────────────────────────────────────────────────────────
    if (vis.length >= 2) {
      ctx.save()
      ctx.beginPath()
      ctx.moveTo(xOf(vis[0].t), yOf(vis[0].y))
      for (let i = 1; i < vis.length; i++) {
        ctx.lineTo(xOf(vis[i].t), yOf(vis[i].y))
      }
      ctx.lineTo(xOf(vis[vis.length - 1].t), PT + pH)
      ctx.lineTo(xOf(vis[0].t), PT + pH)
      ctx.closePath()
      const fillGrad = ctx.createLinearGradient(0, PT, 0, PT + pH)
      fillGrad.addColorStop(0, 'rgba(249,115,22,0.28)')
      fillGrad.addColorStop(1, 'rgba(249,115,22,0.0)')
      ctx.fillStyle = fillGrad
      ctx.fill()
      ctx.restore()

      // Stroke
      ctx.beginPath()
      ctx.moveTo(xOf(vis[0].t), yOf(vis[0].y))
      for (let i = 1; i < vis.length; i++) {
        ctx.lineTo(xOf(vis[i].t), yOf(vis[i].y))
      }
      ctx.strokeStyle = PRICE_COL
      ctx.lineWidth   = 1.8
      ctx.lineJoin    = 'round'
      ctx.stroke()
    }

    // ── Current price tag (right edge of drawn path) ─────────────────────────
    const lastPt  = vis[vis.length - 1]
    const curY    = Math.max(PT + 10, Math.min(PT + pH - 10, yOf(lastPt.y)))
    const sp2     = settlementPrice
    const isUp    = sp2 ? lastPt.y >= sp2 : true
    const tagCol  = isUp ? '#00d4a4' : '#ff4757'

    ctx.fillStyle = tagCol
    ctx.beginPath()
    ctx.roundRect(PL + pW + 2, curY - 9, 54, 18, 3)
    ctx.fill()
    ctx.fillStyle = isUp ? '#0a0e1a' : '#ffffff'
    ctx.font      = `bold 9px ${FONT}`
    ctx.textAlign = 'center'
    ctx.fillText(
      '$' + lastPt.y.toLocaleString(undefined, { minimumFractionDigits: 1 }),
      PL + pW + 29, curY + 4
    )

    // ── Time-remaining badge (bottom-left corner of chart) ────────────────────
    if (expMs > 0) {
      const msLeft = expMs - now
      const label  = msLeft > 0 ? `${fmtMmSs(msLeft)} left` : 'EXPIRED'
      const badgeColor = msLeft < 60_000 ? EXPIRY_COL : msLeft < 300_000 ? '#f59e0b' : '#4a5568'
      ctx.fillStyle  = badgeColor
      ctx.font       = `bold 9px ${FONT}`
      ctx.textAlign  = 'left'
      ctx.fillText(label, PL + 4, PT + pH + 12)
    }

    rafRef.current = requestAnimationFrame(draw)
  }, [activeAsset, activeMarket, settlementPrice, bars, expiryMs, periodStart])

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [draw])

  // ── Header overlay ────────────────────────────────────────────────────────
  const lastY  = bufRef.current.length > 0 ? bufRef.current[bufRef.current.length - 1].y : 0
  const isLive = (Date.now() - lastSampleTsRef.current) < 3000 && lastSampleTsRef.current > 0

  const referencePrice = settlementPrice
  const delta    = (referencePrice && lastY) ? lastY - referencePrice : 0
  const deltaPct = (referencePrice && lastY) ? (delta / referencePrice) * 100 : 0
  const aboveReference = delta >= 0
  const referenceColor = aboveReference ? '#00d4a4' : '#ff4757'

  // Time remaining for header
  const msLeft   = expiryMs > 0 ? expiryMs - Date.now() : null
  const timeStr  = msLeft !== null
    ? (msLeft > 0 ? fmtMmSs(msLeft) : 'EXP')
    : null

  return (
    <div className="relative h-full flex flex-col bg-surface select-none overflow-hidden">
      <div className="absolute top-0 left-0 right-0 flex items-center justify-center px-3 pt-1 z-10 pointer-events-none gap-2">
        <span className={`live-badge${isLive ? '' : ' stale'}`}>
          <span className={`live-dot${isLive ? '' : ' stale'}`} />
          {isLive ? '100ms' : 'Paused'}
        </span>

        <span
          className="text-2xs font-mono font-semibold text-slate-300"
          style={{ borderBottom: `1px dashed ${activeMarket?.resolution_price ? '#ff4757' : '#22d3ee'}`, paddingBottom: 1 }}
        >
          {activeMarket?.resolution_price
            ? `$${activeMarket.resolution_price.toLocaleString()} or above`
            : referencePrice
              ? `REF $${referencePrice.toLocaleString()}`
              : `${activeAsset} · Live`}
        </span>

        {referencePrice != null && lastY > 0 && (
          <span
            className="text-xs font-mono font-bold px-1.5 py-0.5 rounded tabular-nums"
            style={{ background: `${referenceColor}18`, color: referenceColor, border: `1px solid ${referenceColor}44` }}
          >
            {aboveReference ? '▲' : '▼'} {aboveReference ? '+' : ''}{delta.toFixed(2)} pts
          </span>
        )}

        {referencePrice != null && lastY > 0 && (
          <span className="text-2xs font-mono font-semibold tabular-nums" style={{ color: `${referenceColor}cc` }}>
            ({deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(3)}%)
          </span>
        )}

        {timeStr && (
          <span
            className="text-2xs font-mono font-bold px-1.5 py-0.5 rounded"
            style={{
              color: msLeft !== null && msLeft < 60_000 ? EXPIRY_COL : msLeft !== null && msLeft < 300_000 ? '#f59e0b' : '#4a5568',
              background: 'rgba(0,0,0,0.3)',
            }}
          >
            ⏱ {timeStr}
          </span>
        )}
      </div>

      {/* Canvas fills the section; the reference line is rendered in canvas with glow. */}
      <div className="flex-1 relative">
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      </div>
    </div>
  )
}
