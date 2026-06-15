/**
 * TimeAndSales — Polymarket YES/NO probability trade tape.
 *
 * • Newest trade always appears at the TOP; older rows slide down.
 * • Filter bar: Min size (show only ≥ X shares) + Max size (hide above X shares).
 * • Timestamps: HH:MM:SS.mmm  |  YES green  |  NO red
 * • Popout: draggable fixed window with its own filter state.
 */

import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import type { PolyTradeTick } from '../types'

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_TICKS = 2_000
const YES_COL   = '#00d4a4'
const NO_COL    = '#ff4757'

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtMs(ts: number): string {
  const d  = new Date(ts)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const ss = d.getSeconds().toString().padStart(2, '0')
  const ms = d.getMilliseconds().toString().padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

function fmtPrice(p: number): string {
  // price arrives as 0–100 pct (e.g. 54.0 = 54%)
  return `${p.toFixed(1)}%`
}

function fmtSize(size: number): string {
  if (!size) return '—'
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(2)}M`
  if (size >= 1_000)     return `${(size / 1_000).toFixed(1)}K`
  return size.toFixed(0)
}

// ── Filter state ──────────────────────────────────────────────────────────────
interface Filters { minSize: string; maxSize: string }

function applyFilters(ticks: PolyTradeTick[], f: Filters): PolyTradeTick[] {
  const min = f.minSize !== '' ? Number(f.minSize) : null
  const max = f.maxSize !== '' ? Number(f.maxSize) : null
  return ticks.filter(t => {
    if (min !== null && t.size < min) return false
    if (max !== null && t.size > max) return false
    return true
  })
}

// ── Draggable hook ─────────────────────────────────────────────────────────────
function useDrag(initialPos: { x: number; y: number }) {
  const [pos, setPos] = useState(initialPos)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      setPos({ x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy })
    }
    const onUp = () => {
      dragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y }
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
  }

  return { pos, onMouseDown }
}

// ── Filter bar ────────────────────────────────────────────────────────────────
function FilterBar({
  filters,
  onChange,
  visibleCount,
  totalCount,
}: {
  filters:      Filters
  onChange:     (f: Filters) => void
  visibleCount: number
  totalCount:   number
}) {
  const isFiltered = filters.minSize !== '' || filters.maxSize !== ''

  return (
    <div className="shrink-0 px-2 py-1.5 border-b border-surface-border/50 bg-surface/40">
      <div className="flex items-center gap-1.5">
        {/* Min filter */}
        <div className="flex items-center gap-1 flex-1">
          <span className="text-2xs text-muted/70 shrink-0">Min</span>
          <input
            type="number"
            min="0"
            placeholder="0"
            value={filters.minSize}
            onChange={e => onChange({ ...filters, minSize: e.target.value })}
            className="w-full bg-surface border border-surface-border/60 rounded px-1.5 py-0.5 text-2xs font-mono text-slate-300 placeholder-muted/40 focus:outline-none focus:border-accent/50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
          />
        </div>

        <span className="text-muted/40 text-2xs shrink-0">–</span>

        {/* Max filter */}
        <div className="flex items-center gap-1 flex-1">
          <span className="text-2xs text-muted/70 shrink-0">Max</span>
          <input
            type="number"
            min="0"
            placeholder="∞"
            value={filters.maxSize}
            onChange={e => onChange({ ...filters, maxSize: e.target.value })}
            className="w-full bg-surface border border-surface-border/60 rounded px-1.5 py-0.5 text-2xs font-mono text-slate-300 placeholder-muted/40 focus:outline-none focus:border-accent/50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
          />
        </div>

        {/* Clear + count */}
        {isFiltered ? (
          <button
            onClick={() => onChange({ minSize: '', maxSize: '' })}
            className="shrink-0 text-2xs text-accent hover:text-slate-300 px-1 rounded transition-colors"
            title="Clear filters"
          >
            ✕
          </button>
        ) : null}

        <span className="shrink-0 text-2xs text-muted/50 font-mono ml-auto">
          {isFiltered ? `${visibleCount}/${totalCount}` : totalCount}
        </span>
      </div>
    </div>
  )
}

// ── Stats row ─────────────────────────────────────────────────────────────────
function TickStats({ ticks }: { ticks: PolyTradeTick[] }) {
  const recent = ticks.slice(-200)
  const yes    = recent.filter(t => t.side === 'yes').length
  const no     = recent.filter(t => t.side === 'no').length
  const total  = yes + no || 1
  const yesPct = ((yes / total) * 100).toFixed(0)
  const last   = ticks.at(-1)

  return (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-surface-border/50 text-2xs font-mono shrink-0">
      <span className="text-muted/60">200</span>
      <span style={{ color: YES_COL }}>Y {yesPct}%</span>
      <span style={{ color: NO_COL }}>N {(100 - +yesPct)}%</span>
      {last && (
        <span className="font-bold ml-auto" style={{ color: last.side === 'yes' ? YES_COL : NO_COL }}>
          {fmtPrice(last.price)}
        </span>
      )}
    </div>
  )
}

// ── Tape table ────────────────────────────────────────────────────────────────
/** Renders ticks in REVERSE order — newest row is always at the top. */
function TapeTable({ ticks }: { ticks: PolyTradeTick[] }) {
  const scrollRef   = useRef<HTMLDivElement>(null)
  const atTopRef    = useRef(true)
  const prevLenRef  = useRef(0)

  // Track whether user has scrolled away from top
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => { atTopRef.current = el.scrollTop < 40 }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // When new ticks arrive and user is at top, stay pinned to top
  useEffect(() => {
    if (ticks.length !== prevLenRef.current && atTopRef.current) {
      scrollRef.current?.scrollTo({ top: 0, behavior: 'instant' })
    }
    prevLenRef.current = ticks.length
  }, [ticks.length])

  // Render newest first
  const reversed = [...ticks].reverse()

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 font-mono text-2xs">
      {/* Sticky column headers */}
      <div className="sticky top-0 z-10 flex items-center bg-surface-panel border-b border-surface-border/60 px-2 py-[2px] text-muted select-none">
        <span className="w-[88px] shrink-0">Time</span>
        <span className="w-10 text-center shrink-0">Side</span>
        <span className="flex-1 text-right pr-1">Price</span>
        <span className="w-16 text-right">Size</span>
      </div>

      {reversed.map((t, i) => {
        const isYes = t.side === 'yes'
        const col   = isYes ? YES_COL : NO_COL
        // Highlight the very latest tick
        const isLatest = i === 0
        return (
          <div
            key={`${t.timestamp}-${i}`}
            className={`flex items-center px-2 py-[1px] transition-colors ${
              isLatest ? 'bg-surface-hover/60' : 'hover:bg-surface-hover/30'
            }`}
          >
            <span className="w-[88px] shrink-0 text-muted/70 leading-none">{fmtMs(t.timestamp)}</span>
            <span
              className="w-10 text-center shrink-0 font-bold"
              style={{ color: col }}
            >
              {isYes ? 'YES' : 'NO'}
            </span>
            <span className="flex-1 text-right pr-1 font-semibold" style={{ color: col }}>
              {fmtPrice(t.price)}
            </span>
            <span className="w-16 text-right" style={{ color: `${col}99` }}>
              {fmtSize(t.size)}
            </span>
          </div>
        )
      })}

      {ticks.length === 0 && (
        <div className="text-center text-muted py-8 text-2xs leading-relaxed">
          <div>Waiting for trades…</div>
          <div className="text-muted/40 mt-1">Live trades from Polymarket CLOB</div>
        </div>
      )}
    </div>
  )
}

// ── Inner panel (shared between inline + popout) ───────────────────────────────
function TapePanel({
  ticks,
  marketKey,
}: {
  ticks:     PolyTradeTick[]
  marketKey: string | null
}) {
  const [filters, setFilters] = useState<Filters>({ minSize: '', maxSize: '' })
  const visible = applyFilters(ticks, filters)

  return (
    <>
      {/* Stats only meaningful when there's data */}
      {ticks.length > 0 && <TickStats ticks={ticks} />}

      {/* Filter bar — always visible */}
      <FilterBar
        filters={filters}
        onChange={setFilters}
        visibleCount={visible.length}
        totalCount={ticks.length}
      />

      {/* Tape */}
      {marketKey ? (
        <TapeTable ticks={visible} />
      ) : (
        <div className="flex-1 flex items-center justify-center text-2xs text-muted font-mono">
          Select a market to see the tape
        </div>
      )}
    </>
  )
}

// ── Popout window ─────────────────────────────────────────────────────────────
function PopoutWindow({
  ticks,
  marketKey,
  onDock,
}: {
  ticks:     PolyTradeTick[]
  marketKey: string | null
  onDock:    () => void
}) {
  const { pos, onMouseDown } = useDrag({ x: Math.max(0, window.innerWidth - 370), y: 80 })

  return (
    <div
      style={{ position: 'fixed', left: pos.x, top: pos.y, width: 340, height: 460, zIndex: 9999 }}
      className="flex flex-col bg-surface-panel border border-surface-border rounded-lg shadow-2xl overflow-hidden"
    >
      {/* Title bar — drag handle */}
      <div
        onMouseDown={onMouseDown}
        className="flex items-center justify-between px-2.5 py-1.5 bg-surface-border/30 cursor-grab active:cursor-grabbing shrink-0 select-none"
      >
        <span className="text-2xs font-semibold text-slate-300 tracking-wider uppercase">
          Time &amp; Sales
          {marketKey && (
            <span className="ml-1.5 text-muted font-normal normal-case tracking-normal">
              {marketKey.replace('_', ' ')}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onDock}
            className="text-2xs text-muted hover:text-slate-300 px-1.5 py-0.5 rounded hover:bg-surface-hover transition-colors"
          >
            Dock ↙
          </button>
          <button
            onClick={onDock}
            className="text-muted hover:text-slate-200 w-4 h-4 flex items-center justify-center rounded hover:bg-surface-hover transition-colors leading-none"
          >
            ✕
          </button>
        </div>
      </div>

      <TapePanel ticks={ticks} marketKey={marketKey} />
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────
interface Props {
  popped:   boolean
  onPopout: () => void
  onDock:   () => void
}

// Stable empty array — prevents Zustand infinite loop from ?? [] creating new ref each render
const EMPTY_TICKS: PolyTradeTick[] = []

export function TimeAndSales({ popped, onPopout, onDock }: Props) {
  const [localTicks, setLocalTicks] = useState<PolyTradeTick[]>([])
  const localRef = useRef<PolyTradeTick[]>([])

  const activeMarketKey = useStore(s => s.activeMarketKey)
  const storeTicks      = useStore(s => (activeMarketKey ? s.polyTicks?.[activeMarketKey] : undefined) ?? EMPTY_TICKS)

  // Reset when market switches
  useEffect(() => {
    localRef.current = []
    setLocalTicks([])
  }, [activeMarketKey])

  // Accumulate beyond store's 200-tick cap
  useEffect(() => {
    if (!storeTicks.length) return
    const current = localRef.current
    const lastTs  = current.length ? current[current.length - 1].timestamp : 0
    const newOnes = storeTicks.filter(t => t.timestamp > lastTs)
    if (!newOnes.length) return
    const merged  = [...current, ...newOnes]
    const trimmed = merged.length > MAX_TICKS ? merged.slice(-MAX_TICKS) : merged
    localRef.current = trimmed
    setLocalTicks([...trimmed])
  }, [storeTicks])

  // ── Popout ────────────────────────────────────────────────────────────────
  if (popped) {
    return (
      <PopoutWindow
        ticks={localTicks}
        marketKey={activeMarketKey}
        onDock={onDock}
      />
    )
  }

  // ── Inline ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Tab header with popout button */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-surface-border/50 shrink-0">
        <span className="text-2xs font-semibold text-muted uppercase tracking-wider truncate max-w-[160px]">
          {activeMarketKey ? activeMarketKey.replace('_', ' ') : 'Time & Sales'}
        </span>
        <button
          onClick={onPopout}
          title="Pop out"
          className="text-muted hover:text-slate-300 text-xs px-1.5 py-0.5 rounded hover:bg-surface-hover transition-colors shrink-0 ml-1"
        >
          ⤢
        </button>
      </div>

      <TapePanel ticks={localTicks} marketKey={activeMarketKey} />
    </div>
  )
}
