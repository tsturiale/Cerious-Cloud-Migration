import { useStore } from '../store'
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'

// High-contrast, premium neon colors and definitions for options trading
const METRIC_DETAILS: Record<string, { title: string; desc: string; color: string }> = {
  "ATR": {
    title: "Average True Range",
    desc: "Measures the absolute price movement range per bar. Higher values indicate wider standard deviation of price changes.",
    color: "#cbd5e1" // Silver/White
  },
  "Vol (5P)": {
    title: "Short-Term Volatility",
    desc: "Realized volatility calculated over VWAP (5 periods). Drives probability dispersion and options premium expansion.",
    color: "#00e676" // Neon Green (normally low, shifts dynamically)
  },
  "Z-Score": {
    title: "Statistical Z-Score",
    desc: "Distance from the VWAP moving average in standard deviations. Deviations outside [-2, +2] signal high probability of reversion.",
    color: "#ffa502" // Orange
  },
  "Delta (TP)": {
    title: "Merton Truth Probability (Delta)",
    desc: "Theoretical fair value probability of resolving YES based on microstructure jump-diffusion pricing. Difference from market is your Edge.",
    color: "#00f3ff" // Electric Cyan
  },
  "Gamma": {
    title: "Gamma (Sensitivity)",
    desc: "Delta sensitivity rate per 1% change in underlying price. Measures probability acceleration as spot nears strike.",
    color: "#00e676" // Neon Green
  },
  "Theta": {
    title: "Theta (Decay)",
    desc: "Extrinsic value time-decay rate per second. Collect theta by holding short positions near expiration.",
    color: "#ff1744" // Sunset Rose/Red
  },
  "Vanna": {
    title: "Vanna (Vol Sensitivity)",
    desc: "Second-order sensitivity tracking how Delta shifts with changes in volatility. Crucial for regime expansions.",
    color: "#ff9100" // Bright Orange
  },
  "Charm": {
    title: "Charm (Delta Bleed)",
    desc: "Delta drift rate over time under flat spot prices. Tracks probability bleed toward 0% or 100% boundary rails.",
    color: "#d500f9" // Vivid Fuchsia/Purple
  }
}

