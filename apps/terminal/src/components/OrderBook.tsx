import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'
import type { PolyBook, PolyBookLevel } from '../types'

const POLL_MS = 3_000
const ROWS    = 6

const YES_COL = '#00d4a4'
const NO_COL  = '#ff4757'

// ── Clickable book row ────────────────────────────────────────────────────────
interface BookRowProps {
  level:   PolyBookLevel | null
  maxSz:   number
  type:    'bid' | 'ask'
  side:    'yes' | 'no'
  onClick: (cents: number) => void
}

function BookRow({ level, maxSz, type, side, onClick }: BookRowProps) {
  if (!level) return <div className="h-[18px]" />

  const priceCents = Math.round(level.price * 100)
  const sizeVal = level.size ?? 0
  const sz = sizeVal >= 1000
    ? `${(sizeVal / 1000).toFixed(1)}k`
    : sizeVal.toFixed(0)
  const pct = Math.min((sizeVal / maxSz) * 100, 100)

  const barGrad = type === 'bid'
    ? 'from-emerald-500/30 via-emerald-500/10 to-transparent'
    : 'from-red-500/30 via-red-500/10 to-transparent'
  const priceColor = side === 'yes'
    ? (type === 'bid' ? 'text-emerald-400' : 'text-red-400')
    : (type === 'bid' ? 'text-red-400'     : 'text-emerald-400')

  return (
    <div
      onClick={() => onClick(priceCents)}
      className="relative flex justify-between items-center px-1.5 h-[18px] cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.1] transition-colors"
      title={`Click to set ${side.toUpperCase()} limit @ ${priceCents}¢`}
    >
      <div
        className={`absolute inset-y-0 left-0 bg-gradient-to-r ${barGrad} transition-all duration-300`}
        style={{ width: `${pct}%` }}
      />
      <span className={`text-[9px] font-mono z-10 tabular-nums font-semibold ${priceColor}`}>
        {priceCents}¢
      </span>
      <span className="text-[9px] font-mono text-slate-500 z-10 tabular-nums">{sz}</span>
    </div>
  )
}

function MidRow({ cents, side }: { cents: number | null; side: 'yes' | 'no' }) {
  const borderColor = side === 'yes' ? 'border-emerald-800/50' : 'border-red-800/50'
  const bgColor     = side === 'yes' ? 'bg-emerald-950/40'     : 'bg-red-950/40'
  return (
    <div className={`flex items-center justify-between px-1.5 py-[3px] border-y ${borderColor} ${bgColor}`}>
      <span className="text-[9px] font-mono font-bold text-slate-200 tabular-nums">
        {cents != null ? `${cents}¢` : '—'}
      </span>
      <span className="text-[8px] text-slate-500 font-mono">mid</span>
    </div>
  )
}

