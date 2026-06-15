import { create } from 'zustand'
import type {
  Asset, Bar, KeltnerBands, OrderBook, TradeTick, Signal,
  Position, Trade, DailyMetrics, CopyStatus, Regime,
  MarketInfo, ProbPoint, Settlement, PolyBook, PolyTradeTick,
  KalshiMarket, IbkrMarket, CryptoPrice, MarketProvider,
  ExecutionPosition, ExecutionRisk, SimOrder, SimPosition, SimFill,
  SimAlgoRole, SimOrderType,
} from '../types'
import { normalizeModel } from '../types'

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

const SIM_EXCHANGE = 'Sim Exchange' as const
const MIN_SIM_TRADE_EVIDENCE = 2

type SimProductSpec = {
  tickSize: number
  multiplier: number
  tickValue: number
}

const SIM_PRODUCT_SPECS: Record<string, SimProductSpec> = {
  ES: { tickSize: 0.25, multiplier: 50, tickValue: 12.5 },
  NQ: { tickSize: 0.25, multiplier: 20, tickValue: 5 },
  YM: { tickSize: 1, multiplier: 5, tickValue: 5 },
  RTY: { tickSize: 0.1, multiplier: 50, tickValue: 5 },
  CL: { tickSize: 0.01, multiplier: 1000, tickValue: 10 },
  GC: { tickSize: 0.1, multiplier: 100, tickValue: 10 },
  ZM: { tickSize: 0.1, multiplier: 100, tickValue: 10 },
  ZS: { tickSize: 0.25, multiplier: 50, tickValue: 12.5 },
  ES_NQ: { tickSize: 0.25, multiplier: 150, tickValue: 37.5 },
  YM_ES: { tickSize: 1, multiplier: 15, tickValue: 15 },
  RTY_ES: { tickSize: 0.1, multiplier: 350, tickValue: 35 },
}

function priceForOutcome(tick: PolyTradeTick, outcome: 'yes' | 'no'): number {
  if (tick.side === outcome) return tick.price
  return 100 - tick.price
}

function isRawFuturesPrice(price: number): boolean {
  return Number.isFinite(price) && (price < 0 || price > 1)
}

function bookUsesRawPrices(book: PolyBook | undefined, ticks?: PolyTradeTick[]): boolean {
  const bookPrices = [
    book?.best_bid,
    book?.best_ask,
    book?.mid,
    ...(book?.bids ?? []).map(level => level.price),
    ...(book?.asks ?? []).map(level => level.price),
  ].filter((price): price is number => Number.isFinite(price))
  return bookPrices.some(isRawFuturesPrice) || (ticks ?? []).some(tick => isRawFuturesPrice(tick.price))
}

function simDisplayPrice(price: number, rawPrices: boolean): number {
  return rawPrices ? price : cents(price)
}

function simProductSpec(marketKey: string, price?: number): SimProductSpec {
  const spec = SIM_PRODUCT_SPECS[marketKey.toUpperCase()]
  if (spec) return spec
  const rawPrices = typeof price === 'number' && isRawFuturesPrice(price)
  const tickSize = rawPrices ? 0.01 : 1
  const multiplier = rawPrices ? 1 : 0.01
  return { tickSize, multiplier, tickValue: tickSize * multiplier }
}

function simContractMultiplier(orderOrPosition: Pick<SimOrder | SimPosition | SimFill, 'marketKey' | 'multiplier'>, price: number): number {
  if (Number.isFinite(orderOrPosition.multiplier ?? NaN) && Number(orderOrPosition.multiplier) > 0) {
    return Number(orderOrPosition.multiplier)
  }
  return simProductSpec(orderOrPosition.marketKey, price).multiplier
}

function simDollarPnl(marketKey: string, fromPrice: number, toPrice: number, size: number, multiplier?: number): number {
  const appliedMultiplier = Number.isFinite(multiplier ?? NaN) && Number(multiplier) > 0
    ? Number(multiplier)
    : simProductSpec(marketKey, fromPrice).multiplier
  return (toPrice - fromPrice) * size * appliedMultiplier
}

function simPriceLabel(price: number): string {
  if (!Number.isFinite(price)) return '-'
  return isRawFuturesPrice(price) ? price.toFixed(Math.abs(price) >= 100 ? 2 : 3) : `${price.toFixed(1)}c`
}

