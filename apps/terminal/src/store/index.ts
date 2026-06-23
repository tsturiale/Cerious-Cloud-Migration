import { create } from 'zustand'
import type {
  Asset, Bar, KeltnerBands, OrderBook, TradeTick, Signal,
  Position, Trade, DailyMetrics, CopyStatus, Regime,
  MarketInfo, ProbPoint, Settlement, PolyBook, PolyTradeTick,
  KalshiMarket, IbkrMarket, CryptoPrice, MarketProvider,
  ExecutionPosition, ExecutionRisk, SimOrder, SimPosition,
  SimAlgoRole, SimOrderType,
} from '../types'
import { normalizeModel } from '../types'
import {
  calculateOpenFuturesPnl,
  resolveFuturesMultiplier,
} from '../utils/futuresPnl'

function normalizeExchangeNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeSimOrder(order: SimOrder): SimOrder {
  const raw = order as SimOrder & Record<string, unknown>
  const id = String(raw.id ?? raw.orderId ?? raw.order_id ?? `sim-order-${Date.now()}`)
  const marketKey = String(raw.marketKey ?? raw.symbol ?? raw.product ?? 'UNKNOWN')
  const rawSide = String(raw.side ?? raw.orderSide ?? '').toLowerCase()
  const side = rawSide === 'offer' || rawSide === 'ask' || rawSide === 'sell' ? 'offer' : 'bid'
  const status = raw.status === 'partially_filled' || raw.status === 'filled' || raw.status === 'cancelled' || raw.status === 'working'
    ? raw.status
    : 'working'
  const orderType = raw.orderType === 'market' || raw.type === 'market' ? 'market' : 'limit'
  const size = Math.max(0, normalizeExchangeNumber(raw.size ?? raw.quantity))
  const remaining = Math.max(0, normalizeExchangeNumber(raw.remaining ?? raw.remainingQuantity, size))
  return {
    ...order,
    id,
    marketKey,
    outcome: raw.outcome === 'no' ? 'no' : 'yes',
    side,
    orderType,
    price: normalizeExchangeNumber(raw.price ?? raw.limitPrice),
    size,
    remaining,
    filledSize: Math.max(0, normalizeExchangeNumber(raw.filledSize, Math.max(0, size - remaining))),
    matchedVolume: Math.max(0, normalizeExchangeNumber(raw.matchedVolume)),
    status,
    createdAt: normalizeExchangeNumber(raw.createdAt ?? raw.timestampMs, Date.now()),
    updatedAt: normalizeExchangeNumber(raw.updatedAt ?? raw.timestampMs, Date.now()),
    operator: String(raw.operator ?? raw.operatorId ?? 'tsturiale'),
    source: raw.source === 'algo' ? 'algo' : 'manual',
    strategy: String(raw.strategy ?? ''),
    legId: String(raw.legId ?? raw.leg_id ?? `${marketKey}-${id}`),
  }
}

function normalizeSimPosition(position: SimPosition): SimPosition {
  const raw = position as SimPosition & Record<string, unknown>
  const id = String(raw.id ?? raw.positionId ?? raw.position_id ?? `sim-position-${raw.marketKey ?? raw.symbol ?? 'UNKNOWN'}`)
  const marketKey = String(raw.marketKey ?? raw.symbol ?? 'UNKNOWN')
  const size = normalizeExchangeNumber(raw.size ?? raw.qty)
  const avgPrice = normalizeExchangeNumber(raw.avgPrice ?? raw.averagePrice)
  const markPrice = normalizeExchangeNumber(raw.markPrice ?? raw.marketPrice, avgPrice)
  const openPnl = normalizeExchangeNumber(raw.openPnl)
  const realizedPnl = normalizeExchangeNumber(raw.realizedPnl)
  return {
    ...position,
    id,
    marketKey,
    outcome: raw.outcome === 'no' ? 'no' : 'yes',
    size,
    avgPrice,
    markPrice,
    openPnl,
    realizedPnl,
    totalPnl: normalizeExchangeNumber(raw.totalPnl, openPnl + realizedPnl),
    status: raw.status === 'closed' ? 'closed' : 'open',
    openedAt: normalizeExchangeNumber(raw.openedAt, Date.now()),
    closedAt: raw.closedAt == null ? undefined : normalizeExchangeNumber(raw.closedAt),
    operator: String(raw.operator ?? raw.operatorId ?? 'tsturiale'),
    source: raw.source === 'algo' ? 'algo' : 'manual',
    strategy: String(raw.strategy ?? ''),
    legId: String(raw.legId ?? raw.leg_id ?? `${marketKey}-${id}`),
  }
}

