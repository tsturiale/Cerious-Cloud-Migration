import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

interface HealthData {
  clob_connected: boolean
  clob_age_s: number | null
  gamma_ok: boolean
  gamma_age_s: number | null
}

interface ClobAutoReconnectSettings {
  clobAutoReconnect: boolean
  clobStaleThreshold: number
  clobReconnectCd: number
}

const SETTINGS_KEY = 'pt_settings_v1'
const CLOB_AUTORECONNECT_DEFAULTS: ClobAutoReconnectSettings = {
  clobAutoReconnect: true,
  clobStaleThreshold: 20,
  clobReconnectCd: 45,
}

function loadClobAutoReconnectSettings(): ClobAutoReconnectSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return CLOB_AUTORECONNECT_DEFAULTS
    const parsed = JSON.parse(raw)
    return {
      clobAutoReconnect: parsed.clobAutoReconnect ?? CLOB_AUTORECONNECT_DEFAULTS.clobAutoReconnect,
      clobStaleThreshold: parsed.clobStaleThreshold ?? CLOB_AUTORECONNECT_DEFAULTS.clobStaleThreshold,
      clobReconnectCd: parsed.clobReconnectCd ?? CLOB_AUTORECONNECT_DEFAULTS.clobReconnectCd,
    }
  } catch {
    return CLOB_AUTORECONNECT_DEFAULTS
  }
}

function useHealthPoll(): HealthData {
  const [h, setH] = useState<HealthData>({
    clob_connected: false, clob_age_s: null,
    gamma_ok: false, gamma_age_s: null,
  })

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const r = await fetch('/api/health')
        if (!r.ok || cancelled) return
        const d = await r.json()
        if (cancelled) return
        const discoveryAge = d.discovery?.last_run_age_s ?? 9999
        setH({
          clob_connected: d.clob_ws?.connected ?? false,
          clob_age_s: d.clob_ws?.last_msg_age_s ?? null,
          gamma_ok: d.live_data === true && discoveryAge < 60,
          gamma_age_s: discoveryAge < 9999 ? discoveryAge : null,
        })
      } catch { /* ignore */ }
    }
    poll()
    const t = setInterval(poll, 8_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  return h
}

async function triggerClobReconnect() {
  try {
    await fetch('/api/clob/reconnect', { method: 'POST' })
  } catch { /* ignore */ }
}

export function ConnectionHealth() {
  const connected = useStore((s) => s.connected)
  const h = useHealthPoll()
  const lastAutoReconnectMsRef = useRef(0)

  const clobOk = h.clob_connected && (h.clob_age_s === null || h.clob_age_s < 60)
  const clobStale = h.clob_connected && h.clob_age_s !== null && h.clob_age_s >= 60
  const gammaOk = h.gamma_ok
  const clobFreshness =
    h.clob_age_s == null ? 'unknown'
    : h.clob_age_s < 12 ? 'fresh'
    : h.clob_age_s < 30 ? 'aging'
    : 'stale'

  useEffect(() => {
    const cfg = loadClobAutoReconnectSettings()
    if (!cfg.clobAutoReconnect) return
    if (h.clob_age_s == null) return
    if (h.clob_age_s < cfg.clobStaleThreshold) return

    const nowMs = Date.now()
    const cooldownMs = Math.max(5, cfg.clobReconnectCd) * 1000
    if (nowMs - lastAutoReconnectMsRef.current < cooldownMs) return

    lastAutoReconnectMsRef.current = nowMs
    triggerClobReconnect()
  }, [h.clob_age_s])

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5">
        <span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-500 animate-pulse'}`} />
        <span className="text-2xs font-mono text-muted">{connected ? 'LIVE' : 'DISCONNECTED'}</span>
      </div>

      <div
        className="flex items-center gap-1"
        title={`Gamma API ${gammaOk ? 'healthy' : 'down'}${h.gamma_age_s != null ? ` · ${Math.round(h.gamma_age_s)}s ago` : ''}`}
      >
        <span className={`h-2 w-2 rounded-full ${gammaOk ? 'bg-cyan-400' : 'bg-red-500 animate-pulse'}`} />
        <span className={`text-2xs font-mono ${gammaOk ? 'text-muted' : 'text-red-400'}`}>Gamma</span>
      </div>

      <div
        className={`flex items-center gap-1 ${clobStale ? 'cursor-pointer' : ''}`}
        title={
          clobOk ? `CLOB WS live · ${Math.round(h.clob_age_s ?? 0)}s ago`
          : clobStale ? `CLOB stale (${Math.round(h.clob_age_s ?? 0)}s) — click to reconnect`
          : 'CLOB WS disconnected'
        }
        onClick={clobStale ? triggerClobReconnect : undefined}
      >
        <span className={`h-2 w-2 rounded-full ${clobOk ? 'bg-emerald-400' : clobStale ? 'bg-yellow-400 animate-pulse' : 'bg-red-500 animate-pulse'}`} />
        <span className={`text-2xs font-mono ${clobOk ? 'text-muted' : clobStale ? 'text-yellow-400' : 'text-red-400'}`}>
          CLOB{clobStale ? ' ↺' : ''}
        </span>
      </div>

      <div
        className="flex items-center gap-1"
        title={h.clob_age_s != null ? `Book age ${Math.round(h.clob_age_s)}s` : 'Book age unknown'}
      >
        <span
          className={`h-2 w-2 rounded-full ${
            clobFreshness === 'fresh'
              ? 'bg-emerald-400'
              : clobFreshness === 'aging'
                ? 'bg-amber-400'
                : clobFreshness === 'stale'
                  ? 'bg-red-500'
                  : 'bg-slate-500'
          }`}
        />
        <span
          className={`text-2xs font-mono uppercase ${
            clobFreshness === 'fresh'
              ? 'text-emerald-300'
              : clobFreshness === 'aging'
                ? 'text-amber-300'
                : clobFreshness === 'stale'
                  ? 'text-red-300'
                  : 'text-slate-400'
          }`}
        >
          {clobFreshness}
        </span>
      </div>
    </div>
  )
}
