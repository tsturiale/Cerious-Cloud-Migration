/**
 * ProbChart — 100 ms streaming YES / NO probability canvas chart.
 *
 * Seeds the buffer with `market.prob_history` so historical data is visible
 * immediately.  Then continues sampling `polyBooks[activeMarketKey]` every
 * 100 ms for real-time streaming.
 *
 * Pure <canvas> — no SVG / Recharts overhead.
 */

import { useRef, useEffect, useCallback, useState } from 'react'
import { useStore } from '../store'

// ── Constants ────────────────────────────────────────────────────────────────
const MAX_POINTS = 72_000    // 2h at 100 ms; no short rolling-window reset
const SAMPLE_MS = 100        // live sample interval
const GRID = [0, 25, 50, 75, 100]

// Period duration by timeframe (ms) — mirrors PolyPriceChart
const TF_MS: Record<string, number> = {
  '5min':  5  * 60_000,
  '15min': 15 * 60_000,
  '1h':    60 * 60_000,
  '4h':    4  * 60 * 60_000,
}

const YES_COL   = '#00ffff'   // aqua — Truth Engine
const NO_COL    = '#ff4757'
const BRIGHT_YES_MKT = '#39ff14'  // neon green — YES / T&S market line
const GRID_COL = 'rgba(30,45,78,0.5)'
const GRID_COL_50 = '#ff00ff'
const LABEL_COL = '#4a5568'
const FONT = 'JetBrains Mono, monospace'

interface Pt { t: number; y: number; n: number; tp?: number }

