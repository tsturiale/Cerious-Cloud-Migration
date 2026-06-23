// types.ts — TypeScript equivalents of shared/types.py

export type Direction = 'UP' | 'DOWN'
export type Regime = 'low' | 'medium' | 'high' | string
export type ModelName = 'kc_reversion' | 'flow_toxicity' | 'low_vol_accum' | 'high_vol_momentum' | 'tri_engine' | 'v3_titanium' | 'rubber_band'
export type OrderStatus = 'pending' | 'open' | 'filled' | 'cancelled' | 'rejected'
export type Asset = 'ES' | 'NQ' | 'YM' | 'RTY' | 'CL' | 'GC' | 'ZM' | 'ZS' | 'ES_NQ' | 'YM_ES' | 'RTY_ES' | 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'HYPE' | 'BNB' | 'DOGE' | 'EVENT'
export type TimeFrame = '20sec' | '5min' | '15min' | '1h' | '4h' | 'event'

export interface Bar {
  timestamp: number   // unix ms
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface KeltnerBands {
  upper: number
  mid: number
  lower: number
}

export interface OrderBookLevel {
  price: number
  size: number
  count?: number
  ct?: number
}
export interface OrderBook {
  market_id: string
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  best_bid?: number
  best_ask?: number
  mid?: number
  spread_bps?: number
}

export interface TradeTick {
  timestamp: number
  price: number
  size: number
  volume?: number
  side: 'buy' | 'sell'
}

export interface PolyTradeTick {
  timestamp: number
  marketKey: string
  price: number
  size: number
  side: 'yes' | 'no'
  displaySide?: string
  marketSide?: 'buy' | 'sell'
  orderSide?: 'bid' | 'offer'
}

export type SimOrderStatus = 'working' | 'partially_filled' | 'filled' | 'cancelled'
export type SimOrderType = 'limit' | 'market'
export type SimPositionStatus = 'open' | 'closed'
export type SimAlgoRole = 'entry' | 'cover'

export interface SimOrder {
  id: string
  marketKey: string
  outcome: 'yes' | 'no'
  side: 'bid' | 'offer'
  orderType: SimOrderType
  price: number
  size: number
  remaining: number
  filledSize: number
  matchedVolume: number
  status: SimOrderStatus
  createdAt: number
  updatedAt: number
  operator: string
  source: 'manual' | 'algo'
  strategy: string
  legId: string
  entryOrderId?: string
  orderTag?: string
  algoRole?: SimAlgoRole
  algoId?: string
  algoName?: string
  deployIntentId?: string
  parentOrderId?: string
  layer?: number
  trigger?: string
  coverTicksFromFill?: number
  coverTickSize?: number
  tickSize?: number
  tickValue?: number
  multiplier?: number
  displaySide?: string
  orderSide?: 'bid' | 'offer'
}

export interface SimPosition {
  id: string
  marketKey: string
  outcome: 'yes' | 'no'
  size: number
  avgPrice: number
  markPrice: number
  openPnl: number
  realizedPnl: number
  totalPnl: number
  status: SimPositionStatus
  openedAt: number
  closedAt?: number
  operator: string
  source: 'manual' | 'algo'
  strategy: string
  legId: string
  entryOrderId?: string
  orderTag?: string
  algoRole?: SimAlgoRole
  algoId?: string
  algoName?: string
  deployIntentId?: string
  parentOrderId?: string
  layer?: number
  trigger?: string
  coverTicksFromFill?: number
  coverTickSize?: number
  tickSize?: number
  tickValue?: number
  multiplier?: number
}

export interface SimFill extends PolyTradeTick {
  orderId: string
  exchange: 'Sim Exchange'
  operator: string
  source: 'manual' | 'algo'
  strategy: string
  legId: string
  orderTag?: string
  algoRole?: SimAlgoRole
  algoId?: string
  algoName?: string
  deployIntentId?: string
  parentOrderId?: string
  layer?: number
  trigger?: string
  coverTicksFromFill?: number
  coverTickSize?: number
  tickSize?: number
  tickValue?: number
  multiplier?: number
  realizedPnl: number
}

export interface Signal {
  timestamp: number
  asset: Asset
  model: ModelName
  direction: Direction
  strength: number    // 0–3
  regime: Regime
  zscore: number
  ofi: number
  vpin: number
}

export interface Position {
  position_id: string
  asset: Asset
  direction: Direction
  entry_price: number
  size: number
  entry_time: number
  expiry_secs: number   // seconds until expiry
  unrealized_pnl: number
  current_price: number
  partial_exit_done: boolean
  is_copy: boolean
  master_wallet?: string
}

export interface Trade {
  trade_id: string
  asset: Asset
  direction: Direction
  model?: ModelName
  regime: Regime
  entry_time: number
  exit_time: number
  entry_price: number
  exit_price: number
  size: number
  net_pnl: number
  fees: number
  win: boolean
  signal_strength: number
  is_copy: boolean
}

export interface DailyMetrics {
  date: string
  trade_count: number
  win_count: number
  win_rate: number
  net_pnl: number
  sharpe: number
  max_drawdown: number
  trades_remaining: number
  concurrent_positions: number
  at_trade_limit: boolean
  at_loss_limit: boolean
}

export interface JournalNote {
  date: string   // "YYYY-MM-DD"
  text: string
}

export interface DailyPerf {
  date: string
  net_pnl: number
  trade_count: number
  win_count: number
  win_rate: number        // 0–100
  gross_wins: number
  gross_losses: number
}

export interface ModelStats {
  model: ModelName
  trade_count: number
  win_rate: number
  profit_factor: number
  total_pnl: number
}

export interface MasterInfo {
  wallet_address: string
  alias?: string
  source: 'leaderboard' | 'manual'
  win_rate: number
  sharpe: number
  trade_count: number
  paused: boolean
}

export interface CopyStatus {
  enabled: boolean
  active_masters: MasterInfo[]
  copy_trades_today: number
  copy_pnl_today: number
}

export interface ExecutionPosition {
  position_id: string
  asset: Asset
  direction: Direction
  status: string
  entry_price: number
  current_price: number
  size: number
  unrealized_pnl: number
  pnl_pct: number | null
  sl_distance_pct?: number | null
  tp_distance_pct?: number | null
  model?: string
}

export interface ExecutionRisk {
  open_count: number
  up_exposure: number
  dn_exposure: number
  total_exposure: number
  daily_pnl: number
  regime: string
  regime_mult: number
  near_sl_distance_pct: number | null
}

// ── Polymarket market data ───────────────────────────────────────────────────

export interface ProbPoint {
  ts: number       // unix ms
  up_pct: number   // 0–100
}

/** The next-up ("on deck") market for a given slot */
export interface StagedMarket {
  question: string
  expiry_ts: number
  up_pct: number
  down_pct: number
  up_token_id?: string
  condition_id?: string
  live: boolean
}

export interface MarketInfo {
  key: string              // "BTC_15min"
  asset: Asset
  timeframe: TimeFrame
  question: string
  category?: string
  up_pct: number           // 0–100
  down_pct: number         // 0–100
  volume: number           // USD
  expiry_ts: number        // unix ms
  resolution_price?: number   // extracted from question text
  start_price?: number        // Chainlink oracle price at period open (source of truth)
  price_to_beat?: number      // authoritative strike when provided by market feed
  condition_id?: string
  up_token_id?: string
  live: boolean            // true = real provider data
  last_update_ms?: number  // unix ms of most recent price update
  prob_history?: ProbPoint[]
  truth_history?: ProbPoint[]           // TP history from Truth Engine (Merton Jump-Diffusion)
  staged_market?: StagedMarket | null   // next market on deck for this slot