function normalizeExchangeFills(fills: Record<string, PolyTradeTick[]>): Record<string, PolyTradeTick[]> {
  return Object.fromEntries(Object.entries(fills).map(([marketKey, rows]) => [
    marketKey,
    rows.map((fill, index) => {
      const raw = fill as PolyTradeTick & Record<string, unknown>
      return {
        ...fill,
        timestamp: normalizeExchangeNumber(raw.timestamp ?? raw.timestampMs ?? raw.ts, Date.now()),
        marketKey: String(raw.marketKey ?? raw.symbol ?? marketKey),
        price: normalizeExchangeNumber(raw.price ?? raw.match_price),
        size: normalizeExchangeNumber(raw.size ?? raw.qty ?? raw.match_qty),
        side: ['no', 'sell', 'offer', 'ask'].includes(String(raw.side ?? '').toLowerCase()) ? 'no' : 'yes',
        orderId: String(raw.orderId ?? raw.order_id ?? `fill-${marketKey}-${index}`),
      } as PolyTradeTick
    }),
  ]))
}

interface TerminalState {
  // Asset selection
  activeAsset: Asset
  setActiveAsset: (a: Asset) => void

  // Market data
  bars: Record<Asset, Bar[]>
  bands: Record<Asset, KeltnerBands | null>
  orderBook: Record<Asset, OrderBook | null>
  ticks: Record<Asset, TradeTick[]>
  zscore: Record<Asset, number>
  regime: Record<Asset, Regime>

  // Signals
  signals: Record<Asset, Signal[]>

  // Positions & journal
  positions: Position[]
  trades: Trade[]

  // Metrics
  metrics: DailyMetrics | null

  // EdgeCopy
  copyStatus: CopyStatus | null

  // ExecutionAgent
  executionPositions: ExecutionPosition[]
  executionRisk: ExecutionRisk | null

  // Sim Exchange microservice
  simulationEnabled: boolean
  simOrders: SimOrder[]
  simPositions: SimPosition[]
  simMessages: string[]
  setSimulationEnabled: (v: boolean) => void
  setSimTradingState: (state: {
    simOrders?: SimOrder[]
    simPositions?: SimPosition[]
    fills?: Record<string, PolyTradeTick[]>
    simMessages?: string[]
  }) => void
  placeSimOrder: (order: {
    id?: string
    marketKey: string
    outcome: 'yes' | 'no'
    side: 'bid' | 'offer'
    orderType?: SimOrderType
    price: number
    size: number
    operator: string
    source?: 'manual' | 'algo'
    strategy?: string
    legId?: string
    orderTag?: string
    algoRole?: SimAlgoRole
    algoId?: string
    algoName?: string
    parentOrderId?: string
    layer?: number
    trigger?: string
    coverTicksFromFill?: number
    coverTickSize?: number
    tickSize?: number
    tickValue?: number
    multiplier?: number
  }) => string
  cancelSimOrder: (id: string) => void
  cancelSimOrders: (filter?: { marketKey?: string; outcome?: 'yes' | 'no'; side?: 'bid' | 'offer'; source?: 'manual' | 'algo'; algoId?: string }) => void
  clearSimMessages: () => void
  resetTradingSession: () => void

  // Polymarket live markets
  markets: MarketInfo[]
  probHistory: Record<string, ProbPoint[]>   // key = "BTC_15min"
  activeMarketKey: string | null             // currently selected market card
  usingLiveData: boolean

  // ── Polymarket order books (WS-pushed every 3 s by _book_poller) ─────────
  polyBooks: Record<string, PolyBook>        // market_key → latest book
  polyTicks: Record<string, PolyTradeTick[]> // market_key → latest tape ticks (max 200)

