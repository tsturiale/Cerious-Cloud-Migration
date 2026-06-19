/**
 * MultiChart — synchronized candlestick panels: 1m · 5m · 15m · 1h
 *
 * All intervals: fetched from /api/bars/{asset}?interval=N, polled every 2 s.
 * Live bars from WS are merged with REST history on every tick.
 * Panels adapt to the active Polymarket event timeframe when autoRotate is on.
 *
 * KC jitter fix: incremental KC updates only fire when a new bar opens
 * (tracked by unix-second timestamp), never mid-bar.
 */

import { useEffect, useRef, useCallback, useState, useMemo, type MutableRefObject } from 'react'
import {
  createChart, ColorType, CrosshairMode, LineStyle,
  CandlestickSeries, LineSeries, HistogramSeries,
} from 'lightweight-charts'
import { useStore } from '../store'
import type { Asset, Bar, TimeFrame } from '../types'
import { fetchBars } from '../utils/bars'

// Map Polymarket timeframe → preferred chart intervals (most granular first).
// Panel 1 is ALWAYS 1m so clicking any market card shows the 1m spot chart first.
const TF_INTERVALS: Record<TimeFrame, number[]> = {
  '20sec': [1/3, 1,  5,   15, 60],    // 20s · 1m · 5m · 15m · 1h
  '5min':  [1/3, 1,  5,   15, 60],    // 20s · 1m · 5m · 15m · 1h
  '15min': [1/3, 1,  5,   15, 60],    // 20s · 1m · 5m · 15m · 1h
  '1h':    [1/3, 1,  5,   15, 60],    // 20s · 1m · 5m · 15m · 1h
  '4h':    [1/3, 1,  5,   15, 60],    // 20s · 1m · 5m · 15m · 1h
  'event': [1/3, 1,  5,   15, 60],
}

// ── Colours ───────────────────────────────────────────────────────────────────
const BG      = '#0f1629'
const GRID    = '#1e2d4e'
const TEXT    = '#94a3b8'
const UP      = '#00d4a4'
const DOWN    = '#ff4757'
const KC_BAND = '#06b6d480'
const KC_MID  = '#06b6d460'

// ── KC helpers ────────────────────────────────────────────────────────────────
function ema(values: number[], period: number): number[] {
  if (!values.length) return []
  const k = 2 / (period + 1)
  const out = [values[0]]
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k))
  return out
}

function calcKC(bars: Bar[], period = 20, mult = 2.5) {
  if (bars.length < 2) return null
  const closes = bars.map(b => b.close)
  const mid    = ema(closes, period)
  const tr     = bars.map((b, i) =>
    i === 0 ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))
  )
  const atr = ema(tr, period)
  return bars.map((b, i) => ({
    time:  Math.floor(b.timestamp / 1000) as any,
    upper: mid[i] + mult * atr[i],
    mid:   mid[i],
    lower: mid[i] - mult * atr[i],
  }))
}

// ── Z-score: 20-period rolling (price - mean) / stddev ─────────────────────
function calcZScore(bars: Bar[], period = 20): number | null {
  if (bars.length < period) return null
  const closes = bars.slice(-period).map(b => b.close)
  const mean = closes.reduce((a, b) => a + b, 0) / period
  const variance = closes.reduce((a, c) => a + (c - mean) ** 2, 0) / period
  const stddev = Math.sqrt(variance)
  if (stddev === 0) return 0
  return (closes[closes.length - 1] - mean) / stddev
}

// ── Prep: bucket bars by TF, dedup, sort ─────────────────────────────────────
function prepBars(bars: Bar[], intervalMinutes: number) {
  const bktMs = intervalMinutes * 60 * 1000
  const map   = new Map<number, any>()
  for (const b of bars) {
    const t  = Math.floor(b.timestamp / bktMs) * (bktMs / 1000)   // unix seconds
    const ex = map.get(t)
    if (!ex) {
      map.set(t, {
        time: t as any,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume ?? 0,
        _ts: b.timestamp
      })
    } else {
      // Ensure 'open' is from the earliest bar in this bucket
      if (b.timestamp < ex._ts) {
        ex.open = b.open
        ex._ts  = b.timestamp
      }
      ex.high   = Math.max(ex.high, b.high)
      ex.low    = Math.min(ex.low,  b.low)
      ex.close  = b.close
      ex.volume = ex.volume + (b.volume ?? 0)
    }
  }
  return Array.from(map.values()).sort((a, b) => a.time - b.time)
}

