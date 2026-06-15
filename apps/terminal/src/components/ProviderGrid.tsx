// ProviderGrid.tsx — 3 provider cards. Clicking one sets marketProvider and navigates to terminal.

import { useStore } from '../store'
import type { MarketProvider } from '../types'

interface ProviderCardProps {
  provider: MarketProvider
  name: string
  tagline: string
  accentClass: string
  borderClass: string
  marketCount: number
  topMarkets: { title: string; prob: number }[]
  onSelect: () => void
}

function ProviderCard({
  name, tagline, accentClass, borderClass, marketCount, topMarkets, onSelect,
}: ProviderCardProps) {
  return (
    <button
      onClick={onSelect}
      className={`flex-1 min-w-0 text-left bg-surface-panel border ${borderClass} rounded-lg p-4 hover:bg-surface-hover transition-all group`}
    >
      <div className={`text-xs font-bold tracking-widest uppercase mb-1 ${accentClass}`}>{name}</div>
      <div className="text-2xs text-muted mb-3">{tagline}</div>
      <div className="text-2xs text-slate-400 mb-3">
        {marketCount > 0 ? `${marketCount} open markets` : 'Connecting...'}
      </div>
      <div className="space-y-1 mb-3">
        {topMarkets.slice(0, 3).map((m, i) => (
          <div key={i} className="flex items-center justify-between">
            <span className="text-2xs text-muted truncate mr-2 max-w-[160px]">{m.title}</span>
            <span className={`text-2xs font-mono font-bold shrink-0 ${accentClass}`}>
              {Math.round(m.prob * 100)}%
            </span>
          </div>
        ))}
        {marketCount === 0 && (
          <div className="text-2xs text-muted font-mono">No data — check API key in Settings</div>
        )}
      </div>
      <div className={`text-2xs font-semibold ${accentClass} group-hover:underline`}>
        → Open Terminal
      </div>
    </button>
  )
}

interface Props {
  onSelectProvider: (p: MarketProvider) => void
}

export function ProviderGrid({ onSelectProvider }: Props) {
  const markets       = useStore(s => s.markets)
  const kalshiMarkets = useStore(s => s.kalshiMarkets)
  const ibkrMarkets   = useStore(s => s.ibkrMarkets)

  const polyTop    = markets.slice(0, 3).map(m => ({ title: `${m.asset} ${m.timeframe}`, prob: m.up_pct / 100 }))
  const kalshiTop  = kalshiMarkets.slice(0, 3).map(m => ({ title: m.title, prob: m.yes_price }))
  const ibkrTop    = ibkrMarkets.slice(0, 3).map(m => ({ title: m.title, prob: m.yes_price }))

  return (
    <div className="flex gap-4 px-4 pb-4">
      <ProviderCard
        provider="polymarket"
        name="Polymarket"
        tagline="Crypto event markets"
        accentClass="text-blue-400"
        borderClass="border-blue-500/30 hover:border-blue-500/60"
        marketCount={markets.length}
        topMarkets={polyTop}
        onSelect={() => onSelectProvider('polymarket')}
      />
      <ProviderCard
        provider="kalshi"
        name="Kalshi"
        tagline="Regulated US prediction markets"
        accentClass="text-violet-400"
        borderClass="border-violet-500/30 hover:border-violet-500/60"
        marketCount={kalshiMarkets.length}
        topMarkets={kalshiTop}
        onSelect={() => onSelectProvider('kalshi')}
      />
      <ProviderCard
        provider="forecasttrader"
        name="ForecastTrader"
        tagline="IBKR event contracts"
        accentClass="text-emerald-400"
        borderClass="border-emerald-500/30 hover:border-emerald-500/60"
        marketCount={ibkrMarkets.length}
        topMarkets={ibkrTop}
        onSelect={() => onSelectProvider('forecasttrader')}
      />
    </div>
  )
}
