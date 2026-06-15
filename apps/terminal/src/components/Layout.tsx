import { useState, useEffect } from 'react'
import { Chart } from './Chart'
import { MultiChart } from './MultiChart'
import { OrderBook } from './OrderBook'
import { SignalPanel } from './SignalPanel'
import { OrderPanel } from './OrderPanel'
import { PositionMonitor } from './PositionMonitor'
import { Performance } from './Performance'
import { Analytics } from './Analytics'
import { EdgeCopyPanel } from './EdgeCopyPanel'
import { RiskBar } from './RiskBar'
import { MarketNav } from './MarketNav'
import { ProbChart } from './ProbChart'
import { PolyPriceChart } from './PolyPriceChart'
import { RubberBandPanel } from './RubberBandPanel'
import { TapeIndicator } from './TapeIndicator'
import { SettlementsPage } from './SettlementsPage'
import { PaperTrade } from './PaperTrade'
import { Settings } from './Settings'
import { TimeAndSales } from './TimeAndSales'
import { TapeChart } from './TapeChart'
import { HubPage } from './HubPage'
import { ConnectionHealth } from './ConnectionHealth'
import { GreeksEducationPanel } from './GreeksEducationPanel'
import { HealthTab } from './HealthTab'
import { AGRFlow } from './AGRFlow'
import { ResolutionPage } from './ResolutionPage'
import { RotationBanner } from './RotationCountdown'
import { MultiScreenLauncher } from './MultiScreenLauncher'
import { ExecutionPanel } from './ExecutionPanel'
import { EventTerminal } from './EventTerminal'
import { OrderBook2 } from './OrderBook2'
import { SystemPage } from './SystemPage'
import { useStore } from '../store'
import type { Asset } from '../types'
import {
  Panel,
  Group,
  Separator,
} from 'react-resizable-panels'

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'BNB', 'DOGE', 'EVENT']

type LeftTab = 'markets' | 'signals' | 'traps'
type RightTab = 'orders' | 'book' | 'book2' | 'positions' | 'execution' | 'analytics' | 'edgecopy' | 'tape' | 'flow'
type TapeSubTab = 'history' | 'chart'
type View = 'hub' | 'terminal' | 'event_terminal' | 'system' | 'journal' | 'settlements' | 'strategy' | 'paper' | 'settings' | 'health' | 'resolution'