  // ── Polymarket fills history (persisted per market for session) ──────────
  fills: Record<string, PolyTradeTick[]>     // market_key → all fills in this market (session-long)

  // ── Settlement history ────────────────────────────────────────────────────
  settlements: Settlement[]                  // most-recent-first

  // Connection
  connected: boolean
  setConnected: (v: boolean) => void

  // ── Auto-rotation ────────────────────────────────────────────────────────
  autoRotate: boolean
  setAutoRotate: (v: boolean) => void

  // ── Market Provider Selection ─────────────────────────────────────────────
  marketProvider: MarketProvider
  setMarketProvider: (p: MarketProvider) => void

  // ── Crypto spot prices (Binance) ──────────────────────────────────────────
  cryptoPrices: Record<string, CryptoPrice>
  setCryptoPrices: (data: Record<string, CryptoPrice>) => void

  // ── Kalshi markets ────────────────────────────────────────────────────────
  kalshiMarkets: KalshiMarket[]
  setKalshiMarkets: (m: KalshiMarket[]) => void

  // ── IBKR ForecastTrader markets ───────────────────────────────────────────
  ibkrMarkets: IbkrMarket[]
  setIbkrMarkets: (m: IbkrMarket[]) => void

  // ── Popped-out tabs ───────────────────────────────────────────────────────
  poppedTabs: Set<string>
  toggleTabPop: (tabId: string) => void

  // ── DOM click — set when user clicks a book level ────────────────────────
  bookClickPrice: { outcome: 'yes' | 'no'; cents: number } | null
  setBookClickPrice: (v: { outcome: 'yes' | 'no'; cents: number } | null) => void

  // Updaters
  pushBar: (asset: Asset, bar: Bar) => void
  setBands: (asset: Asset, b: KeltnerBands) => void
  setBook: (asset: Asset, b: OrderBook) => void
  pushTick: (asset: Asset, t: TradeTick) => void
  setZscore: (asset: Asset, z: number, r: Regime) => void
  pushSignal: (s: Signal) => void
  setPositions: (p: Position[]) => void
  setMetrics: (m: DailyMetrics) => void
  setCopyStatus: (c: CopyStatus) => void
  loadSnapshot: (asset: Asset, data: any) => void

  // ExecutionAgent updaters
  setExecutionPositions: (p: ExecutionPosition[]) => void
  setExecutionRisk: (r: ExecutionRisk) => void

  // Market updaters
  setMarkets: (markets: MarketInfo[], live?: boolean) => void
  /** Select a market card — also syncs activeAsset to the market's asset. */
  setActiveMarketKey: (k: string | null) => void
  /** Merge externally-fetched probability history points (e.g. from /api/poly/prices-history). */
  mergeProbHistory: (key: string, points: ProbPoint[]) => void

  // PolyBook updater (WS push from _book_poller)
  setPolyBook: (key: string, book: PolyBook) => void
  pushPolyTick: (key: string, tick: PolyTradeTick) => void
  /** Append fill to market-specific history (persisted for session). */
  pushPolyFill: (key: string, tick: PolyTradeTick) => void

  // Settlement updaters
  /** Replace the full settlement list (from snapshot or API fetch). */
  setSettlements: (s: Settlement[]) => void
}