function mergeAndAggregate(histBars: Bar[] = [], liveBars: Bar[] = [], intervalMinutes: number): Bar[] {
  const all = [...(histBars || []), ...(liveBars || [])]
  const bucketMs = intervalMinutes * 60 * 1000
  const map = new Map<number, Bar>()
  for (const b of all) {
    const t = Math.floor(b.timestamp / bucketMs) * bucketMs
    const ex = map.get(t)
    if (!ex) {
      map.set(t, { ...b, timestamp: t })
    } else {
      ex.high   = Math.max(ex.high,  b.high)
      ex.low    = Math.min(ex.low,   b.low)
      ex.close  = b.close
      ex.volume = ex.volume + (b.volume ?? 0)
    }
  }
  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp)
}

// ── Single-panel chart hook ───────────────────────────────────────────────────
function useChartPanel(
  containerRef: React.RefObject<HTMLDivElement | null>,
  intervalMinutes: number,
) {
  const chartRef    = useRef<any>(null)
  const candleRef   = useRef<any>(null)
  const upperRef    = useRef<any>(null)
  const midRef      = useRef<any>(null)
  const lowerRef    = useRef<any>(null)
  const volumeRef   = useRef<any>(null)
  const dataKeyRef  = useRef('')
  // KC jitter fix: only push KC update when bar time actually changes
  const lastKcTimeRef = useRef(0)
  // Bumped on every chart (re-)creation so dependants can re-apply overlays
  const [gen, setGen] = useState(0)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: BG }, textColor: TEXT },
      grid: {
        vertLines: { color: GRID, style: LineStyle.Dotted },
        horzLines: { color: GRID, style: LineStyle.Dotted },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: GRID, scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor: GRID, timeVisible: true, secondsVisible: intervalMinutes < 1.1 },
      autoSize: true,
    })
    chartRef.current = chart

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN,
      borderUpColor: UP, borderDownColor: DOWN,
      wickUpColor: UP, wickDownColor: DOWN,
    })
    candleRef.current = candle

    // Keltner Channel bands — aqua blue upper/lower, dashed mid
    upperRef.current = chart.addSeries(LineSeries,
      { color: KC_BAND, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    midRef.current = chart.addSeries(LineSeries,
      { color: KC_MID, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false })
    lowerRef.current = chart.addSeries(LineSeries,
      { color: KC_BAND, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })

    const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol' })
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })
    volumeRef.current = vol

    // Signal to dependants that a new chart + series are ready
    setGen(g => g + 1)

    return () => { try { chart.remove() } catch { /* ignore */ } }
  }, [containerRef, intervalMinutes])

  const paint = useCallback((bars: Bar[], scrollToLatest = false) => {
    if (!candleRef.current || bars.length === 0) return

    // Include the forming (incomplete) bar — the heartbeat animates it live.
    const barsForPrepare = bars

    const prepared = prepBars(barsForPrepare, intervalMinutes)
    if (prepared.length === 0) return

    // Key off bar count + first timestamp so structural changes trigger full setData.
    const dataKey = `${intervalMinutes}-${prepared.length}-${prepared[0].time}`
    const isNew = dataKeyRef.current !== dataKey

    try {
      if (isNew) {
        candleRef.current.setData(prepared)
        volumeRef.current?.setData(prepared.map(b => ({
          time: b.time, value: b.volume,
          color: b.close >= b.open ? `${UP}80` : `${DOWN}80`,
        })))

        // KC is calculated from the same prepared bars (already excludes incomplete for 1m)
        const kc = calcKC(barsForPrepare)
        if (kc && upperRef.current) {
          const dedup = Array.from(new Map(kc.map(d => [d.time as number, d])).values())
            .sort((a, b) => (a.time as number) - (b.time as number))
          upperRef.current.setData(dedup.map(d => ({ time: d.time, value: d.upper })))
          midRef.current.setData(  dedup.map(d => ({ time: d.time, value: d.mid   })))
          lowerRef.current.setData(dedup.map(d => ({ time: d.time, value: d.lower })))
          lastKcTimeRef.current = dedup[dedup.length - 1].time as number
        }
        dataKeyRef.current = dataKey

        // Scroll to the latest bar on initial load or period rotation
        if (scrollToLatest && chartRef.current) {
          try { chartRef.current.timeScale().scrollToRealTime() } catch { /* ignore */ }
        }

      } else {
        // Incremental: update last candle + volume
        const last = prepared[prepared.length - 1]
        try { candleRef.current.update(last) } catch { /* time went back */ }
        try {
          volumeRef.current?.update({
            time: last.time, value: last.volume,
            color: last.close >= last.open ? `${UP}80` : `${DOWN}80`,
          })
        } catch { /* ignore */ }

        // KC: only push when bar time changes — no sub-bar jitter
        const kc = calcKC(barsForPrepare)
        if (kc?.length && upperRef.current) {
          const lastKc = kc[kc.length - 1]
          const lastT  = lastKc.time as number
          if (lastT !== lastKcTimeRef.current) {
            try {
              upperRef.current.update({ time: lastT, value: lastKc.upper })
              midRef.current.update(  { time: lastT, value: lastKc.mid   })
              lowerRef.current.update({ time: lastT, value: lastKc.lower })
              lastKcTimeRef.current = lastT
            } catch { /* time went backward */ }
          }
        }
      }
    } catch (err) {
      console.warn(`[MultiChart ${intervalMinutes}m] paint:`, err)
    }
  }, [intervalMinutes])

  return { paint, chartRef, candleRef, gen }
}

