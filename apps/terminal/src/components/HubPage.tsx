// HubPage.tsx — Hub landing page.
// Sections: CryptoPriceStrip | HubStats | ProviderGrid | UnifiedFeed

import { useEffect } from 'react'
import { CryptoPriceStrip, CryptoPriceGrid } from './CryptoPriceStrip'
import { HubStats } from './HubStats'
import { ProviderGrid } from './ProviderGrid'
import { UnifiedFeed } from './UnifiedFeed'
import { useStore } from '../store'
import type { MarketProvider } from '../types'

interface Props {
  onSelectProvider: (p: MarketProvider) => void
}

const HUB_SCALE = 0.67

function HubLaunchButtons({ onSelectProvider }: Props) {
  return (
    <div className="flex gap-6 px-4 py-6">
      {/* Crypto Terminal — All Spot Exchanges */}
      <button
        onClick={() => onSelectProvider('coinbase')}
        className="flex-1 group relative overflow-hidden bg-gradient-to-br from-[#071a3a] to-[#0b2b5b] border border-blue-500/40 rounded-xl p-8 transition-all hover:scale-[1.02] hover:border-blue-400 active:scale-95 shadow-[0_0_20px_rgba(37,99,235,0.22)] hover:shadow-[0_0_40px_rgba(37,99,235,0.35)]"
      >
        <div className="absolute inset-0 bg-gradient-to-tr from-blue-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
        <div className="relative z-10 flex flex-col items-center gap-2">
          <div className="text-[2.06rem] font-black text-blue-300 tracking-tighter uppercase italic group-hover:drop-shadow-[0_0_10px_rgba(147,197,253,0.85)] transition-all">
            Crypto Terminal
          </div>
          <div className="text-[0.825rem] font-bold text-blue-300/70 uppercase tracking-[0.2em]">
            Polymarket · Kalshi · Forecast Trader
          </div>
          <div className="mt-4 px-6 py-2 bg-blue-500/20 border border-blue-400/30 rounded-full text-[11px] font-black text-blue-200 uppercase tracking-widest group-hover:bg-blue-500/30 transition-all">
            Launch Spot Engine →
          </div>
        </div>
      </button>

      {/* Event Terminal — All Prediction Markets */}
      <button
        onClick={() => onSelectProvider('polymarket')}
        className="flex-1 group relative overflow-hidden bg-gradient-to-br from-[#0b2349] to-[#123974] border border-sky-300/40 rounded-xl p-8 transition-all hover:scale-[1.02] hover:border-sky-200 active:scale-95 shadow-[0_0_20px_rgba(56,189,248,0.2)] hover:shadow-[0_0_40px_rgba(56,189,248,0.32)]"
      >
        <div className="absolute inset-0 bg-gradient-to-tr from-sky-300/15 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
        <div className="relative z-10 flex flex-col items-center gap-2">
          <div className="text-[2.06rem] font-black text-sky-200 tracking-tighter uppercase italic group-hover:drop-shadow-[0_0_10px_rgba(186,230,253,0.9)] transition-all">
            Event Terminal
          </div>
          <div className="text-[0.825rem] font-bold text-sky-200/70 uppercase tracking-[0.2em]">
            Polymarket · Kalshi · IBKR
          </div>
          <div className="mt-4 px-6 py-2 bg-sky-300/20 border border-sky-200/40 rounded-full text-[11px] font-black text-sky-100 uppercase tracking-widest group-hover:bg-sky-300/30 transition-all">
            Launch Event Engine →
          </div>
        </div>
      </button>

      {/* Sports Terminal — Polymarket + Kalshi + OG/Crypto (line 3) */}
      <button
        onClick={() => onSelectProvider('polymarket')}
        className="flex-1 group relative overflow-hidden bg-gradient-to-br from-[#0a1f3f] to-[#132e5a] border border-indigo-400/40 rounded-xl p-8 transition-all hover:scale-[1.02] hover:border-indigo-300 active:scale-95 shadow-[0_0_20px_rgba(129,140,248,0.22)] hover:shadow-[0_0_40px_rgba(129,140,248,0.35)]"
      >
        <div className="absolute inset-0 bg-gradient-to-tr from-indigo-400/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
        <div className="relative z-10 flex flex-col items-center gap-2">
          <div className="text-[2.06rem] font-black text-indigo-200 tracking-tighter uppercase italic group-hover:drop-shadow-[0_0_10px_rgba(165,180,252,0.85)] transition-all">
            Sports Terminal
          </div>
          <div className="text-[0.825rem] font-bold text-indigo-200/70 uppercase tracking-[0.2em]">
            Polymarket · Kalshi · OG/Crypto
          </div>
          <div className="mt-4 px-6 py-2 bg-indigo-400/20 border border-indigo-300/30 rounded-full text-[11px] font-black text-indigo-100 uppercase tracking-widest group-hover:bg-indigo-400/30 transition-all">
            Launch Sports Engine →
          </div>
        </div>
      </button>
    </div>
  )
}

import { EducationalWiki } from './EducationalWiki'

export function HubPage({ onSelectProvider }: Props) {
  const setKalshiMarkets = useStore(s => s.setKalshiMarkets)
  const setIbkrMarkets   = useStore(s => s.setIbkrMarkets)

  // Fetch Kalshi markets on mount
  useEffect(() => {
    const fetchKalshi = async () => {
      try {
        const kalshiKey = localStorage.getItem('kalshi_api_key') ?? ''
        const r = await fetch('/api/kalshi/markets', {
          headers: kalshiKey ? { 'X-Kalshi-Key': kalshiKey } : {},
        })
        if (r.ok) setKalshiMarkets(await r.json())
      } catch { /* silently ignore */ }
    }
    fetchKalshi()
  }, [setKalshiMarkets])

  // Fetch IBKR markets on mount
  useEffect(() => {
    const fetchIbkr = async () => {
      try {
        const ibkrKey     = localStorage.getItem('ibkr_api_key') ?? ''
        const ibkrAccount = localStorage.getItem('ibkr_account_id') ?? ''
        const headers: Record<string, string> = {}
        if (ibkrKey)     headers['X-Ibkr-Key']     = ibkrKey
        if (ibkrAccount) headers['X-Ibkr-Account'] = ibkrAccount
        const r = await fetch('/api/ibkr/markets', { headers })
        if (r.ok) setIbkrMarkets(await r.json())
      } catch { /* silently ignore */ }
    }
    fetchIbkr()
  }, [setIbkrMarkets])

  return (
    <div className="flex flex-col h-full bg-surface overflow-hidden">
      <CryptoPriceStrip />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div
          style={{
            transform: `scale(${HUB_SCALE})`,
            transformOrigin: 'top left',
            width: `${100 / HUB_SCALE}%`,
          }}
        >
          <HubLaunchButtons onSelectProvider={onSelectProvider} />
          <HubStats />
          <CryptoPriceGrid />
          <ProviderGrid onSelectProvider={onSelectProvider} />
          <EducationalWiki />
          <UnifiedFeed />
        </div>
      </div>
    </div>
  )
}