  // Option A Truth Engine (Microstructure-Adjusted BS)
  truth_up_pct?: number
  truth_down_pct?: number
  truth_feature_source?: '20s' | '1m_fallback'
  gamma?: number
  theta?: number
  vega?: number
  vanna?: number
  charm?: number
  atr?: number
  volatility?: number
  zscore?: number
  edge_up?: number
  edge_down?: number
  tickSize?: number
  tickValue?: number
  multiplier?: number
}

// ── Polymarket YES/NO order book ─────────────────────────────────────────────

export interface PolyBookLevel {
  price: number   // probability 0.01–0.99 (e.g. 0.52 = 52¢ = 52% chance YES)
  size:  number   // shares (1 share pays $1 if outcome is YES)
  count?: number
  ct?: number
}

export interface PolyBook {
  market_key:   string
  question:     string
  up_token_id:  string
  bids:         PolyBookLevel[]   // YES bids, sorted descending (highest first)
  asks:         PolyBookLevel[]   // YES asks, sorted ascending  (lowest first)
  best_bid:     number | null
  best_ask:     number | null
  mid:          number            // midpoint probability (0–1)
  spread_pct:   number | null     // spread in percentage points
  up_pct:       number            // 0–100
  down_pct:     number            // 0–100
  ltp?:         number
  ltp_size?:    number
  expiry_ts:    number
  live:         boolean
  timestamp_ms: number
  seen_ms?:     number
  final_minute_mode?: boolean
  final_minute_hold?: boolean
  book_has_real_two_sided?: boolean
}

export interface CmeBook {
  symbol: string
  venue: string
  source?: string
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  bestBid?: number
  bestAsk?: number
  bidSize?: number
  askSize?: number
  bidCount?: number
  askCount?: number
  mid?: number
  ltp?: number
  ltpSize?: number
  volume?: number
  spread?: number
  tsMs?: number
  tickSize?: number
  tickValue?: number
  multiplier?: number
  synthetic?: boolean
  ltpSource?: string
}

export interface CmeTradeTick {
  symbol: string
  venue: string
  source?: string
  timestamp: number
  price: number
  size: number
  volume?: number
  side?: 'buy' | 'sell'
  bestBid?: number
  bestAsk?: number
  tickSize?: number
  tickValue?: number
  multiplier?: number
}

// ── Settlement history ───────────────────────────────────────────────────────

/** A single settled market record, written when a market expires and rotates. */
export interface Settlement {
  settled_at:     number        // unix ms when recorded
  key:            string        // "BTC_15min"
  asset:          Asset
  timeframe:      TimeFrame
  question:       string
  final_up_pct:   number        // 0–100
  final_down_pct: number        // 0–100
  outcome:        'UP' | 'DOWN' // final resolution direction
  volume:         number        // USD
  expiry_ts:      number        // unix ms
  condition_id:   string
  live:           boolean       // true = real Polymarket data
  price_to_beat?: number        // USD strike price (Dome REST / Chainlink fallback)
  final_price?:   number        // USD price at settlement (Dome REST when available)
  winning_side?:  string        // "Up" | "Down" from Dome resolution
}

// WebSocket message envelope
export type WsMsg =
  | { type: 'bar';         asset: Asset; data: Bar }
  | { type: 'bands';       asset: Asset; data: KeltnerBands }
  | { type: 'book';        asset: Asset; data: OrderBook }
  | { type: 'tick';        asset: Asset; data: TradeTick }
  | { type: 'cme_book';    symbol: string; data: CmeBook }
  | { type: 'cme_trade';   symbol: string; data: CmeTradeTick }
  | { type: 'signal';      data: Signal }
  | { type: 'position';    data: Position[] }
  | { type: 'metrics';     data: DailyMetrics }
  | { type: 'zscore';      asset: Asset; value: number; regime: Regime }
  | { type: 'copy_status'; data: CopyStatus }
  | { type: 'markets';     data: MarketInfo[] }
  | { type: 'settlements'; data: Settlement[] }
  | { type: 'poly_book';   market_key: string; data: PolyBook }
  | { type: 'poly_tick';   market_key: string; data: PolyTradeTick }
  | { type: 'fill';        market_key: string; data: PolyTradeTick }
  | { type: 'order_snapshot'; data: { simOrders?: SimOrder[]; simPositions?: SimPosition[]; fills?: Record<string, PolyTradeTick[]>; simMessages?: string[] } }
  | { type: 'execution_event'; data: { positions?: ExecutionPosition[]; risk?: ExecutionRisk } }

export const MODEL_LABELS: Record<ModelName, string> = {
  kc_reversion: 'KC Reversion',
  flow_toxicity: 'Flow Toxicity',
  low_vol_accum: 'Low Vol Accum',
  high_vol_momentum: 'HV Momentum',
  tri_engine: 'Tri-Engine',
  v3_titanium: 'V3 Titanium',
  rubber_band: 'Rubber Band',
}

export const MODEL_COLORS: Record<ModelName, string> = {
  kc_reversion: '#3b82f6',
  flow_toxicity: '#a855f7',
  low_vol_accum: '#22c55e',
  high_vol_momentum: '#f59e0b',
  tri_engine: '#ef4444',
  v3_titanium: '#8b5cf6',
  rubber_band: '#00d4a4',
}

export const CANONICAL_MODEL_NAMES = [
  'rubber_band',
  'kc_reversion',
  'flow_toxicity',
] as const satisfies readonly ModelName[]

/** Maps legacy / alternate model name strings to their canonical ModelName. */
const MODEL_ALIASES: Record<string, ModelName> = {
  titanium:        'v3_titanium',
  v3titanium:      'v3_titanium',
  'v3-titanium':   'v3_titanium',
  tri_engine_v2:   'tri_engine',
  v5_titanium:     'v3_titanium',
  rubberband:      'rubber_band',
  'rubber-band':   'rubber_band',
}

export function normalizeModel(raw: string): ModelName {
  return (MODEL_ALIASES[raw] ?? raw) as ModelName
}

export const TIMEFRAME_LABELS: Record<TimeFrame, string> = {
  '20sec': '20-Second', // sub-minute microstructure
  '5min':  '5-Minute',    // markets expiring ≤ 20 min
  '15min': '15-Minute',   // markets expiring ≤ 75 min
  '1h':    '1-Hour',      // markets expiring ≤ 6 h
  '4h':    '4-Hour',      // markets expiring > 6 h
  'event': 'Event',
}

// ── Market Provider ──────────────────────────────────────────────────────────

export type MarketProvider = 'cme' | 'polymarket' | 'kalshi' | 'forecasttrader' | 'hyperliquid' | 'coingecko'

// ── Kalshi market ────────────────────────────────────────────────────────────

export interface KalshiMarket {
  id: string           // e.g. "KXBTCD-25MAR-B84000"
  title: string        // "Will BTC be above $84k on Mar 25?"
  yes_price: number    // 0–1 (probability)
  no_price: number     // 0–1
  volume: number       // USD
  close_time: string   // ISO date string
  category: string     // "Crypto" | "Economics" | "Finance" | etc.

  // Option A Truth Engine (Microstructure-Adjusted BS)
  truth_up_pct?: number
  truth_down_pct?: number
  truth_feature_source?: '20s' | '1m_fallback'
  gamma?: number
  theta?: number
  vega?: number
  vanna?: number
  charm?: number
  atr?: number
  volatility?: number
  edge_up?: number
  edge_down?: number
}

// ── IBKR ForecastTrader market ───────────────────────────────────────────────

export interface IbkrMarket {
  conid: string        // IBKR contract ID
  title: string
  yes_price: number    // 0–1
  no_price: number     // 0–1
  volume: number       // USD
  expiry: string       // ISO date string
  category: string
}

// ── Crypto spot price (Binance) ──────────────────────────────────────────────

export interface CryptoPrice {
  price: number
  change24h: number    // percentage, e.g. 1.24 means +1.24%
  open?: number
  high?: number
  low?: number
  previousClose?: number
  volume?: number
  bid?: number
  ask?: number
  bidSize?: number
  askSize?: number
  timestamp?: number
}
