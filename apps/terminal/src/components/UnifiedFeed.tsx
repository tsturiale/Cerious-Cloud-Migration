// UnifiedFeed.tsx — Flat cross-provider market list sorted by volume.

import { useMemo } from 'react'
import { useStore } from '../store'
import type { MarketProvider } from '../types'

interface FeedItem {
  id: string
  title: string
  prob: number        // 0–1
  volume: number
  provider: MarketProvider
}

const PROVIDER_DOT: Record<MarketProvider, string> = {
  cme:            'bg-cyan-400',
  polymarket:     'bg-blue-400',
  kalshi:         'bg-violet-400',
  forecasttrader: 'bg-emerald-400',
  hyperliquid:    'bg-fuchsia-400',
  coingecko:      'bg-lime-400',
}

const PROVIDER_LABEL: Record<MarketProvider, string> = {
  cme:            'CME',
  polymarket:     'Poly',
  kalshi:         'Kalshi',
  forecasttrader: 'IBKR',
  hyperliquid:    'Hyperliquid',
  coingecko:      'CoinGecko',
}

function formatVolume(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}

export function UnifiedFeed() {
  const markets       = useStore(s => s.markets)
  const kalshiMarkets = useStore(s => s.kalshiMarkets)
  const ibkrMarkets   = useStore(s => s.ibkrMarkets)

  const items = useMemo<FeedItem[]>(() => {
    const poly: FeedItem[] = markets.map(m => ({
      id: m.key, title: `${m.asset} ${m.timeframe}`, prob: m.up_pct / 100,
      volume: m.volume, provider: 'cme',
    }))
    const kalshi: FeedItem[] = kalshiMarkets.map(m => ({
      id: m.id, title: m.title, prob: m.yes_price,
      volume: m.volume, provider: 'kalshi',
    }))
    const ibkr: FeedItem[] = ibkrMarkets.map(m => ({
      id: m.conid, title: m.title, prob: m.yes_price,
      volume: m.volume, provider: 'forecasttrader',
    }))
    return [...poly, ...kalshi, ...ibkr].sort((a, b) => b.volume - a.volume).slice(0, 40)
  }, [markets, kalshiMarkets, ibkrMarkets])

  if (items.length === 0) {
    return (
      <div className="flex-1 px-4 py-6 text-center text-2xs text-muted font-mono">
        No markets loaded — start the backend and configure API keys in Settings
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-4">
      <div className="text-2xs font-semibold text-muted uppercase tracking-wider mb-2">
        Top Markets by Volume
      </div>
      <div className="space-y-1">
        {items.map(item => {
          const pct = Math.round(item.prob * 100)
          return (
            <div
              key={`${item.provider}-${item.id}`}
              className="flex items-center gap-3 bg-surface-panel border border-surface-border rounded px-3 py-2 hover:border-surface-border/80 transition-colors"
            >
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${PROVIDER_DOT[item.provider]}`} />
              <span className="text-2xs text-muted shrink-0 w-10">{PROVIDER_LABEL[item.provider]}</span>
              <span className="flex-1 text-2xs text-slate-300 truncate">{item.title}</span>
              <div className="flex items-center gap-2 shrink-0">
                <div className="w-20 h-1.5 bg-surface rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent/60 rounded-full transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-2xs font-mono font-bold text-accent w-8 text-right">{pct}%</span>
                <span className="text-2xs font-mono text-muted w-12 text-right">{formatVolume(item.volume)}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