function simUsesRawProduct(order: Pick<SimOrder, 'marketKey' | 'price' | 'multiplier'>): boolean {
  return Boolean(SIM_PRODUCT_SPECS[order.marketKey.toUpperCase()])
    || isRawFuturesPrice(order.price)
    || (Number.isFinite(order.multiplier ?? NaN) && Number(order.multiplier) > 1)
}

function simOrderSideLabel(order: Pick<SimOrder, 'marketKey' | 'outcome' | 'side' | 'price' | 'multiplier'>): string {
  if (simUsesRawProduct(order)) return order.side === 'bid' ? 'BUY' : 'SELL'
  return `${order.outcome.toUpperCase()} ${order.side.toUpperCase()}`
}

function simDisplaySide(order: Pick<SimOrder, 'marketKey' | 'outcome' | 'side' | 'price' | 'multiplier'>): string {
  if (simUsesRawProduct(order)) return order.side === 'bid' ? 'BUY' : 'SELL'
  return order.outcome.toUpperCase()
}

function simCrosses(incoming: SimOrder, resting: SimOrder): boolean {
  if (incoming.marketKey !== resting.marketKey || incoming.outcome !== resting.outcome || incoming.side === resting.side) return false
  if (incoming.orderType === 'market') return true
  return incoming.side === 'bid'
    ? incoming.price >= resting.price
    : incoming.price <= resting.price
}

function sortRestingForMatch(incoming: SimOrder, orders: SimOrder[]): SimOrder[] {
  return orders
    .filter(order => (
      order.id !== incoming.id
      && order.marketKey === incoming.marketKey
      && order.outcome === incoming.outcome
      && order.side !== incoming.side
      && (order.status === 'working' || order.status === 'partially_filled')
      && order.remaining > 0
      && simCrosses(incoming, order)
    ))
    .sort((a, b) => {
      const priceRank = incoming.side === 'bid' ? a.price - b.price : b.price - a.price
      if (priceRank !== 0) return priceRank
      return a.createdAt - b.createdAt
    })
}

function simFillTick(fill: SimFill): PolyTradeTick {
  return {
    timestamp: fill.timestamp,
    marketKey: fill.marketKey,
    price: fill.price,
    size: fill.size,
    side: fill.side,
    displaySide: fill.displaySide,
    orderSide: fill.orderSide,
    exchange: fill.exchange,
    orderId: fill.orderId,
  } as PolyTradeTick & { exchange: typeof SIM_EXCHANGE; orderId: string }
}

function cents(price: number): number {
  return Math.max(1, Math.min(99, Math.round(price * 100)))
}

function marketPriceSatisfiesOrder(order: SimOrder, marketPrice: number): boolean {
  if (!Number.isFinite(marketPrice)) return false
  if (order.orderType === 'market') return true
  return order.side === 'bid'
    ? marketPrice <= order.price
    : marketPrice >= order.price
}

type VisibleMarketMatch = { price: number; size: number; contraId: string }

function visibleBookCounterparties(order: SimOrder, book: PolyBook | undefined): VisibleMarketMatch[] {
  if (!book) return []
  const rawPrices = bookUsesRawPrices(book)

  const byPrice = (matches: VisibleMarketMatch[]) => matches
    .filter(match => match.size >= MIN_SIM_TRADE_EVIDENCE && marketPriceSatisfiesOrder(order, match.price))
    .sort((a, b) => order.side === 'bid' ? a.price - b.price : b.price - a.price)

  if (rawPrices) {
    return order.side === 'bid'
      ? byPrice(book.asks.map(level => ({ price: simDisplayPrice(level.price, true), size: level.size, contraId: 'visible-ask' })))
      : byPrice(book.bids.map(level => ({ price: simDisplayPrice(level.price, true), size: level.size, contraId: 'visible-bid' })))
  }

  if (order.outcome === 'yes' && order.side === 'bid') {
    return byPrice(book.asks.map(level => ({ price: cents(level.price), size: level.size, contraId: 'visible-yes-ask' })))
  }
  if (order.outcome === 'yes' && order.side === 'offer') {
    return byPrice(book.bids.map(level => ({ price: cents(level.price), size: level.size, contraId: 'visible-yes-bid' })))
  }
  if (order.outcome === 'no' && order.side === 'bid') {
    return byPrice(book.bids.map(level => ({ price: 100 - cents(level.price), size: level.size, contraId: 'visible-no-ask' })))
  }
  return byPrice(book.asks.map(level => ({ price: 100 - cents(level.price), size: level.size, contraId: 'visible-no-bid' })))
}

