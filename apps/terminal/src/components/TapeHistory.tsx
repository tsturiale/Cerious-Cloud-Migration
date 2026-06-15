/**
 * TapeHistory — right-panel Time & Sales view.
 *
 * Merges polyTicks (all market trades) + fills (session orders).
 * Two equal-width columns: YES (left) | NO (right), newest at top.
 * Header: live YES/NO prices + volume imbalance bar + cumulative totals.
 * Each row: price% | size | time | running Σ cumulative.
 */

import { useMemo, useState } from 'react'
import { useStore } from '../store'
import type { PolyTradeTick } from '../types'

const YES_COL = '#00d4a4'
const NO_COL  = '#ff4757'
const EMPTY: PolyTradeTick[] = []

function fmtTime(ts: number): string {
  const d  = new Date(ts)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const ss = d.getSeconds().toString().padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function fmtDollar(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

type Mode = 'all' | 'mine'

export function TapeHistory() {
  const s          = useStore()
  const activeKey  = s.activeMarketKey
  const fills      = activeKey ? (s.fills[activeKey]      ?? []) : EMPTY
  const polyTicks  = activeKey ? (s.polyTicks[activeKey]  ?? []) : EMPTY
  const polyBooks  = s.polyBooks
  const markets    = s.markets

  const [mode, setMode] = useState<Mode>('all')

  // Live YES/NO probability prices
  const book     = activeKey ? polyBooks[activeKey] ?? null : null
  const market   = markets.find(m => m.key === activeKey) ?? null
  const yesPrice = book?.up_pct   ?? market?.up_pct   ?? null
  const noPrice  = book?.down_pct ?? market?.down_pct ?? null

  // Source: merge polyTicks + fills (deduped by timestamp)
  const allTrades = useMemo(() => {
    const map = new Map<number, PolyTradeTick>()
    for (const t of fills)     map.set(t.timestamp, t)
    for (const t of polyTicks) map.set(t.timestamp, t)
    return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp) // oldest first for cum
  }, [fills, polyTicks])

  const myFills = useMemo(
    () => [...fills].sort((a, b) => a.timestamp - b.timestamp),
    [fills]
  )

  const source = mode === 'all' ? allTrades : myFills

  // Running cumulative maps (oldest → newest)
  const { yesCumMap, noCumMap, yesFills, noFills, stats } = useMemo(() => {
    const yes = source.filter(t => t.side === 'yes')
    const no  = source.filter(t => t.side === 'no')

    let yCum = 0, nCum = 0
    const yCumMap = new Map<number, number>()
    const nCumMap = new Map<number, number>()
    for (const t of yes) { yCum += t.size; yCumMap.set(t.timestamp, yCum) }
    for (const t of no)  { nCum += t.size; nCumMap.set(t.timestamp, nCum) }

    const yVol = yCum
    const nVol = nCum
    const total = yVol + nVol

    return {
      yesCumMap: yCumMap,
      noCumMap:  nCumMap,
      yesFills:  [...yes].reverse(), // newest first for display
      noFills:   [...no].reverse(),
      stats: {
        yesVol:  yVol,
        noVol:   nVol,
        total,
        yesPct:  total ? Math.round((yVol / total) * 100) : 50,
        count:   source.length,
      },
    }
  }, [source])

  return (
    <div className="flex flex-col h-full font-mono text-[11px] bg-surface overflow-hidden">

      {/* ── Live price banner ─────────────────────────────── */}
      <div className="shrink-0 px-2 py-1 border-b border-surface-border bg-black/20 flex items-center gap-2">
        <div className="flex flex-col items-center flex-1">
          <span className="text-[7px] font-mono text-up/50 uppercase tracking-widest leading-none">YES PRICE</span>
          <span className="text-[15px] font-black tabular-nums leading-tight" style={{ color: YES_COL }}>
            {yesPrice != null ? `${yesPrice.toFixed(1)}¢` : '—'}
          </span>
        </div>

        {/* Midpoint spread indicator */}
        <div className="flex flex-col items-center shrink-0">
          {yesPrice != null && noPrice != null && (
            <>
              <span className="text-[7px] text-muted/40 uppercase">spread</span>
              <span className="text-[9px] font-bold font-mono text-muted/60 tabular-nums">
                {Math.abs(100 - yesPrice - noPrice).toFixed(1)}¢
              </span>
            </>
          )}
        </div>

        <div className="flex flex-col items-center flex-1">
          <span className="text-[7px] font-mono text-down/50 uppercase tracking-widest leading-none">NO PRICE</span>
          <span className="text-[15px] font-black tabular-nums leading-tight" style={{ color: NO_COL }}>
            {noPrice != null ? `${noPrice.toFixed(1)}¢` : '—'}
          </span>
        </div>
      </div>

      {/* ── Mode toggle + vol totals ────────────────────── */}
      <div className="shrink-0 px-2 pt-1 pb-0.5 border-b border-surface-border space-y-1">
        {/* All / Mine toggle */}
        <div className="flex items-center gap-1">
          {(['all', 'mine'] as Mode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider transition-all ${
                mode === m
                  ? 'bg-accent/20 text-accent border border-accent/40'
                  : 'text-muted/50 hover:text-muted'
              }`}
            >
              {m === 'all' ? 'All Trades' : 'My Fills'}
            </button>
          ))}
          <span className="ml-auto text-[9px] text-muted/40 tabular-nums">{stats.count}</span>
        </div>

        {/* YES / NO dollar totals */}
        <div className="flex items-center justify-between">
          <span style={{ color: YES_COL }} className="font-bold text-[10px]">
            YES {fmtDollar(stats.yesVol)}
          </span>
          <span className="text-muted/40 text-[8px]">{stats.yesPct}% flow</span>
          <span style={{ color: NO_COL }} className="font-bold text-[10px]">
            NO {fmtDollar(stats.noVol)}
          </span>
        </div>

        {/* Volume imbalance bar */}
        {stats.count > 0 && (
          <div className="h-1.5 w-full rounded-full overflow-hidden flex">
            <div
              className="h-full transition-all"
              style={{ width: `${stats.yesPct}%`, background: YES_COL, opacity: 0.8 }}
            />
            <div className="h-full flex-1" style={{ background: NO_COL, opacity: 0.8 }} />
          </div>
        )}
      </div>

      {/* ── Column headers ─────────────────────────────── */}
      <div className="shrink-0 grid grid-cols-2 border-b border-surface-border/60">
        <div className="px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider border-r border-surface-border/40"
          style={{ color: YES_COL }}>
          YES
        </div>
        <div className="px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider"
          style={{ color: NO_COL }}>
          NO
        </div>
      </div>

      {/* ── Side-by-side trade columns ──────────────────── */}
      <div className="flex-1 grid grid-cols-2 min-h-0 overflow-hidden">

        {/* YES column */}
        <div className="flex flex-col overflow-hidden border-r border-surface-border/40">
          <div className="flex-1 overflow-y-auto min-h-0">
            {yesFills.length === 0 ? (
              <div className="p-2 text-[9px] text-muted/40">
                {activeKey ? 'waiting…' : '—'}
              </div>
            ) : (
              <div className="divide-y divide-surface-border/20">
                {yesFills.map((fill, i) => {
                  const cum = yesCumMap.get(fill.timestamp)
                  return (
                    <div
                      key={`yes-${fill.timestamp}-${i}`}
                      className="px-1.5 py-[3px] flex flex-col gap-0"
                      style={{ borderLeft: `2px solid ${YES_COL}30` }}
                    >
                      {/* Price + size */}
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold tabular-nums" style={{ color: YES_COL }}>
                          {(fill.price ?? 50).toFixed(1)}¢
                        </span>
                        <span className="text-[10px] tabular-nums text-slate-300">
                          {fmtDollar(fill.size ?? 0)}
                        </span>
                      </div>
                      {/* Time + running cum */}
                      <div className="flex items-center justify-between">
                        <span className="text-[7px] text-muted/50 tabular-nums">
                          {fmtTime(fill.timestamp)}
                        </span>
                        {cum != null && (
                          <span className="text-[7px] tabular-nums" style={{ color: `${YES_COL}70` }}>
                            Σ{fmtDollar(cum)}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* YES footer: total + weighted avg price */}
          <div className="shrink-0 px-2 py-0.5 border-t border-surface-border/40 space-y-0" style={{ color: YES_COL }}>
            <div className="text-[9px] font-bold">{fmtDollar(stats.yesVol)} total</div>
            {yesPrice != null && (
              <div className="text-[8px] opacity-60">{yesPrice.toFixed(1)}¢ live</div>
            )}
          </div>
        </div>

        {/* NO column */}
        <div className="flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto min-h-0">
            {noFills.length === 0 ? (
              <div className="p-2 text-[9px] text-muted/40">
                {activeKey ? 'waiting…' : '—'}
              </div>
            ) : (
              <div className="divide-y divide-surface-border/20">
                {noFills.map((fill, i) => {
                  const cum = noCumMap.get(fill.timestamp)
                  return (
                    <div
                      key={`no-${fill.timestamp}-${i}`}
                      className="px-1.5 py-[3px] flex flex-col gap-0"
                      style={{ borderLeft: `2px solid ${NO_COL}30` }}
                    >
                      {/* Price + size */}
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold tabular-nums" style={{ color: NO_COL }}>
                          {(fill.price ?? 50).toFixed(1)}¢
                        </span>
                        <span className="text-[10px] tabular-nums text-slate-300">
                          {fmtDollar(fill.size ?? 0)}
                        </span>
                      </div>
                      {/* Time + running cum */}
                      <div className="flex items-center justify-between">
                        <span className="text-[7px] text-muted/50 tabular-nums">
                          {fmtTime(fill.timestamp)}
                        </span>
                        {cum != null && (
                          <span className="text-[7px] tabular-nums" style={{ color: `${NO_COL}70` }}>
                            Σ{fmtDollar(cum)}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* NO footer: total + live price */}
          <div className="shrink-0 px-2 py-0.5 border-t border-surface-border/40 space-y-0" style={{ color: NO_COL }}>
            <div className="text-[9px] font-bold">{fmtDollar(stats.noVol)} total</div>
            {noPrice != null && (
              <div className="text-[8px] opacity-60">{noPrice.toFixed(1)}¢ live</div>
            )}
          </div>
        </div>
      </div>

      {/* Market key label */}
      {activeKey && (
        <div className="shrink-0 px-2 py-0.5 text-[8px] text-muted/30 border-t border-surface-border/30">
          {activeKey}
        </div>
      )}
    </div>
  )
}
