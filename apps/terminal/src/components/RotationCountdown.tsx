// RotationCountdown.tsx
// Shared countdown hook + RotationBanner for the terminal chart panel.
// The banner appears inside the center panel when the active market
// has ≤ BANNER_THRESHOLD seconds left, showing time-to-expiry and
// the staged "next up" market info.

import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'

// ── Constants ─────────────────────────────────────────────────────────────────

export const PERIOD_SECS: Record<string, number> = {
  '5min': 300, '15min': 900, '1h': 3600, '4h': 14400,
}

// Banner appears this many seconds before expiry
const BANNER_THRESHOLD = 60

// ── Hook ─────────────────────────────────────────────────────────────────────

/** Returns seconds remaining until expiry_ts (unix ms). Updates every second. */
export function useCountdown(expiry_ts: number): number {
  const [secs, setSecs] = useState(() =>
    Math.max(0, Math.round((expiry_ts - Date.now()) / 1000))
  )
  useEffect(() => {
    const tick = () => setSecs(Math.max(0, Math.round((expiry_ts - Date.now()) / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [expiry_ts])
  return secs
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format seconds as "M:SS" */
export function fmtCountdown(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Extract the time-window portion from a Polymarket question title.
 *  "Bitcoin Up or Down - April 30, 4:30PM-4:35PM ET" → "4:30PM-4:35PM ET" */
export function parseTimeWindow(question: string): string {
  const m = question.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:AM|PM)(?:\s*ET)?)/i)
  if (m) return m[1].replace(/\s*–\s*/, '-').trim()
  // fallback: everything after the last comma
  const after = question.split(',').pop()?.trim()
  return after ?? question.slice(0, 32)
}

// ── RotationBanner ────────────────────────────────────────────────────────────
// Inserted as a shrink-0 strip just above the chart area in the center panel.
// Shows: ROTATING M:SS  ▸  NEXT time-window  |  ▲ up%  ▼ down%
// Also flashes "ROTATED" for 2.5 s whenever the active market's condition_id
// changes, confirming the slot rolled over to the new period.

export function RotationBanner() {
  const markets   = useStore(s => s.markets)
  const activeKey = useStore(s => s.activeMarketKey)
  const market    = activeKey ? markets.find(m => m.key === activeKey) : undefined
  const secs      = useCountdown(market?.expiry_ts ?? 0)

  // Detect condition_id change → rotation occurred
  const prevCidRef  = useRef<string | undefined>(undefined)
  const [rotated, setRotated] = useState(false)

  useEffect(() => {
    const cid = market?.condition_id
    if (prevCidRef.current !== undefined && cid !== prevCidRef.current && cid) {
      setRotated(true)
      const t = setTimeout(() => setRotated(false), 2500)
      return () => clearTimeout(t)
    }
    prevCidRef.current = cid
  }, [market?.condition_id])

  // Show the ROTATED flash regardless of time threshold
  if (rotated) {
    return (
      <div className="shrink-0 flex flex-col border-b border-emerald-500/40 bg-emerald-500/10">
        <div className="flex items-center gap-2 px-3 py-1 text-[10px] font-mono">
          <span className="font-bold text-emerald-400 animate-pulse tracking-wider">
            ROTATED — NEW PERIOD LIVE
          </span>
          {market && (
            <>
              <span className="text-muted/40 text-[8px]">▸</span>
              <span className="text-slate-300 truncate">{parseTimeWindow(market.question)}</span>
              <span className="ml-auto flex items-center gap-2 shrink-0">
                <span className="text-up font-semibold">▲ {market.up_pct.toFixed(1)}%</span>
                <span className="text-down font-semibold">▼ {market.down_pct.toFixed(1)}%</span>
              </span>
            </>
          )}
        </div>
        <div className="h-[2px] w-full bg-emerald-500/60" />
      </div>
    )
  }

  // Only show countdown banner when within BANNER_THRESHOLD of expiry
  if (!market?.live || secs > BANNER_THRESHOLD) return null

  const staged     = market.staged_market
  const totalSecs  = PERIOD_SECS[market.timeframe] ?? 300
  const barPct     = Math.max(0, Math.min(100, (secs / Math.min(totalSecs, BANNER_THRESHOLD)) * 100))
  const urgent     = secs <= 15

  return (
    <div
      className={`shrink-0 flex flex-col border-b transition-colors
        ${urgent
          ? 'border-amber-500/50 bg-amber-500/8'
          : 'border-accent/25 bg-accent/5'}`}
    >
      {/* Info row */}
      <div className="flex items-center gap-2 px-3 py-1 text-[10px] font-mono">
        <span className={`font-bold tabular-nums tracking-wider ${urgent ? 'text-amber-400 animate-pulse' : 'text-accent'}`}>
          ROTATING {fmtCountdown(secs)}
        </span>
        <span className="text-muted/40 text-[8px]">▸</span>
        {staged ? (
          <>
            <span className="text-slate-300 truncate">
              {market.asset} · {parseTimeWindow(staged.question)}
            </span>
            <span className="ml-auto flex items-center gap-2 shrink-0">
              <span className="text-up font-semibold">▲ {staged.up_pct.toFixed(1)}%</span>
              <span className="text-down font-semibold">▼ {staged.down_pct.toFixed(1)}%</span>
            </span>
          </>
        ) : (
          <span className="text-muted/40 italic">loading next market…</span>
        )}
      </div>

      {/* Draining time bar — width shrinks from 100% → 0% over BANNER_THRESHOLD seconds */}
      <div className="h-[2px] w-full bg-surface-border">
        <div
          className={`h-full transition-all duration-1000 ease-linear rounded-full
            ${urgent ? 'bg-amber-400' : 'bg-accent/80'}`}
          style={{ width: `${barPct}%` }}
        />
      </div>
    </div>
  )
}