function lastExternalPrint(order: SimOrder, ticks: PolyTradeTick[] | undefined): VisibleMarketMatch | null {
  const last = [...(ticks ?? [])].reverse().find(tick => (tick as PolyTradeTick & Record<string, unknown>).exchange !== SIM_EXCHANGE)
  if (!last) return null
  const rawPrices = bookUsesRawPrices(undefined, ticks)
  return {
    price: rawPrices ? last.price : Math.round(priceForOutcome(last, order.outcome)),
    size: last.size,
    contraId: 'last-external-print',
  }
}

function visibleMarketMatches(order: SimOrder, book: PolyBook | undefined, ticks: PolyTradeTick[] | undefined): VisibleMarketMatch[] {
  const bookMatches = visibleBookCounterparties(order, book)
  if (bookMatches.length > 0) return bookMatches

  const print = lastExternalPrint(order, ticks)
  if (!print) return []
  if (print.size < MIN_SIM_TRADE_EVIDENCE) return []
  if (!marketPriceSatisfiesOrder(order, print.price)) return []
  return [print]
}

function publishSimFill(
  filledOrder: SimOrder,
  size: number,
  price: number,
  timestamp: number,
  contraId: string,
  fills: Record<string, PolyTradeTick[]>,
  polyTicks: Record<string, PolyTradeTick[]>,
  simPositions: SimPosition[],
  messages: string[],
): {
  fills: Record<string, PolyTradeTick[]>
  polyTicks: Record<string, PolyTradeTick[]>
  simPositions: SimPosition[]
} {
  const fill: SimFill = {
    timestamp,
    marketKey: filledOrder.marketKey,
    price,
    size,
    side: filledOrder.outcome,
    displaySide: simDisplaySide(filledOrder),
    orderSide: filledOrder.side,
    orderId: filledOrder.id,
    exchange: SIM_EXCHANGE,
    operator: filledOrder.operator,
    source: filledOrder.source,
    strategy: filledOrder.strategy,
    legId: filledOrder.legId,
    orderTag: filledOrder.orderTag,
    algoRole: filledOrder.algoRole,
    algoId: filledOrder.algoId,
    algoName: filledOrder.algoName,
    parentOrderId: filledOrder.parentOrderId,
    layer: filledOrder.layer,
    trigger: filledOrder.trigger,
    coverTicksFromFill: filledOrder.coverTicksFromFill,
    coverTickSize: filledOrder.coverTickSize,
    tickSize: filledOrder.tickSize,
    tickValue: filledOrder.tickValue,
    multiplier: filledOrder.multiplier,
    realizedPnl: 0,
  }
  const marketFills = fills[filledOrder.marketKey] ?? []
  const marketTicks = polyTicks[filledOrder.marketKey] ?? []
  const nextFills = { ...fills, [filledOrder.marketKey]: [...marketFills, fill].slice(-250) }
  const nextPolyTicks = { ...polyTicks, [filledOrder.marketKey]: [...marketTicks.slice(-199), simFillTick(fill)] }
  const nextSimPositions = updateSimPositions(simPositions, fill, filledOrder, price)
  messages.push(`Sim Exchange fill ${size}x ${simOrderSideLabel(filledOrder)} ${simPriceLabel(price)} on ${filledOrder.marketKey}; ${filledOrder.id} matched ${contraId}.`)
  return { fills: nextFills, polyTicks: nextPolyTicks, simPositions: nextSimPositions }
}