export function Layout() {
  const activeAsset = useStore(s => s.activeAsset)
  const autoRotate = useStore(s => s.autoRotate)
  const marketProvider = useStore(s => s.marketProvider)
  const poppedTabs = useStore(s => s.poppedTabs)
  const toggleTabPop = useStore(s => s.toggleTabPop)

  const [leftTab, setLeftTab] = useState<LeftTab>('markets')
  const [rightTab, setRightTab] = useState<RightTab>('book')
  const [tapeSubTab, setTapeSubTab] = useState<TapeSubTab>('history')
  const [tapePopped, setTapePopped] = useState(false)
  const [view, setView] = useState<View>('hub')
  const [chartMode, setChartMode] = useState<'single' | '2' | '3' | '4' | '5'>('single')
  const [popPositions, setPopPositions] = useState<Record<string, { left: number; top: number }>>({})

  // Section 1 = main chart, sBottom = combined price+prob+tape block
  // s2Inner / s3Inner = inner split between price and probability charts
  const [sBottomFlex, setSBottomFlex] = useState(4.2)
  const [s2Inner, setS2Inner] = useState(1.2)
  const [s3Inner, setS3Inner] = useState(1.2)

  const onWheelBottom = (e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.2 : 0.2
    setSBottomFlex(prev => Math.max(1, Math.min(12, prev + delta)))
  }
  const onWheelInner = (e: React.WheelEvent) => {
    e.preventDefault()
    if (e.deltaY > 0) {
      // Shrink section 2, expand section 3
      setS2Inner(prev => Math.max(0.4, prev - 0.1))
      setS3Inner(prev => Math.min(4, prev + 0.1))
    } else {
      // Expand section 2, shrink section 3
      setS2Inner(prev => Math.min(4, prev + 0.1))
      setS3Inner(prev => Math.max(0.4, prev - 0.1))
    }
  }

  useEffect(() => {
    if (!autoRotate) return
    const id = setInterval(() => {
      const { activeMarketKey: key, markets, setActiveMarketKey } = useStore.getState()
      if (!key || markets.length === 0) return
      const current = markets.find(m => m.key === key)
      if (!current) return
      const sameTimeframe = markets
        .filter(m => m.timeframe === current.timeframe && m.live)
        .sort((a, b) => ASSETS.indexOf(a.asset as any) - ASSETS.indexOf(b.asset as any))
      if (sameTimeframe.length === 0) return
      const idx = sameTimeframe.findIndex(m => m.key === key)
      if (idx === -1) return
      let next
      if (idx < sameTimeframe.length - 1) {
        next = sameTimeframe[idx + 1]
      } else {
        const timeframes = ['5min', '15min', '1h', '4h']
        const tfIdx = timeframes.indexOf(current.timeframe)
        const nextTF = timeframes[(tfIdx + 1) % timeframes.length]
        const nextTFMarkets = markets
          .filter(m => m.timeframe === nextTF && m.live)
          .sort((a, b) => ASSETS.indexOf(a.asset as any) - ASSETS.indexOf(b.asset as any))
        next = nextTFMarkets[0]
      }
      if (next) setActiveMarketKey(next.key)
    }, 8000)
    return () => clearInterval(id)
  }, [autoRotate])

  const rightTabs: { id: RightTab; label: string }[] = [
    { id: 'book',      label: 'Book'   },
    { id: 'book2',     label: 'Book 2' },
    { id: 'tape',      label: 'Tape'   },
    { id: 'flow',      label: 'AGR'    },
    { id: 'orders',    label: 'Orders' },
    { id: 'positions', label: 'Pos.'   },
    { id: 'execution', label: 'Exec'   },
    { id: 'analytics', label: 'Stats'  },
    { id: 'edgecopy',  label: 'Copy'   },
  ]

  return (
    <div className="flex flex-col h-screen bg-surface text-slate-200 overflow-hidden">
      <header className="flex items-center justify-between px-3 py-1.5 bg-surface-panel border-b border-surface-border shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold text-accent tracking-widest uppercase">ArbiTek Terminal</span>
          <div className="h-4 w-px bg-surface-border" />
          <div className="flex bg-surface px-1 py-0.5 rounded border border-surface-border gap-0.5">
            {(['polymarket', 'kalshi', 'coinbase', 'hyperliquid', 'forecasttrader'] as const).map(p => (
              <button key={p} onClick={() => useStore.getState().setMarketProvider(p)} className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase transition-all ${marketProvider === p ? 'bg-accent/20 text-accent' : 'text-muted hover:text-slate-300'}`}>
                {p === 'forecasttrader' ? 'IBKR'
                  : p === 'coinbase' ? 'Coinbase'
                  : p === 'hyperliquid' ? 'Hyperliquid'
                  : p}
              </button>
            ))}
          </div>
          <div className="h-4 w-px bg-surface-border" />
          <div className="flex gap-0.5">
            {([
              { id: 'hub', label: '⬡ Hub' },
              { id: 'terminal', label: 'Crypto' },
              { id: 'event_terminal', label: 'Events' },
              { id: 'system', label: 'System' },
              { id: 'journal', label: 'Performance' },
              { id: 'settlements', label: 'History' },
              { id: 'paper', label: 'Paper' },
              { id: 'resolution', label: 'Resolution' },
              { id: 'health', label: 'Health' },
              { id: 'settings', label: '⚙' },
            ] as { id: View; label: string }[]).map(v => (
              <button
                key={v.id}
                onClick={() => setView(v.id)}
                className={`px-2.5 py-0.5 rounded font-semibold transition-colors ${v.id === 'settings' ? 'text-xl leading-none' : 'text-xs'} ${view === v.id ? 'bg-accent/20 text-accent border border-accent/40' : 'text-muted hover:text-slate-300 hover:bg-surface-hover'}`}
              >
                {v.label}
              </button>
            ))}
          </div>
          {view === 'terminal' && (
            <>
              <div className="h-3 w-px bg-surface-border" />
              <div className="flex gap-1 items-center">
                <div className="flex bg-surface px-0.5 py-0.5 rounded border border-surface-border gap-0.5">
                  {(['single', '2', '3', '4', '5'] as const).map(m => (
                    <button key={m} onClick={() => setChartMode(m)} className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all ${chartMode === m ? 'bg-accent/20 text-accent' : 'text-muted hover:text-slate-300'}`}>{m === 'single' ? '1' : m}</button>
                  ))}
                </div>
                <div className="h-3 w-px bg-surface-border mx-1" />
                <button onClick={() => useStore.getState().setAutoRotate(!autoRotate)} className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-tighter transition-all border ${autoRotate ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40' : 'bg-surface-hover text-muted border-surface-border'}`}>Rotate {autoRotate ? 'ON' : 'OFF'}</button>
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <MultiScreenLauncher />
          <div className="h-4 w-px bg-surface-border" />
          <ConnectionHealth />
          <div className="h-4 w-px bg-surface-border" />
          <RiskBar />
        </div>
      </header>

      <div className={`flex-1 min-h-0 ${view !== 'terminal' ? '' : 'hidden'}`}>
        {view === 'hub' && <HubPage onSelectProvider={(p) => { 
          useStore.getState().setMarketProvider(p); 
          if (p === 'polymarket' || p === 'kalshi' || p === 'forecasttrader') {
            setView('event_terminal');
          } else {
            setView('terminal');
          }
        }} />}
        {view === 'event_terminal' && <EventTerminal />}
        {view === 'system' && <SystemPage />}
        {view === 'journal' && <Performance />}
        {view === 'settlements' && <SettlementsPage />}
        {view === 'paper' && <PaperTrade />}
        {view === 'resolution' && <ResolutionPage />}
        {view === 'health' && <HealthTab />}
        {view === 'settings' && <Settings />}
      </div>

      <div className={`flex-1 min-h-0 ${view !== 'terminal' ? 'hidden' : ''}`}>
        <Group orientation="horizontal" className="h-full">
          <Panel defaultSize={15} minSize={5} className="border-r border-surface-border bg-surface-panel flex flex-col overflow-hidden">
            <div className="flex shrink-0 border-b border-surface-border">
              {(['markets', 'signals', 'traps'] as LeftTab[]).map(t => (
                <button key={t} onClick={() => setLeftTab(t)} className={`flex-1 py-1 text-2xs font-semibold capitalize transition-colors border-b-2 ${leftTab === t ? 'text-accent border-accent' : 'text-muted border-transparent hover:text-slate-400'}`}>{t}</button>
              ))}
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              {leftTab === 'markets' && <MarketNav />}
              {leftTab === 'signals' && <SignalPanel asset={activeAsset} />}
              {leftTab === 'traps' && <RubberBandPanel />}
            </div>
          </Panel>

          <Separator className="w-1 bg-[#0d1f3c] flex items-center justify-center cursor-col-resize"><div className="w-0.5 h-full bg-[#0d1f3c]" /></Separator>

          <Panel defaultSize={72} minSize={30}>
            <div className="flex flex-col h-full overflow-hidden">
              <RotationBanner />
              {/* Section 1 — main OHLCV chart */}
              <div className="relative overflow-hidden" style={{ flex: 7, minHeight: 180 }}>
                {chartMode === 'single' ? <Chart asset={activeAsset} /> : <MultiChart asset={activeAsset} panels={parseInt(chartMode) as 2 | 3 | 4 | 5} />}
              </div>

              {/* Divider: resize section 1 vs bottom block */}
              <div className="h-[5px] bg-[#0d1f3c] hover:bg-[#162d55] transition-colors cursor-ns-resize" onWheel={onWheelBottom} />

              {/* Bottom block: sections 2, 3 & 4 — [PolyPrice + ProbChart + RubberBand stacked] | [TapeIndicator] */}
              <div className="flex overflow-hidden" style={{ flex: sBottomFlex, minHeight: 192 }}>

                {/* Left column: PolyPriceChart (section 2 top) + ProbChart (section 3 bottom) */}
                <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
                  <div className="relative overflow-hidden" style={{ flex: s2Inner, minHeight: 96 }}>
                    <PolyPriceChart />
                  </div>
                  <div className="h-[4px] bg-[#0d1f3c] hover:bg-[#162d55] transition-colors cursor-ns-resize" onWheel={onWheelInner} />
                  <div className="relative overflow-hidden" style={{ flex: s3Inner, minHeight: 96 }}>
                    <ProbChart />
                  </div>
                </div>

                {/* Right column: Time & Sales tape spanning full height of sections 2, 3 & 4 */}
                <div className="w-[165px] shrink-0 border-l border-surface-border">
                  <TapeIndicator />
                </div>
              </div>
            </div>
          </Panel>

          <Separator className="w-1 bg-[#0d1f3c] flex items-center justify-center cursor-col-resize"><div className="w-0.5 h-full bg-[#0d1f3c]" /></Separator>

          <Panel defaultSize={13} minSize={5} className="border-l border-surface-border bg-surface-panel flex flex-col overflow-hidden relative">
            <div className="flex border-b border-surface-border shrink-0">
              {rightTabs.map(t => (
                <div key={t.id} className="flex-1 flex flex-col relative group">
                  <button onClick={() => setRightTab(t.id)} className={`w-full py-1 text-[10px] font-bold transition-colors border-b-2 ${rightTab === t.id ? 'text-accent border-accent' : 'text-muted border-transparent hover:text-slate-400'}`}>{t.label}</button>
                  <button onClick={() => toggleTabPop(t.id)} className="absolute top-0 right-0 p-0.5 text-[8px] opacity-0 group-hover:opacity-100 hover:text-accent z-10" title="Pop out">↗</button>
                </div>
              ))}
            </div>
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
              {poppedTabs.has(rightTab) ? (
                <div className="flex-1 flex items-center justify-center text-xs text-muted/50 italic bg-black/20">Tab popped out</div>
              ) : (
                <>
                  {rightTab === 'orders' && <OrderPanel asset={activeAsset} />}
                  {rightTab === 'book' && (
                    <div className="flex flex-col h-full min-h-0">
                      {/* DOM ladders — fixed 42% so it's always visible even before a market is selected */}
                      <div className="shrink-0 overflow-y-auto border-b border-surface-border" style={{ height: '42%' }}>
                        <OrderBook />
                      </div>
                      {/* Execution panel — fills remaining 58% */}
                      <div className="flex-1 min-h-0 overflow-hidden">
                        <OrderPanel asset={activeAsset} />
                      </div>
                    </div>
                  )}
                  {rightTab === 'book2' && <OrderBook2 />}
                  {rightTab === 'positions' && <PositionMonitor />}
                  {rightTab === 'execution' && <ExecutionPanel />}
                  {rightTab === 'analytics' && <Analytics />}
                  {rightTab === 'edgecopy' && <EdgeCopyPanel />}
                  {rightTab === 'flow' && <AGRFlow />}
                  {rightTab === 'tape' && (
                    <div className="flex flex-col h-full">
                      <div className="flex gap-1 bg-surface-hover border-b border-surface-border px-2 py-1.5 shrink-0">
                        <button onClick={() => setTapeSubTab('history')} className={`px-2 py-0.5 rounded text-xs font-semibold ${tapeSubTab === 'history' ? 'bg-accent/20 text-accent border border-accent/40' : 'text-muted'}`}>Time &amp; Sales</button>
                        <button onClick={() => setTapeSubTab('chart')} className={`px-2 py-0.5 rounded text-xs font-semibold ${tapeSubTab === 'chart' ? 'bg-accent/20 text-accent border border-accent/40' : 'text-muted'}`}>Tape Flow</button>
                      </div>
                      <div className="flex-1 min-h-0 overflow-hidden">
                        {tapeSubTab === 'history' && <TimeAndSales popped={false} onPopout={() => {}} onDock={() => {}} />}
                        {tapeSubTab === 'chart' && <TapeChart />}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            <GreeksEducationPanel />
          </Panel>
        </Group>

        <div className="fixed inset-0 pointer-events-none z-50">
          {Array.from(poppedTabs).map((tabId, idx) => {
            const tab = rightTabs.find(t => t.id === tabId)
            if (!tab) return null
            // Per-tab window sizes — book needs extra height for full OrderPanel
            const WIN: Record<string, [number, number]> = {
              book:      [430, 760],
              book2:     [720, 760],
              orders:    [400, 600],
              tape:      [360, 480],
              flow:      [400, 520],
              positions: [380, 440],
              execution: [420, 520],
              analytics: [380, 440],
              edgecopy:  [360, 440],
            }
            const [winW, winH] = WIN[tabId] ?? [340, 420]
            const pos = popPositions[tabId] ?? { top: 60 + (idx * 30), left: 80 + (idx * 40) }
            const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
              const startX = e.clientX
              const startY = e.clientY
              const startLeft = pos.left
              const startTop = pos.top
              e.currentTarget.setPointerCapture(e.pointerId)
              const move = (ev: PointerEvent) => {
                const left = Math.max(0, Math.min(window.innerWidth - winW, startLeft + ev.clientX - startX))
                const top = Math.max(0, Math.min(window.innerHeight - 36, startTop + ev.clientY - startY))
                setPopPositions(prev => ({ ...prev, [tabId]: { left, top } }))
              }
              const up = () => {
                window.removeEventListener('pointermove', move)
                window.removeEventListener('pointerup', up)
              }
              window.addEventListener('pointermove', move)
              window.addEventListener('pointerup', up)
            }
            return (
              <div key={tabId} className="absolute pointer-events-auto bg-surface-panel border border-accent/30 shadow-2xl rounded-lg overflow-hidden flex flex-col" style={{ width: winW, height: winH, top: pos.top, left: pos.left, zIndex: 1000 + idx }}>
                <div onPointerDown={startDrag} className="bg-surface px-3 py-1.5 border-b border-surface-border flex items-center justify-between shrink-0 cursor-move select-none">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-accent">{tab.label} (Popped)</span>
                  <button onPointerDown={e => e.stopPropagation()} onClick={() => toggleTabPop(tabId)} className="text-xs text-muted hover:text-red-400 ml-4">✕</button>
                </div>
                <div className="flex-1 min-h-0 overflow-hidden">
                  {tabId === 'orders' && <OrderPanel asset={activeAsset} />}
                  {tabId === 'book' && (
                    <div className="flex flex-col h-full min-h-0">
                      {/* Fixed 180 px for the book ladders — leaves ~547 px for OrderPanel */}
                      <div className="shrink-0 overflow-y-auto border-b border-surface-border" style={{ height: 180 }}>
                        <OrderBook />
                      </div>
                      <div className="flex-1 min-h-0 overflow-hidden">
                        <OrderPanel asset={activeAsset} />
                      </div>
                    </div>
                  )}
                  {tabId === 'book2' && <OrderBook2 />}
                  {tabId === 'positions' && <PositionMonitor />}
                  {tabId === 'analytics' && <Analytics />}
                  {tabId === 'edgecopy' && <EdgeCopyPanel />}
                  {tabId === 'flow' && <AGRFlow />}
                  {tabId === 'tape' && <TimeAndSales popped={false} onPopout={() => {}} onDock={() => toggleTabPop(tabId)} />}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {tapePopped && rightTab !== 'tape' && (
        <TimeAndSales popped={true} onPopout={() => {}} onDock={() => setTapePopped(false)} />
      )}
    </div>
  )
}
