/**
 * PanelWindow — renders a single terminal panel in a dedicated browser window.
 * Activated when URL contains ?panel=<type>.
 *
 * Each panel window opens its own WebSocket via AssetConnector so it gets live
 * data independently. BroadcastChannel (useBroadcastSync) keeps asset/market
 * selection in sync with the primary window.
 */
import { useState } from 'react'
import { Chart } from './Chart'
import { MultiChart } from './MultiChart'
import { OrderBook } from './OrderBook'
import { OrderPanel } from './OrderPanel'
import { TapeHistory } from './TapeHistory'
import { TapeChart } from './TapeChart'
import { AGRFlow } from './AGRFlow'
import { MarketNav } from './MarketNav'
import { ProbChart } from './ProbChart'
import { PolyPriceChart } from './PolyPriceChart'
import { TapeIndicator } from './TapeIndicator'
import { ConnectionHealth } from './ConnectionHealth'
import { useStore } from '../store'
import type { Asset } from '../types'

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'BNB', 'DOGE']

const PANEL_LABELS: Record<string, string> = {
  chart:      'OHLCV Chart',
  multichart: 'Multi-Chart (4 TF)',
  trading:    'Order Book + Execution',
  tape:       'Trade Tape',
  flow:       'AGR Flow',
  markets:    'Markets + Prob',
  probchart:  'Binary Probability',
  center:     'Chart + Poly Price',
  right:      'Order Book + Orders + AGR',
}

interface Props {
  panel: string
}

export function PanelWindow({ panel }: Props) {
  const activeAsset = useStore(s => s.activeAsset)
  const setActiveAsset = useStore(s => s.setActiveAsset)
  const activeMarketKey = useStore(s => s.activeMarketKey)
  const markets = useStore(s => s.markets)
  const connected = useStore(s => s.connected)
  const [tapeTab, setTapeTab] = useState<'history' | 'flow'>('history')

  const market = markets.find(m => m.key === activeMarketKey)
  const label = PANEL_LABELS[panel] ?? panel.toUpperCase()

  return (
    <div className="flex flex-col h-screen bg-surface text-slate-200 overflow-hidden">
      {/* ── Minimal header ──────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-3 py-1 bg-surface-panel border-b border-surface-border shrink-0 gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-bold text-accent tracking-widest uppercase whitespace-nowrap">
            ArbiTek · {label}
          </span>
          <div className="h-3 w-px bg-surface-border" />

          {/* Asset tabs */}
          <div className="flex gap-0.5">
            {ASSETS.map(a => (
              <button
                key={a}
                onClick={() => setActiveAsset(a)}
                className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-all
                  ${activeAsset === a
                    ? 'bg-accent/20 text-accent border border-accent/40'
                    : 'text-muted hover:text-slate-300 hover:bg-surface-hover'
                  }`}
              >
                {a}
              </button>
            ))}
          </div>

          {market && (
            <>
              <div className="h-3 w-px bg-surface-border" />
              <span className="text-[10px] font-mono text-slate-400 whitespace-nowrap">
                {market.asset} {market.timeframe}
                {market.up_pct != null && (
                  <span className={`ml-2 ${market.up_pct > 50 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {market.up_pct.toFixed(1)}% UP
                  </span>
                )}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]' : 'bg-red-500'}`} />
          <ConnectionHealth />
          <div className="h-3 w-px bg-surface-border" />
          <button
            onClick={() => window.close()}
            className="text-muted hover:text-red-400 text-[10px] px-2 py-0.5 rounded hover:bg-surface-hover transition-colors"
            title="Close this window"
          >
            ✕ Close
          </button>
        </div>
      </header>

      {/* ── Panel content ────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {panel === 'chart' && <Chart asset={activeAsset} />}

        {panel === 'multichart' && <MultiChart asset={activeAsset} panels={4} />}

        {panel === 'trading' && (
          <div className="flex h-full">
            <div className="w-[50%] border-r border-surface-border flex flex-col overflow-hidden">
              <div className="shrink-0 overflow-y-auto border-b border-surface-border" style={{ height: '50%' }}>
                <OrderBook />
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <OrderPanel asset={activeAsset} />
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              <AGRFlow />
            </div>
          </div>
        )}

        {panel === 'tape' && (
          <div className="flex flex-col h-full">
            <div className="flex gap-1 px-3 py-2 border-b border-surface-border bg-surface-hover shrink-0">
              <button
                onClick={() => setTapeTab('history')}
                className={`px-3 py-1 rounded text-xs font-semibold border transition-all
                  ${tapeTab === 'history' ? 'bg-accent/20 text-accent border-accent/40' : 'text-muted border-transparent hover:text-slate-300'}`}
              >
                Time &amp; Sales
              </button>
              <button
                onClick={() => setTapeTab('flow')}
                className={`px-3 py-1 rounded text-xs font-semibold border transition-all
                  ${tapeTab === 'flow' ? 'bg-accent/20 text-accent border-accent/40' : 'text-muted border-transparent hover:text-slate-300'}`}
              >
                Tape Flow
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              {tapeTab === 'history' ? <TapeHistory /> : <TapeChart />}
            </div>
          </div>
        )}

        {panel === 'flow' && <AGRFlow />}

        {panel === 'probchart' && <ProbChart />}

        {panel === 'markets' && (
          <div className="flex h-full">
            <div className="w-[260px] shrink-0 border-r border-surface-border overflow-hidden">
              <MarketNav />
            </div>
            <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
              <div className="flex-1 min-h-0 overflow-hidden">
                <ProbChart />
              </div>
              <div className="h-[160px] border-t border-surface-border shrink-0 overflow-hidden">
                <PolyPriceChart />
              </div>
            </div>
          </div>
        )}

        {/* "center" preset: main chart stack */}
        {panel === 'center' && (
          <div className="flex flex-col h-full">
            <div className="flex-1 min-h-0 overflow-hidden">
              <MultiChart asset={activeAsset} panels={4} />
            </div>
            <div className="h-[180px] shrink-0 border-t border-surface-border flex overflow-hidden">
              <div className="flex-1 min-w-0 overflow-hidden">
                <PolyPriceChart />
              </div>
              <div className="w-[140px] shrink-0 border-l border-surface-border overflow-hidden">
                <TapeIndicator />
              </div>
            </div>
          </div>
        )}

        {/* "right" preset: book + orders stacked, flow beside */}
        {panel === 'right' && (
          <div className="flex h-full">
            <div className="w-[45%] flex flex-col border-r border-surface-border overflow-hidden">
              <div className="shrink-0 overflow-y-auto border-b border-surface-border" style={{ height: '44%' }}>
                <OrderBook />
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <OrderPanel asset={activeAsset} />
              </div>
            </div>
            <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
              <div className="flex-1 min-h-0 overflow-hidden">
                <AGRFlow />
              </div>
              <div className="h-[140px] border-t border-surface-border shrink-0 overflow-hidden">
                <ProbChart />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