function buildAlgoCoverOrder(entryOrder: SimOrder, size: number, fillPrice: number, timestamp: number): SimOrder | null {
  if (entryOrder.source !== 'algo' || entryOrder.algoRole !== 'entry') return null
  const coverTicks = Number(entryOrder.coverTicksFromFill ?? 0)
  const tickSize = Number(entryOrder.coverTickSize ?? 0)
  if (!Number.isFinite(coverTicks) || coverTicks <= 0 || !Number.isFinite(tickSize) || tickSize <= 0) return null
  const coverSide = entryOrder.side === 'bid' ? 'offer' : 'bid'
  const direction = entryOrder.side === 'bid' ? 1 : -1
  const coverPrice = fillPrice + (direction * coverTicks * tickSize)
  const id = `${entryOrder.id}-cover-${timestamp}`
  return {
    id,
    marketKey: entryOrder.marketKey,
    outcome: entryOrder.outcome,
    side: coverSide,
    orderType: 'limit',
    price: coverPrice,
    size,
    remaining: size,
    filledSize: 0,
    matchedVolume: 0,
    status: 'working',
    createdAt: timestamp,
    updatedAt: timestamp,
    operator: entryOrder.operator,
    source: 'algo',
    strategy: entryOrder.strategy,
    legId: `${entryOrder.legId}-C${timestamp}`,
    orderTag: 'ALGO COVER',
    algoRole: 'cover',
    algoId: entryOrder.algoId,
    algoName: entryOrder.algoName,
    parentOrderId: entryOrder.id,
    layer: entryOrder.layer,
    trigger: 'entry-fill-cover',
    tickSize: entryOrder.tickSize,
    tickValue: entryOrder.tickValue,
    multiplier: entryOrder.multiplier,
  }
}

function fillWorkingOrdersFromVisibleMarket(
  orders: SimOrder[],
  marketKey: string,
  book: PolyBook | undefined,
  ticks: PolyTradeTick[] | undefined,
  fills: Record<string, PolyTradeTick[]>,
  polyTicks: Record<string, PolyTradeTick[]>,
  simPositions: SimPosition[],
  messages: string[],
): {
  simOrders: SimOrder[]
  fills: Record<string, PolyTradeTick[]>
  polyTicks: Record<string, PolyTradeTick[]>
  simPositions: SimPosition[]
} {
  let nextOrders = orders
  let nextFills = fills
  let nextPolyTicks = polyTicks
  let nextPositions = simPositions
  let coverOrders: SimOrder[] = []

  for (const order of nextOrders) {
    if (order.marketKey !== marketKey) continue
    if (order.status !== 'working' && order.status !== 'partially_filled') continue
    if (order.remaining <= 0) continue
    let working = order
    for (const match of visibleMarketMatches(working, book, ticks)) {
      if (working.remaining <= 0) break
      const ts = Date.now()
      const fillSize = Math.min(working.remaining, match.size)
      if (fillSize <= 0) continue
      const remaining = working.remaining - fillSize
      const updatedOrder: SimOrder = {
        ...working,
        remaining,
        filledSize: working.filledSize + fillSize,
        matchedVolume: working.matchedVolume + fillSize,
        status: remaining === 0 ? 'filled' : 'partially_filled',
        updatedAt: ts,
      }
      const published = publishSimFill(updatedOrder, fillSize, match.price, ts, match.contraId, nextFills, nextPolyTicks, nextPositions, messages)
      nextFills = published.fills
      nextPolyTicks = published.polyTicks
      nextPositions = published.simPositions
      const coverOrder = buildAlgoCoverOrder(updatedOrder, fillSize, match.price, ts)
      if (coverOrder) {
        coverOrders = [coverOrder, ...coverOrders]
        messages.push(`Sim Exchange staged ALGO COVER ${coverOrder.remaining}x ${simOrderSideLabel(coverOrder)} ${simPriceLabel(coverOrder.price)} on ${coverOrder.marketKey}; parent ${updatedOrder.id}.`)
      }
      nextOrders = nextOrders.map(item => item.id === order.id ? updatedOrder : item)
      working = updatedOrder
    }
  }

  return { simOrders: [...coverOrders, ...nextOrders], fills: nextFills, polyTicks: nextPolyTicks, simPositions: nextPositions }
}

