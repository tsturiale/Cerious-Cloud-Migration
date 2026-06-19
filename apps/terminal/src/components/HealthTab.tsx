import { useEffect, useState } from 'react'

interface HealthData {
  status: string
  live_data: boolean
  connections: number
  clob_ws: {
    connected: boolean
    last_msg_age_s: number | null
    subscribed_tokens: number
  }
  kraken_ws: {
    last_msg_age_s: number | null
  }
  rtds_ws: {
    connected: boolean
    last_msg_age_s: number | null
    last_prices: Record<string, unknown>
  }
  chainlink_ws: {
    connected: boolean
    last_msg_age_s: number | null
    assets: number
  }
  dome_ws: {
    connected: boolean
    active_subs: number
    subscribed_markets: string[]
  }
  discovery: {
    last_run_age_s: number | null
  }
  markets: {
    active_live: number
    active_non_live: number
    staged_live: number
  }
  settlements: number
}

export function HealthTab() {
  const [health, setHealth] = useState<HealthData | null>(null)
  const [lastUpdate, setLastUpdate] = useState<number>(0)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const r = await fetch('/api/health')
        if (!r.ok || cancelled) return
        const data = await r.json()
        if (cancelled) return
        setHealth(data)
        setLastUpdate(Date.now())
      } catch { }
    }
    poll()
    const t = setInterval(poll, 2000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const formatAge = (s: number | null): string => {
    if (s === null) return '—'
    if (s < 60) return `${Math.round(s)}s`
    const m = Math.floor(s / 60)
    return `${m}m ${Math.round(s % 60)}s`
  }

  const statusColor = (s: string): string => {
    if (s.includes('stale') || s === 'no_live_data') return 'text-warn'
    if (s === 'ok') return 'text-up'
    return 'text-muted'
  }

  const freshColor = (age_s: number | null, threshold: number): string => {
    if (age_s === null) return 'text-muted'
    if (age_s > threshold) return 'text-warn'
    return 'text-up'
  }

  const connectedBadge = (connected: boolean) => (
    <span className={connected ? 'text-up' : 'text-down'}>
      {connected ? '● Connected' : '● Disconnected'}
    </span>
  )

  if (!health) {
    return (
      <div className="flex items-center justify-center h-full text-muted">
        Loading health data...
      </div>
    )
  }

  const rtds = health.rtds_ws ?? { connected: false, last_msg_age_s: null, last_prices: {} }
  const dome = health.dome_ws ?? { connected: false, active_subs: 0, subscribed_markets: [] }

  return (
    <div className="flex flex-col h-full overflow-auto p-4 gap-4 text-xs font-mono">
      {/* Overall Status */}
      <div className="space-y-1">
        <div className="font-semibold text-slate-300">System Status</div>
        <div className="flex items-center gap-4 pl-2">
          <div className={`font-bold uppercase ${statusColor(health.status)}`}>
            {health.status.replace('_', ' ')}
          </div>
          <span className="text-muted">Live: {health.live_data ? 'Yes' : 'No'}</span>
          <span className="text-muted">Clients: {health.connections}</span>
        </div>
      </div>

      {/* Polymarket CLOB */}
      <div className="border-t border-surface-border pt-2 space-y-1">
        <div className="font-semibold text-slate-300">Polymarket CLOB</div>
        <div className="pl-2 space-y-0.5">
          <div className="flex justify-between">
            <span className="text-muted">Status:</span>
            {connectedBadge(health.clob_ws.connected)}
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Last Update:</span>
            <span className={freshColor(health.clob_ws.last_msg_age_s, 60)}>
              {formatAge(health.clob_ws.last_msg_age_s)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Subscribed:</span>
            <span className="text-slate-200">{health.clob_ws.subscribed_tokens} tokens</span>
          </div>
        </div>
      </div>

      {/* Dome WS */}
      <div className="border-t border-surface-border pt-2 space-y-1">
        <div className="font-semibold text-slate-300">Dome WS (Order Flow)</div>
        <div className="pl-2 space-y-0.5">
          <div className="flex justify-between">
            <span className="text-muted">Status:</span>
            {connectedBadge(dome.connected)}
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Active Subs:</span>
            <span className="text-slate-200">{dome.active_subs}</span>
          </div>
          {dome.subscribed_markets.length > 0 && (
            <div className="flex justify-between">
              <span className="text-muted">Markets:</span>
              <span className="text-slate-400 text-2xs">{dome.subscribed_markets.join(', ')}</span>
            </div>
          )}
        </div>
      </div>

      {/* Polymarket RTDS */}
      <div className="border-t border-surface-border pt-2 space-y-1">
        <div className="font-semibold text-slate-300">Polymarket RTDS</div>
        <div className="pl-2 space-y-0.5">
          <div className="flex justify-between">
            <span className="text-muted">Status:</span>
            {connectedBadge(rtds.connected)}
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Last Update:</span>
            <span className={freshColor(rtds.last_msg_age_s, 30)}>
              {formatAge(rtds.last_msg_age_s)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Price Feeds:</span>
            <span className="text-slate-200">{Object.keys(rtds.last_prices ?? {}).length}</span>
          </div>
        </div>
      </div>

      {/* Spot Market */}
      <div className="border-t border-surface-border pt-2 space-y-1">
        <div className="font-semibold text-slate-300">Spot Market</div>
        <div className="pl-2 space-y-0.5">
          <div className="flex justify-between">
            <span className="text-muted">Last Update:</span>
            <span className={freshColor(health.kraken_ws.last_msg_age_s, 30)}>
              {formatAge(health.kraken_ws.last_msg_age_s)}
            </span>
          </div>
        </div>
      </div>

      {/* Chainlink Data Streams */}
      <div className="border-t border-surface-border pt-2 space-y-1">
        <div className="font-semibold text-slate-300">Chainlink Data Streams</div>
        <div className="pl-2 space-y-0.5">
          <div className="flex justify-between">
            <span className="text-muted">Status:</span>
            {connectedBadge(health.chainlink_ws.connected)}
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Last Update:</span>
            <span className={freshColor(health.chainlink_ws.last_msg_age_s, 5)}>
              {formatAge(health.chainlink_ws.last_msg_age_s)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Assets Tracked:</span>
            <span className="text-slate-200">{health.chainlink_ws.assets}</span>
          </div>
          {!health.chainlink_ws.connected && (
            <div className="text-2xs text-muted/60 pt-0.5">
              Awaiting account feed provisioning from Chainlink
            </div>
          )}
        </div>
      </div>

      {/* Market Discovery */}
      <div className="border-t border-surface-border pt-2 space-y-1">
        <div className="font-semibold text-slate-300">Market Discovery</div>
        <div className="pl-2 space-y-0.5">
          <div className="flex justify-between">
            <span className="text-muted">Last Scan:</span>
            <span className={freshColor(health.discovery.last_run_age_s, 15)}>
              {formatAge(health.discovery.last_run_age_s)}
            </span>
          </div>
        </div>
      </div>

      {/* Markets Summary */}
      <div className="border-t border-surface-border pt-2 space-y-1">
        <div className="font-semibold text-slate-300">Markets</div>
        <div className="pl-2 space-y-0.5">
          <div className="flex justify-between">
            <span className="text-muted">Live Active:</span>
            <span className="text-up font-bold">{health.markets.active_live}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Non-live:</span>
            <span className="text-slate-200">{health.markets.active_non_live}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Staged (Live):</span>
            <span className="text-slate-200">{health.markets.staged_live}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Settlements Logged:</span>
            <span className="text-slate-200">{health.settlements}</span>
          </div>
        </div>
      </div>

      {/* Last Update Timestamp */}
      <div className="border-t border-surface-border pt-2">
        <div className="text-2xs text-muted/50">
          Last update: {lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : '—'}
        </div>
      </div>
    </div>
  )
}