// ── Panel component ───────────────────────────────────────────────────────────

interface PanelProps {
  asset:        Asset
  interval:     number
  label:        string
  liveBars:     Bar[]
  strikePrice?: number   // yellow dashed line at market session open price
}

// Strike-line yellow
const STRIKE_COL = '#f59e0b'

function ChartPanel({ asset, interval, label, liveBars, strikePrice }: PanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { paint, chartRef, candleRef, gen } = useChartPanel(containerRef, interval)
  const strikePriceLineRef = useRef<any>(null)
  const barsRef         = useRef<Bar[]>([])
  // Tracks the latest TF-aggregated bars for the heartbeat (open/high/low of current bucket)
  const aggBarsRef      = useRef<Bar[]>([])
  const prevAsset       = useRef(asset)
  const hasInitialData  = useRef(false)  // true after first successful REST load

  // Strike line: yellow dashed horizontal at the market session open price.
  // Re-applies whenever strikePrice changes OR the chart is recreated (gen bumps).
  useEffect(() => {
    const series = candleRef.current
    if (!series) return
    // Remove previous line (safe even if chart was recreated)
    if (strikePriceLineRef.current) {
      try { series.removePriceLine(strikePriceLineRef.current) } catch { /* stale ref — ignore */ }
      strikePriceLineRef.current = null
    }
    if (strikePrice && strikePrice > 0) {
      try {
        strikePriceLineRef.current = series.createPriceLine({
          price:            strikePrice,
          color:            STRIKE_COL,
          lineWidth:        1,
          lineStyle:        LineStyle.Dashed,
          axisLabelVisible: true,
          title:            'OPEN',
        })
      } catch { /* chart not ready */ }
    }
  }, [strikePrice, gen, candleRef])

  // All intervals: fetch 500 bars from REST, poll every 2 s
  useEffect(() => {
    let cancelled = false
    let inFlight = false

    const load = async () => {
      if (inFlight) return
      inFlight = true
      try {
        // 20s uses 1000 bars; 1m and 5m use 350 bars; longer TFs keep 500.
        const limit = interval < 1 ? 1000 : interval <= 5 ? 350 : 500
        const bars = await fetchBars(asset, interval, limit, 20_000)
        if (!cancelled && bars.length) {
          barsRef.current = bars
          // Seed aggBarsRef on first load so heartbeat can start immediately
          if (aggBarsRef.current.length === 0) {
            aggBarsRef.current = mergeAndAggregate(bars, [], interval)
          }
          // scrollToLatest=true on the very first successful load so chart shows recent bars
          const firstLoad = !hasInitialData.current
          hasInitialData.current = true
          paint(bars, firstLoad)
        }
      } catch { /* leave existing data */ }
      finally { inFlight = false }
    }

    load()
    const id = setInterval(load, 2_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [asset, interval, paint])

  // Reset on asset change
  useEffect(() => {
    if (prevAsset.current !== asset) {
      barsRef.current = []
      aggBarsRef.current = []
      hasInitialData.current = false
      prevAsset.current = asset
    }
  }, [asset])

  // All intervals: repaint on every WS live-bar update to animate the forming candle.
  // 1m  → full dedup merge (WS bar wins on same timestamp).
  // 5m+ → merge REST history with recent 1m WS bars covering the current bucket.
  useEffect(() => {
    const combined = mergeAndAggregate(barsRef.current, liveBars, interval)
    if (combined.length > 0) {
      aggBarsRef.current = combined   // keep heartbeat reference fresh
      paint(combined, false)
    }
  }, [liveBars, interval, paint])

  // ── 1-second live candle heartbeat ───────────────────────────────────────
  // Pushes the freshest tick into the forming candle every second so
  // all panel TFs stream live even when WS bar updates are ~60 s apart.
  useEffect(() => {
    const tfSec = interval * 60
    const id = setInterval(() => {
      if (!candleRef.current) return
      const aggBars = aggBarsRef.current
      if (aggBars.length === 0) return

      const s        = useStore.getState()
      const ticks    = s.ticks[asset]
      const lastTick = ticks && ticks.length > 0 ? ticks[ticks.length - 1] : null
      const lastAgg  = aggBars[aggBars.length - 1]
      const latestPrice = lastTick ? lastTick.price : lastAgg.close

      const nowSec    = Math.floor(Date.now() / 1000)
      const bucketSec = Math.floor(nowSec / tfSec) * tfSec
      const bucketMs  = bucketSec * 1000

      const isCurrentBucket = lastAgg.timestamp >= bucketMs
      const openPrice = isCurrentBucket ? lastAgg.open  : latestPrice
      const baseHigh  = isCurrentBucket ? lastAgg.high  : latestPrice
      const baseLow   = isCurrentBucket ? lastAgg.low   : latestPrice

      const bucketTicks = ticks?.filter(t => t.timestamp >= bucketMs).map(t => t.price) ?? []
      const liveHigh    = bucketTicks.length > 0 ? Math.max(baseHigh, ...bucketTicks) : Math.max(baseHigh, latestPrice)
      const liveLow     = bucketTicks.length > 0 ? Math.min(baseLow,  ...bucketTicks) : Math.min(baseLow,  latestPrice)

      try {
        candleRef.current.update({
          time:  bucketSec as any,
          open:  openPrice,
          high:  liveHigh,
          low:   liveLow,
          close: latestPrice,
        })
      } catch { /* LightweightCharts time-order guard */ }
    }, 1000)
    return () => clearInterval(id)
  }, [asset, interval, candleRef])

  // Header: last price + % change + z-score
  const bars   = barsRef.current.length > 0 ? barsRef.current : liveBars
  const profileBars = mergeAndAggregate(barsRef.current, liveBars, interval)
  const last   = bars.length > 0 ? bars[bars.length - 1] : null
  const price  = last?.close ?? null
  const change = last && bars.length > 1
    ? ((last.close - bars[bars.length - 2].close) / bars[bars.length - 2].close) * 100
    : null
  const zscore = calcZScore(bars, 20)

  return (
    <div className="flex flex-col h-full min-w-0">
      <div className="flex items-center justify-between px-2 py-0.5 bg-surface-panel border-b border-surface-border shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold text-accent font-mono">{label}</span>
          <span className="text-[10px] font-mono text-muted">{asset}</span>
          <span className="text-[9px] font-mono text-slate-600">KC 20/2.5×</span>
        </div>
        <div className="flex items-center gap-2">
          {zscore !== null && (
            <span className={`text-[10px] font-mono font-bold ${
              Math.abs(zscore) > 2 ? 'text-down' : Math.abs(zscore) > 1 ? 'text-warn' : 'text-slate-400'
            }`}>
              z: {zscore.toFixed(2)}
            </span>
          )}
          {price !== null && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono font-semibold text-slate-200">
                {price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              {change !== null && (
                <span className={`text-[9px] font-mono ${change >= 0 ? 'text-up' : 'text-down'}`}>
                  {change >= 0 ? '+' : ''}{change.toFixed(2)}%
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0 relative">
        <div ref={containerRef} className="absolute inset-0" />
        <DeadzoneOverlay interval={interval} chartRef={chartRef} gen={gen} />
        <VolumeProfileOverlay interval={interval} bars={profileBars} candleRef={candleRef} />
      </div>
    </div>
  )
}

function VolumeProfileOverlay({
  interval,
  bars,
  candleRef,
}: {
  interval: number
  bars: Bar[]
  candleRef: MutableRefObject<any>
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const draw = () => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const host = canvas.parentElement
      if (!host) return

      const w = host.clientWidth
      const h = host.clientHeight
      const dpr = window.devicePixelRatio || 1
      const cw = Math.round(w * dpr)
      const ch = Math.round(h * dpr)
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw
        canvas.height = ch
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      if (!bars.length) return
      if (!candleRef.current?.priceToCoordinate) return

      const profileBars = bars
      if (profileBars.length < 2) return

      const low = Math.min(...profileBars.map(b => b.low))
      const high = Math.max(...profileBars.map(b => b.high))
      if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return

      const binsCount = 28
      const step = (high - low) / binsCount
      if (step <= 0) return
      const bins = new Array<number>(binsCount).fill(0)

      for (const b of profileBars) {
        const barVol = b.volume ?? 0
        if (barVol <= 0) continue
        const barLow = Math.max(low, b.low)
        const barHigh = Math.min(high, b.high)
        const range = barHigh - barLow
        if (range <= 0) {
          const idx = Math.max(0, Math.min(binsCount - 1, Math.floor((b.close - low) / step)))
          bins[idx] += barVol
          continue
        }
        for (let i = 0; i < binsCount; i++) {
          const binLow = low + i * step
          const binHigh = binLow + step
          const overlap = Math.max(0, Math.min(barHigh, binHigh) - Math.max(barLow, binLow))
          if (overlap > 0) bins[i] += barVol * (overlap / range)
        }
      }

      const totalVol = bins.reduce((a, b) => a + b, 0)
      if (totalVol <= 0) return
      const maxVol = Math.max(...bins)
      if (maxVol <= 0) return
      const pocIdx = bins.indexOf(maxVol)

      let vaLow = pocIdx
      let vaHigh = pocIdx
      let covered = bins[pocIdx]
      const target = totalVol * 0.7
      while (covered < target && (vaLow > 0 || vaHigh < binsCount - 1)) {
        const left = vaLow > 0 ? bins[vaLow - 1] : -1
        const right = vaHigh < binsCount - 1 ? bins[vaHigh + 1] : -1
        if (right >= left) {
          if (vaHigh < binsCount - 1) { vaHigh++; covered += bins[vaHigh] }
          else if (vaLow > 0) { vaLow--; covered += bins[vaLow] }
        } else if (vaLow > 0) {
          vaLow--; covered += bins[vaLow]
        } else if (vaHigh < binsCount - 1) {
          vaHigh++; covered += bins[vaHigh]
        }
      }

      const xLeft = 0
      const maxBarW = Math.max(18, Math.floor(w * 0.2))
      const minOpacity = 0.18

      for (let i = 0; i < binsCount; i++) {
        const vol = bins[i]
        if (vol <= 0) continue
        const p0 = low + i * step
        const p1 = p0 + step
        const yc0 = candleRef.current.priceToCoordinate(p0)
        const yc1 = candleRef.current.priceToCoordinate(p1)
        if (yc0 == null || yc1 == null) continue
        const yTop = Math.min(yc0, yc1)
        const yBot = Math.max(yc0, yc1)
        const hh = Math.max(1, yBot - yTop)
        const ww = (vol / maxVol) * maxBarW
        const x = xLeft

        const inVa = i >= vaLow && i <= vaHigh
        const isPoc = i === pocIdx
        if (isPoc) ctx.fillStyle = 'rgba(255, 71, 87, 0.95)'
        else if (inVa) ctx.fillStyle = 'rgba(125, 211, 252, 0.72)'
        else {
          const alpha = minOpacity + (vol / maxVol) * 0.35
          ctx.fillStyle = `rgba(59, 130, 246, ${alpha.toFixed(3)})`
        }
        ctx.fillRect(x, yTop, ww, hh)
      }

      ctx.fillStyle = 'rgba(148, 163, 184, 0.85)'
      ctx.font = '8px Cascadia Mono, Consolas, monospace'
      ctx.textAlign = 'left'
      const tfLabel = interval < 1 ? '20s' : `${interval}m`
      ctx.fillText(`VP All Bars • ${tfLabel}`, xLeft + 2, 10)
    }

    draw()
    const id = setInterval(draw, 1000)
    return () => clearInterval(id)
  }, [interval, bars, candleRef])

  return <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" style={{ zIndex: 6 }} />
}

function DeadzoneOverlay({ interval, chartRef, gen }: { interval: number; chartRef: any; gen: number }) {
  const [coords, setCoords] = useState<{ x1: number; x2: number } | null>(null)
  
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || (interval !== 5 && interval !== 15)) {
      setCoords(null)
      return
    }

    const update = () => {
      const timeScale = chart.timeScale()
      const now = Date.now() / 1000
      const tfSec = interval * 60
      const periodStart = Math.floor(now / tfSec) * tfSec
      const deadzoneEnd = periodStart + (interval === 5 ? 60 : 180)
      
      const x1 = timeScale.timeToCoordinate(periodStart as any)
      const x2 = timeScale.timeToCoordinate(deadzoneEnd as any)
      
      if (x1 !== null && x2 !== null) {
        setCoords({ x1, x2 })
      } else {
        setCoords(null)
      }
    }

    update()
    const sub = () => update()
    chart.timeScale().subscribeVisibleTimeRangeChange(sub)
    const id = setInterval(update, 1000)
    
    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(sub)
      clearInterval(id)
    }
  }, [chartRef, gen, interval])

  if (!coords) return null

  const width = coords.x2 - coords.x1
  if (width <= 0) return null

  return (
    <div 
      className="absolute top-0 bottom-0 pointer-events-none flex items-center justify-center overflow-hidden"
      style={{ 
        left: coords.x1, 
        width: width,
        background: 'rgba(100, 116, 139, 0.2)',
        borderRight: '1px dashed rgba(100, 116, 139, 0.4)',
        zIndex: 5
      }}
    >
      <span className="text-[8px] font-bold text-slate-500/50 uppercase -rotate-90 whitespace-nowrap">
        Waiting
      </span>
    </div>
  )
}