function updateSimPositions(
  positions: SimPosition[],
  fill: SimFill,
  order: SimOrder,
  markPrice: number,
): SimPosition[] {
  const open = positions.find(position => (
    position.marketKey === order.marketKey
    && position.outcome === order.outcome
    && position.status === 'open'
    && position.operator === order.operator
    && position.legId === order.legId
  ))
  const direction = order.side === 'bid' ? 1 : -1
  const signedSize = direction * fill.size
  const multiplier = simContractMultiplier(order, fill.price)
  const tickSize = order.tickSize ?? simProductSpec(order.marketKey, fill.price).tickSize
  const tickValue = order.tickValue ?? tickSize * multiplier

  if (!open) {
    const openPnl = simDollarPnl(order.marketKey, fill.price, markPrice, signedSize, multiplier)
    return [...positions, {
      id: `sim-pos-${order.id}`,
      marketKey: order.marketKey,
      outcome: order.outcome,
      size: signedSize,
      avgPrice: fill.price,
      markPrice,
      openPnl,
      realizedPnl: 0,
      totalPnl: openPnl,
      status: signedSize === 0 ? 'closed' : 'open',
      openedAt: fill.timestamp,
      operator: order.operator,
      source: order.source,
      strategy: order.strategy,
      legId: order.legId,
      orderTag: order.orderTag,
      algoRole: order.algoRole,
      algoId: order.algoId,
      algoName: order.algoName,
      parentOrderId: order.parentOrderId,
      layer: order.layer,
      trigger: order.trigger,
      tickSize,
      tickValue,
      multiplier,
    }]
  }

  return positions.map(position => {
    if (position !== open) return position
    const nextSize = position.size + signedSize
    const isReducing = Math.sign(position.size) !== Math.sign(signedSize)
    const closedQty = isReducing ? Math.min(Math.abs(position.size), Math.abs(signedSize)) : 0
    const positionMultiplier = simContractMultiplier(position, position.avgPrice)
    const realized = isReducing ? simDollarPnl(position.marketKey, position.avgPrice, fill.price, closedQty * Math.sign(position.size), positionMultiplier) : 0
    const avgPrice = nextSize === 0
      ? 0
      : isReducing && Math.sign(nextSize) !== Math.sign(position.size)
        ? fill.price
        : Math.sign(nextSize) === Math.sign(position.size) && !isReducing
      ? ((position.avgPrice * Math.abs(position.size)) + (fill.price * Math.abs(signedSize))) / Math.abs(nextSize)
      : position.avgPrice
    const openPnl = nextSize === 0 ? 0 : simDollarPnl(position.marketKey, avgPrice, markPrice, nextSize, positionMultiplier)
    const realizedPnl = position.realizedPnl + realized
    return {
      ...position,
      size: nextSize,
      avgPrice,
      markPrice,
      openPnl,
      realizedPnl,
      totalPnl: realizedPnl + openPnl,
      status: nextSize === 0 ? 'closed' : 'open',
      closedAt: nextSize === 0 ? fill.timestamp : position.closedAt,
      tickSize: position.tickSize ?? tickSize,
      tickValue: position.tickValue ?? tickValue,
      multiplier: positionMultiplier,
    }
  })
}

