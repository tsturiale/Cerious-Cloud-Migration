import { useState, useEffect } from 'react'
import { useStore } from '../store'

interface RubberBandData {
  asset: string
  timestamp: string
  regime: string
  z_20s: number
  z_1m: number
  z_5m: number
  asymmetry: number
  ofi: number
  ofi_zscore: number
  vol_zscore: number
  long_signal: boolean
  short_signal: boolean
  strength: number
  state: string
  didi_trend?: string
}

export function RubberBandPanel() {
  const activeAsset = useStore(s => s.activeAsset)
  const [rubberBandData, setRubberBandData] = useState<RubberBandData | null>(null)
  const [error, setError] = useState<string>('')

  useEffect(() => {
    if (!activeAsset) return

    const fetchRubberBand = async () => {
      try {
        const response = await fetch(`/api/rubber-band/${activeAsset}`)
        const data = await response.json()
        
        if (data.error) {
          setError(data.error)
          setRubberBandData(null)
        } else {
          setError('')
          setRubberBandData(data)
        }
      } catch (err) {
        setError('Failed to fetch rubber band data')
        setRubberBandData(null)
      }
    }

    fetchRubberBand()
    const interval = setInterval(fetchRubberBand, 1000) // Update every second

    return () => clearInterval(interval)
  }, [activeAsset])

  if (error) {
    return (
      <div className="h-full bg-surface-panel flex items-center justify-center">
        <div className="text-xs text-muted/70 text-center">
          <div className="mb-1">⚠ Rubber Band</div>
          <div>{error}</div>
        </div>
      </div>
    )
  }

  if (!rubberBandData) {
    return (
      <div className="h-full bg-surface-panel flex items-center justify-center">
        <div className="text-xs text-muted/50">Loading rubber band data...</div>
      </div>
    )
  }

  const getStateColor = (state: string) => {
    switch (state) {
      case 'LONG_TRAP': return 'text-green-400'
      case 'SHORT_TRAP': return 'text-red-400'
      case 'STRETCHED_LOW': return 'text-yellow-400'
      case 'STRETCHED_HIGH': return 'text-orange-400'
      default: return 'text-muted'
    }
  }

  const getStretchIntensity = (z: number) => {
    const abs = Math.abs(z)
    if (abs >= 2.0) return 'text-red-400 font-bold'
    if (abs >= 1.5) return 'text-orange-400'
    if (abs >= 1.0) return 'text-yellow-400'
    return 'text-muted'
  }

  const getOFIDirection = (ofi: number) => {
    if (ofi > 0.5) return 'text-green-400 font-semibold'
    if (ofi < -0.5) return 'text-red-400 font-semibold'
    return 'text-muted'
  }

  return (
    <div className="h-full bg-surface-panel p-2 text-xs overflow-hidden">
      {/* Header */}
      <div className="flex justify-between items-center mb-2 pb-1 border-b border-surface-border">
        <div className="text-accent font-semibold">Trapped Trader ({activeAsset})</div>
        <div className={`text-[10px] ${getStateColor(rubberBandData.state)}`}>
          {rubberBandData.state.replace('_', ' ')}
        </div>
      </div>

      {/* Multi-Timeframe Z-Scores */}
      <div className="grid grid-cols-3 gap-2 mb-2 text-center">
        <div className="bg-surface/30 rounded p-1">
          <div className="text-[9px] text-muted mb-1">20s</div>
          <div className={`text-[11px] ${getStretchIntensity(rubberBandData.z_20s)}`}>
            {rubberBandData.z_20s.toFixed(2)}
          </div>
        </div>
        <div className="bg-surface/30 rounded p-1">
          <div className="text-[9px] text-muted mb-1">1m</div>
          <div className={`text-[11px] ${getStretchIntensity(rubberBandData.z_1m)}`}>
            {rubberBandData.z_1m.toFixed(2)}
          </div>
        </div>
        <div className="bg-surface/30 rounded p-1">
          <div className="text-[9px] text-muted mb-1">5m</div>
          <div className={`text-[11px] ${getStretchIntensity(rubberBandData.z_5m)}`}>
            {rubberBandData.z_5m.toFixed(2)}
          </div>
        </div>
      </div>

      {/* Asymmetry Composite Score */}
      <div className="bg-surface/20 rounded p-2 mb-2">
        <div className="flex justify-between items-center">
          <span className="text-[9px] text-muted">Asymmetry Score</span>
          <span className={`text-[11px] font-semibold ${getStretchIntensity(rubberBandData.asymmetry)}`}>
            {rubberBandData.asymmetry.toFixed(3)}
          </span>
        </div>
        <div className="mt-1 h-1 bg-surface-border rounded overflow-hidden">
          <div 
            className={`h-full transition-all duration-300 ${
              rubberBandData.asymmetry > 0 ? 'bg-red-400' : 'bg-green-400'
            }`}
            style={{ 
              width: `${Math.min(Math.abs(rubberBandData.asymmetry) * 25, 100)}%`,
              marginLeft: rubberBandData.asymmetry > 0 ? '50%' : `${Math.max(50 - Math.abs(rubberBandData.asymmetry) * 25, 0)}%`
            }}
          />
        </div>
      </div>

      {/* OFI Confirmation */}
      <div className="grid grid-cols-2 gap-2 mb-2 text-[10px]">
        <div className="bg-surface/20 rounded p-1">
          <div className="text-muted mb-1">OFI Raw</div>
          <div className={getOFIDirection(rubberBandData.ofi)}>
            {rubberBandData.ofi.toFixed(3)}
          </div>
        </div>
        <div className="bg-surface/20 rounded p-1">
          <div className="text-muted mb-1">OFI Z-Score</div>
          <div className={getOFIDirection(rubberBandData.ofi_zscore)}>
            {rubberBandData.ofi_zscore.toFixed(2)}
          </div>
        </div>
      </div>

      {/* Signal Status */}
      {(rubberBandData.long_signal || rubberBandData.short_signal) && (
        <div className={`rounded p-2 mb-2 border animate-pulse transition-all duration-300 ${
          rubberBandData.long_signal 
            ? 'bg-green-500/20 border-green-400 shadow-[0_0_15px_rgba(74,222,128,0.6)]' 
            : 'bg-red-500/20 border-red-400 shadow-[0_0_15px_rgba(248,113,113,0.6)]'
        }`}>
          <div className="flex justify-between items-center">
            <div className={`text-[11px] font-bold tracking-wide ${
              rubberBandData.long_signal ? 'text-green-400' : 'text-red-400'
            }`}>
              ⚡ ORDERFLOW REVERSAL
            </div>
            <div className={`text-[10px] font-bold ${
              rubberBandData.long_signal ? 'text-green-300' : 'text-red-300'
            }`}>
              STR: {rubberBandData.strength.toFixed(1)}
            </div>
          </div>
          <div className="text-[9px] text-slate-300 mt-1 font-medium">
            {rubberBandData.long_signal ? 'LONG TRAP: Late sellers exhausted' : 'SHORT TRAP: Late buyers exhausted'}
          </div>
        </div>
      )}

      {/* Volume Expansion */}
      <div className="bg-surface/20 rounded p-1 text-[9px]">
        <div className="flex justify-between">
          <span className="text-muted">Vol Z-Score</span>
          <span className={`${rubberBandData.vol_zscore > 0.3 ? 'text-accent' : 'text-muted'}`}>
            {rubberBandData.vol_zscore.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Regime Context */}
      <div className="mt-1 flex items-center justify-between text-[8px] px-1">
        <span className="text-muted/50">{rubberBandData.regime} regime</span>
        {rubberBandData.didi_trend && rubberBandData.didi_trend !== 'NEUTRAL' && (
          <span className={`px-1 rounded ${
            rubberBandData.didi_trend === 'BULLISH' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
          }`}>
            HTF DIDI: {rubberBandData.didi_trend}
          </span>
        )}
      </div>
    </div>
  )
}