// ── Interval label map ────────────────────────────────────────────────────────
const INTERVAL_LABELS: Record<number, string> = {
  [1/3]: '20s', 1: '1m', 5: '5m', 15: '15m', 60: '1h', 240: '4h', 1440: '1D',
}

// ── MultiChart ────────────────────────────────────────────────────────────────

interface Props { asset: Asset; panels?: 2 | 3 | 4 | 5 }

export function MultiChart({ asset, panels = 4 }: Props) {
  const liveBars        = useStore(s => s.bars[asset] || [])
  const activeMarketKey = useStore(s => s.activeMarketKey)
  const markets         = useStore(s => s.markets)

  // Derive panel intervals from the active market's timeframe so charts
  // always show the most relevant granularities for the current event period.
  // Panel 1 is always 1m (see TF_INTERVALS above).
  const mkt        = markets.find(m => m.key === activeMarketKey)
  const tf         = mkt?.timeframe ?? '5min'
  const allIvs     = TF_INTERVALS[tf] ?? [1/3, 1, 5, 15, 60]
  const intervals  = allIvs.slice(0, panels)

  // Strike price: opening price of the current market period.
  // Derived from the TF-bucketed liveBars open so the OPEN line sits exactly
  // at the candle body open \u2014 not at the backend's Dome-polled start_price
  // which can be seeded at a different tick and appear displaced.
  //
  // Priority 1: open of the first liveBars bucket aligned to the market TF period start.
  // Priority 2: open of the first raw 1m bar at or after period start.
  // Priority 3: start_price from backend (last resort \u2014 may be stale).
  const strikePrice = useMemo(() => {
    if (!mkt || !liveBars.length) return mkt?.start_price ?? undefined
    const PERIOD_MS: Record<string, number> = {
      '5min': 5 * 60 * 1000, '15min': 15 * 60 * 1000,
      '1h': 60 * 60 * 1000,  '4h': 4 * 60 * 60 * 1000,
    }
    const periodMs = PERIOD_MS[mkt.timeframe] ?? 0
    if (!periodMs) return mkt?.start_price ?? undefined
    const periodStartMs  = mkt.expiry_ts - periodMs
    const periodStartSec = Math.floor(periodStartMs / 1000)
    // Bucket the period start to the market TF (e.g., 15m = 900s buckets)
    const tfSec    = periodMs / 1000
    const bucketTs = Math.floor(periodStartSec / tfSec) * tfSec * 1000

    // Priority 1: find the liveBars bar whose TF bucket aligns with period start
    const bucketBar = liveBars.find(b =>
      Math.floor(b.timestamp / periodMs) * periodMs === bucketTs
    )
    if (bucketBar?.open) return bucketBar.open

    // Priority 2: first raw 1m bar at or after period start
    const firstBar = liveBars.find(b => b.timestamp >= periodStartMs)
    if (firstBar?.open) return firstBar.open

    // Priority 3: backend start_price (last resort)
    return mkt?.start_price ?? undefined
  }, [mkt, liveBars])

  return (
    <div className="flex h-full w-full divide-x divide-surface-border">
      {intervals.map(iv => (
        <div key={iv} className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <ChartPanel
            asset={asset}
            interval={iv}
            label={INTERVAL_LABELS[iv] ?? `${iv}m`}
            liveBars={liveBars}
            strikePrice={strikePrice}
          />
        </div>
      ))}
    </div>
  )
}
