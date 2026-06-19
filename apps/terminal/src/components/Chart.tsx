import { useEffect, useRef, useState, useMemo, type MutableRefObject } from 'react'
import {
  createChart, ColorType, CrosshairMode, LineStyle,
  CandlestickSeries, LineSeries, HistogramSeries,
} from 'lightweight-charts'
import { useStore } from '../store'
import type { Asset, Bar } from '../types'
import { fetchBars } from '../utils/bars'

// ── Timeframes ────────────────────────────────────────────────────────────────
type TF = 'tick' | number

const TF_OPTIONS: { value: TF; label: string }[] = [
  { value: 'tick', label: 'Tick' },
  { value: 1/3,    label: '20s'  },
  { value: 1,      label: '1m'   },
  { value: 5,      label: '5m'   },
  { value: 15,     label: '15m'  },
  { value: 60,     label: '1h'   },
  { value: 240,    label: '4h'   },
  { value: 480,    label: '8h'   },
  { value: 1440,   label: 'D'    },
]

const VP_BIN_OPTIONS = [24, 32, 48, 64, 80, 96, 128] as const

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

// ── APZ helpers ───────────────────────────────────────────────────────────────
function emaArr(values: number[], period: number): number[] {
  if (!values.length) return []
  const k = 2 / (period + 1)
  const out = [values[0]]
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k))
  return out
}

// Adaptive Price Zone (Lee Leibfarth)
// dEMA = 2×EMA1 − EMA2 (eliminates lag); bands = dEMA ± mult×ATR
function calcAPZ(bars: Bar[], period = 5, mult = 2.0) {
  if (bars.length < period * 2) return null
  const closes = bars.map(b => b.close)
  const ema1 = emaArr(closes, period)
  const ema2 = emaArr(ema1,   period)
  const dema = ema1.map((e1, i) => 2 * e1 - ema2[i])   // double-smoothed, lag-reduced
  const tr = bars.map((b, i) =>
    i === 0 ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))
  )
  const atr = emaArr(tr, period)
  return bars.map((b, i) => ({
    time:  Math.floor(b.timestamp / 1000) as any,
    upper: dema[i] + mult * atr[i],
    mid:   dema[i],
    lower: dema[i] - mult * atr[i],
  }))
}

// ── Calendar-aligned bar start (5m, 15m, 60m on top of hour) ─────────────────
function getBarStart(timestamp: number, intervalMinutes: number): number {
  const date = new Date(timestamp)
  const msPerMin = 60 * 1000

  if (intervalMinutes === 60) {
    // Top of the hour
    date.setMinutes(0, 0, 0)
  } else if (intervalMinutes === 15) {
    // 0, 15, 30, 45
    const min = Math.floor(date.getMinutes() / 15) * 15
    date.setMinutes(min, 0, 0)
  } else if (intervalMinutes === 5) {
    // 0, 5, 10, ..., 55
    const min = Math.floor(date.getMinutes() / 5) * 5
    date.setMinutes(min, 0, 0)
  } else {
    // Fallback: simple bucket
    const bucketMs = intervalMinutes * msPerMin
    return Math.floor(timestamp / bucketMs) * bucketMs
  }

  return date.getTime()
}

// ── Bar prep: bucket by TF, dedup, sort ascending ────────────────────────────
function prepBars(bars: Bar[], intervalMinutes: number) {
  const map = new Map<number, any>()
  for (const b of bars) {
    const startMs = getBarStart(b.timestamp, intervalMinutes)
    const t = Math.floor(startMs / 1000) // unix seconds
    const ex = map.get(t)
    if (!ex) {
      map.set(t, { time: t as any, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 })
    } else {
      ex.high   = Math.max(ex.high, b.high)
      ex.low    = Math.min(ex.low,  b.low)
      ex.close  = b.close
      ex.volume = ex.volume + (b.volume ?? 0)
    }
  }
  return Array.from(map.values()).sort((a, b) => a.time - b.time)
}