function CumVolRow({
  bids, asks, side,
}: {
  bids: (PolyBookLevel | null)[]
  asks: (PolyBookLevel | null)[]
  side: 'yes' | 'no'
}) {
  const validBids = bids.filter(Boolean) as PolyBookLevel[]
  const validAsks = asks.filter(Boolean) as PolyBookLevel[]
  const bidDollar = validBids.reduce((s, l) => s + (l.price ?? 0) * (l.size ?? 0), 0)
  const askDollar = validAsks.reduce((s, l) => s + (l.price ?? 0) * (l.size ?? 0), 0)
  const fmt = (v: number) => {
    if (!Number.isFinite(v)) return '—'
    return v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M`
    : v >= 1_000   ? `$${(v / 1_000).toFixed(1)}k`
    : `$${v.toFixed(0)}`
  }
  const bidCol = side === 'yes' ? 'text-emerald-500/80' : 'text-red-500/80'
  const askCol = side === 'yes' ? 'text-red-500/80'     : 'text-emerald-500/80'
  return (
    <div className="flex justify-between items-center px-1.5 py-1 border-t border-surface-border bg-surface-card/40 text-[8px] font-mono shrink-0">
      <span className={`${bidCol} font-semibold tabular-nums`}>{fmt(bidDollar)} bid</span>
      <span className="text-slate-600 text-[7px] tracking-wider uppercase">cum $</span>
      <span className={`${askCol} font-semibold tabular-nums`}>{fmt(askDollar)} ask</span>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export function OrderBook() {
  const activeMarketKey  = useStore(s => s.activeMarketKey)
  const markets          = useStore(s => s.markets)
  const polyBooks        = useStore(s => s.polyBooks)
  const marketProvider   = useStore(s => s.marketProvider)
  const setBookClickPrice = useStore(s => s.setBookClickPrice)
  const market = markets.find(m => m.key === activeMarketKey)

  const rawWsBook = marketProvider === 'polymarket' && activeMarketKey
    ? polyBooks[activeMarketKey] ?? null : null
  const wsAgeRef = rawWsBook ? (rawWsBook as PolyBook & { seen_ms?: number }).seen_ms ?? rawWsBook.timestamp_ms : 0
  const wsBook = rawWsBook
    && rawWsBook.up_token_id === market?.up_token_id
    && Date.now() - wsAgeRef < POLL_MS * 6
      ? rawWsBook : null

  const [restBook, setRestBook] = useState<PolyBook | null>(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [mkDiff, setMkDiff] = useState<{
    key: string
    polyUp: number | null
    kalshiUp: number | null
    diffCents: number | null
    edgeSide: 'poly_richer' | 'kalshi_richer' | 'flat'
  } | null>(null)
  const cancelRef = useRef(false)

  useEffect(() => {
    if (!activeMarketKey) { setRestBook(null); setError(null); return }
    if (marketProvider === 'polymarket' && market && !market.live) { setRestBook(null); setError(null); return }
    cancelRef.current = false
    setLoading(true)

    function buildRequest() {
      if (marketProvider === 'kalshi') {
        const key = localStorage.getItem('kalshi_api_key') ?? ''
        return { url: `/api/kalshi/book/${activeMarketKey}`, headers: key ? { 'X-Kalshi-Key': key } : {} as Record<string,string> }
      }
      if (marketProvider === 'forecasttrader') {
        const key  = localStorage.getItem('ibkr_api_key') ?? ''
        const acct = localStorage.getItem('ibkr_account_id') ?? ''
        const h: Record<string,string> = {}
        if (key)  h['X-Ibkr-Key']     = key
        if (acct) h['X-Ibkr-Account'] = acct
        return { url: `/api/ibkr/book/${activeMarketKey}`, headers: h }
      }
      return { url: `/api/poly/book/${activeMarketKey}`, headers: {} as Record<string,string> }
    }

    async function fetchBook() {
      const { url, headers } = buildRequest()
      try {
        const resp = await fetch(url, { headers })
        if (cancelRef.current) return
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ detail: resp.statusText }))
          setError(err.detail ?? 'Failed'); setLoading(false); return
        }
        const data: PolyBook = await resp.json()
        if (!cancelRef.current) { setRestBook(data); setError(null); setLoading(false) }
      } catch {
        if (!cancelRef.current) { setError('Network error'); setLoading(false) }
      }
    }
    fetchBook()
    const id = setInterval(fetchBook, POLL_MS)
    return () => { cancelRef.current = true; clearInterval(id) }
  }, [activeMarketKey, marketProvider, market?.live])

  useEffect(() => {
    if (!activeMarketKey) {
      setMkDiff(null)
      return
    }
    const activeKey = activeMarketKey
    let cancelled = false
    async function fetchDiff() {
      try {
        const url = marketProvider === 'kalshi'
          ? `/api/eval/poly-kalshi-diff?market_id=${encodeURIComponent(activeKey)}`
          : `/api/eval/poly-kalshi-diff?market_key=${encodeURIComponent(activeKey)}`
        const resp = await fetch(url)
        if (!resp.ok || cancelled) return
        const data = await resp.json()
        if (cancelled || !data?.ok) return
        setMkDiff({
          key: data.key,
          polyUp: data.poly?.up_pct ?? null,
          kalshiUp: data.kalshi?.up_pct ?? null,
          diffCents: data.diff_cents ?? null,
          edgeSide: (data.edge_side ?? 'flat') as 'poly_richer' | 'kalshi_richer' | 'flat',
        })
      } catch {
        if (!cancelled) setMkDiff(null)
      }
    }
    fetchDiff()
    const id = setInterval(fetchDiff, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [activeMarketKey, marketProvider])

  const book: PolyBook | null =
    wsBook && (!restBook || wsBook.timestamp_ms >= restBook.timestamp_ms) ? wsBook : restBook
  const bookAgeMs = book ? (Date.now() - ((book.seen_ms ?? book.timestamp_ms))) : null
  const freshness =
    bookAgeMs == null ? 'unknown'
    : bookAgeMs < 12_000 ? 'fresh'
    : bookAgeMs < 25_000 ? 'aging'
    : 'stale'

  // YES ladder
  const rawYesAsks = (book?.asks ?? []).slice(0, ROWS).reverse()
  const rawYesBids = (book?.bids ?? []).slice(0, ROWS)
  const maxSzY     = Math.max(...rawYesAsks.map(l => l?.size ?? 0), ...rawYesBids.map(l => l?.size ?? 0), 1)
  const yesAsks: (PolyBookLevel | null)[] = Array(ROWS).fill(null).map((_, i) => rawYesAsks[i] ?? null)
  const yesBids: (PolyBookLevel | null)[] = Array(ROWS).fill(null).map((_, i) => rawYesBids[i] ?? null)

  // NO ladder (complementary)
  const rawNoAsks = (book?.bids ?? []).slice(0, ROWS)
    .map(b => ({ price: Math.round((1 - b.price) * 100) / 100, size: b?.size ?? 0 }))
    .sort((a, b) => a.price - b.price).reverse()
  const rawNoBids = (book?.asks ?? []).slice(0, ROWS)
    .map(a => ({ price: Math.round((1 - a.price) * 100) / 100, size: a?.size ?? 0 }))
    .sort((a, b) => b.price - a.price)
  const maxSzN  = Math.max(...rawNoAsks.map(l => l?.size ?? 0), ...rawNoBids.map(l => l?.size ?? 0), 1)
  const noAsks: (PolyBookLevel | null)[] = Array(ROWS).fill(null).map((_, i) => rawNoAsks[i] ?? null)
  const noBids: (PolyBookLevel | null)[] = Array(ROWS).fill(null).map((_, i) => rawNoBids[i] ?? null)

  const yesMidCts = book ? Math.round(book.mid * 100)       : null
  const noMidCts  = book ? Math.round((1 - book.mid) * 100) : null

  if (!activeMarketKey) {
    return (
      <div className="flex flex-col w-full h-full min-h-[120px] items-center justify-center text-muted text-2xs font-mono px-4 text-center gap-1">
        <span className="text-[18px] text-surface-border">⬡</span>
        <span>Select a market to view order book</span>
      </div>
    )
  }
  if (marketProvider === 'polymarket' && market && !market.live) {
    return (
      <div className="flex flex-col w-full h-full min-h-[120px]">
        <div className="panel-header shrink-0">
          <span className="text-xs font-semibold text-slate-300">{market.asset} {market.timeframe} Book</span>
          <span className="label text-yellow-400">NO CLOB</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-muted text-2xs font-mono px-4 text-center">
          No real Polymarket order book available
        </div>
      </div>
    )
  }

  const providerLabel = marketProvider === 'kalshi' ? 'KALSHI' : marketProvider === 'forecasttrader' ? 'IBKR' : 'POLY'

  return (
    <div className="flex flex-col overflow-hidden bg-surface">

      {/* Header */}
      <div className="panel-header shrink-0">
        <span className="text-xs font-semibold text-slate-300 truncate max-w-[160px]">
          {market?.asset ?? activeMarketKey?.split('_')[0]} {market?.timeframe ?? activeMarketKey?.split('_')[1]} Live Book
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          {book?.spread_pct != null && <span className="label">{book.spread_pct.toFixed(1)}¢ spd</span>}
          {book?.final_minute_mode && (
            <span
              className={`label ${book.final_minute_hold ? 'text-amber-300' : 'text-cyan-300'}`}
              title={book.final_minute_hold ? 'Final minute hold mode (no fallback)' : 'Final minute mode (live CLOB)'}
            >
              {book.final_minute_hold ? 'HOLD 60s' : 'FINAL 60s'}
            </span>
          )}
          {book && (
            <span
              className={`label ${
                freshness === 'fresh'
                  ? 'text-emerald-300'
                  : freshness === 'aging'
                    ? 'text-amber-300'
                    : freshness === 'stale'
                      ? 'text-red-300'
                      : 'text-slate-400'
              }`}
              title={bookAgeMs != null ? `Book age ${Math.round(bookAgeMs / 1000)}s` : 'Book age unknown'}
            >
              {freshness.toUpperCase()}
            </span>
          )}
          {wsBook
            ? <span className="label text-green-400">WS ●</span>
            : loading && !book
              ? <span className="label text-yellow-400 animate-pulse">LOAD…</span>
              : <span className="label text-green-400">{providerLabel}</span>
          }
        </div>
      </div>

      {/* YES/NO probability bar */}
      {book && (
        <div className="shrink-0 px-2 py-1 border-b border-surface-border">
          <div className="flex justify-between text-[9px] font-mono mb-0.5">
            <span className="text-emerald-400 font-bold">YES {book.up_pct != null ? `${book.up_pct.toFixed(1)}%` : '—'}</span>
            <span className="text-slate-500 truncate max-w-[100px] text-[8px]">{activeMarketKey}</span>
            <span className="text-red-400 font-bold">NO {book.down_pct != null ? `${book.down_pct.toFixed(1)}%` : '—'}</span>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden flex">
            <div className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-500" style={{ width: `${book.up_pct ?? 0}%` }} />
            <div className="h-full bg-gradient-to-r from-red-600 to-red-400 transition-all duration-500" style={{ width: `${book.down_pct ?? 0}%` }} />
          </div>
        </div>
      )}

      {/* Poly vs Kalshi evaluation box */}
      {mkDiff && (
        <div className="shrink-0 px-2 py-1 border-b border-surface-border bg-surface-card/40">
          <div className="flex items-center justify-between">
            <span className="text-[8px] uppercase tracking-wider text-muted/60 font-mono">Poly vs Kalshi</span>
            <span className="text-[8px] text-slate-500 font-mono truncate max-w-[110px]">{mkDiff.key}</span>
          </div>
          <div className="mt-0.5 flex items-center justify-between text-[10px] font-mono">
            <span className="text-cyan-300">POLY {mkDiff.polyUp != null ? `${mkDiff.polyUp.toFixed(1)}¢` : '—'}</span>
            <span
              className={
                mkDiff.diffCents == null
                  ? 'text-slate-500'
                  : mkDiff.diffCents > 0
                    ? 'text-amber-300'
                    : mkDiff.diffCents < 0
                      ? 'text-emerald-300'
                      : 'text-slate-300'
              }
              title="+ means Polymarket richer than Kalshi"
            >
              Δ {mkDiff.diffCents == null ? '—' : `${mkDiff.diffCents > 0 ? '+' : ''}${mkDiff.diffCents.toFixed(2)}¢`}
            </span>
            <span className="text-violet-300">KAL {mkDiff.kalshiUp != null ? `${mkDiff.kalshiUp.toFixed(1)}¢` : '—'}</span>
          </div>
        </div>
      )}

      {/* Click hint */}
      {book && (
        <div className="shrink-0 px-2 py-[3px] text-[8px] text-muted/40 font-mono border-b border-surface-border/40 text-center">
          click a level to set limit price ↓
        </div>
      )}

      {/* Dual DOM ladders */}
      <div className="shrink-0 grid grid-cols-2 gap-px bg-surface-border">

        {/* YES column */}
        <div className="bg-surface flex flex-col">
          <div className="flex items-center justify-center py-0.5 bg-gradient-to-b from-emerald-900/50 to-emerald-950/30 border-b border-emerald-800/30 shrink-0">
            <span className="text-[9px] font-bold tracking-widest uppercase" style={{ color: YES_COL }}>▲ YES</span>
          </div>
          <div className="flex justify-between px-1.5 py-[2px] bg-surface-card border-b border-surface-border shrink-0">
            <span className="text-[8px] text-slate-500 font-mono">Price</span>
            <span className="text-[8px] text-slate-500 font-mono">Vol</span>
          </div>
          {loading && !book && <div className="h-[18px] text-center text-[9px] text-slate-500 animate-pulse flex items-center justify-center">…</div>}
          {error && !book && <div className="h-[18px] text-[9px] text-red-400 flex items-center justify-center">{error}</div>}
          {yesAsks.map((a, i) => <BookRow key={i} level={a} maxSz={maxSzY} type="ask" side="yes" onClick={c => setBookClickPrice({ outcome: 'yes', cents: c })} />)}
          <MidRow cents={yesMidCts} side="yes" />
          {yesBids.map((b, i) => <BookRow key={i} level={b} maxSz={maxSzY} type="bid" side="yes" onClick={c => setBookClickPrice({ outcome: 'yes', cents: c })} />)}
          <div className="px-1.5 py-[3px] border-t border-surface-border bg-surface-card/50 text-[8px] font-mono shrink-0">
            <div className="text-emerald-500 tabular-nums">B {book?.best_bid != null ? `${Math.round(book.best_bid * 100)}¢` : '—'}</div>
            <div className="text-red-500 tabular-nums">A {book?.best_ask != null ? `${Math.round(book.best_ask * 100)}¢` : '—'}</div>
          </div>
        </div>

        {/* NO column */}
        <div className="bg-surface flex flex-col">
          <div className="flex items-center justify-center py-0.5 bg-gradient-to-b from-red-900/50 to-red-950/30 border-b border-red-800/30 shrink-0">
            <span className="text-[9px] font-bold tracking-widest uppercase" style={{ color: NO_COL }}>▼ NO</span>
          </div>
          <div className="flex justify-between px-1.5 py-[2px] bg-surface-card border-b border-surface-border shrink-0">
            <span className="text-[8px] text-slate-500 font-mono">Price</span>
            <span className="text-[8px] text-slate-500 font-mono">Vol</span>
          </div>
          {noAsks.map((a, i) => <BookRow key={i} level={a} maxSz={maxSzN} type="ask" side="no" onClick={c => setBookClickPrice({ outcome: 'no', cents: c })} />)}
          <MidRow cents={noMidCts} side="no" />
          {noBids.map((b, i) => <BookRow key={i} level={b} maxSz={maxSzN} type="bid" side="no" onClick={c => setBookClickPrice({ outcome: 'no', cents: c })} />)}
          <div className="px-1.5 py-[3px] border-t border-surface-border bg-surface-card/50 text-[8px] font-mono shrink-0">
            <div className="text-red-500 tabular-nums">B {book?.best_ask != null ? `${Math.round((1 - book.best_ask) * 100)}¢` : '—'}</div>
            <div className="text-emerald-500 tabular-nums">A {book?.best_bid != null ? `${Math.round((1 - book.best_bid) * 100)}¢` : '—'}</div>
          </div>
        </div>
      </div>

      {/* Cumulative volume */}
      <div className="shrink-0 grid grid-cols-2 gap-px bg-surface-border">
        <CumVolRow bids={yesBids} asks={yesAsks} side="yes" />
        <CumVolRow bids={noBids}  asks={noAsks}  side="no"  />
      </div>

    </div>
  )
}
