import toast from 'react-hot-toast'
import { useStore } from '../store'
import type { ExecutionPosition, ExecutionRisk } from '../types'

const API = '/api'

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_CLASS: Record<string, string> = {
  PENDING:       'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  OPEN:          'bg-up/15 text-up border-up/30',
  STOPPED_OUT:   'bg-down/15 text-down border-down/30',
  TAKEN_PROFIT:  'bg-accent/15 text-accent border-accent/30',
  EXPIRED:       'bg-muted/15 text-muted border-muted/30',
  CANCELLED:     'bg-muted/15 text-muted border-muted/30',
  EMERGENCY:     'bg-red-500/15 text-red-400 border-red-500/30',
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`tag text-2xs border ${STATUS_CLASS[status] ?? 'bg-muted/15 text-muted border-muted/30'}`}>
      {status.replace('_', ' ')}
    </span>
  )
}

// ── Individual position row ───────────────────────────────────────────────────

function ExecutionRow({ pos, onClose }: { pos: ExecutionPosition; onClose: (id: string) => void }) {
  const pnlPos = pos.unrealized_pnl >= 0
  const slPct  = pos.sl_distance_pct   ?? null
  const tpPct  = pos.tp_distance_pct   ?? null

  // Colour the SL distance: near SL = danger
  const slClass = slPct === null ? 'text-muted'
    : slPct < 3 ? 'text-down font-bold'
    : slPct < 8 ? 'text-warn'
    : 'text-slate-300'

  // Colour the TP distance: near TP = good
  const tpClass = tpPct === null ? 'text-muted'
    : tpPct < 3 ? 'text-up font-bold'
    : tpPct < 8 ? 'text-accent'
    : 'text-slate-300'

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-border/40 hover:bg-surface-hover transition-colors text-xs">
      {/* Asset + direction */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="text-xs font-semibold text-slate-200">{pos.asset}</span>
          <span className={`tag text-2xs ${pos.direction === 'UP' ? 'tag-up' : 'tag-down'}`}>
            {pos.direction}
          </span>
          <StatusBadge status={pos.status} />
        </div>
        <div className="flex gap-3 font-mono text-2xs text-muted">
          <span>entry <span className="text-slate-400">{pos.entry_price.toFixed(2)}¢</span></span>
          <span>now <span className="text-slate-400">{pos.current_price.toFixed(2)}¢</span></span>
          <span>${pos.size.toFixed(0)}</span>
          {pos.model && <span className="text-accent">{pos.model}</span>}
        </div>
      </div>

      {/* SL / TP distances */}
      <div className="flex flex-col items-end gap-0.5 min-w-[70px]">
        <div className="flex items-baseline gap-1">
          <span className="label text-2xs">SL</span>
          <span className={`font-mono text-2xs ${slClass}`}>
            {slPct !== null ? `${slPct.toFixed(1)}%` : '—'}
          </span>
        </div>
        <div className="flex items-baseline gap-1">
          <span className="label text-2xs">TP</span>
          <span className={`font-mono text-2xs ${tpClass}`}>
            {tpPct !== null ? `${tpPct.toFixed(1)}%` : '—'}
          </span>
        </div>
      </div>

      {/* Unrealised P&L */}
      <div className="w-16 text-right">
        <div className={`font-mono text-xs font-semibold ${pnlPos ? 'text-up' : 'text-down'}`}>
          {pnlPos ? '+' : ''}{pos.unrealized_pnl.toFixed(2)}
        </div>
        <div className={`font-mono text-2xs ${pnlPos ? 'text-up/70' : 'text-down/70'}`}>
          {pos.pnl_pct !== null ? `${pnlPos ? '+' : ''}${pos.pnl_pct.toFixed(2)}%` : ''}
        </div>
      </div>

      {/* Close button */}
      {pos.status === 'OPEN' || pos.status === 'PENDING' ? (
        <button
          onClick={() => onClose(pos.position_id)}
          className="btn btn-danger py-0.5 px-1.5 text-2xs ml-1"
        >
          ✕
        </button>
      ) : (
        <div className="w-8" />
      )}
    </div>
  )
}

// ── Risk dashboard row ────────────────────────────────────────────────────────

