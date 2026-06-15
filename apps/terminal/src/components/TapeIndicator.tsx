/**
 * TapeIndicator — compact live YES/NO trade tape for sections 2/3.
 *
 * Sources: fills (session) + polyTicks (recent), deduped by timestamp.
 * Shows: live YES/NO prices, per-row price + size + cumulative Σ volume.
 */

import { useMemo } from 'react'
import { useStore } from '../store'
import type { PolyTradeTick } from '../types'

const YES_COL  = '#00d4a4'
const NO_COL   = '#ff4757'
const EMPTY: PolyTradeTick[] = []

function fmtSize(s: number): string {
  if (s >= 1_000_000) return `${(s / 1_000_000).toFixed(1)}M`
  if (s >= 1_000)     return `${(s / 1_000).toFixed(1)}K`
  return s.toFixed(0)
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

export function TapeIndicator() {
  const activeKey  = useStore(s => s.activeMarketKey)
  const polyTicks  = useStore(s => (activeKey ? s.polyTicks[activeKey]  : undefined) ?? EMPTY)
  const fills      = useStore(s => (activeKey ? s.fills[activeKey]      : undefined) ?? EMPTY)
  const polyBooks  = useStore(s => s.polyBooks)
  const markets    = useStore(s => s.markets)

  // Live YES/NO probability prices
  const book    = activeKey ? polyBooks[activeKey] ?? null : null
  const market  = markets.find(m => m.key === activeKey) ?? null
  const yesPrice = book?.up_pct   ?? market?.up_pct   ?? null
  const noPrice  = book?.down_pct ?? market?.down_pct ?? null

  // Merge polyTicks + fills, deduplicate by timestamp, sort newest-first
  const merged = useMemo(() => {
    const map = new Map<number, PolyTradeTick>()
    for (const t of fills)     map.set(t.timestamp, t)
    for (const t of polyTicks) map.set(t.timestamp, t)
    return Array.from(map.values()).sort((a, b) => b.timestamp - a.timestamp)
  }, [fills, polyTicks])

  const recent = merged.slice(0, 80)

  // Per-side cumulative volume maps (oldest → newest running sum)
  const { yesCumMap, noCumMap, yesVol, noVol, yesCount, noCount } = useMemo(() => {
    const ySorted = [...merged].filter(t => t.side === 'yes').reverse() // oldest first
    const nSorted = [...merged].filter(t => t.side === 'no').reverse()

    let yCum = 0, nCum = 0, yVol = 0, nVol = 0
    const yCumMap = new Map<number, number>()
    const nCumMap = new Map<number, number>()

    for (const t of ySorted) { yCum += t.size; yCumMap.set(t.timestamp, yCum); yVol += t.size }
    for (const t of nSorted) { nCum += t.size; nCumMap.set(t.timestamp, nCum); nVol += t.size }

    return {
      yesCumMap: yCumMap,
      noCumMap:  nCumMap,
      yesVol:    yVol,
      noVol:     nVol,
      yesCount:  ySorted.length,
      noCount:   nSorted.length,
    }
  }, [merged])

  const total = yesCount + noCount || 1
  const totalVol = yesVol + noVol || 1

  return (
    <div className="flex flex-col h-full bg-surface-panel border border-surface-border rounded overflow-hidden">

      {/* ── Live price bar ─────────────────────────────── */}
      <div className="shrink-0 px-2 py-1 border-b border-surface-border bg-black/20 flex items-center justify-between gap-1">
        <div className="flex flex-col items-center flex-1">
          <span className="text-[8px] font-mono text-up/60 uppercase tracking-widest leading-none">YES</span>
          <span
            className="text-[13px] font-black font-mono tabular-nums leading-tight"
            style={{ color: YES_COL }}
          >
            {yesPrice != null ? `${yesPrice.toFixed(1)}¢` : '—'}
          </span>
        </div>
        <div className="h-8 w-px bg-surface-border/50" />
        <div className="flex flex-col items-center flex-1">
          <span className="text-[8px] font-mono text-down/60 uppercase tracking-widest leading-none">NO</span>
          <span
            className="text-[13px] font-black font-mono tabular-nums leading-tight"
            style={{ color: NO_COL }}
          >
            {noPrice != null ? `${noPrice.toFixed(1)}¢` : '—'}
          </span>
        </div>
      </div>

      {/* ── Count + vol header ─────────────────────────── */}
      <div className="px-2 py-0.5 border-b border-surface-border shrink-0 flex items-center justify-between">
        <span className="text-[9px] font-bold text-accent font-mono uppercase tracking-wider">Tape</span>
        <div className="flex items-center gap-1.5 text-[9px] font-mono">
          <span style={{ color: YES_COL }}>
            Y {((yesCount / total) * 100).toFixed(0)}%
          </span>
          <span className="text-muted/40">·</span>
          <span style={{ color: NO_COL }}>
            N {((noCount / total) * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      {/* ── Volume imbalance bar ───────────────────────── */}
      {merged.length > 0 && (
        <div className="h-1 shrink-0 flex">
          <div
            className="h-full transition-all duration-300"
            style={{ width: `${(yesVol / totalVol) * 100}%`, background: YES_COL, opacity: 0.7 }}
          />
          <div className="h-full flex-1" style={{ background: NO_COL, opacity: 0.7 }} />
        </div>
      )}

      {/* ── Tick rows ──────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
        {recent.length === 0 ? (
          <div className="text-[9px] text-muted/60 font-mono p-2 text-center mt-4">
            waiting for trades…
          </div>
        ) : (
          <div className="divide-y divide-surface-border/20">
            {recent.map((tick, i) => {
              const isYes = tick.side === 'yes'
              const col   = isYes ? YES_COL : NO_COL
              const cum   = (isYes ? yesCumMap : noCumMap).get(tick.timestamp)
              return (
                <div
                  key={`${tick.timestamp}-${i}`}
                  className="px-1.5 py-[3px] font-mono"
                  style={{ borderLeft: `2px solid ${col}28` }}
                >
                  {/* Row 1: side badge + price + size */}
                  <div className="flex items-center gap-1">
                    <span
                      className="text-[8px] font-bold shrink-0 w-5 text-center rounded-sm py-[1px]"
                      style={{ color: col, background: `${col}22` }}
                    >
                      {isYes ? 'Y' : 'N'}
                    </span>
                    <span
                      className="text-[10px] font-bold tabular-nums flex-1"
                      style={{ color: col }}
                    >
                      {tick.price.toFixed(1)}¢
                    </span>
                    <span
                      className="text-[10px] tabular-nums shrink-0"
                      style={{ color: `${col}cc` }}
                    >
                      ${fmtSize(tick.size)}
                    </span>
                  </div>
                  {/* Row 2: time + cumulative */}
                  <div className="flex items-center justify-between pl-6">
                    <span className="text-[7px] text-muted/45 tabular-nums">
                      {fmtTime(tick.timestamp)}
                    </span>
                    {cum != null && (
                      <span
                        className="text-[7px] tabular-nums font-mono"
                        style={{ color: `${col}80` }}
                      >
                        Σ${fmtSize(cum)}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Cumulative vol footer ──────────────────────── */}
      {merged.length > 0 && (
        <div className="px-2 py-1 border-t border-surface-border/50 shrink-0 space-y-0.5">
          <div className="flex justify-between text-[9px] font-mono font-bold">
            <span style={{ color: YES_COL }}>Y Σ${fmtSize(yesVol)}</span>
            <span style={{ color: NO_COL }}>N Σ${fmtSize(noVol)}</span>
          </div>
          <div className="flex justify-between text-[8px] font-mono text-muted/50">
            <span>{yesCount} trades</span>
            <span className="text-muted/30">vol</span>
            <span>{noCount} trades</span>
          </div>
        </div>
      )}
    </div>
  )
}