// Merge API histBars + live WS 1m bars into higher-TF buckets
function mergeAndAggregate(histBars: Bar[], liveBars: Bar[], intervalMinutes: number): Bar[] {
  const all = [...histBars, ...liveBars]
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

// ── Component ─────────────────────────────────────────────────────────────────
interface Props { asset: Asset }

export function Chart({ asset }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<any>(null)
  const candleRef    = useRef<any>(null)
  const upperRef     = useRef<any>(null)
  const midRef       = useRef<any>(null)
  const lowerRef     = useRef<any>(null)
  const tickRef      = useRef<any>(null)
  const volumeRef    = useRef<any>(null)
  // Price lines managed outside the paint loop (created once, updated in place)
  const strikeLineRef = useRef<any>(null)
  const settleLineRef = useRef<any>(null)

  // Tracks data key so we only do full setData when something structural changes
  const dataKeyRef     = useRef('')
  // Tracks the unix-second timestamp of the last bar we wrote KC for
  // KC only updates when bar time changes → eliminates sub-bar jitter
  const lastKcTimeRef  = useRef(0)

  const liveBars  = useStore(s => s.bars[asset])
  const liveTicks = useStore(s => s.ticks[asset])
  const activeMarketKey = useStore(s => s.activeMarketKey)
  const markets   = useStore(s => s.markets)
  const connected = useStore(s => s.connected)

  const [tf, setTf]         = useState<TF>(1)
  const [vpBins, setVpBins] = useState<number>(64)
  const [histBars, setHist] = useState<Bar[]>([])
  const [bars60m,  set60m]  = useState<Bar[]>([])
  const [loading,  setLoad] = useState(false)

  // Tracks the latest TF-aggregated bars so the heartbeat always has the correct
  // open/high/low for the current bucket without accessing stale closure values.
  const displayBarsRef = useRef<Bar[]>([])

  // Reset TF to 1m when asset changes for maximum price granularity
  useEffect(() => { setTf(1) }, [asset])

  // Auto-switch chart TF to align bars with the active market's period window.
  // BTC_5min → 5m bars, BTC_15min → 15m bars, BTC_1h → 1h bars, BTC_4h → 4h bars.
  // Each bar then corresponds to exactly one Polymarket period so the strike line
  // sits at the right edge of the completed period rather than floating mid-bar.
  useEffect(() => {
    if (!activeMarketKey) return
    const suffix = activeMarketKey.split('_').pop() ?? ''
    const TF_FROM_MARKET: Partial<Record<string, TF>> = {
      '5min': 5, '15min': 15, '1h': 60, '4h': 240,
    }
    const newTf = TF_FROM_MARKET[suffix]
    if (newTf !== undefined) setTf(newTf)
  }, [activeMarketKey])

  // Fetch history for TFs that need a REST call (everything except 1m/tick/8h)
  useEffect(() => {
    if (tf === 'tick' || tf === 480) {
      setHist([])
      return
    }
    setLoad(true)
    const limit = tf === 1/3 ? 500 : 500
    let cancelled = false
    fetchBars(asset, tf, limit, 20_000)
      .then(bars => { if (!cancelled && bars.length) setHist(bars) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoad(false) })
    return () => { cancelled = true }
  }, [asset, tf])

  // Always keep 60m bars for 8h aggregation
  useEffect(() => {
    let cancelled = false
    fetchBars(asset, 60, 500, 20_000)
      .then(bars => { if (!cancelled && bars.length) set60m(bars) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [asset])

  // ── 1-second live candle heartbeat ───────────────────────────────────────
  // Fires every second and pushes the freshest price into the forming candle.
  // Uses displayBarsRef (already aggregated to the selected TF) for open/high/low
  // so the bucket open is always correct regardless of which raw 1m bars arrived.
  // Falls back to last bar close when no fresh ticks are present.
  useEffect(() => {
    if (tf === 'tick') return
    const tfSec = (tf as number) * 60
    const id = setInterval(() => {
      if (!candleRef.current) return
      const aggBars = displayBarsRef.current
      if (aggBars.length === 0) return

      const s         = useStore.getState()
      const ticks     = s.ticks[asset]
      const lastTick  = ticks && ticks.length > 0 ? ticks[ticks.length - 1] : null
      const lastAgg   = aggBars[aggBars.length - 1]
      // Latest price: prefer freshest tick, fall back to last aggregated close
      const latestPrice = lastTick ? lastTick.price : lastAgg.close

      // Bucket boundary from wall clock — not from lastBar.timestamp
      const nowSec    = Math.floor(Date.now() / 1000)
      const bucketSec = Math.floor(nowSec / tfSec) * tfSec
      const bucketMs  = bucketSec * 1000

      // Is the last aggregated bar from the current bucket?
      const isCurrentBucket = lastAgg.timestamp >= bucketMs
      const openPrice = isCurrentBucket ? lastAgg.open  : latestPrice
      const baseHigh  = isCurrentBucket ? lastAgg.high  : latestPrice
      const baseLow   = isCurrentBucket ? lastAgg.low   : latestPrice

      // Ticks inside the current bucket → accurate intra-bucket H/L
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
  }, [tf, asset])

  // Derived market info
  const activeMarket = useMemo(
    () => markets.find(m => m.key === activeMarketKey && m.asset === asset) ?? null,
    [markets, activeMarketKey, asset],
  )

  // Which bars to display
  const displayBars: Bar[] = useMemo(() => {
    if (tf === 'tick') return []
    if (tf === 1/3) {
      const bucketMs = 20000
      const map = new Map<number, Bar>()
      // First process 1s hist bars
      for (const b of histBars) {
        const ts = Math.floor(b.timestamp / bucketMs) * bucketMs
        const ex = map.get(ts)
        if (!ex) {
          map.set(ts, { ...b, timestamp: ts })
        } else {
          ex.high = Math.max(ex.high, b.high)
          ex.low = Math.min(ex.low, b.low)
          ex.close = b.close
          ex.volume += b.volume
        }
      }
      // Then overlay live ticks
      if (liveTicks) {
        for (const t of liveTicks) {
          const ts = Math.floor(t.timestamp / bucketMs) * bucketMs
          const ex = map.get(ts)
          if (!ex) {
            map.set(ts, { timestamp: ts, open: t.price, high: t.price, low: t.price, close: t.price, volume: t.size ?? t.volume ?? 0 })
          } else {
            ex.high = Math.max(ex.high, t.price)
            ex.low = Math.min(ex.low, t.price)
            ex.close = t.price
            ex.volume += (t.size ?? t.volume ?? 0)
          }
        }
      }
      return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp)
    }
    if (tf === 480) return mergeAndAggregate(bars60m, liveBars, 480)
    if (histBars.length === 0) return []
    return mergeAndAggregate(histBars, liveBars, tf as number)
  }, [tf, liveBars, histBars, bars60m, liveTicks])

  // Keep displayBarsRef in sync so the heartbeat reads the TF-aggregated bar
  useEffect(() => { displayBarsRef.current = displayBars }, [displayBars])

  const apzData = useMemo(() => calcAPZ(displayBars), [displayBars])
  const zscore = useMemo(() => calcZScore(displayBars, 20), [displayBars])

  // ── Init chart once ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0f1629' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { color: '#1e2d4e', style: LineStyle.Dotted },
        horzLines: { color: '#1e2d4e', style: LineStyle.Dotted },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#1e2d4e', scaleMargins: { top: 0.05, bottom: 0.05 } },
      timeScale: { borderColor: '#1e2d4e', timeVisible: true },
      autoSize: true,
    })
    chartRef.current = chart

    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: '#00d4a4', downColor: '#ff4757',
      borderUpColor: '#00d4a4', borderDownColor: '#ff4757',
      wickUpColor: '#00d4a4', wickDownColor: '#ff4757',
    })

    tickRef.current = chart.addSeries(LineSeries, {
      color: '#f97316', lineWidth: 2,
      crosshairMarkerVisible: true, lastValueVisible: true, priceLineVisible: false,
    })

    // Keltner Channel bands — aqua blue upper/lower, dashed mid
    upperRef.current = chart.addSeries(LineSeries,
      { color: '#06b6d480', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    midRef.current = chart.addSeries(LineSeries,
      { color: '#06b6d460', lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false })
    lowerRef.current = chart.addSeries(LineSeries,
      { color: '#06b6d480', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' }, priceScaleId: 'volume',
    })
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })
    volumeRef.current = volume

    return () => { try { chart.remove() } catch { /* ignore */ } }
  }, [])

  // ── Paint data ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!candleRef.current || !tickRef.current) return

    // ── Tick mode ─────────────────────────────────────────────────────────
    if (tf === 'tick') {
      candleRef.current.applyOptions({ visible: false })
      upperRef.current?.applyOptions({ visible: false })
      midRef.current?.applyOptions({ visible: false })
      lowerRef.current?.applyOptions({ visible: false })
      volumeRef.current?.applyOptions({ visible: false })
      tickRef.current.applyOptions({ visible: true })

      if (liveTicks.length > 0) {
        const map = new Map<number, number>()
        for (const t of liveTicks) map.set(Math.floor(t.timestamp / 1000), t.price)
        const tickData = Array.from(map.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([time, value]) => ({ time: time as any, value }))
        if (tickData.length) tickRef.current.setData(tickData)
      }
      return
    }

    // ── Candle mode ───────────────────────────────────────────────────────
    candleRef.current.applyOptions({ visible: true })
    upperRef.current?.applyOptions({ visible: true })
    midRef.current?.applyOptions({ visible: true })
    lowerRef.current?.applyOptions({ visible: true })
    volumeRef.current?.applyOptions({ visible: true })
    tickRef.current.applyOptions({ visible: false })

    if (displayBars.length === 0) return

    const prepared = prepBars(displayBars, tf as number)
    if (prepared.length === 0) return

    // Data key: changes when structural data changes → triggers full setData
    const dataKey = `${asset}-${tf}-${prepared.length}-${prepared[0]?.time ?? 0}`
    const isNew = dataKeyRef.current !== dataKey

    // ── Candles ───────────────────────────────────────────────────────────
    try {
      if (isNew) {
        candleRef.current.setData(prepared)
      } else {
        try {
          candleRef.current.update(prepared[prepared.length - 1])
        } catch {
          // Last bar time went backward (REST refresh edge case) — full redraw
          candleRef.current.setData(prepared)
        }
      }
    } catch { /* ignore */ }

    // ── Volume ────────────────────────────────────────────────────────────
    if (volumeRef.current) {
      const volData = prepared.map(b => ({
        time:  b.time,
        value: b.volume ?? 0,
        color: b.close >= b.open ? '#00d4a480' : '#ff475780',
      }))
      try {
        if (isNew) volumeRef.current.setData(volData)
        else       volumeRef.current.update(volData[volData.length - 1])
      } catch {
        try { volumeRef.current.setData(volData) } catch { /* ignore */ }
      }
    }

    dataKeyRef.current = dataKey

    // Scroll to latest bar on fresh data load so 1m mode always shows current price
    if (isNew && chartRef.current) {
      chartRef.current.timeScale().scrollToRealTime()
    }

    // ── Binary market price lines ─────────────────────────────────────────
    // Legacy binary/event-market reference line.
    let strike: number | null = null
    if (activeMarket?.price_to_beat && activeMarket.price_to_beat > 0) {
      strike = activeMarket.price_to_beat
    }
    if (!strike && activeMarket?.expiry_ts) {
      const PERIOD_MS: Record<string, number> = {
        '5min': 5 * 60 * 1000, '15min': 15 * 60 * 1000,
        '1h': 60 * 60 * 1000,  '4h': 4 * 60 * 60 * 1000,
      }
      const periodMs = PERIOD_MS[activeMarket.timeframe] ?? 0
      if (periodMs) {
        const periodStartMs = activeMarket.expiry_ts - periodMs
        const periodEndMs = activeMarket.expiry_ts

        // Priority 1: use raw live bars within the market period (most accurate to traded market).
        if (liveBars?.length) {
          const inPeriod = liveBars.filter(b => b.timestamp >= periodStartMs && b.timestamp < periodEndMs)
          if (inPeriod.length > 0) {
            const first = inPeriod.sort((a, b) => a.timestamp - b.timestamp)[0]
            if (first?.open) strike = first.open
          }
        }

        // Priority 2: rebucket currently visible display bars by market-period duration.
        if (!strike && displayBars.length > 0) {
          const periodBucket = displayBars
            .filter(b => Math.floor(b.timestamp / periodMs) * periodMs === periodStartMs)
            .sort((a, b) => a.timestamp - b.timestamp)
          if (periodBucket.length > 0 && periodBucket[0].open) strike = periodBucket[0].open
        }
      }
    }
    // Priority 3: backend start_price (last resort)
    if (!strike) strike = activeMarket?.start_price ?? null

    if (strike && candleRef.current) {
      if (!strikeLineRef.current) {
        strikeLineRef.current = candleRef.current.createPriceLine({
          price: strike,
          color: '#22d3ee', lineWidth: 1, lineStyle: LineStyle.Dashed,
          axisLabelVisible: true, title: 'REF',
        })
      } else {
        strikeLineRef.current.applyOptions({ price: strike })
      }
    } else if (strikeLineRef.current && candleRef.current) {
      try { candleRef.current.removePriceLine(strikeLineRef.current) } catch { /* ignore */ }
      strikeLineRef.current = null
    }

    // SETTLED = resolution_price — shown after the market resolves
    const settled = activeMarket?.resolution_price ?? null
    if (settled && candleRef.current) {
      if (!settleLineRef.current) {
        settleLineRef.current = candleRef.current.createPriceLine({
          price: settled,
          color: '#22d3ee', lineWidth: 2, lineStyle: LineStyle.Solid,
          axisLabelVisible: true, title: 'SETTLED',
        })
      } else {
        settleLineRef.current.applyOptions({ price: settled })
      }
    } else if (settleLineRef.current && candleRef.current) {
      try { candleRef.current.removePriceLine(settleLineRef.current) } catch { /* ignore */ }
      settleLineRef.current = null
    }

    // ── APZ bands ─────────────────────────────────────────────────────────
    if (apzData && apzData.length > 0 && upperRef.current) {
      const dedup = Array.from(
        new Map(apzData.map(d => [d.time as number, d])).values()
      )
        .filter(d =>
          Number.isFinite(d.time as number) &&
          Number.isFinite(d.upper) &&
          Number.isFinite(d.mid) &&
          Number.isFinite(d.lower),
        )
        .sort((a, b) => (a.time as number) - (b.time as number))

      if (dedup.length === 0) return

      if (isNew) {
        upperRef.current.setData(dedup.map(d => ({ time: d.time, value: d.upper })))
        midRef.current.setData(  dedup.map(d => ({ time: d.time, value: d.mid   })))
        lowerRef.current.setData(dedup.map(d => ({ time: d.time, value: d.lower })))
        lastKcTimeRef.current = dedup[dedup.length - 1].time as number
      } else {
        const last = dedup[dedup.length - 1]
        const lastT = last.time as number
        if (lastT !== lastKcTimeRef.current) {
          try {
            upperRef.current.update({ time: lastT, value: last.upper })
            midRef.current.update(  { time: lastT, value: last.mid   })
            lowerRef.current.update({ time: lastT, value: last.lower })
            lastKcTimeRef.current = lastT
          } catch { /* time went backward — ignore */ }
        }
      }
    }
  }, [displayBars, apzData, liveTicks, tf, asset, activeMarket, liveBars])

  // ── Freshness ─────────────────────────────────────────────────────────────
  const lastTs = Math.max(
    liveBars.length  ? liveBars[liveBars.length - 1].timestamp   : 0,
    liveTicks.length ? liveTicks[liveTicks.length - 1].timestamp : 0,
  )
  const isLive = connected && (lastTs === 0 || Date.now() - lastTs < 300_000)

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      <div className="panel-header">
        {/* Left */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-slate-300 shrink-0">{asset}</span>

          <span className={`live-badge${isLive ? '' : ' stale'}`}>
            <span className={`live-dot${isLive ? '' : ' stale'}`} />
            {isLive ? 'Live' : connected ? 'Stale' : 'Off'}
          </span>

          <div className="flex gap-0.5 shrink-0">
            {TF_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => setTf(value)}
                className={`px-1.5 py-0.5 rounded text-2xs font-mono font-semibold transition-colors ${tf === value
                  ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-300/40'
                  : 'text-cyan-300/85 hover:text-cyan-200 hover:bg-surface-hover'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tf !== 'tick' && (
            <div className="flex items-center gap-1 shrink-0 ml-1">
              <span className="text-2xs text-amber-300 font-mono">VP</span>
              <div className="flex gap-0.5">
                {VP_BIN_OPTIONS.map(opt => (
                  <button
                    key={opt}
                    onClick={() => setVpBins(opt)}
                    className={`px-1.5 py-0.5 rounded text-2xs font-mono font-semibold transition-colors ${
                      vpBins === opt
                        ? 'bg-blue-500/20 text-blue-300 border border-blue-400/40'
                        : 'text-muted hover:text-slate-300 hover:bg-surface-hover'
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {loading && <span className="text-2xs text-muted font-mono animate-pulse">loading…</span>}

          {activeMarket && !loading && (
            <span className="text-2xs font-mono text-slate-500 truncate hidden sm:block">
              {activeMarket.asset} {activeMarket.timeframe} live stream
            </span>
          )}
        </div>

        {/* Right */}
        <div className="flex items-center gap-2 shrink-0">
          {activeMarket && (
            <div className="flex items-center gap-1">
              <span className="text-2xs text-muted font-mono">{activeMarket.timeframe}</span>
            </div>
          )}

          {zscore !== null && (
            <span className={`label ${
              Math.abs(zscore) > 2 ? 'text-down' : Math.abs(zscore) > 1 ? 'text-warn' : 'text-slate-400'
            }`}>
              z-score: {zscore.toFixed(2)}
            </span>
          )}
          <span className="label" style={{ color: '#06b6d4' }}>KC 5/2×</span>
        </div>
      </div>

      <div className="flex-1 relative">
        <div ref={containerRef} className="absolute inset-0" />
        <DeadzoneOverlay tf={tf} chartRef={chartRef} />
        <VolumeProfileOverlay tf={tf} bars={displayBars} candleRef={candleRef} binsCount={vpBins} />
      </div>
    </div>
  )
}

function DeadzoneOverlay({ tf, chartRef }: { tf: TF; chartRef: any }) {
  const [coords, setCoords] = useState<{ x1: number; x2: number } | null>(null)
  
  useEffect(() => {
    const chart = chartRef.current
    const interval = typeof tf === 'number' ? tf : 0
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
  }, [chartRef, tf])

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
      <span className="text-[10px] font-bold text-slate-500/50 uppercase -rotate-90 whitespace-nowrap">
        Waiting
      </span>
    </div>
  )
}

