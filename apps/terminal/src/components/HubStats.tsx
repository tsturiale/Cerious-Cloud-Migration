// HubStats.tsx — 4 summary stat cards reading from the existing store.

import { useStore } from '../store'

function StatCard({ label, value, sub, subColor = 'text-emerald-400' }: {
  label: string
  value: string
  sub?: string
  subColor?: string
}) {
  return (
    <div className="flex-1 bg-surface-panel border border-surface-border rounded p-3 min-w-0">
      <div className="text-2xs text-muted uppercase tracking-wider mb-1">{label}</div>
      <div className="text-sm font-mono font-bold text-slate-200">{value}</div>
      {sub && <div className={`text-2xs font-mono mt-0.5 ${subColor}`}>{sub}</div>}
    </div>
  )
}

export function HubStats() {
  const markets       = useStore(s => s.markets)
  const kalshiMarkets = useStore(s => s.kalshiMarkets)
  const ibkrMarkets   = useStore(s => s.ibkrMarkets)
  const positions     = useStore(s => s.positions)
  const metrics       = useStore(s => s.metrics)
  const signals       = useStore(s => s.signals)

  const totalMarkets = markets.length + kalshiMarkets.length + ibkrMarkets.length

  const activeSignals = Object.values(signals).reduce((acc, arr) => acc + arr.length, 0)
  const strongSignals = Object.values(signals).reduce(
    (acc, arr) => acc + arr.filter(s => s.strength >= 2).length, 0
  )

  const todayPnl  = metrics?.net_pnl ?? 0
  const pnlColor  = todayPnl >= 0 ? 'text-emerald-400' : 'text-red-400'
  const winRate   = metrics ? Math.round(metrics.win_rate * 100) : 0

  return (
    <div className="flex gap-3 px-4 py-3">
      <StatCard
        label="Total Markets"
        value={String(totalMarkets)}
        sub={`Poly: ${markets.length} · Kalshi: ${kalshiMarkets.length} · IBKR: ${ibkrMarkets.length}`}
        subColor="text-muted"
      />
      <StatCard
        label="Active Signals"
        value={String(activeSignals)}
        sub={`Strong: ${strongSignals}`}
      />
      <StatCard
        label="Open Positions"
        value={String(positions.length)}
        sub={positions.length > 0 ? `${positions.length} active` : 'None open'}
        subColor={positions.length > 0 ? 'text-amber-400' : 'text-muted'}
      />
      <StatCard
        label="Today P&L"
        value={todayPnl >= 0 ? `+$${todayPnl.toFixed(2)}` : `-$${Math.abs(todayPnl).toFixed(2)}`}
        sub={`Win rate: ${winRate}%`}
        subColor={pnlColor}
      />
    </div>
  )
}