function Sparkline({ values, label, color }: { values: number[]; label: string; color: string }) {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const width = 60
  const height = 16
  const padding = 2
  
  // Calculate coordinates
  const coords = values.map((val, index) => {
    const x = padding + (index / (values.length - 1)) * (width - 2 * padding)
    const y = padding + (height - 2 * padding) - ((val - min) / range) * (height - 2 * padding)
    return { x, y }
  })
  
  const points = coords.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
  
  // Closed shape coordinates for gradient fill
  const first = coords[0]
  const last = coords[coords.length - 1]
  const fillPoints = [
    `${first.x.toFixed(1)},${height.toFixed(1)}`,
    ...coords.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`),
    `${last.x.toFixed(1)},${height.toFixed(1)}`
  ].join(' ')

  const gradId = `spark-grad-${label.replace(/[^a-zA-Z0-9]/g, '')}`

  return (
    <svg width={width} height={height} className="ml-2 shrink-0 overflow-visible">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.0" />
        </linearGradient>
      </defs>
      {/* Shaded Area */}
      <polygon fill={`url(#${gradId})`} points={fillPoints} />
      {/* Path Line */}
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
      {/* Highlight circle on latest tick */}
      <circle
        cx={last.x}
        cy={last.y}
        r="2"
        fill="#ffffff"
        stroke={color}
        strokeWidth="1"
      />
    </svg>
  )
}

interface MetricRowProps {
  label: string
  value: string
  colorClass: string
  sparklineValues?: number[]
  trend?: 'up' | 'down' | 'flat'
  subtext?: string
  f_val: number
  extraData?: any
  onHover: (rect: DOMRect | null, label: string | null) => void
}

function MetricRow({
  label,
  value,
  colorClass,
  sparklineValues,
  trend,
  subtext,
  f_val,
  extraData,
  onHover
}: MetricRowProps) {
  const details = METRIC_DETAILS[label]
  const themeColor = details?.color || '#cbd5e1'

  return (
    <div 
      onMouseEnter={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        onHover(rect, label)
      }}
      onMouseLeave={() => {
        onHover(null, null)
      }}
      className="flex flex-col bg-surface-panel/40 border border-surface-border/40 rounded p-1.5 hover:bg-surface-hover/30 hover:border-accent/40 hover:shadow-[0_0_8px_rgba(58,237,255,0.15)] transition-all select-none cursor-help"
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted font-mono tracking-wide uppercase font-semibold">{label}</span>
        <div className="flex items-center">
          {trend === 'up' && <span className="text-up text-[9px] mr-1">▲</span>}
          {trend === 'down' && <span className="text-down text-[9px] mr-1">▼</span>}
          <span className={`font-bold font-mono text-xs tabular-nums ${colorClass}`}>{value}</span>
          {sparklineValues && sparklineValues.length >= 2 && (
            <Sparkline values={sparklineValues} label={label} color={themeColor} />
          )}
        </div>
      </div>

      {/* Visual Micro-charts / Sliders */}
      <div className="w-full mt-1 shrink-0">
        {/* Z-Score barbell slider [-3 to +3] */}
        {label === "Z-Score" && (
          <div className="w-full bg-slate-800/80 rounded-full h-1 relative border border-slate-700/30">
            <div className="absolute top-0 bottom-0 left-[16.6%] right-[16.6%] bg-slate-700/20 border-l border-r border-slate-600/30" />
            <div className="absolute top-0 bottom-0 left-[33.3%] right-[33.3%] bg-slate-700/40 border-l border-r border-slate-500/40" />
            <div className="absolute top-0 bottom-0 left-1/2 w-px bg-slate-500/50" />
            <div 
              className={`absolute top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full transition-all duration-200 ${
                Math.abs(f_val) > 2 ? 'bg-down shadow-[0_0_6px_#ff4757]' : Math.abs(f_val) > 1 ? 'bg-warn shadow-[0_0_6px_#ffa502]' : 'bg-up shadow-[0_0_6px_#00d4a4]'
              }`}
              style={{ left: `${Math.max(5, Math.min(95, 50 + (f_val / 3) * 50))}%` }}
            />
          </div>
        )}

        {/* Delta Option Edge Gauge (Model vs Market) */}
        {label === "Delta (TP)" && extraData && (
          <div className="w-full bg-slate-800/80 rounded-full h-1 relative border border-slate-700/30">
            {/* Edge span shading */}
            <div 
              className="absolute top-0 bottom-0 bg-accent/30" 
              style={{ 
                left: `${Math.min(f_val, extraData.market_price)}%`, 
                width: `${Math.abs(f_val - extraData.market_price)}%` 
              }} 
            />
            {/* Model (TP) value - glowing Cyan */}
            <div 
              className="absolute top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-accent shadow-[0_0_6px_#00f3ff] z-10" 
              style={{ left: `${Math.max(4, Math.min(96, f_val))}%` }}
            />
            {/* Market Price (Polymarket probability) - plain silver */}
            <div 
              className="absolute top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-slate-400 border border-slate-900 z-10" 
              style={{ left: `${Math.max(4, Math.min(96, extraData.market_price))}%` }}
            />
          </div>
        )}

        {/* Dynamic aggression bar for Volatility */}
        {label === "Vol (5P)" && (
          <div className="w-full bg-slate-800/80 rounded-full h-1 relative overflow-hidden border border-slate-700/30">
            <div 
              className={`absolute top-0 bottom-0 left-0 rounded-full transition-all duration-300 ${
                f_val > 0.035 ? 'bg-down' : f_val > 0.02 ? 'bg-warn' : 'bg-up'
              }`}
              style={{ width: `${Math.max(5, Math.min(100, (f_val / 0.08) * 100))}%` }}
            />
          </div>
        )}

        {/* Standard progress bars for ATR and Option sensitivity Greeks */}
        {label === "ATR" && extraData?.history && (
          <div className="w-full bg-slate-800/80 rounded-full h-1 overflow-hidden border border-slate-700/30">
            <div 
              className="h-full bg-slate-400 rounded-full transition-all duration-300"
              style={{ width: `${Math.max(5, Math.min(100, (f_val / (Math.max(...extraData.history, 0.01) * 1.2)) * 100))}%` }}
            />
          </div>
        )}
        {label === "Gamma" && (
          <div className="w-full bg-slate-800/80 rounded-full h-1 overflow-hidden border border-slate-700/30">
            <div 
              className="h-full bg-emerald-500 rounded-full transition-all duration-300"
              style={{ width: `${Math.max(5, Math.min(100, (f_val / 0.10) * 100))}%` }}
            />
          </div>
        )}
        {label === "Theta" && (
          <div className="w-full bg-slate-800/80 rounded-full h-1 overflow-hidden border border-slate-700/30">
            <div 
              className="h-full bg-[#ff1744] rounded-full transition-all duration-300"
              style={{ width: `${Math.max(5, Math.min(100, (Math.abs(f_val) / 0.015) * 100))}%` }}
            />
          </div>
        )}
        {label === "Vanna" && (
          <div className="w-full bg-slate-800/80 rounded-full h-1 overflow-hidden border border-slate-700/30">
            <div 
              className="h-full bg-amber-500 rounded-full transition-all duration-300"
              style={{ width: `${Math.max(5, Math.min(100, (Math.abs(f_val) / 0.06) * 100))}%` }}
            />
          </div>
        )}
        {label === "Charm" && (
          <div className="w-full bg-slate-800/80 rounded-full h-1 overflow-hidden border border-slate-700/30">
            <div 
              className="h-full bg-fuchsia-500 rounded-full transition-all duration-300"
              style={{ width: `${Math.max(5, Math.min(100, (Math.abs(f_val) / 0.08) * 100))}%` }}
            />
          </div>
        )}
      </div>

      {subtext && (
        <span className="text-[9px] text-slate-500 font-mono mt-1 text-right tracking-tight">{subtext}</span>
      )}
    </div>
  )
}