// ── Component ────────────────────────────────────────────────────────────────
export function ProbChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bufRef = useRef<Pt[]>([])
  const rafRef = useRef(0)
  const sampRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const keyRef = useRef<string | null>(null)
  const condIdRef = useRef<string | undefined>(undefined)
  const seededRef = useRef(false)
  const lastSampleTsRef = useRef(0)   // tracks sampler freshness for LIVE badge
  const lastGoodRef = useRef<{y: number; n: number} | null>(null)

  // Drives LIVE badge re-render every second
  const [, setTick] = useState(0)

  // Reactive header data
  const activeMarketKey = useStore(s => s.activeMarketKey)
  const markets = useStore(s => s.markets)
  const polyBooks = useStore(s => s.polyBooks)
  const market = markets.find(m => m.key === activeMarketKey)
  const book = activeMarketKey ? polyBooks[activeMarketKey] ?? null : null
  const conditionId = market?.condition_id

  // ── Settlement reference price (the "beat number") ─────────────────────────
  // Sources in priority order:
  //   1. Chainlink oracle price at period open (most accurate — same source Polymarket uses)
  //   2. resolution_price extracted from question text (e.g. "$67,500" in title)
  //   3. null → don't show badge
  // A value < 1.0 indicates a probability fallback leaked through — suppress it.
  const rawSettle = market?.start_price ?? market?.resolution_price ?? null
  const settlementPrice = (rawSettle != null && rawSettle > 1.0) ? rawSettle : null

  // ── Seed buffer from prob_history on market switch ─────────────────────────
  useEffect(() => {
    if (activeMarketKey !== keyRef.current) {
      keyRef.current = activeMarketKey
      seededRef.current = false
      bufRef.current = []
      lastGoodRef.current = null

      // Seed from probHistory (prob_history is stripped from market objects in the store)
      const s = useStore.getState()
      const hist = (activeMarketKey ? s.probHistory[activeMarketKey] : null) ?? []
      const mk = s.markets.find(m => m.key === activeMarketKey)
      const truthHist = mk?.truth_history ?? []
      if (hist.length > 0 || truthHist.length > 0) {
        const merged: Record<number, Pt> = {}
        hist.forEach(p => { merged[p.ts] = { t: p.ts, y: p.up_pct, n: 100 - p.up_pct } })
        truthHist.forEach(p => {
          if (merged[p.ts]) merged[p.ts].tp = p.up_pct
          else merged[p.ts] = { t: p.ts, y: 50, n: 50, tp: p.up_pct }
        })

        bufRef.current = Object.values(merged).sort((a, b) => a.t - b.t)
        seededRef.current = true
      }
    }
  }, [activeMarketKey])

  // ── Period rotation watcher (same key, new condition_id) ─────────────────
  // activeMarketKey stays constant when a period rolls over; only condition_id
  // changes. Detect this and clear the buffer so the new period starts clean.
  useEffect(() => {
    if (!conditionId) return
    if (conditionId === condIdRef.current) return
    condIdRef.current = conditionId

    bufRef.current = []
    seededRef.current = false
    lastGoodRef.current = null

    // Reseed from the new period's prob_history (already stored after the
    // store wiped and re-merged it during the rotation setMarkets call)
    const s = useStore.getState()
    const hist = (activeMarketKey ? s.probHistory[activeMarketKey] : null) ?? []
    const mk = s.markets.find(m => m.key === activeMarketKey)
    const truthHist = mk?.truth_history ?? []
    if (hist.length > 0 || truthHist.length > 0) {
      const merged: Record<number, Pt> = {}
      hist.forEach(p => { merged[p.ts] = { t: p.ts, y: p.up_pct, n: 100 - p.up_pct } })
      truthHist.forEach(p => {
        if (merged[p.ts]) merged[p.ts].tp = p.up_pct
        else merged[p.ts] = { t: p.ts, y: 50, n: 50, tp: p.up_pct }
      })
      bufRef.current = Object.values(merged).sort((a, b) => a.t - b.t)
      seededRef.current = true
    }
  }, [conditionId, activeMarketKey])

  // Also re-seed when markets/probHistory updates (and buffer is still empty)
  const probHistory = useStore(s => s.probHistory)
  useEffect(() => {
    if (!activeMarketKey) return
    if (seededRef.current) return  // already seeded, live samples take over
    if (bufRef.current.length > 0) return

    const hist = probHistory[activeMarketKey] ?? []
    const mk = markets.find(m => m.key === activeMarketKey)
    const truthHist = mk?.truth_history ?? []
    if (hist.length > 0 || truthHist.length > 0) {
      const merged: Record<number, Pt> = {}
      hist.forEach(p => { merged[p.ts] = { t: p.ts, y: p.up_pct, n: 100 - p.up_pct } })
      truthHist.forEach(p => {
        if (merged[p.ts]) merged[p.ts].tp = p.up_pct
        else merged[p.ts] = { t: p.ts, y: 50, n: 50, tp: p.up_pct }
      })
      bufRef.current = Object.values(merged).sort((a, b) => a.t - b.t)
      seededRef.current = true
    }
  }, [markets, probHistory, activeMarketKey])

  // ── Backfill tp onto seeded buffer pts that lack it ───────────────────────
  // When the buffer was seeded from prob_history before truth engine data
  // arrived, existing pts have tp=undefined. This effect stamps the current
  // truth_up_pct onto all such pts the moment it becomes available, so
  // drawSeries(vis, 'tp', …) has ≥2 points and draws the aqua line.
  useEffect(() => {
    if (!activeMarketKey) return
    const mk = markets.find(m => m.key === activeMarketKey)
    if (!mk?.truth_up_pct) return
    const buf = bufRef.current
    if (buf.length < 2) return
    const tpCount = buf.filter(p => p.tp != null).length
    if (tpCount >= 2) return  // already enough — live sampler will maintain it
    const tp = mk.truth_up_pct
    for (const pt of buf) {
      if (pt.tp == null) pt.tp = tp
    }
  }, [markets, activeMarketKey])

  // ── 100 ms live sampler ───────────────────────────────────────────────────
  useEffect(() => {
    sampRef.current = setInterval(() => {
      const s = useStore.getState()
      const k = s.activeMarketKey
      if (!k) return
      const b = s.polyBooks[k]
      const m = s.markets.find(x => x.key === k)
      if (!b && !m) return

      const now = Date.now()
      const buf = bufRef.current

      // Avoid duplicate timestamps (prob_history has coarser points)
      const last = buf.length > 0 ? buf[buf.length - 1] : null
      if (last && (now - last.t) < 80) return  // skip if <80ms since last

      // Prefer fresh order book data (< 3s old) using seen_ms heartbeat.
      // timestamp_ms only changes on structural book deltas and can look stale
      // even when the feed is healthy.
      // During lag/reconnect, backend returns 50% as fallback when APIs are unreachable.
      let y: number | undefined
      let n: number | undefined
      const bookSeenMs = b ? (b.seen_ms ?? b.timestamp_ms) : 0
      if (b && (now - bookSeenMs) < 3000) {
        // Book is fresh — use and cache it
        y = b.up_pct
        n = b.down_pct
        lastGoodRef.current = { y, n }
      } else if (lastGoodRef.current) {
        // Book is stale — hold last known good value to prevent snap to 50% during lag
        y = lastGoodRef.current.y
        n = lastGoodRef.current.n
      } else if (m) {
        // No cached value yet — use market snapshot only if not a 50/50 default
        y = m.up_pct
        n = m.down_pct
      }

      // Skip if unavailable or stuck at 50/50 default
      if (y === undefined || n === undefined) return
      if (y === 50 && n === 50) return

      const tp = m?.truth_up_pct

      buf.push({ t: now, y, n, tp })
      if (buf.length > MAX_POINTS) buf.splice(0, buf.length - MAX_POINTS)
      lastSampleTsRef.current = now   // update freshness tracker
    }, SAMPLE_MS)

    // Tick the badge re-render every second
    const tickId = setInterval(() => setTick(n => n + 1), 1000)

    return () => {
      if (sampRef.current) clearInterval(sampRef.current)
      clearInterval(tickId)
    }
  }, [])

  // ── rAF draw loop ─────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    // Always reschedule — even if an exception occurs mid-frame the loop survives
    try {
    const cvs = canvasRef.current
    if (!cvs) { rafRef.current = requestAnimationFrame(draw); return }
    const ctx = cvs.getContext('2d')
    if (!ctx) { rafRef.current = requestAnimationFrame(draw); return }

    // ── DPR-aware resize ───────────────────────────────
    const dpr = window.devicePixelRatio || 1
    const rect = cvs.getBoundingClientRect()
    const W = rect.width
    const H = rect.height
    const cw = Math.round(W * dpr)
    const ch = Math.round(H * dpr)
    if (cvs.width !== cw || cvs.height !== ch) {
      cvs.width = cw
      cvs.height = ch
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    // ── Padding ────────────────────────────────────────
    const PT = 6, PB = 18, PL = 6, PR = 42
    const pW = W - PL - PR
    const pH = H - PT - PB

    // ── Grid + Y labels ────────────────────────────────
    for (const v of GRID) {
      const gy = PT + pH * (1 - v / 100)
      ctx.beginPath()
      ctx.moveTo(PL, gy)
      ctx.lineTo(PL + pW, gy)
      if (v === 50) {
        ctx.setLineDash([5, 3])
        ctx.strokeStyle = GRID_COL_50
        ctx.lineWidth = 1.5
        ctx.shadowColor = GRID_COL_50
        ctx.shadowBlur = 8
      } else {
        ctx.setLineDash([2, 5])
        ctx.strokeStyle = GRID_COL
        ctx.lineWidth = 0.5
        ctx.shadowBlur = 0
      }
      ctx.stroke()
      ctx.setLineDash([])
      ctx.shadowBlur = 0

      ctx.fillStyle = v === 50 ? GRID_COL_50 : LABEL_COL
      ctx.font = v === 50 ? `bold 9px ${FONT}` : `9px ${FONT}`
      ctx.textAlign = 'left'
      ctx.fillText(`${v}%`, PL + pW + 4, gy + 3)
    }

    // ── Buffer check ───────────────────────────────────
    const buf = bufRef.current
    if (buf.length < 2) {
      ctx.fillStyle = LABEL_COL
      ctx.font = `11px ${FONT}`
      ctx.textAlign = 'center'
      ctx.fillText('Awaiting probability data…', W / 2, H / 2)
      rafRef.current = requestAnimationFrame(draw)
      return
    }

    // ── Fixed period window: left = period open, right = expiry_ts ───────────
    // Mirrors PolyPriceChart so both charts share the same X-axis.
    const s = useStore.getState()
    const now = Date.now()

    const mkt2  = s.markets.find(m => m.key === s.activeMarketKey)
    const expMs = mkt2?.expiry_ts ?? 0
    const tfDur = TF_MS[mkt2?.timeframe ?? '5min'] ?? 300_000
    const tMin  = expMs > 0 ? expMs - tfDur : (buf[0]?.t ?? now - tfDur)
    const tMax  = expMs > 0 ? expMs : now + 30_000

    const xOf = (t: number) => PL + pW * Math.max(0, Math.min(1, (t - tMin) / (tMax - tMin)))
    const yOf = (v: number) => {
      const raw = PT + pH * (1 - Math.max(0, Math.min(100, v)) / 100)
      return Math.max(PT + 14, Math.min(PT + pH - 14, raw))
    }

    // ── Deadzone Grayout ───────────────────────────────
    // First 1 min of 5min, first 3 min of 15min
    const timeframe = mkt2?.timeframe ?? '5min'
    const deadzoneMs = timeframe === '5min' ? 60_000 : timeframe === '15min' ? 180_000 : 0
    if (deadzoneMs > 0) {
      const deadzoneEnd = tMin + deadzoneMs
      const dzX = xOf(deadzoneEnd)
      if (dzX > PL) {
        ctx.fillStyle = 'rgba(100, 116, 139, 0.25)' // Slate-500 equivalent with transparency
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

    const vis = buf.filter(p => p.t >= tMin - 5_000 && p.t <= tMax + 1_000)
    if (vis.length < 1) {
      ctx.fillStyle = LABEL_COL
      ctx.font = `10px ${FONT}`
      ctx.textAlign = 'center'
      ctx.fillText('Waiting for stream data…', W / 2, H / 2)
      rafRef.current = requestAnimationFrame(draw)
      return
    }

    // ── Draw helper ────────────────────────────────────
    function drawSeries(
      data: Pt[],
      key: 'y' | 'n' | 'tp',
      col: string,
      fillAlpha: number,
      isDotted: boolean = false
    ) {
      const series = data.filter(p => p[key] != null)
      if (series.length < 2) return

      // ── Area fill ────────────────────────────────────────────────────────
      ctx!.beginPath()
      ctx!.moveTo(xOf(series[0].t), yOf(series[0][key]!))
      for (let i = 1; i < series.length; i++) {
        ctx!.lineTo(xOf(series[i].t), yOf(series[i][key]!))
      }
      ctx!.lineTo(xOf(series[series.length - 1].t), PT + pH)
      ctx!.lineTo(xOf(series[0].t), PT + pH)
      ctx!.closePath()
      ctx!.globalAlpha = fillAlpha
      ctx!.fillStyle = col
      ctx!.fill()
      ctx!.globalAlpha = 1

      // ── Base line — only for TP (solid); YES/NO use fireball-only, no line ──
      if (!isDotted) {
        ctx!.beginPath()
        ctx!.moveTo(xOf(series[0].t), yOf(series[0][key]!))
        for (let i = 1; i < series.length; i++) {
          ctx!.lineTo(xOf(series[i].t), yOf(series[i][key]!))
        }
        ctx!.strokeStyle = col
        ctx!.lineWidth = 2.5
        ctx!.lineJoin = 'round'
        ctx!.lineCap = 'round'
        ctx!.stroke()
      }

      // ── Fireball + flame tail (YES / NO) | simple dot (TP) ─────────────────
      const last = series[series.length - 1]
      const lx = xOf(last.t)
      const ly = yOf(last[key]!)

      if (isDotted) {
        // Outer radial glow halo
        const grd = ctx!.createRadialGradient(lx, ly, 0, lx, ly, 11)
        grd.addColorStop(0,    `${col}aa`)
        grd.addColorStop(0.45, `${col}55`)
        grd.addColorStop(1,    `${col}00`)
        ctx!.beginPath()
        ctx!.arc(lx, ly, 11, 0, Math.PI * 2)
        ctx!.fillStyle = grd
        ctx!.fill()

        // Bright core
        ctx!.beginPath()
        ctx!.arc(lx, ly, 4, 0, Math.PI * 2)
        ctx!.fillStyle = col
        ctx!.fill()

        // White-hot centre
        ctx!.beginPath()
        ctx!.arc(lx, ly, 1.8, 0, Math.PI * 2)
        ctx!.fillStyle = 'rgba(255,255,255,0.92)'
        ctx!.fill()
      } else {
        // TP line — simple glow dot (no fireball)
        ctx!.beginPath()
        ctx!.arc(lx, ly, 6, 0, Math.PI * 2)
        ctx!.fillStyle = col
        ctx!.globalAlpha = 0.25
        ctx!.fill()
        ctx!.globalAlpha = 1

        ctx!.beginPath()
        ctx!.arc(lx, ly, 3, 0, Math.PI * 2)
        ctx!.fillStyle = col
        ctx!.fill()
      }

      // value label — YES/NO go RIGHT of fireball at same Y level; TP stays above dot
      const val = last[key]!
      ctx!.fillStyle = col
      ctx!.font = `bold 10px ${FONT}`
      if (isDotted) {
        // Right side of the glowing ball, vertically centred on it
        const rightX = lx + 14
        // If near the right edge, fall back to left of fireball
        if (rightX + 34 > PL + pW + PR - 2) {
          ctx!.textAlign = 'right'
          ctx!.fillText(`${val.toFixed(1)}%`, lx - 14, ly + 3)
        } else {
          ctx!.textAlign = 'left'
          ctx!.fillText(`${val.toFixed(1)}%`, rightX, ly + 3)
        }
      } else {
        // TP line — keep label above the dot
        ctx!.textAlign = 'right'
        ctx!.fillText(`${val.toFixed(1)}%`, lx - 2, ly - 8)
      }
    }

    // Draw order: NO → YES → TP (each on top of previous)
    drawSeries(vis, 'n',  NO_COL,      0.18, true)   // dashed red   + fireball
    drawSeries(vis, 'y',  BRIGHT_YES_MKT, 0.18, true) // dashed green + fireball
    drawSeries(vis, 'tp', YES_COL,     0.25, false)   // solid aqua   + simple dot

    // ── T&S bubbles: polyTicks (market tape) as small size-scaled bubbles ────────
    // Drawn before fills so our own order dots render on top.
    const mktPolyTicks = s.activeMarketKey ? (s.polyTicks[s.activeMarketKey] ?? []) : []
    for (const tick of mktPolyTicks) {
      if (tick.timestamp >= tMin - 5_000 && tick.timestamp <= tMax + 1_000) {
        const x = xOf(tick.timestamp)
        const tickYesPct = tick.side === 'yes' ? tick.price : (100 - tick.price)
        const y = yOf(tickYesPct)

        // Radius scales with trade size (log), min 2, max 6
        const r = Math.max(2, Math.min(6, 1.2 + Math.log10(Math.max(1, tick.size))))
        const col = tick.side === 'yes' ? BRIGHT_YES_MKT : NO_COL

        // Outer glow halo
        ctx.beginPath()
        ctx.arc(x, y, r + 3, 0, Math.PI * 2)
        ctx.fillStyle = `${col}1a`
        ctx.fill()
        // Semi-transparent bubble body
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fillStyle = col
        ctx.globalAlpha = 0.45
        ctx.fill()
        ctx.globalAlpha = 1
      }
    }

    // ── Tape dots: all fills in this market (persisted per market for session) ─────────
    // tick.price is the actual execution probability (0–100).
    // YES fill: price IS the YES probability → plot at yOf(tick.price)
    // NO fill:  price is the NO probability  → equivalent YES = 100 - tick.price
    const marketFills = s.activeMarketKey ? (s.fills[s.activeMarketKey] ?? []) : []
    for (const tick of marketFills) {
      if (tick.timestamp >= tMin - 5_000 && tick.timestamp <= tMax + 1_000) {
        const x = xOf(tick.timestamp)
        const tickYesPct = tick.side === 'yes' ? tick.price : (100 - tick.price)
        const y = yOf(tickYesPct)

        // Outer glow ring
        ctx.beginPath()
        ctx.arc(x, y, 5, 0, Math.PI * 2)
        ctx.fillStyle = tick.side === 'yes' ? `${BRIGHT_YES_MKT}33` : `${NO_COL}33`
        ctx.fill()
        // Core dot
        ctx.beginPath()
        ctx.arc(x, y, 2.5, 0, Math.PI * 2)
        ctx.fillStyle = tick.side === 'yes' ? BRIGHT_YES_MKT : NO_COL
        ctx.globalAlpha = 0.9
        ctx.fill()
        ctx.globalAlpha = 1
      }
    }

    // ── Expiry boundary marker ───────────────────────────
    if (expMs > 0) {
      const ex = xOf(expMs)
      if (ex >= PL && ex <= PL + pW) {
        ctx.strokeStyle = '#ff4757'
        ctx.lineWidth   = 1
        ctx.setLineDash([3, 3])
        ctx.globalAlpha = 0.4
        ctx.beginPath(); ctx.moveTo(ex, PT); ctx.lineTo(ex, PT + pH); ctx.stroke()
        ctx.globalAlpha = 1
        ctx.setLineDash([])
      }
    }

    // ── "Now" cursor line ────────────────────────────────
    if (now >= tMin && now <= tMax) {
      const nx = xOf(now)
      ctx.beginPath()
      ctx.moveTo(nx, PT)
      ctx.lineTo(nx, PT + pH)
      ctx.setLineDash([2, 3])
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.setLineDash([])
    }

    // ── X-axis time labels (period-anchored, matching PolyPriceChart) ─────────
    const periodMs2  = tMax - tMin
    const intervals2 = [30_000, 60_000, 120_000, 300_000, 600_000, 900_000]
    const labelIv    = intervals2.find(iv => periodMs2 / iv <= 6) ?? intervals2[intervals2.length - 1]
    ctx.fillStyle  = LABEL_COL
    ctx.font       = `8px ${FONT}`
    ctx.textAlign  = 'center'
    const firstLbl = Math.ceil(tMin / labelIv) * labelIv
    for (let t = firstLbl; t <= tMax; t += labelIv) {
      const x = xOf(t)
      if (x < PL + 10 || x > PL + pW - 5) continue
      const d = new Date(t)
      ctx.fillText(
        `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`,
        x, H - 3
      )
    }

    // ── 50% crosshair label ──────────────────────────────
    const y50 = yOf(50)
    ctx.shadowColor = GRID_COL_50
    ctx.shadowBlur = 10
    ctx.fillStyle = GRID_COL_50
    ctx.font = `bold 9px ${FONT}`
    ctx.textAlign = 'right'
    ctx.fillText('50%', PL + pW + 38, y50 + 3)
    ctx.shadowBlur = 0

    } catch (e) {
      // Swallow draw errors — never let an exception kill the rAF loop
      console.warn('[ProbChart] draw error (frame skipped):', e)
    }
    rafRef.current = requestAnimationFrame(draw)
  }, [])

  // Start / stop rAF
  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [draw])

  // ── Compute header info ────────────────────────────────────────────────────────────────
  const lastPt = bufRef.current.length > 0 ? bufRef.current[bufRef.current.length - 1] : null
  const yesNow = book?.up_pct ?? market?.up_pct ?? lastPt?.y ?? null
  const noNow = book?.down_pct ?? market?.down_pct ?? lastPt?.n ?? null
  const tpNow = market?.truth_up_pct ?? lastPt?.tp ?? null
  
  const tfLabel = market?.timeframe ?? ''
  // LIVE: sampler received a point in the last 3 seconds
  const isLive = (Date.now() - lastSampleTsRef.current) < 3000 && lastSampleTsRef.current > 0

  // ── No market selected ──────────────────────────────────────────────────────
  if (!activeMarketKey) {
    return (
      <div className="flex flex-col h-full">
        <div className="panel-header">
          <span className="text-xs font-semibold text-slate-300">YES / NO Probability Stream</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-xs text-muted font-mono">
          Select a market from the Markets tab
        </div>
      </div>
    )
  }

  // ── Main render ─────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">

      {/* Header */}
      <div className="panel-header shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-300">
            {market?.asset ?? '—'} {market?.timeframe ?? ''}
          </span>
          {/* Pulsing LIVE badge */}
          <span className={`live-badge${isLive ? '' : ' stale'}`}>
            <span className={`live-dot${isLive ? '' : ' stale'}`} />
            {isLive ? 'Live' : 'Waiting'}
          </span>
          <span className="text-2xs px-1 rounded bg-surface text-muted font-mono tracking-wider">
            {bufRef.current.length > 0 ? `${bufRef.current.length} pts` : '…'}
          </span>
          {tfLabel && (
            <span className="text-2xs text-slate-500 font-mono">{tfLabel}</span>
          )}
          {/* Settlement reference price — "beat number" from Chainlink/Polymarket oracle */}
          {settlementPrice != null && (
            <span
              className="text-2xs font-mono px-1.5 py-0.5 rounded border"
              style={{ color: '#22d3ee', borderColor: 'rgba(34,211,238,0.3)', background: 'rgba(34,211,238,0.07)' }}
              title="Period-open reference price (Chainlink oracle — same source as Polymarket resolution)"
            >
              REF ${settlementPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
          )}
        </div>

          <div className="flex items-center gap-4">
            {yesNow != null && noNow != null && (
              <>
                {/* Truth Edge Signal (Glow) */}
                {tpNow != null && (
                  <div className="flex flex-col items-end">
                    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-accent/10 border border-accent/30 animate-pulse-glow"
                      style={{
                        boxShadow: Math.abs(tpNow - yesNow) > 2 ? '0 0 10px rgba(0, 255, 255, 0.4)' : 'none'
                      }}>
                      <span className="text-[10px] font-bold text-accent tracking-widest uppercase opacity-70">
                        {Math.abs(market?.vanna || 0) > 0.01 ? 'Vanna+Edge' : 'Edge'}
                      </span>
                      <span className={`text-xs font-mono font-black ${(tpNow - (yesNow ?? 50)) > 0 ? 'text-up' : 'text-down'}`}>
                        {(tpNow - (yesNow ?? 50)) > 0 ? '+' : ''}{(tpNow - (yesNow ?? 50)).toFixed(1)}%
                      </span>
                    </div>
                  </div>
                )}

                {/* YES (Market - Dotted) */}
                <div className="flex flex-col items-center">
                  <div className="flex items-center gap-1">
                    <span className="w-2.5 h-[1.5px] rounded-full inline-block border-b border-dotted" style={{ borderColor: '#00ffcc' }} />
                    <span className="text-xs font-mono font-bold" style={{ color: '#00ffcc' }}>
                      {yesNow != null ? yesNow.toFixed(1) : '—'}%
                    </span>
                  </div>
                  <span className="text-[9px] text-slate-500 font-mono scale-90 uppercase">MKT</span>
                </div>

                {/* NO (Market - Dotted) */}
                <div className="flex flex-col items-center">
                  <div className="flex items-center gap-1">
                    <span className="w-2.5 h-[1.5px] rounded-full inline-block border-b border-dotted" style={{ borderColor: NO_COL }} />
                    <span className="text-xs font-mono font-bold" style={{ color: NO_COL }}>
                      {noNow != null ? noNow.toFixed(1) : '—'}%
                    </span>
                  </div>
                  <span className="text-[9px] text-slate-500 font-mono scale-90 uppercase">NO</span>
                </div>
              </>
            )}
            <span className="text-2xs px-1.5 py-0.5 rounded bg-accent/20 text-accent border border-accent/30 font-mono font-black shadow-sm">
              100ms
            </span>
          </div>
        </div>

      {/* Canvas */}
      <div className="flex-1 min-h-0 relative bg-[#080d19]">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
        />
      </div>
    </div>
  )
}
