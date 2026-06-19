/**
 * MiniChart — lightweight single-timeframe panel used in 3/4-panel mode.
 *
 * Fetches 120 bars at the given interval on mount and when asset changes.
 * For the 1m panel, pass `staticBars` (live bars from store) to skip the fetch.
 */
import { useEffect, useRef } from 'react'
import {
  createChart, ColorType, CrosshairMode, LineStyle,
  CandlestickSeries, LineSeries,
} from 'lightweight-charts'
import type { Asset, Bar } from '../types'
import { fetchBars } from '../utils/bars'

// Re-use the same KC calc as Chart.tsx
function emaArr(values: number[], period: number): number[] {
  if (values.length === 0) return []
  const k = 2 / (period + 1)
  const out: number[] = [values[0]]
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k))
  }
  return out
}

function calcKC(bars: Bar[], period = 20, mult = 2.5) {
  if (bars.length < 2) return null
  const closes = bars.map(b => b.close)
  const midLine = emaArr(closes, period)
  const tr = bars.map((b, i) =>
    i === 0
      ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)),
  )
  const atrLine = emaArr(tr, period)
  return bars.map((b, i) => ({
    time: Math.floor(b.timestamp / 1000) as any,
    upper: midLine[i] + mult * atrLine[i],
    mid: midLine[i],
    lower: midLine[i] - mult * atrLine[i],
  }))
}

// Aggregate 1m bars into a higher interval client-side (fallback for assets
// without native multi-interval data, e.g. HYPE, BNB).
function aggregateToInterval(bars1m: Bar[], targetMin: number): Bar[] {
  const bucketMs = targetMin * 60_000
  const map = new Map<number, Bar>()
  for (const b of bars1m) {
    const ts = Math.floor(b.timestamp / bucketMs) * bucketMs
    const existing = map.get(ts)
    if (!existing) {
      map.set(ts, { ...b, timestamp: ts })
    } else {
      existing.high   = Math.max(existing.high, b.high)
      existing.low    = Math.min(existing.low,  b.low)
      existing.close  = b.close
      existing.volume = (existing.volume ?? 0) + (b.volume ?? 0)
    }
  }
  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp)
}

function prepBars(bars: Bar[], interval: number) {
  const bucketMs = interval === 1 ? 60_000 : interval * 60_000
  const map = new Map<number, any>()
  for (const b of bars) {
    const t = interval === 1
      ? Math.floor(b.timestamp / bucketMs) * 60
      : Math.floor(b.timestamp / 1000)
    map.set(t, { time: t as any, open: b.open, high: b.high, low: b.low, close: b.close })
  }
  return Array.from(map.values()).sort((a, b) => a.time - b.time)
}

interface Props {
  asset: Asset
  interval: number
  label: string
  staticBars?: Bar[]
  fallbackBars?: Bar[]   // 1m live bars — aggregated client-side if API returns empty
}

export function MiniChart({ asset, interval, label, staticBars, fallbackBars }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<any>(null)
  const candleRef    = useRef<any>(null)
  const upperRef     = useRef<any>(null)
  const midRef       = useRef<any>(null)
  const lowerRef     = useRef<any>(null)
  const barsRef      = useRef<Bar[]>([])

  // ── Init chart ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0a1020' },
        textColor: '#64748b',
      },
      grid: {
        vertLines: { color: '#111827', style: LineStyle.Dotted },
        horzLines: { color: '#111827', style: LineStyle.Dotted },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#1e2d4e', scaleMargins: { top: 0.05, bottom: 0.05 } },
      timeScale: { borderColor: '#1e2d4e', timeVisible: true, borderVisible: false },
      autoSize: true,
    })
    chartRef.current = chart

    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: '#00d4a4', downColor: '#ff4757',
      borderUpColor: '#00d4a4', borderDownColor: '#ff4757',
      wickUpColor: '#00d4a4', wickDownColor: '#ff4757',
    })
    upperRef.current = chart.addSeries(LineSeries, { color: '#3b82f660', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    midRef.current   = chart.addSeries(LineSeries, { color: '#60a5fa60', lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false })
    lowerRef.current = chart.addSeries(LineSeries, { color: '#3b82f660', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })

    return () => { chart.remove() }
  }, [])

  // ── Apply bars to chart ───────────────────────────────────────────────────
  function applyBars(bars: Bar[]) {
    if (!candleRef.current || bars.length === 0) return
    const prepared = prepBars(bars, interval)
    if (prepared.length === 0) return
    try {
      candleRef.current.setData(prepared)

      // Compute KC from the already-deduplicated prepared data so timestamps
      // align exactly with candles — avoids jitter from raw ms timestamps.
      const barsForKC: Bar[] = prepared.map(p => ({
        timestamp: (p.time as number) * 1000,
        open: p.open, high: p.high, low: p.low, close: p.close, volume: 0,
      }))
      const kc = calcKC(barsForKC)
      if (kc && upperRef.current) {
        upperRef.current.setData(kc.map(d => ({ time: d.time, value: d.upper })))
        midRef.current.setData(kc.map(d => ({ time: d.time, value: d.mid })))
        lowerRef.current.setData(kc.map(d => ({ time: d.time, value: d.lower })))
      }
    } catch (err) {
      console.warn('[MiniChart] setData skipped:', err)
    }
  }

  // ── Static bars (1m live feed) ────────────────────────────────────────────
  useEffect(() => {
    if (!staticBars || staticBars.length === 0) return
    barsRef.current = staticBars.slice(-120)
    applyBars(barsRef.current)
  }, [staticBars])

  // ── Fetch bars from backend ───────────────────────────────────────────────
  useEffect(() => {
    if (staticBars) return  // skip fetch when driven by live store
    let cancelled = false
    fetchBars(asset, interval, 120, 20_000)
      .then(bars => {
        if (cancelled) return
        if (bars.length) {
          barsRef.current = bars
          applyBars(bars)
        } else if (fallbackBars?.length) {
          // Asset has no native data at this interval; aggregate from 1m.
          const agg = aggregateToInterval(fallbackBars, interval).slice(-120)
          barsRef.current = agg
          applyBars(agg)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [asset, fallbackBars, interval, staticBars])

  return (
    <div className="flex flex-col overflow-hidden border-r border-[#1e2d4e] last:border-r-0 bg-[#0a1020]">
      {/* Interval label bar */}
      <div className="px-2 py-1 flex items-center gap-2 shrink-0 bg-[#0d1526] border-b border-[#1e2d4e]">
        <span className="text-[11px] font-mono font-bold text-accent tracking-wide">{label}</span>
        <span className="text-[10px] font-mono text-slate-500">{asset}</span>
      </div>
      {/* Chart fills remaining cell height — overflow-hidden clips the canvas */}
      <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden" />
    </div>
  )
}