function markOpenSimPositions(positions: SimPosition[], marketKey: string, tick: PolyTradeTick): SimPosition[] {
  let changed = false
  const next = positions.map(position => {
    if (position.marketKey !== marketKey || position.status !== 'open') return position
    const markPrice = isRawFuturesPrice(tick.price) ? tick.price : priceForOutcome(tick, position.outcome)
    const openPnl = simDollarPnl(position.marketKey, position.avgPrice, markPrice, position.size, position.multiplier)
    changed = true
    return {
      ...position,
      markPrice,
      openPnl,
      totalPnl: position.realizedPnl + openPnl,
    }
  })
  return changed ? next : positions
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
  setExecutionPositions: (p) => set({ executionPositions: p }),
  setExecutionRisk: (r) => set({ executionRisk: r }),

  setSimulationEnabled: (v) => set(s => ({
    simulationEnabled: v,
    simMessages: [`Sim Exchange ${v ? 'enabled' : 'disabled'}.`, ...s.simMessages].slice(0, 50),
  })),
  placeSimOrder: (order) => {
    const id = order.id ?? `sim-${order.marketKey}-${order.outcome}-${order.side}-${order.price}-${Date.now()}`
    set(s => {
      const now = Date.now()
      const spec = simProductSpec(order.marketKey, order.price)
      let incoming: SimOrder = {
        id,
        marketKey: order.marketKey,
        outcome: order.outcome,
        side: order.side,
        orderType: order.orderType ?? 'limit',
        price: order.price,
        size: order.size,
        remaining: order.size,
        filledSize: 0,
        matchedVolume: 0,
        status: 'working',
        createdAt: now,
        updatedAt: now,
        operator: order.operator,
        source: order.source ?? 'manual',
        strategy: order.strategy ?? 'manual',
        legId: order.legId ?? `${id}-L1`,
        orderTag: order.orderTag,
        algoRole: order.algoRole,
        algoId: order.algoId,
        algoName: order.algoName,
        parentOrderId: order.parentOrderId,
        layer: order.layer,
        trigger: order.trigger,
        coverTicksFromFill: order.coverTicksFromFill,
        coverTickSize: order.coverTickSize,
        tickSize: order.tickSize ?? spec.tickSize,
        tickValue: order.tickValue ?? spec.tickValue,
        multiplier: order.multiplier ?? spec.multiplier,
      }

      let simOrders = [...s.simOrders]
      let simPositions = s.simPositions
      let fills = s.fills
      let polyTicks = s.polyTicks
      let coverOrders: SimOrder[] = []
      const messages: string[] = []

      const publishFill = (filledOrder: SimOrder, size: number, price: number, timestamp: number, contraId: string) => {
        const published = publishSimFill(filledOrder, size, price, timestamp, contraId, fills, polyTicks, simPositions, messages)
        fills = published.fills
        polyTicks = published.polyTicks
        simPositions = published.simPositions
        const coverOrder = buildAlgoCoverOrder(filledOrder, size, price, timestamp)
        if (coverOrder) {
          coverOrders = [coverOrder, ...coverOrders]
          messages.push(`Sim Exchange staged ALGO COVER ${coverOrder.remaining}x ${simOrderSideLabel(coverOrder)} ${simPriceLabel(coverOrder.price)} on ${coverOrder.marketKey}; parent ${filledOrder.id}.`)
        }
      }

      for (const resting of sortRestingForMatch(incoming, simOrders)) {
        if (incoming.remaining <= 0) break
        const matchQty = Math.min(incoming.remaining, resting.remaining)
        if (matchQty <= 0) continue
        const fillPrice = resting.price
        const ts = Date.now()
        incoming = {
          ...incoming,
          remaining: incoming.remaining - matchQty,
          filledSize: incoming.filledSize + matchQty,
          status: incoming.remaining - matchQty === 0 ? 'filled' : 'partially_filled',
          updatedAt: ts,
        }
        simOrders = simOrders.map(item => item.id === resting.id ? {
          ...item,
          remaining: item.remaining - matchQty,
          filledSize: item.filledSize + matchQty,
          status: item.remaining - matchQty === 0 ? 'filled' as const : 'partially_filled' as const,
          updatedAt: ts,
        } : item)
        publishFill(incoming, matchQty, fillPrice, ts, resting.id)
        publishFill(resting, matchQty, fillPrice, ts, incoming.id)
      }

      if (incoming.remaining > 0) {
        for (const visibleMatch of visibleMarketMatches(incoming, s.polyBooks[incoming.marketKey], s.polyTicks[incoming.marketKey])) {
          if (incoming.remaining <= 0) break
          const matchQty = Math.min(incoming.remaining, visibleMatch.size)
          if (matchQty <= 0) continue
          const ts = Date.now()
          const remaining = incoming.remaining - matchQty
          incoming = {
            ...incoming,
            remaining,
            filledSize: incoming.filledSize + matchQty,
            matchedVolume: incoming.matchedVolume + matchQty,
            status: remaining === 0 ? 'filled' : 'partially_filled',
            updatedAt: ts,
          }
          publishFill(incoming, matchQty, visibleMatch.price, ts, visibleMatch.contraId)
        }
      }

      const shouldRest = incoming.orderType === 'limit' && incoming.remaining > 0
      const finalIncoming: SimOrder = shouldRest
        ? { ...incoming, status: incoming.filledSize > 0 ? 'partially_filled' : 'working', updatedAt: Date.now() }
        : { ...incoming, status: incoming.remaining === 0 ? 'filled' : 'cancelled', updatedAt: Date.now() }

      const nextOrders = shouldRest || finalIncoming.filledSize > 0
        ? [finalIncoming, ...coverOrders, ...simOrders]
        : [...coverOrders, ...simOrders]

      const acceptanceMessage = shouldRest
        ? `Sim Exchange resting LIMIT ${finalIncoming.remaining}x ${simOrderSideLabel(finalIncoming)} ${simPriceLabel(finalIncoming.price)} on ${finalIncoming.marketKey}.`
        : finalIncoming.remaining === 0
          ? `Sim Exchange completed ${finalIncoming.orderType.toUpperCase()} ${finalIncoming.size}x ${simOrderSideLabel(finalIncoming)} on ${finalIncoming.marketKey}.`
          : `Sim Exchange killed unfilled MARKET remainder ${finalIncoming.remaining}x on ${finalIncoming.marketKey}.`

      return {
        simOrders: nextOrders.slice(0, 500),
        simPositions,
        fills,
        polyTicks,
        simMessages: [acceptanceMessage, ...messages, ...s.simMessages].slice(0, 50),
      }
    })
    return id
  },
  cancelSimOrder: (id) => set(s => ({
    simOrders: s.simOrders.map(order => order.id === id && order.status !== 'filled' ? { ...order, status: 'cancelled', updatedAt: Date.now() } : order),
    simMessages: [`Sim Exchange cancelled order ${id}.`, ...s.simMessages].slice(0, 50),
  })),
  cancelSimOrders: (filter) => set(s => {
    let cancelled = 0
    const simOrders = s.simOrders.map(order => {
      const match = (!filter?.marketKey || filter.marketKey === order.marketKey)
        && (!filter?.outcome || filter.outcome === order.outcome)
        && (!filter?.side || filter.side === order.side)
        && (!filter?.source || filter.source === order.source)
        && (!filter?.algoId || filter.algoId === order.algoId)
        && order.status !== 'filled'
        && order.status !== 'cancelled'
      if (!match) return order
      cancelled += 1
      return { ...order, status: 'cancelled' as const, updatedAt: Date.now() }
    })
    return {
      simOrders,
      simMessages: [`Sim Exchange cancelled ${cancelled} working order${cancelled === 1 ? '' : 's'}.`, ...s.simMessages].slice(0, 50),
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
    const nextPolyBooks = { ...s.polyBooks, [key]: book }
    if (!s.simulationEnabled) return { polyBooks: nextPolyBooks }

    const messages: string[] = []
    const matched = fillWorkingOrdersFromVisibleMarket(
      s.simOrders,
      key,
      book,
      s.polyTicks[key],
      s.fills,
      s.polyTicks,
      s.simPositions,
      messages,
    )

    return {
      polyBooks: nextPolyBooks,
      simOrders: matched.simOrders,
      fills: matched.fills,
      polyTicks: matched.polyTicks,
      simPositions: matched.simPositions,
      ...(messages.length ? { simMessages: [...messages, ...s.simMessages].slice(0, 50) } : {}),
    }
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
    if (!s.simulationEnabled) {
      return { polyTicks: nextPolyTicks }
    }

    let simPositions = markOpenSimPositions(s.simPositions, key, tick)
    const messages: string[] = []
    const matched = fillWorkingOrdersFromVisibleMarket(
      s.simOrders,
      key,
      s.polyBooks[key],
      nextPolyTicks[key],
      s.fills,
      nextPolyTicks,
      simPositions,
      messages,
    )

    return {
      polyTicks: matched.polyTicks,
      simOrders: matched.simOrders,
      fills: matched.fills,
      simPositions: matched.simPositions,
      ...(messages.length ? { simMessages: [...messages, ...s.simMessages].slice(0, 50) } : {}),
    }
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
      executionPositions: (data.execution_positions ?? []) as ExecutionPosition[],
      executionRisk: (data.execution_risk ?? null) as ExecutionRisk | null,
      polyBooks: { ...s.polyBooks, ...(data.poly_books ?? {}) },
      polyTicks: { ...s.polyTicks, ...(data.poly_ticks ?? {}) },
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