const ASSETS: Asset[] = ['ES', 'NQ', 'YM', 'RTY', 'CL', 'GC', 'ZM', 'ZS', 'ES_NQ', 'YM_ES', 'RTY_ES', 'BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'BNB', 'DOGE', 'EVENT']
const initRecord = <T>(v: T) => Object.fromEntries(ASSETS.map(a => [a, v])) as Record<Asset, T>

function finiteNumber(value: unknown): number | null {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function yesPriceFromBook(book: PolyBook): number | null {
  const ltp = finiteNumber(book.ltp)
  if (ltp !== null) return ltp
  const mid = finiteNumber(book.mid)
  if (mid !== null) return mid
  const bid = finiteNumber(book.best_bid)
  const ask = finiteNumber(book.best_ask)
  if (bid !== null && ask !== null) return (bid + ask) / 2
  return bid ?? ask
}

function signedExecutionPositionSize(direction: string, size: number): number {
  const normalized = direction.toUpperCase()
  if (normalized.includes('DOWN') || normalized.includes('SHORT') || normalized.includes('SELL')) return -Math.abs(size)
  return Math.abs(size)
}

function executionPositionMatchesMarket(position: ExecutionPosition, marketKey: string): boolean {
  return String(position.asset || '').trim().toUpperCase() === String(marketKey || '').trim().toUpperCase()
}

function markOpenExecutionPositionsToPrice(
  positions: ExecutionPosition[],
  marketKey: string,
  markPrice: number | null,
): ExecutionPosition[] {
  if (markPrice === null || !Number.isFinite(markPrice)) return positions
  let changed = false
  const next = positions.map(position => {
    if (!executionPositionMatchesMarket(position, marketKey) || /closed|filled|cancel/i.test(position.status)) return position
    const entryPrice = Number(position.entry_price)
    const contracts = signedExecutionPositionSize(position.direction, Number(position.size) || 0)
    if (!Number.isFinite(entryPrice) || !Number.isFinite(contracts)) return position
    const multiplier = resolveFuturesMultiplier(position.asset, (position as ExecutionPosition & { multiplier?: number }).multiplier, entryPrice)
    const openPnl = calculateOpenFuturesPnl(entryPrice, markPrice, contracts, multiplier)
    if (position.current_price === markPrice && position.unrealized_pnl === openPnl) return position
    changed = true
    return {
      ...position,
      current_price: markPrice,
      unrealized_pnl: openPnl,
    }
  })
  return changed ? next : positions
}

function markOpenExecutionPositionsFromBook(positions: ExecutionPosition[], marketKey: string, book: PolyBook): ExecutionPosition[] {
  return markOpenExecutionPositionsToPrice(positions, marketKey, yesPriceFromBook(book))
}

function markOpenExecutionPositions(positions: ExecutionPosition[], marketKey: string, tick: PolyTradeTick): ExecutionPosition[] {
  return markOpenExecutionPositionsToPrice(positions, marketKey, tick.price)
}

function markOpenExecutionPositionsFromKnownMarkets(
  positions: ExecutionPosition[],
  books: Record<string, PolyBook>,
  ticks: Record<string, PolyTradeTick[]>,
): ExecutionPosition[] {
  let next = positions
  for (const [marketKey, book] of Object.entries(books)) {
    next = markOpenExecutionPositionsFromBook(next, marketKey, book)
  }
  for (const [marketKey, series] of Object.entries(ticks)) {
    const latest = series.at(-1)
    if (latest) next = markOpenExecutionPositions(next, marketKey, latest)
  }
  return next
}

export const useStore = create<TerminalState>((set, get) => ({
  activeAsset: 'ES',
  setActiveAsset: (a) => {
    const { markets } = get()
    // Prefer shortest live timeframe. Polymarket contracts expire internally,
    // but the terminal treats each asset/timeframe as a continuous slot.
    const TF_PREF = ['5min', '15min', '1h', '4h'] as const
    const live = markets.filter(m => m.asset === a && m.live)
    const best = TF_PREF
      .map(tf => live.find(m => m.timeframe === tf && !(m.up_pct === 50 && m.down_pct === 50)))
      .find(Boolean) ?? live[0]
    set({ activeAsset: a, activeMarketKey: best ? best.key : null })
  },

  bars: initRecord<Bar[]>([]),
  bands: initRecord<KeltnerBands | null>(null),
  orderBook: initRecord<OrderBook | null>(null),
  ticks: initRecord<TradeTick[]>([]),
  zscore: initRecord<number>(0),
  regime: initRecord<Regime>('medium'),
  signals: initRecord<Signal[]>([]),

  positions: [],
  trades: [],
  metrics: null,
  copyStatus: null,

  // ExecutionAgent
  executionPositions: [],
  executionRisk: null,

  // Sim Exchange microservice
  simulationEnabled: true,
  simOrders: [],
  simPositions: [],
  simMessages: [],

  connected: false,
  autoRotate: false,
  setAutoRotate: (v) => set({ autoRotate: v }),

  marketProvider: 'cme',
  setMarketProvider: (p) => set({ marketProvider: p }),

  cryptoPrices: {},
  setCryptoPrices: (data) => set({ cryptoPrices: data }),

  kalshiMarkets: [],
  setKalshiMarkets: (m) => set({ kalshiMarkets: m }),

  ibkrMarkets: [],
  setIbkrMarkets: (m) => set({ ibkrMarkets: m }),

  // Live market state
  markets: [],
  probHistory: {},
  activeMarketKey: null,
  usingLiveData: false,

  // Polymarket order books
  polyBooks: {},
  polyTicks: {},

  // Fills history (persisted per market, session-long)
  fills: {},

  // Settlement history
  settlements: [],

  poppedTabs: new Set<string>(),
  toggleTabPop: (tabId) => set(s => {
    const next = new Set(s.poppedTabs)
    if (next.has(tabId)) next.delete(tabId); else next.add(tabId);
    return { poppedTabs: next }
  }),

  bookClickPrice: null,
  setBookClickPrice: (v) => set({ bookClickPrice: v }),

  setConnected: (v) => set({ connected: v }),

  // Keep last 4 500 bars ≈ 3 days of 1-min history
  pushBar: (asset, bar) => set(s => {
    const prev = s.bars[asset]
    if (prev.length > 0 && prev[prev.length - 1].timestamp === bar.timestamp) {
      const updated = [...prev]
      updated[updated.length - 1] = bar
      return { bars: { ...s.bars, [asset]: updated } }
    }
    return { bars: { ...s.bars, [asset]: [...prev.slice(-4499), bar] } }
  }),

  setBands: (asset, b) => set(s => ({
    bands: { ...s.bands, [asset]: b }
  })),

  setBook: (asset, b) => set(s => ({
    orderBook: { ...s.orderBook, [asset]: b }
  })),

  pushTick: (asset, t) => set(s => ({
    ticks: { ...s.ticks, [asset]: [...s.ticks[asset].slice(-49), t] }
  })),

  setZscore: (asset, z, r) => set(s => ({
    zscore: { ...s.zscore, [asset]: z },
    regime: { ...s.regime, [asset]: r },
  })),

  pushSignal: (sig) => set(s => {
    const normalized = { ...sig, model: normalizeModel(sig.model) }
    const prev = s.signals[normalized.asset as Asset] ?? []
    const filtered = prev.filter(x => x.model !== normalized.model)
    return { signals: { ...s.signals, [normalized.asset]: [...filtered, normalized].slice(-8) } }
  }),

  setPositions: (p) => set({ positions: p }),
  setMetrics: (m) => set({ metrics: m }),
  setCopyStatus: (c) => set({ copyStatus: c }),

  // ExecutionAgent
  setExecutionPositions: (p) => set(s => ({
    executionPositions: markOpenExecutionPositionsFromKnownMarkets(p, s.polyBooks, s.polyTicks),
  })),
  setExecutionRisk: (r) => set({ executionRisk: r }),

  setSimulationEnabled: (v) => set(s => ({
    simulationEnabled: v,
    simMessages: [`Sim Exchange ${v ? 'enabled' : 'disabled'}.`, ...s.simMessages].slice(0, 50),
  })),
  setSimTradingState: (state) => set(s => ({
    simOrders: state.simOrders ? state.simOrders.map(normalizeSimOrder) : s.simOrders,
    simPositions: state.simPositions ? state.simPositions.map(normalizeSimPosition) : s.simPositions,
    fills: state.fills ? normalizeExchangeFills(state.fills) : s.fills,
    simMessages: state.simMessages ?? s.simMessages,
  })),
  placeSimOrder: (order) => {
    const id = order.id ?? `sim-${order.marketKey}-${order.outcome}-${order.side}-${order.price}-${Date.now()}`
    set(s => ({
      simMessages: [
        `Order ${id} was not applied locally. Waiting for native exchange snapshot.`,
        ...s.simMessages,
      ].slice(0, 50),
    }))
    return id
  },
  cancelSimOrder: (id) => set(s => ({
    simMessages: [`Cancel ${id} must be confirmed by the native exchange.`, ...s.simMessages].slice(0, 50),
  })),
  cancelSimOrders: (filter) => set(s => {
    void filter
    return {
      simMessages: [`Cancel-all must be confirmed by the native exchange.`, ...s.simMessages].slice(0, 50),
    }
  }),
  clearSimMessages: () => set({ simMessages: [] }),
  resetTradingSession: () => set({
    executionPositions: [],
    executionRisk: null,
    simOrders: [],
    simPositions: [],
    fills: {},
    simMessages: [`Session reset ${new Date().toISOString()}. Local orders, fills, and positions cleared.`],
  }),

  // Merge incoming market array
  setMarkets: (incoming, live = false) => set(s => {
    const newProbHistory = { ...s.probHistory }
    const newFills = { ...s.fills }
    const newPolyTicks = { ...s.polyTicks }
    const newPolyBooks = { ...s.polyBooks }

    // Detect period rotation: same slot key, new condition_id.
    // Clear stale per-period data so all downstream components start clean.
    incoming.forEach(m => {
      if (!m.condition_id) return
      const prev = s.markets.find(pm => pm.key === m.key)
      if (prev?.condition_id && prev.condition_id !== m.condition_id) {
        // New period for this slot — wipe ticks, book, and old prob history
        delete newPolyTicks[m.key]
        delete newPolyBooks[m.key]
        delete newProbHistory[m.key]   // will be re-seeded from m.prob_history below
      }
    })

    const updatedMarkets: MarketInfo[] = incoming.map(m => {
      if (m.prob_history && m.prob_history.length > 0) {
        const existing = newProbHistory[m.key] ?? []
        const merged = [...existing, ...m.prob_history]
          .filter((v, i, arr) => arr.findIndex(x => x.ts === v.ts) === i)
          .sort((a, b) => a.ts - b.ts)
          .slice(-4320)
        newProbHistory[m.key] = merged
      }
      const { prob_history: _ph, ...rest } = m
      return rest
    })
    // Clean up fills for markets no longer in the list (expired)
    const incomingKeys = new Set(incoming.map(m => m.key))
    Object.keys(newFills).forEach(key => {
      if (!incomingKeys.has(key)) {
        delete newFills[key]
      }
    })
    const hasLive = live || incoming.some(m => m.live) || s.usingLiveData

    // Keep the selected market pointed at a live continuous slot. Contract
    // expiry is an internal rollover detail and should not make a pair vanish.
    let nextKey = s.activeMarketKey
    const current = nextKey ? updatedMarkets.find(m => m.key === nextKey) : undefined
    if (hasLive && (!current || !current.live)) {
      const asset = s.activeMarketKey
        ? s.activeMarketKey.split('_')[0]
        : (updatedMarkets.find(m => m.live)?.asset ?? 'ES')
      const TF_PREF = ['5min', '15min', '1h', '4h']
      const live  = updatedMarkets.filter(m => m.asset === asset && m.live)
      const best  = TF_PREF
        .map(tf => live.find(m => m.timeframe === tf && !(m.up_pct === 50 && m.down_pct === 50)))
        .find(Boolean) ?? live[0] ?? updatedMarkets.find(m => m.live)
      if (best) nextKey = best.key
    }

    return {
      markets: updatedMarkets,
      probHistory: newProbHistory,
      fills: newFills,
      polyTicks: newPolyTicks,
      polyBooks: newPolyBooks,
      usingLiveData: hasLive,
      activeMarketKey: nextKey,
    }
  }),

  /**
   * Select a market card by key.
   * Also updates activeAsset so the main OHLCV chart auto-switches to
   * the selected market's underlying asset.
   */
  setActiveMarketKey: (k) => set(s => {
    if (!k) return { activeMarketKey: null }
    const market = s.markets.find(m => m.key === k)
    return {
      activeMarketKey: k,
      ...(market ? { activeAsset: market.asset as Asset } : {}),
    }
  }),

  setPolyBook: (key, book) => set(s => {
    const prev = s.polyBooks[key]
    if (prev) {
      const prevSeen = (prev as PolyBook & { seen_ms?: number }).seen_ms ?? prev.timestamp_ms
      const nextSeen = (book as PolyBook & { seen_ms?: number }).seen_ms ?? book.timestamp_ms
      if (nextSeen < prevSeen) return s
    }
    return { polyBooks: { ...s.polyBooks, [key]: book } }
  }),

  pushPolyTick: (key, tick) => set(s => {
    const prev = s.polyTicks[key] ?? []
    const last = prev[prev.length - 1]
    if (
      last
      && last.timestamp === tick.timestamp
      && last.price === tick.price
      && last.size === tick.size
      && last.side === tick.side
    ) {
      return s
    }
    const nextPolyTicks = {
      ...s.polyTicks,
      [key]: [...prev.slice(-199), tick],
    }
    return { polyTicks: nextPolyTicks }
  }),

  pushPolyFill: (key, tick) => set(s => {
    const prev = s.fills[key] ?? []
    // Dedup by composite key — timestamp alone collapses trades in the same second
    const tickKey = (t: PolyTradeTick) => `${t.timestamp}-${t.price}-${t.size}-${t.side}`
    const exists = prev.some(f => tickKey(f) === tickKey(tick))
    if (exists) return s
    // Cap at 100 most recent trades (prevents unbounded growth)
    const capped = [...prev, tick].slice(-100)
    return {
      fills: {
        ...s.fills,
        [key]: capped,
      },
    }
  }),

  setSettlements: (s) => set({ settlements: s }),

  /** Merge externally-fetched prob history (from /api/poly/prices-history backfill). */
  mergeProbHistory: (key, points) => set(s => {
    const existing = s.probHistory[key] ?? []
    const merged = [...points, ...existing]
      .filter((v, i, arr) => arr.findIndex(x => x.ts === v.ts) === i)
      .sort((a, b) => a.ts - b.ts)
      .slice(-4320)
    return { probHistory: { ...s.probHistory, [key]: merged } }
  }),

  loadSnapshot: (asset, data) => {
    const s = get()
    const snapshotPolyBooks = { ...s.polyBooks, ...(data.poly_books ?? {}) }
    const snapshotPolyTicks = { ...s.polyTicks, ...(data.poly_ticks ?? {}) }
    const snapshotExecutionPositions = markOpenExecutionPositionsFromKnownMarkets(
      (data.execution_positions ?? []) as ExecutionPosition[],
      snapshotPolyBooks,
      snapshotPolyTicks,
    )
    const newState: Partial<TerminalState> = {
      bars: { ...s.bars, [asset]: data.bars ?? [] },
      bands: { ...s.bands, [asset]: data.bands ?? null },
      zscore: { ...s.zscore, [asset]: data.zscore ?? 0 },
      regime: { ...s.regime, [asset]: data.regime ?? 'medium' },
      signals: { ...s.signals, [asset]: (data.signals ?? []).map((sig: Signal) => ({ ...sig, model: normalizeModel(sig.model) })) },
      positions: data.positions ?? [],
      metrics: data.metrics ?? null,
      copyStatus: data.copy_status ?? null,
      // ExecutionAgent — these arrive in the WS snapshot as execution_positions
      executionPositions: snapshotExecutionPositions,
      executionRisk: (data.execution_risk ?? null) as ExecutionRisk | null,
      polyBooks: snapshotPolyBooks,
      polyTicks: snapshotPolyTicks,
    }
    if (data.order_state) {
      newState.simOrders = data.order_state.simOrders ?? s.simOrders
      newState.simPositions = data.order_state.simPositions ?? s.simPositions
      newState.fills = data.order_state.fills ?? s.fills
      newState.simMessages = data.order_state.simMessages ?? s.simMessages
    }
    if (data.markets) {
      // Inline setMarkets logic for snapshot
      const newProbHistory = { ...s.probHistory }
      const updatedMarkets: MarketInfo[] = (data.markets as MarketInfo[]).map(m => {
        if (m.prob_history && m.prob_history.length > 0) {
          const existing = s.probHistory[m.key] ?? []
          const merged = [...existing, ...m.prob_history]
            .filter((v, i, arr) => arr.findIndex(x => x.ts === v.ts) === i)
            .sort((a, b) => a.ts - b.ts)
            .slice(-4320)
          newProbHistory[m.key] = merged
        }
        const { prob_history: _ph, ...rest } = m as any
        return rest
      })
      newState.markets = updatedMarkets
      newState.probHistory = newProbHistory
      if ((data.markets as MarketInfo[]).some(m => m.live)) {
        newState.usingLiveData = true
      }
    }
    set(newState as any)
  },
}))
