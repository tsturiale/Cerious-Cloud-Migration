// CryptoPriceStrip.tsx — Live Kraken spot prices for all tracked assets.
// Polls /api/crypto/prices every 10s.
// Renders a top ticker strip + a full price grid on the Hub.

import { useEffect } from 'react'
import { useStore } from '../store'

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'BNB', 'DOGE']

function fmtPrice(p: number): string {
  if (p >= 1000) return `$${p.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  if (p >= 1)    return `$${p.toFixed(4)}`
  return `$${p.toFixed(5)}`
}

// ── Top ticker strip (always visible) ────────────────────────────────────────
export function CryptoPriceStrip() {
  const cryptoPrices    = useStore(s => s.cryptoPrices)
  const setCryptoPrices = useStore(s => s.setCryptoPrices)

  useEffect(() => {
    let cancelled = false
    const fetchPrices = async () => {
      try {
        const r = await fetch('/api/crypto/prices')
        if (!r.ok || cancelled) return
        const data = await r.json()
        if (!cancelled) setCryptoPrices(data)
      } catch { /* silently ignore */ }
    }
    fetchPrices()
    const t = setInterval(fetchPrices, 10_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [setCryptoPrices])

  return (
    <div className="flex items-center gap-1 overflow-x-auto scrollbar-none px-3 py-1.5 bg-surface-panel border-b border-surface-border shrink-0">
      <span className="text-2xs font-bold text-accent tracking-widest uppercase mr-2 shrink-0">
        LIVE
      </span>
      {ASSETS.map(asset => {
        const p  = cryptoPrices[asset]
        const up = p && p.change24h >= 0
        return (
          <div
            key={asset}
            className="flex items-center gap-1.5 bg-surface border border-surface-border rounded px-2 py-0.5 shrink-0"
          >
            <span className="text-2xs font-mono font-bold text-amber-400">{asset}</span>
            <span className="text-2xs font-mono text-slate-200">
              {p ? fmtPrice(p.price) : '—'}
            </span>
            {p && (
              <span className={`text-2xs font-mono font-semibold ${up ? 'text-emerald-400' : 'text-red-400'}`}>
                {up ? '+' : ''}{p.change24h.toFixed(2)}%
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Full price grid (used on Hub page) ────────────────────────────────────────
export function CryptoPriceGrid() {
  const cryptoPrices = useStore(s => s.cryptoPrices)

  return (
    <div className="px-4 pb-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-2xs font-bold text-accent tracking-widest uppercase">
          Crypto Prices
        </span>
        <span className="text-2xs text-muted/50">Kraken · updates every 10s</span>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {ASSETS.map(asset => {
          const p  = cryptoPrices[asset]
          const up = p ? p.change24h >= 0 : null

          return (
            <div
              key={asset}
              className="bg-surface-panel border border-surface-border rounded p-2.5 flex flex-col gap-0.5"
            >
              {/* Header row */}
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-amber-400 font-mono">{asset}</span>
                {p && (
                  <span
                    className={`text-2xs font-mono font-semibold px-1 py-0.5 rounded ${
                      up
                        ? 'bg-emerald-400/10 text-emerald-400'
                        : 'bg-red-400/10 text-red-400'
                    }`}
                  >
                    {up ? '+' : ''}{p.change24h.toFixed(2)}%
                  </span>
                )}
              </div>

              {/* Price */}
              <div className="text-sm font-mono font-bold text-slate-100">
                {p ? fmtPrice(p.price) : <span className="text-muted/40">—</span>}
              </div>

              {/* 24h change bar */}
              {p && (
                <div className="mt-1 h-0.5 w-full rounded-full bg-surface-border overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${up ? 'bg-emerald-400' : 'bg-red-400'}`}
                    style={{
                      width: `${Math.min(Math.abs(p.change24h) * 8, 100)}%`,
                      marginLeft: up ? '50%' : undefined,
                      marginRight: up ? undefined : `${50 - Math.min(Math.abs(p.change24h) * 8, 50)}%`,
                      transform: up ? undefined : 'translateX(-100%)',
                    }}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