function VolumeProfileOverlay({
  tf,
  bars,
  candleRef,
  binsCount,
}: {
  tf: TF
  bars: Bar[]
  candleRef: MutableRefObject<any>
  binsCount: number
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

      // Render VP on all candle timeframes (skip tick mode).
      if (tf === 'tick') return
      if (!bars.length) return
      if (!candleRef.current?.priceToCoordinate) return

      const profileBars = bars
      if (profileBars.length < 3) return

      const low = Math.min(...profileBars.map(b => b.low))
      const high = Math.max(...profileBars.map(b => b.high))
      if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return

      const bins = new Array<number>(binsCount).fill(0)
      const step = (high - low) / binsCount
      if (step <= 0) return

      // Distribute each bar volume across overlapping price bins.
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
        const nextLow = vaLow > 0 ? bins[vaLow - 1] : -1
        const nextHigh = vaHigh < binsCount - 1 ? bins[vaHigh + 1] : -1
        if (nextHigh >= nextLow) {
          if (vaHigh < binsCount - 1) {
            vaHigh++
            covered += bins[vaHigh]
          } else if (vaLow > 0) {
            vaLow--
            covered += bins[vaLow]
          }
        } else if (vaLow > 0) {
          vaLow--
          covered += bins[vaLow]
        } else if (vaHigh < binsCount - 1) {
          vaHigh++
          covered += bins[vaHigh]
        }
      }

      const xLeft = 0
      const maxBarW = Math.max(24, Math.floor(w * 0.2))
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

        if (isPoc) {
          ctx.fillStyle = 'rgba(255, 71, 87, 0.95)'
        } else if (inVa) {
          ctx.fillStyle = 'rgba(125, 211, 252, 0.72)'
        } else {
          const alpha = minOpacity + (vol / maxVol) * 0.35
          ctx.fillStyle = `rgba(59, 130, 246, ${alpha.toFixed(3)})`
        }
        ctx.fillRect(x, yTop, ww, hh)
      }

      // Small label for context.
      ctx.fillStyle = 'rgba(148, 163, 184, 0.9)'
      ctx.font = '10px Cascadia Mono, Consolas, monospace'
      ctx.textAlign = 'left'
      ctx.fillText('VP All Bars', xLeft + 2, 12)
    }

    draw()
    const id = setInterval(draw, 1000)
    return () => clearInterval(id)
  }, [tf, bars, candleRef, binsCount])

  if (tf === 'tick') return null

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 6 }}
    />
  )
}