function RiskDashboard({ risk }: { risk: ExecutionRisk }) {
  const dailyPos = risk.daily_pnl >= 0

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2 bg-surface-panel border-b border-surface-border">
      {/* Daily P&L */}
      <RiskStat
        label="Day P&L"
        value={`${dailyPos ? '+' : ''}$${risk.daily_pnl.toFixed(2)}`}
        className={dailyPos ? 'text-up' : 'text-down'}
      />

      <div className="w-px h-5 bg-surface-border" />

      {/* Open positions */}
      <RiskStat
        label="Open"
        value={`${risk.open_count}`}
        className={risk.open_count >= 3 ? 'text-warn' : 'text-slate-200'}
      />

      {/* Exposure */}
      <RiskStat
        label="UP exp"
        value={`$${risk.up_exposure.toFixed(0)}`}
        className="text-up"
      />
      <RiskStat
        label="DN exp"
        value={`$${risk.dn_exposure.toFixed(0)}`}
        className="text-down"
      />
      <RiskStat
        label="Total"
        value={`$${risk.total_exposure.toFixed(0)}`}
        className="text-slate-200"
      />

      <div className="w-px h-5 bg-surface-border" />

      {/* Regime sizing */}
      <RiskStat
        label="Regime"
        value={`${risk.regime_mult.toFixed(1)}×`}
        className={risk.regime_mult < 0.6 ? 'text-warn' : 'text-slate-200'}
      />

      {/* SL distance bar (nearest SL) */}
      {risk.near_sl_distance_pct !== null && (
        <>
          <div className="flex items-center gap-2">
            <span className="label text-2xs">Nearest SL</span>
            <div className="w-20 h-1.5 bg-surface-border rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  risk.near_sl_distance_pct < 3 ? 'bg-down' :
                  risk.near_sl_distance_pct < 8 ? 'bg-warn' : 'bg-up'
                }`}
                style={{ width: `${Math.min(100, risk.near_sl_distance_pct * 5)}%` }}
              />
            </div>
            <span className={`font-mono text-2xs ${
              risk.near_sl_distance_pct < 3 ? 'text-down font-bold' :
              risk.near_sl_distance_pct < 8 ? 'text-warn' : 'text-slate-300'
            }`}>
              {risk.near_sl_distance_pct.toFixed(1)}%
            </span>
          </div>
        </>
      )}

      {/* Emergency close */}
      <button
        onClick={async () => {
          await fetch(`${API}/execution/emergency-close`, { method: 'POST' })
          toast('⚠️ All positions emergency closed', {
            style: { background: '#1a0a0a', color: '#f87171', border: '1px solid #7f1d1d' },
          })
        }}
        className="btn btn-danger py-0.5 px-2 text-2xs ml-auto"
      >
        ⚠️ EMERGENCY CLOSE ALL
      </button>
    </div>
  )
}

function RiskStat({ label, value, className }: { label: string; value: string; className: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="label text-2xs">{label}</span>
      <span className={`font-mono text-xs font-semibold ${className}`}>{value}</span>
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function ExecutionPanel() {
  const executionPositions = useStore(s => s.executionPositions)
  const executionRisk      = useStore(s => s.executionRisk)

  async function closePosition(id: string) {
    const res = await fetch(`${API}/execution/${id}`, { method: 'DELETE' })
    if (!res.ok) toast.error('Close failed')
    else toast('Position closed', { style: { background: '#0f1629', color: '#e2e8f0', border: '1px solid #1e2d4e' } })
  }

  const openPositions = executionPositions.filter(p => p.status === 'OPEN' || p.status === 'PENDING')
  const closedPositions = executionPositions.filter(p => p.status !== 'OPEN' && p.status !== 'PENDING')
  const totalPnl = executionPositions.reduce((s, p) => s + p.unrealized_pnl, 0)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="panel-header">
        <span className="text-xs font-semibold text-slate-300">Execution Agent</span>
        <div className="flex items-center gap-2">
          <span className="label">{openPositions.length} open</span>
          <span className={`text-xs font-mono font-semibold ${totalPnl >= 0 ? 'text-up' : 'text-down'}`}>
            {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Risk dashboard */}
      {executionRisk && <RiskDashboard risk={executionRisk} />}

      {/* Open positions */}
      {openPositions.length === 0 && !executionRisk ? (
        <div className="flex-1 flex items-center justify-center text-muted text-xs font-mono">
          Waiting for positions...
        </div>
      ) : openPositions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-muted text-xs font-mono">
          No open positions
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {openPositions.map(p => (
            <ExecutionRow key={p.position_id} pos={p} onClose={closePosition} />
          ))}
        </div>
      )}

      {/* Closed / historical positions (last 5) */}
      {closedPositions.length > 0 && (
        <div className="border-t border-surface-border">
          <div className="px-3 py-1 bg-surface-panel">
            <span className="label text-2xs">Closed ({closedPositions.length})</span>
          </div>
          <div className="max-h-40 overflow-y-auto">
            {closedPositions.slice(0, 5).map(p => (
              <ExecutionRow key={p.position_id} pos={p} onClose={closePosition} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