export function GreeksEducationPanel() {
  const activeMarketKey = useStore(s => s.activeMarketKey)
  const markets = useStore(s => s.markets)
  const [popout, setPopout] = useState(false)

  // Hover state for portal tooltip
  const [hoveredMetric, setHoveredMetric] = useState<string | null>(null)
  const [hoveredRect, setHoveredRect] = useState<DOMRect | null>(null)

  // Greeks rolling tracking state
  const [history, setHistory] = useState<Record<string, number[]>>({})
  const [prevMarketKey, setPrevMarketKey] = useState<string | null>(null)

  const market = markets.find(m => m.key === activeMarketKey)

  // Clear history on market switch
  useEffect(() => {
    if (activeMarketKey !== prevMarketKey) {
      setHistory({})
      setPrevMarketKey(activeMarketKey)
    }
  }, [activeMarketKey, prevMarketKey])

  const {
    atr = 0,
    volatility = 0,
    zscore = 0,
    truth_up_pct = 0,
    gamma = 0,
    theta = 0,
    vanna = 0,
    charm = 0,
    up_pct = 50,
  } = market || {}
  const regime = (market as { regime?: string } | undefined)?.regime ?? 'medium'

  const f_atr = atr ?? 0
  const f_volatility = volatility ?? 0
  const f_zscore = zscore ?? 0
  const f_truth_up_pct = truth_up_pct ?? 0
  const f_gamma = gamma ?? 0
  const f_theta = theta ?? 0
  const f_vanna = vanna ?? 0
  const f_charm = charm ?? 0
  const f_up_pct = up_pct ?? 50
  const f_regime = regime ?? 'medium'

  // Track values in rolling history
  useEffect(() => {
    if (!market) return
    setHistory(prev => {
      const updateKey = (key: string, val: number) => {
        const arr = prev[key] ? [...prev[key]] : []
        if (arr.length === 0 || arr[arr.length - 1] !== val) {
          arr.push(val)
        }
        return arr.slice(-20)
      }
      return {
        atr: updateKey('atr', f_atr),
        volatility: updateKey('volatility', f_volatility),
        zscore: updateKey('zscore', f_zscore),
        delta: updateKey('delta', f_truth_up_pct),
        gamma: updateKey('gamma', f_gamma),
        theta: updateKey('theta', f_theta),
        vanna: updateKey('vanna', f_vanna),
        charm: updateKey('charm', f_charm),
      }
    })
  }, [f_atr, f_volatility, f_zscore, f_truth_up_pct, f_gamma, f_theta, f_vanna, f_charm, market])

  if (!market) {
    return null
  }

  const getHistoryKey = (label: string): string => {
    if (label === 'Vol (5P)') return 'volatility'
    if (label === 'Delta (TP)') return 'delta'
    return label.toLowerCase().replace(/[^a-z]/g, '')
  }

  const getTrend = (key: string) => {
    const arr = history[key]
    if (!arr || arr.length < 2) return 'flat'
    const last = arr[arr.length - 1]
    const prev = arr[arr.length - 2]
    return last > prev ? 'up' : last < prev ? 'down' : 'flat'
  }

  // Statistics calculation for hovered metric
  const getStats = (label: string) => {
    const key = getHistoryKey(label)
    const vals = history[key]
    if (!vals || vals.length === 0) return null
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const sum = vals.reduce((a, b) => a + b, 0)
    const mean = sum / vals.length
    const variance = vals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / vals.length
    const stddev = Math.sqrt(variance)
    const latest = vals[vals.length - 1]
    const first = vals[0]
    const change = latest - first
    const changePct = first !== 0 ? (change / Math.abs(first)) * 100 : 0
    return { min, max, mean, stddev, change, changePct, values: vals }
  }

  const formatValue = (label: string, val: number): string => {
    if (label === 'ATR') return `$${val.toFixed(2)}`
    if (label === 'Vol (5P)') return `${(val * 100).toFixed(2)}%`
    if (label === 'Delta (TP)') return `${val.toFixed(1)}%`
    if (label === 'Z-Score') return val.toFixed(2)
    return val.toFixed(3)
  }

  // Model vs Market Edge calculations
  const deltaBias = f_truth_up_pct - f_up_pct
  const edgeSign = deltaBias >= 0 ? '+' : ''
  const deltaColor = Math.abs(deltaBias) > 2 ? (deltaBias > 0 ? 'text-up' : 'text-down') : 'text-accent'

  const hoveredStats = hoveredMetric ? getStats(hoveredMetric) : null
  const hoveredDetails = hoveredMetric ? METRIC_DETAILS[hoveredMetric] : null

  return (
    <div className="border-t border-surface-border shrink-0 bg-surface flex flex-col relative">
      <div className="flex items-center justify-between px-2 py-1 bg-surface-panel border-b border-surface-border select-none">
        <span className="text-[10px] font-bold text-accent uppercase tracking-wider">Merton Jump-Diffusion Greeks</span>
        <button
          onClick={() => setPopout(true)}
          className="text-xs text-muted hover:text-white px-1.5 py-0.5 rounded bg-surface hover:bg-surface-hover border border-surface-border transition-colors font-semibold"
          title="Education Review"
        >
          📖 Learn
        </button>
      </div>
      
      <div className="p-2 grid grid-cols-2 gap-x-2 gap-y-1.5 overflow-y-auto">
        <MetricRow 
          label="ATR" 
          value={`$${f_atr.toFixed(2)}`} 
          colorClass="text-slate-100" 
          sparklineValues={history.atr}
          trend={getTrend('atr')}
          subtext="bar price range"
          f_val={f_atr}
          extraData={{ history: history.atr }}
          onHover={(rect, label) => { setHoveredRect(rect); setHoveredMetric(label); }}
        />
        <MetricRow 
          label="Vol (5P)" 
          value={`${(f_volatility * 100).toFixed(2)}%`} 
          colorClass={f_volatility > 0.035 ? 'text-down' : f_volatility > 0.02 ? 'text-warn' : 'text-up'} 
          sparklineValues={history.volatility}
          trend={getTrend('volatility')}
          subtext="vwap volatility"
          f_val={f_volatility}
          onHover={(rect, label) => { setHoveredRect(rect); setHoveredMetric(label); }}
        />
        <MetricRow 
          label="Z-Score" 
          value={`${f_zscore.toFixed(2)}`} 
          colorClass={Math.abs(f_zscore) > 2.0 ? 'text-down' : Math.abs(f_zscore) > 1.0 ? 'text-warn' : 'text-slate-200'} 
          sparklineValues={history.zscore}
          trend={getTrend('zscore')}
          subtext={`regime: ${f_regime}`}
          f_val={f_zscore}
          onHover={(rect, label) => { setHoveredRect(rect); setHoveredMetric(label); }}
        />
        <MetricRow 
          label="Delta (TP)" 
          value={`${f_truth_up_pct.toFixed(1)}%`} 
          colorClass={deltaColor}
          sparklineValues={history.delta}
          trend={getTrend('delta')}
          subtext={`mkt ${f_up_pct.toFixed(1)}% (${edgeSign}${deltaBias.toFixed(1)}% edge)`}
          f_val={f_truth_up_pct}
          extraData={{ market_price: f_up_pct }}
          onHover={(rect, label) => { setHoveredRect(rect); setHoveredMetric(label); }}
        />

        <MetricRow 
          label="Gamma" 
          value={`${f_gamma.toFixed(3)}`} 
          colorClass="text-emerald-400" 
          sparklineValues={history.gamma}
          trend={getTrend('gamma')}
          subtext="sensitivity per 1%"
          f_val={f_gamma}
          onHover={(rect, label) => { setHoveredRect(rect); setHoveredMetric(label); }}
        />
        <MetricRow 
          label="Theta" 
          value={`${f_theta.toFixed(3)}`} 
          colorClass="text-[#ff1744]" 
          sparklineValues={history.theta}
          trend={getTrend('theta')}
          subtext="decay / second"
          f_val={f_theta}
          onHover={(rect, label) => { setHoveredRect(rect); setHoveredMetric(label); }}
        />
        <MetricRow 
          label="Vanna" 
          value={`${f_vanna.toFixed(3)}`} 
          colorClass="text-amber-400" 
          sparklineValues={history.vanna}
          trend={getTrend('vanna')}
          subtext="vol sensitivity"
          f_val={f_vanna}
          onHover={(rect, label) => { setHoveredRect(rect); setHoveredMetric(label); }}
        />
        <MetricRow 
          label="Charm" 
          value={`${f_charm.toFixed(3)}`} 
          colorClass="text-fuchsia-400" 
          sparklineValues={history.charm}
          trend={getTrend('charm')}
          subtext="delta bleed / hour"
          f_val={f_charm}
          onHover={(rect, label) => { setHoveredRect(rect); setHoveredMetric(label); }}
        />
      </div>

      {/* Floating Historical Statistics Portal Tooltip */}
      {hoveredMetric && hoveredRect && hoveredDetails && hoveredStats && createPortal(
        <div 
          className="fixed z-[9999] bg-[#080d19]/95 border border-surface-border backdrop-blur-md rounded shadow-2xl p-3 text-slate-200 text-2xs font-mono w-72 pointer-events-none flex flex-col gap-2.5 transition-all"
          style={{
            top: `${Math.max(10, Math.min(window.innerHeight - 240, hoveredRect.top + (hoveredRect.height / 2) - 110))}px`,
            left: `${hoveredRect.left - 295}px`
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-surface-border pb-1">
            <span className="font-bold tracking-wide uppercase" style={{ color: hoveredDetails.color }}>
              {hoveredDetails.title}
            </span>
            <span className="text-[9px] text-slate-500 font-bold">20T HISTORY</span>
          </div>

          {/* Description */}
          <div className="text-[10px] text-slate-400 leading-normal font-sans">
            {hoveredDetails.desc}
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 bg-black/40 border border-surface-border/40 rounded p-1.5 text-[10px]">
            <div className="flex justify-between">
              <span className="text-slate-500 font-sans">MIN:</span>
              <span className="font-bold tabular-nums text-slate-300">{formatValue(hoveredMetric, hoveredStats.min)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500 font-sans">MAX:</span>
              <span className="font-bold tabular-nums text-slate-300">{formatValue(hoveredMetric, hoveredStats.max)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500 font-sans">MEAN:</span>
              <span className="font-bold tabular-nums text-slate-300">{formatValue(hoveredMetric, hoveredStats.mean)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500 font-sans">STD DEV:</span>
              <span className="font-bold tabular-nums text-slate-300">
                {hoveredMetric === 'ATR' || hoveredMetric === 'Z-Score' ? hoveredStats.stddev.toFixed(3) : (hoveredStats.stddev * (hoveredMetric === 'Vol (5P)' || hoveredMetric === 'Delta (TP)' ? 100 : 1)).toFixed(3) + (hoveredMetric === 'Vol (5P)' || hoveredMetric === 'Delta (TP)' ? '%' : '')}
              </span>
            </div>
          </div>

          {/* Momentum / Change */}
          <div className="flex items-center justify-between bg-black/20 border-t border-surface-border/30 pt-1 text-[10px]">
            <span className="text-slate-500 font-sans">20T MOMENTUM:</span>
            <span className={`font-bold tabular-nums ${hoveredStats.change >= 0 ? 'text-up' : 'text-down'}`}>
              {hoveredStats.change >= 0 ? '▲' : '▼'} {Math.abs(hoveredStats.changePct).toFixed(1)}%
            </span>
          </div>
        </div>,
        document.body
      )}

      {popout && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-4">
          <div className="bg-surface-panel border border-surface-border rounded shadow-2xl max-w-2xl w-full flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between p-4 border-b border-surface-border">
              <h2 className="text-xl font-bold tracking-wide text-white">Truth Engine Greeks: Education Review</h2>
              <button
                onClick={() => setPopout(false)}
                className="text-muted hover:text-white px-2 py-1 rounded transition-colors text-lg"
              >
                ✕
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto space-y-6 text-sm text-slate-300 font-sans">
              <p className="leading-relaxed">
                Welcome to the <strong>Option A: Truth Engine</strong>. Crypto prediction markets suffer from aggressive liquidations, fat tails, and extreme micro-structural inefficiencies. We use a <em>Merton Jump-Diffusion</em> probability engine combined with <em>Student-t distributions</em> to accurately track these anomalies on 5m and 15m timeframes.
              </p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-surface p-3 rounded border border-surface-border/80">
                  <h3 className="font-bold text-slate-200 mb-1 text-xs uppercase tracking-wider">Bar ATR (Average True Range)</h3>
                  <p className="text-xs text-slate-400">Measures absolute dollar movement over recent periods. High ATR expands options premium and drives prediction probabilities away from boundaries.</p>
                </div>
                
                <div className="bg-surface p-3 rounded border border-surface-border/80">
                  <h3 className="font-bold text-[#00e676] mb-1 text-xs uppercase tracking-wider">Volatility (5 Period)</h3>
                  <p className="text-xs text-slate-400">Short-term standard deviation of VWAP. Detects volume-weighted aggression before large breakout moves, adjusting options premium pricing.</p>
                </div>

                <div className="bg-surface p-3 rounded border border-surface-border/80">
                  <h3 className="font-bold text-[#00f3ff] mb-1 text-xs uppercase tracking-wider">Delta (Truth Prob)</h3>
                  <p className="text-xs text-slate-400">Core probability that the market resolves YES. In binary options, contract price is the Delta. Discrepancies with orderbook mid-prices represent your Edge.</p>
                </div>

                <div className="bg-surface p-3 rounded border border-surface-border/80">
                  <h3 className="font-bold text-[#00e676] mb-1 text-xs uppercase tracking-wider">Gamma</h3>
                  <p className="text-xs text-slate-400">Rate of change of Delta as the underlying crypto moves by 1%. High gamma creates violent swings, especially when spot is near strike close to expiry.</p>
                </div>

                <div className="bg-surface p-3 rounded border border-surface-border/80">
                  <h3 className="font-bold text-[#ff1744] mb-1 text-xs uppercase tracking-wider">Theta</h3>
                  <p className="text-xs text-slate-400">Time-decay of probability. Binary options lose extrinsic value as time passes (if spot != strike). harvesters collect Theta by selling options.</p>
                </div>
                
                <div className="bg-surface p-3 rounded border border-surface-border/80">
                  <h3 className="font-bold text-[#ff9100] mb-1 text-xs uppercase tracking-wider">Vanna (2nd Order)</h3>
                  <p className="text-xs text-slate-400">Sensitivity of Delta to changes in Volatility. Identifies zones where sudden volatility spikes dynamically swing the probability.</p>
                </div>

                <div className="bg-surface p-3 rounded border border-surface-border/80 md:col-span-2">
                  <h3 className="font-bold text-[#d500f9] mb-1 text-xs uppercase tracking-wider">Charm (Delta Bleed)</h3>
                  <p className="text-xs text-slate-400">Rate at which Delta changes over time. Tracks how the probability naturally drifts toward 0% or 100% boundary rails near expiration even when spot is flat.</p>
                </div>
              </div>
            </div>
            
            <div className="p-4 border-t border-surface-border bg-surface text-center">
              <button
                onClick={() => setPopout(false)}
                className="px-6 py-2 bg-accent/20 border border-accent/40 text-accent rounded font-bold hover:bg-accent/30 transition-colors uppercase tracking-wider text-xs"
              >
                Close & Return to Trading
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
