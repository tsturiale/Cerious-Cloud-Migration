import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction, type WheelEvent as ReactWheelEvent } from 'react'
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
} from 'lightweight-charts'
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Check,
  Copy,
  Database,
  Download,
  Folder,
  FolderOpen,
  Lock,
  LogOut,
  Plus,
  Power,
  Save,
  Search,
  Server,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import { useStore } from '../store'
import type { Asset, Bar, PolyBook, PolyTradeTick, SimOrder, SimPosition, WsMsg } from '../types'
import { OrderBook2 } from './OrderBook2'
import { FixMonitor } from './FixMonitor'
import { fetchBars } from '../utils/bars'
import ceriousLogo from '../assets/branding/cerious-logo.png'
import {
  calculateFuturesMarketValue,
  calculateOpenFuturesPnl,
  isKnownFuturesProduct,
  resolveFuturesMultiplier,
} from '../utils/futuresPnl'
import {
  depthMultiplierOptionsForTickSize as depthMultiplierOptionsForTick,
  finiteMarketPrice as finiteDepthPrice,
  formatMarketPrice as fmtLadderPrice,
  resolveDepthDisplayContract,
  roundToPriceIncrement as roundToTick,
} from '../utils/marketDisplay'
import {
  PRODUCT_ASSETS,
  PROVIDERS,
  SERVICE_BLUEPRINT,
  providerLabel,
  type ProviderKey,
  type WorkspaceTemplate,
  type WorkspaceWindowKind,
} from '../services/workspaceServices'
import { ceriousWsBase } from '../platform/transport'

const ENABLE_LEGACY_BROWSER_WS = import.meta.env.VITE_CERIOUS_ENABLE_LEGACY_WS === 'true'

type WorkspaceWindow = {
  id: string
  kind: WorkspaceWindowKind
  title: string
  x: number
  y: number
  w: number
  h: number
  z: number
  collapsed: boolean
  template?: WorkspaceTemplate
  provider?: ProviderKey
  symbol?: string
  account?: string
  poppedOut?: boolean
  floatingBounds?: FloatingWindowBounds
  chartSettings?: CeriousChartSettings
  depthLadderSettings?: DepthLadderSettings
}

type ResizeDirection = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

type MarketRowConfig = {
  id: string
  provider: ProviderKey
  symbol: string
}

const EMPTY_TRADE_TICKS: PolyTradeTick[] = []

type MarketDataColumnKey =
  | 'exchange'
  | 'symbol'
  | 'last'
  | 'bid'
  | 'ask'
  | 'bidSize'
  | 'askSize'
  | 'volume'
  | 'open'
  | 'high'
  | 'low'
  | 'previous'
  | 'change'
  | 'changePct'
  | 'time'
  | 'expiry'
  | 'status'
  | 'action'

const MARKET_DATA_COLUMNS: Array<{ key: MarketDataColumnKey; label: string; width: number; min: number; max: number; resizable?: boolean }> = [
  { key: 'exchange', label: 'Exch', width: 48, min: 38, max: 90, resizable: true },
  { key: 'symbol', label: 'Symbol', width: 58, min: 42, max: 128, resizable: true },
  { key: 'last', label: 'Last', width: 66, min: 50, max: 130, resizable: true },
  { key: 'bid', label: 'Bid', width: 66, min: 50, max: 130, resizable: true },
  { key: 'ask', label: 'Ask', width: 66, min: 50, max: 130, resizable: true },
  { key: 'bidSize', label: 'BidSz', width: 50, min: 42, max: 96, resizable: true },
  { key: 'askSize', label: 'AskSz', width: 50, min: 42, max: 96, resizable: true },
  { key: 'volume', label: 'Vol', width: 54, min: 42, max: 110, resizable: true },
  { key: 'open', label: 'Open', width: 62, min: 48, max: 120, resizable: true },
  { key: 'high', label: 'High', width: 62, min: 48, max: 120, resizable: true },
  { key: 'low', label: 'Low', width: 62, min: 48, max: 120, resizable: true },
  { key: 'previous', label: 'Prev', width: 62, min: 48, max: 120, resizable: true },
  { key: 'change', label: 'Chg', width: 58, min: 46, max: 112, resizable: true },
  { key: 'changePct', label: 'Chg%', width: 58, min: 46, max: 112, resizable: true },
  { key: 'time', label: 'Time', width: 88, min: 60, max: 132, resizable: true },
  { key: 'expiry', label: 'Exp', width: 60, min: 44, max: 96, resizable: true },
  { key: 'status', label: 'Status', width: 58, min: 48, max: 92, resizable: true },
  { key: 'action', label: '', width: 28, min: 28, max: 38 },
]

const DEFAULT_MARKET_DATA_COLUMN_WIDTHS = MARKET_DATA_COLUMNS.reduce((acc, column) => {
  acc[column.key] = column.width
  return acc
}, {} as Record<MarketDataColumnKey, number>)

type AlertSound = 'system-chime' | 'system-bell' | 'system-alarm'
type AlertDeliveryChannel = 'audio' | 'desktop' | 'sms'
type AlertDeliveryResult = { channel: AlertDeliveryChannel; ok: boolean; message: string }
type AlertDeliveryStatus = { ok: boolean; message: string; at: number }
type SmsAlertStatus = {
  ok?: boolean
  ready?: boolean
  configured?: boolean
  dryRun?: boolean
  provider?: string | null
  transports?: string[]
  error?: string
}
type AlgoTemplate = 'mean-reversion-v2' | 'scale-in'
type AlgoStatus = 'draft' | 'held' | 'quoting' | 'paused'
type DepthColumnKey = 'orders' | 'bid' | 'price' | 'ask'
type DepthLadderDensity = 'small' | 'medium' | 'large'

type DepthLadderSettings = {
  columnOrder: DepthColumnKey[]
  columnWidths: Record<DepthColumnKey, number>
  density: DepthLadderDensity
  priceMultiplier: number
  softGrid: boolean
  actionMode: 'limit' | 'market'
  fastTrade: boolean
}

type CmeDepthLevel = {
  price: number
  size: number
  count?: number
  ct?: number
  level?: number
}

type CmeBook = {
  symbol: string
  venue: 'CME' | string
  source?: string
  bids: CmeDepthLevel[]
  asks: CmeDepthLevel[]
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
}

type CmeTradeTick = {
  symbol: string
  venue: 'CME' | string
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

type AlgoDefinition = {
  id: string
  name: string
  template: AlgoTemplate
  templateId?: string
  version?: string
  provider: ProviderKey
  symbol: string
  marketKey?: string
  instruments?: string[]
  side: 'bid' | 'offer' | 'both'
  orderType: 'limit' | 'market'
  clipSize: number
  maxPosition: number
  signalRules?: AlgoSignalRule[]
  risk?: AlgoRisk
  midpointPeg?: AlgoMidpointPeg
  entryPeg?: AlgoEntryPeg
  layerPlan?: AlgoLayerPlan
  syntheticOrderManager?: AlgoSyntheticOrderManager
  exitPolicy?: AlgoExitPolicy
  orderPolicy?: AlgoOrderPolicy
  notes?: string
  operator: string
  status: AlgoStatus
  updatedAt: number
}

type AlgoSignalRule = {
  id: string
  field: string
  operator: string
  value: string | number | boolean
  action: string
  enabled: boolean
}

type AlgoRisk = {
  maxPosition: number
  maxLossAtr: number
  clipSchedule: string
  requireMarketOpen: boolean
}

type AlgoMidpointPeg = {
  enabled: boolean
  source: string
  label?: string
  previousClose: boolean
}

type AlgoEntryPeg = {
  source: string
  lookback?: number
  standardDeviations: number
  interval?: string
  timeframe?: string
}

type AlgoLayerPlan = {
  layerCount: number
  layerSpacingTicks: number
  maxLayers: number
  applySymmetrically: boolean
  workBuySide: boolean
  workSellSide: boolean
}

type AlgoSyntheticOrderManager = {
  enabled: boolean
  containerizedOrders: boolean
  entryTechnique: string
  holdUntilTriggered: boolean
  releaseDestination: string
}

type AlgoExitPolicy = {
  attachOnEntryFill: boolean
  oco: boolean
  coverTicksFromFill: number
  profitTicksFromEntry: number
  stopTicksFromEntry: number
  stopType: string
  coverLimitPlacement: string
}

type AlgoOrderPolicy = {
  mode: string
  orderType: string
  priceReference: string
  doNotCrossInside: boolean
  doNotCrossSelf: boolean
  liveOrderEntryEnabled: boolean
}

type AlertRule = {
  id: string
  symbol?: Asset
  provider?: ProviderKey
  productSymbol?: string
  field: 'last' | 'fill'
  op: '>' | '<' | '>=' | '<='
  value: number
  valueMode?: 'money' | 'percent' | 'cents' | 'price'
  enabled: boolean
  delivery?: {
    audio?: boolean
    desktop?: boolean
    sms?: boolean
    sound?: AlertSound
    phone?: string
  }
}

const ALERT_FIELDS = new Set<AlertRule['field']>(['last', 'fill'])
const ALERT_OPS = new Set<AlertRule['op']>(['>', '<', '>=', '<='])
const ALERT_VALUE_MODES = new Set<NonNullable<AlertRule['valueMode']>>(['money', 'percent', 'cents', 'price'])
const WORKSPACE_HEADER_HEIGHT = 48
const WORKSPACE_FOOTER_HEIGHT = 28
const WORKSPACE_EDGE_PAN_ZONE = 150
const WORKSPACE_HOVER_PAN_ZONE = 24

type SavedWorkspace = {
  name: string
  operator: string
  windows: WorkspaceWindow[]
  rows: MarketRowConfig[]
  alerts?: AlertRule[]
  algoLibrary?: AlgoDefinition[]
  algoManager?: AlgoManagerWorkspaceState
  selectedProvider?: ProviderKey
  selectedSymbol?: string
  updatedAt: number
  recoveredFrom?: string
  serverFile?: string
}

type AlgoManagerWorkspaceState = {
  stagedAlgoIds: string[]
  selectedDeployIds: string[]
  statusFilter?: AlgoStatus | 'all'
  deployStatus?: string
  updatedAt?: number
}

type FloatingWindowBounds = {
  x: number
  y: number
  w: number
  h: number
}

type RecoveredWorkspacesPayload = {
  workspaces?: Array<Partial<SavedWorkspace>>
}

type WorkspaceBackup = {
  id: string
  backedUpAt: number
  reason: string
  workspace: SavedWorkspace
}

type ProductOption = {
  provider: ProviderKey
  symbol: string
  label: string
  subtitle: string
  marketKey?: string
  asset?: Asset
  timeframe?: string
  yes?: number
  no?: number
  truthYes?: number
  truthNo?: number
  spot?: number
  priceToBeat?: number
  expiryTs?: number
  volume?: number
  openInterest?: number
  lastUpdate?: number
  live?: boolean
  tickSize?: number
  tickValue?: number
  multiplier?: number
}

const STORAGE_KEY = 'cerious.workspace.desktop.v1'
const WORKSPACE_NAMES_KEY = 'cerious.workspace.names.v1'
const DEFAULT_WORKSPACE_KEY = 'cerious.workspace.default.v1'
const WORKSPACE_BACKUPS_KEY = 'cerious.workspace.backups.v1'
const WORKSPACE_SESSION_TOKEN_KEY = 'cerious.workspace.sessionToken.v1'
const TED_S_DEFAULT_RECOVERY_FILE = 'leveldb-07-ted-s.json'
const ALGO_LIBRARY_KEY = 'cerious.algo.library.v1'
const ALGO_MANAGER_STATE_KEY = 'cerious.algo.manager.state.v1'
const DEPTH_LADDER_LAYOUT_KEY = 'cerious.depth-ladder.layout.v1'
const TRADE_ANALYTICS_IMPORT_KEY = 'cerious.trade-analytics.import.v1'
const MODEL_VARIANT_KEY = 'cerious.model.variant.v1'
const MODEL_VARIANT_LIBRARY_KEY = 'cerious.model.variant.library.v1'
const LEGACY_CERIOUS_MODEL_VARIANT_KEY = 'ceriousTraderModelVariantRegistryV1'
const ALGO_LIBRARY_EVENT = 'cerious-algo-library'
const ALGO_MANAGER_STATE_EVENT = 'cerious-algo-manager-state'
const DEFAULT_OPERATOR = 'Operator 1'
const MAX_WORKSPACE_BACKUPS = 12
const TRADE_ANALYTICS_ACCOUNT_SIZE = 500_000
const CME_PRODUCT_ASSETS: Asset[] = ['ES', 'NQ', 'YM', 'RTY', 'CL', 'GC', 'ZM', 'ZS', 'ES_NQ', 'YM_ES', 'RTY_ES']
const DEPTH_LADDER_PRICE_MULTIPLIERS = [1, 2, 4, 5, 8, 10, 16]
const DEFAULT_DEPTH_LADDER_SETTINGS: DepthLadderSettings = {
  columnOrder: ['orders', 'bid', 'price', 'ask'],
  columnWidths: {
    orders: 72,
    bid: 112,
    price: 96,
    ask: 112,
  },
  density: 'medium',
  priceMultiplier: 1,
  softGrid: true,
  actionMode: 'limit',
  fastTrade: false,
}
const WINDOW_LABELS: Record<WorkspaceWindowKind, string> = {
  marketData: 'Market Data',
  depthLadder: 'Depth Ladder',
  order: 'Order Book',
  fills: 'Fills',
  alerts: 'Alert Manager',
  charts: 'Charts',
  liquidityMap: 'Liquidity Map',
  algoBuilder: 'Algo Builder',
  algoManager: 'Algo Manager',
  serviceMap: 'System Services',
  depthTrader: 'Depth Ladder',
  depthTraderEsNq: 'Depth Ladder - ES / NQ',
  depthTraderYmEs: 'Depth Ladder - YM / ES',
  depthTraderRtyEs: 'Depth Ladder - RTY / ES',
  mdTraderEs: 'Depth Ladder - ES',
  goose: 'GOOSE',
  dailySummary: 'Daily Summary',
  streamingNews: 'Streaming News',
  liveApiArchitecture: 'Live API Architecture',
  tradeAnalytics: 'Trade Analytics',
  positionsOrders: 'Positions & Orders',
  auditTrail: 'Audit Trail',
  spreadConfigurations: 'Spread Configurations',
  relativeSpreadCharts: 'Relative Spread Charts',
  relativeSpreadVisuals: 'Relative Spread Visuals',
  notionalCalculator: 'Notional Calculator',
  macroRegimeSummary: 'Macro Regime Summary',
  liveSpreadSignals: 'Live Spread Signals',
  atrZScoreEngine: 'ATR and Z-Score Engine',
  executionRules: 'Execution Rules',
  orderLayeringTechniques: 'Order Layering Techniques',
  moneyManagement: 'Money Management',
  crossSpreadOpportunityMap: 'Cross-Spread Opportunity Map',
  riskChecklist: 'Risk Checklist',
  sourceNotes: 'Source Notes',
  modelResearchGovernance: 'Model Research & Governance',
  fixMonitor: 'FIX Monitor',
}

const WIDGET_MENU: Array<{ group: string; kinds: WorkspaceWindowKind[] }> = [
  { group: 'Cerious Core', kinds: ['marketData', 'depthLadder', 'positionsOrders', 'fills', 'auditTrail'] },
  { group: 'Daily Summary', kinds: ['dailySummary'] },
  { group: 'GOOSE', kinds: ['goose'] },
  { group: 'Spread Signals', kinds: ['spreadConfigurations', 'relativeSpreadCharts', 'relativeSpreadVisuals', 'liveSpreadSignals', 'atrZScoreEngine', 'crossSpreadOpportunityMap'] },
  { group: 'Research & Risk', kinds: ['macroRegimeSummary', 'tradeAnalytics', 'notionalCalculator', 'executionRules', 'orderLayeringTechniques', 'moneyManagement', 'riskChecklist', 'sourceNotes', 'modelResearchGovernance'] },
  { group: 'News', kinds: ['streamingNews'] },
  { group: 'Trading', kinds: ['order', 'alerts', 'liquidityMap', 'fixMonitor'] },
  { group: 'Algos', kinds: ['algoBuilder', 'algoManager'] },
  { group: 'Charts', kinds: ['charts'] },
  { group: 'System', kinds: ['liveApiArchitecture', 'serviceMap'] },
]

const REMOVED_WINDOW_KINDS = new Set<string>([
])

const REMOVED_WINDOW_PATTERNS = [
  /^ladder$/i,
  new RegExp(['^crypto', 'Terminal$'].join(''), 'i'),
  new RegExp(['^event', 'Terminal$'].join(''), 'i'),
  new RegExp(['^sports', 'Terminal$'].join(''), 'i'),
  new RegExp(['^trading', 'View'].join(''), 'i'),
  new RegExp(['^single', 'PanelChart$'].join(''), 'i'),
  /^cerious(Two|Three)PanelChart$/i,
  new RegExp(['^prediction', 'Chart$'].join(''), 'i'),
  new RegExp(['^product', 'Library$'].join(''), 'i'),
  /^spread(EsNq|YmEs|RtyEs)$/i,
  new RegExp(['^p', 'tb'].join(''), 'i'),
  new RegExp(['^g', 'reeks$'].join(''), 'i'),
  new RegExp(['^the', 'oQuoter$'].join(''), 'i'),
  /^knowledge$/i,
]

function isRemovedWindowKind(kind: unknown): boolean {
  const key = String(kind ?? '')
  return REMOVED_WINDOW_KINDS.has(key) || REMOVED_WINDOW_PATTERNS.some(pattern => pattern.test(key))
}

const PROVIDER_COLORS: Record<ProviderKey, string> = {
  cme: '#00d4a4',
  polymarket: '#00d4a4',
  kalshi: '#7dd3fc',
  hyperliquid: '#a78bfa',
  forecasttrader: '#f472b6',
}

function normalizeProviderKey(provider: ProviderKey | undefined): ProviderKey {
  if (provider && PROVIDERS.some(item => item.key === provider)) return provider
  return 'cme'
}

function normalizeProductKey(value: unknown): string {
  return String(value ?? '').trim().toUpperCase()
}

function productAliasSet(option: ProductOption | undefined, fallback?: unknown): Set<string> {
  const aliases = new Set<string>()
  ;[fallback, option?.marketKey, option?.symbol, option?.asset].forEach(value => {
    const key = normalizeProductKey(value)
    if (key) aliases.add(key)
  })
  return aliases
}

function algoMarketCandidates(algo: Partial<AlgoDefinition>): string[] {
  const candidates = [
    algo.marketKey,
    algo.symbol,
    ...(Array.isArray(algo.instruments) ? algo.instruments : []),
  ].map(normalizeProductKey).filter(Boolean)
  return candidates.filter((candidate, index, list) => list.indexOf(candidate) === index)
}

function findProductOptionForAlgo(options: ProductOption[], algo: AlgoDefinition): ProductOption | undefined {
  const provider = normalizeProviderKey(algo.provider)
  const candidates = new Set(algoMarketCandidates(algo))
  return options.find(option => (
    option.provider === provider
    && [option.marketKey, option.symbol, option.asset].some(value => candidates.has(normalizeProductKey(value)))
  )) ?? options.find(option => (
    [option.marketKey, option.symbol, option.asset].some(value => candidates.has(normalizeProductKey(value)))
  ))
}

function resolveAlgoMarketKey(algo: AlgoDefinition, option: ProductOption | undefined): string {
  return normalizeProductKey(option?.marketKey) || algoMarketCandidates(algo)[0] || normalizeProductKey(algo.symbol)
}

function normalizeAlertRule(raw: unknown, index: number): AlertRule | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Partial<AlertRule> & Record<string, unknown>
  const field = ALERT_FIELDS.has(source.field as AlertRule['field']) ? source.field as AlertRule['field'] : 'last'
  const op = ALERT_OPS.has(source.op as AlertRule['op']) ? source.op as AlertRule['op'] : '>='
  const value = Number(source.value)
  const rawDelivery = source.delivery && typeof source.delivery === 'object'
    ? source.delivery as NonNullable<AlertRule['delivery']>
    : {}
  const sound = rawDelivery.sound && ['system-chime', 'system-bell', 'system-alarm'].includes(rawDelivery.sound)
    ? rawDelivery.sound
    : 'system-chime'
  const valueMode = ALERT_VALUE_MODES.has(source.valueMode as NonNullable<AlertRule['valueMode']>)
    ? source.valueMode as AlertRule['valueMode']
    : undefined
  return {
    id: String(source.id || `alert-${Date.now()}-${index}`),
    symbol: source.symbol,
    provider: normalizeProviderKey(source.provider),
    productSymbol: typeof source.productSymbol === 'string' ? source.productSymbol : undefined,
    field,
    op,
    value: Number.isFinite(value) ? value : 0,
    valueMode,
    enabled: source.enabled !== false,
    delivery: {
      audio: rawDelivery.audio !== false,
      desktop: rawDelivery.desktop === true,
      sms: rawDelivery.sms === true,
      sound,
      phone: typeof rawDelivery.phone === 'string' ? rawDelivery.phone : undefined,
    },
  }
}

function venueColor(provider: ProviderKey | 'execution' | 'sim'): string {
  if (provider === 'execution') return '#f6c343'
  if (provider === 'sim') return '#74ff8d'
  return PROVIDER_COLORS[provider]
}

function defaultWindows(template: WorkspaceTemplate = 'cme'): WorkspaceWindow[] {
  void template
  return [
    win('marketData', 16, 58, 560, 315, 1),
    win('charts', 588, 58, 620, 430, 2),
    win('depthLadder', 1220, 58, 600, 655, 3),
    win('order', 16, 386, 370, 430, 4),
    win('fills', 398, 500, 390, 310, 5),
    win('alerts', 800, 500, 400, 310, 6),
    win('liquidityMap', 16, 830, 370, 290, 11),
    win('serviceMap', 398, 1134, 520, 260, 12),
    win('algoManager', 930, 1134, 430, 300, 13),
    win('spreadConfigurations', 1372, 1134, 448, 300, 14),
  ]
}

function win(
  kind: WorkspaceWindowKind,
  x: number,
  y: number,
  w: number,
  h: number,
  z: number,
  template?: WorkspaceTemplate,
): WorkspaceWindow {
  return {
    id: `${kind}-${z}`,
    kind,
    title: WINDOW_LABELS[kind],
    x,
    y,
    w,
    h,
    z,
    collapsed: false,
    template,
  }
}

function defaultSymbolForWindowKind(kind: WorkspaceWindowKind, fallback: string): string {
  if (kind === 'depthLadder') return ''
  if (kind === 'charts') return 'ES_NQ'
  if (kind === 'depthTraderEsNq') return 'ES_NQ'
  if (kind === 'depthTraderYmEs') return 'YM_ES'
  if (kind === 'depthTraderRtyEs') return 'RTY_ES'
  if (kind === 'mdTraderEs') return 'ES'
  return fallback
}

function ensureLegacyChartWindows(windows: WorkspaceWindow[]): WorkspaceWindow[] {
  if (windows.some(item => item.kind === 'charts' || item.kind === 'relativeSpreadCharts')) return windows
  const maxZ = windows.reduce((max, item) => Math.max(max, item.z), 0)
  return [
    ...windows,
    {
      ...win('charts', 588, 58, 620, 430, maxZ + 1),
      id: `charts-migrated-${Date.now()}`,
      z: maxZ + 1,
    },
  ]
}

function ensureFuturesDepthLadderWindow(windows: WorkspaceWindow[]): WorkspaceWindow[] {
  if (windows.some(item => item.kind === 'depthLadder')) return windows
  const maxZ = windows.reduce((max, item) => Math.max(max, item.z), 0)
  return [
    ...windows,
    {
      ...win('depthLadder', 1220, 58, 600, 655, maxZ + 1),
      id: `depth-ladder-migrated-${Date.now()}`,
      symbol: 'ES',
      provider: 'cme',
      z: maxZ + 1,
    },
  ]
}

function displayNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function fmtMoney(value: unknown): string {
  const n = finiteOptional(value)
  if (n === undefined) return '-'
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(Math.abs(n) >= 100 ? 0 : 2)}`
}

function fmtNum(value: unknown, digits = 2): string {
  const n = finiteOptional(value)
  if (n === undefined) return '-'
  return n.toFixed(digits)
}

function fmtPct(value: unknown): string {
  const n = finiteOptional(value)
  if (n === undefined) return '-'
  return `${(n * 100).toFixed(1)}%`
}

function fmtInt(value: unknown): string {
  const n = finiteOptional(value)
  if (n === undefined) return '-'
  return Math.round(n).toLocaleString()
}

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function normalizeDepthLadderSettings(raw: unknown): DepthLadderSettings {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<DepthLadderSettings>
  const validColumns: DepthColumnKey[] = ['orders', 'bid', 'price', 'ask']
  const rawOrder = Array.isArray(source.columnOrder) ? source.columnOrder : DEFAULT_DEPTH_LADDER_SETTINGS.columnOrder
  const columnOrder = [
    ...rawOrder.filter((column): column is DepthColumnKey => validColumns.includes(column as DepthColumnKey)),
    ...validColumns,
  ].filter((column, index, list) => list.indexOf(column) === index)
  const widths = source.columnWidths && typeof source.columnWidths === 'object' ? source.columnWidths : {}
  const columnWidths = validColumns.reduce((acc, column) => {
    const fallback = DEFAULT_DEPTH_LADDER_SETTINGS.columnWidths[column]
    const rawWidth = Number((widths as Partial<Record<DepthColumnKey, number>>)[column])
    acc[column] = Number.isFinite(rawWidth) ? clamp(rawWidth, 48, 260) : fallback
    return acc
  }, {} as Record<DepthColumnKey, number>)
  const density = ['small', 'medium', 'large'].includes(String(source.density)) ? source.density as DepthLadderDensity : DEFAULT_DEPTH_LADDER_SETTINGS.density
  const actionMode = source.actionMode === 'market' ? 'market' : 'limit'
  const rawMultiplier = Number(source.priceMultiplier)
  const priceMultiplier = DEPTH_LADDER_PRICE_MULTIPLIERS.includes(rawMultiplier) ? rawMultiplier : DEFAULT_DEPTH_LADDER_SETTINGS.priceMultiplier
  return {
    columnOrder,
    columnWidths,
    density,
    priceMultiplier,
    softGrid: typeof source.softGrid === 'boolean' ? source.softGrid : DEFAULT_DEPTH_LADDER_SETTINGS.softGrid,
    actionMode,
    fastTrade: typeof source.fastTrade === 'boolean' ? source.fastTrade : DEFAULT_DEPTH_LADDER_SETTINGS.fastTrade,
  }
}

function loadDepthLadderDefaultSettings(): DepthLadderSettings {
  try {
    const raw = window.localStorage.getItem(DEPTH_LADDER_LAYOUT_KEY)
    return normalizeDepthLadderSettings(raw ? JSON.parse(raw) : undefined)
  } catch {
    return DEFAULT_DEPTH_LADDER_SETTINGS
  }
}

function saveDepthLadderDefaultSettings(settings: DepthLadderSettings): DepthLadderSettings {
  const normalized = normalizeDepthLadderSettings(settings)
  window.localStorage.setItem(DEPTH_LADDER_LAYOUT_KEY, JSON.stringify(normalized))
  return normalized
}

function normalizeStringIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))]
}

function normalizeAlgoStatusFilter(value: unknown): AlgoStatus | 'all' {
  const raw = String(value || 'all')
  return raw === 'held' || raw === 'quoting' || raw === 'paused' || raw === 'draft' ? raw : 'all'
}

function normalizeAlgoManagerWorkspaceState(raw: unknown): AlgoManagerWorkspaceState {
  const row = raw && typeof raw === 'object' ? raw as Partial<AlgoManagerWorkspaceState> : {}
  const stagedAlgoIds = normalizeStringIdList(row.stagedAlgoIds)
  const selectedDeployIds = normalizeStringIdList(row.selectedDeployIds).filter(id => stagedAlgoIds.includes(id))
  return {
    stagedAlgoIds,
    selectedDeployIds,
    statusFilter: normalizeAlgoStatusFilter(row.statusFilter),
    deployStatus: '',
    updatedAt: Number(row.updatedAt || Date.now()),
  }
}

function loadAlgoManagerWorkspaceState(): AlgoManagerWorkspaceState {
  try {
    return normalizeAlgoManagerWorkspaceState(JSON.parse(window.localStorage.getItem(ALGO_MANAGER_STATE_KEY) || '{}'))
  } catch {
    return normalizeAlgoManagerWorkspaceState(null)
  }
}

function saveAlgoManagerWorkspaceState(next: AlgoManagerWorkspaceState, notify = false): AlgoManagerWorkspaceState {
  const normalized = normalizeAlgoManagerWorkspaceState({ ...next, updatedAt: next.updatedAt ?? Date.now() })
  window.localStorage.setItem(ALGO_MANAGER_STATE_KEY, JSON.stringify(normalized))
  if (notify) window.dispatchEvent(new CustomEvent(ALGO_MANAGER_STATE_EVENT, { detail: normalized }))
  return normalized
}

function normalizeAlgoLibrarySnapshot(raw: unknown): AlgoDefinition[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return sortAlgoDefinitions(raw
    .map(item => normalizeStoredAlgoDefinition(item as Partial<AlgoDefinition> | Record<string, unknown>))
    .filter((item): item is AlgoDefinition => !!item))
}

function applyWorkspaceAlgoSnapshot(workspace: SavedWorkspace): void {
  // Algo definitions are owned by the file-backed algo service. Workspace snapshots
  // only restore manager row selection so a saved layout cannot re-arm live statuses.
  if (workspace.algoManager) saveAlgoManagerWorkspaceState(workspace.algoManager, true)
}

function normalizeWorkspace(raw: Partial<SavedWorkspace> | null | undefined): SavedWorkspace | null {
  if (!raw || !Array.isArray(raw.windows)) return null
  const windows = ensureFuturesDepthLadderWindow(ensureLegacyChartWindows(raw.windows.filter(item => !isRemovedWindowKind(item.kind)))).map(item => ({
    ...item,
    provider: normalizeProviderKey(item.provider as ProviderKey | undefined),
    ...(item.kind === 'depthLadder' && item.depthLadderSettings
      ? { depthLadderSettings: normalizeDepthLadderSettings(item.depthLadderSettings) }
      : {}),
  }))
  return {
    name: String(raw.name || 'Cerious CME Desk'),
    operator: String(raw.operator || DEFAULT_OPERATOR),
    windows,
    rows: Array.isArray(raw.rows)
      ? raw.rows.map(row => ({ ...row, provider: normalizeProviderKey(row.provider) }))
      : [],
    alerts: Array.isArray(raw.alerts)
      ? raw.alerts.map(normalizeAlertRule).filter((item): item is AlertRule => !!item)
      : [],
    algoLibrary: normalizeAlgoLibrarySnapshot(raw.algoLibrary),
    algoManager: raw.algoManager ? normalizeAlgoManagerWorkspaceState(raw.algoManager) : undefined,
    selectedProvider: normalizeProviderKey(raw.selectedProvider),
    selectedSymbol: raw.selectedSymbol,
    updatedAt: Number(raw.updatedAt || Date.now()),
    recoveredFrom: raw.recoveredFrom,
    serverFile: raw.serverFile,
  }
}

function loadDefaultWorkspace(): SavedWorkspace | null {
  try {
    const raw = window.localStorage.getItem(DEFAULT_WORKSPACE_KEY)
    if (!raw) return null
    return normalizeWorkspace(JSON.parse(raw) as Partial<SavedWorkspace>)
  } catch {
    return null
  }
}

function loadActiveWorkspace(): SavedWorkspace | null {
  try {
    const defaultWorkspace = loadDefaultWorkspace()
    if (defaultWorkspace) return defaultWorkspace
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return normalizeWorkspace(JSON.parse(raw) as Partial<SavedWorkspace>)
  } catch {
    return null
  }
}

function loadSavedWorkspaces(): SavedWorkspace[] {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_NAMES_KEY)
    const parsed = raw ? JSON.parse(raw) as Array<Partial<SavedWorkspace>> : []
    const indexed = Array.isArray(parsed)
      ? parsed
          .map(normalizeWorkspace)
          .filter((item): item is SavedWorkspace => !!item)
      : []
    const active = loadActiveWorkspace()
    return active ? upsertSavedWorkspace(indexed, active) : indexed.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

function workspaceKey(operator: string, name: string): string {
  return `${operator.trim().toLowerCase()}::${name.trim().toLowerCase()}`
}

function upsertSavedWorkspace(list: SavedWorkspace[], next: SavedWorkspace): SavedWorkspace[] {
  return [
    next,
    ...list.filter(item => workspaceKey(item.operator, item.name) !== workspaceKey(next.operator, next.name)),
  ].sort((a, b) => b.updatedAt - a.updatedAt)
}

function loadWorkspaceBackups(): WorkspaceBackup[] {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_BACKUPS_KEY)
    const parsed = raw ? JSON.parse(raw) as Array<Partial<WorkspaceBackup>> : []
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(item => {
        const workspace = normalizeWorkspace(item.workspace)
        if (!workspace) return null
        return {
          id: String(item.id || `${workspaceKey(workspace.operator, workspace.name)}::${Number(item.backedUpAt || workspace.updatedAt || Date.now())}`),
          backedUpAt: Number(item.backedUpAt || workspace.updatedAt || Date.now()),
          reason: String(item.reason || 'workspace backup'),
          workspace,
        } satisfies WorkspaceBackup
      })
      .filter((item): item is WorkspaceBackup => !!item)
      .sort((a, b) => b.backedUpAt - a.backedUpAt)
  } catch {
    return []
  }
}

function backupWorkspace(next: SavedWorkspace, reason: string): WorkspaceBackup[] {
  const backedUpAt = Date.now()
  const backup: WorkspaceBackup = {
    id: `${workspaceKey(next.operator, next.name)}::${backedUpAt}`,
    backedUpAt,
    reason,
    workspace: { ...next, updatedAt: backedUpAt },
  }
  const backups = [
    backup,
    ...loadWorkspaceBackups().filter(item => item.id !== backup.id),
  ].slice(0, MAX_WORKSPACE_BACKUPS)
  window.localStorage.setItem(WORKSPACE_BACKUPS_KEY, JSON.stringify(backups))
  return backups
}

function persistWorkspaceSnapshot(next: SavedWorkspace, list: SavedWorkspace[], makeDefault: boolean, backupReason: string): void {
  window.localStorage.setItem(WORKSPACE_NAMES_KEY, JSON.stringify(list))
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  if (makeDefault) window.localStorage.setItem(DEFAULT_WORKSPACE_KEY, JSON.stringify(next))
  backupWorkspace(next, backupReason)
}

function workspaceSessionToken(): string {
  return window.localStorage.getItem(WORKSPACE_SESSION_TOKEN_KEY) || ''
}

function ceriousSessionHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init)
  const token = workspaceSessionToken()
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
    headers.set('X-Cerious-Session', token)
  }
  return headers
}

function ceriousFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: ceriousSessionHeaders(init.headers),
  })
}

async function saveWorkspaceServerSnapshot(next: SavedWorkspace, reason: string): Promise<boolean> {
  try {
    const response = await ceriousFetch('/api/workspaces/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: next,
        reason,
        sessionToken: workspaceSessionToken(),
      }),
    })
    return response.ok
  } catch {
    return false
  }
}

async function fetchRecoveredWorkspaces(): Promise<SavedWorkspace[]> {
  try {
    const response = await ceriousFetch('/api/workspaces/recovered', { cache: 'no-store' })
    if (!response.ok) return []
    const payload = await response.json() as RecoveredWorkspacesPayload
    if (!Array.isArray(payload.workspaces)) return []
    return payload.workspaces
      .map(normalizeWorkspace)
      .filter((item): item is SavedWorkspace => !!item)
  } catch {
    return []
  }
}

async function fetchServerSavedWorkspaces(): Promise<SavedWorkspace[]> {
  try {
    const token = workspaceSessionToken()
    const suffix = token ? `?token=${encodeURIComponent(token)}` : ''
    const response = await ceriousFetch(`/api/workspaces/saved${suffix}`, { cache: 'no-store' })
    if (!response.ok) return []
    const payload = await response.json() as RecoveredWorkspacesPayload
    if (!Array.isArray(payload.workspaces)) return []
    return payload.workspaces
      .map(normalizeWorkspace)
      .filter((item): item is SavedWorkspace => !!item)
  } catch {
    return []
  }
}

function algoTemplateLabel(template: AlgoTemplate): string {
  if (template === 'mean-reversion-v2') return 'Mean Reversion v2'
  return 'Scale In'
}

function defaultCeriousMeanReversionFields(symbol: string) {
  return {
    templateId: 'mean-reversion-v2',
    version: '2.0',
    instruments: [symbol],
    signalRules: [
      { id: 'regression-bands-ready', field: 'linearRegressionBands', operator: '=', value: true, action: 'pegEntryBands', enabled: true },
      { id: 'entry-touch', field: 'marketCanTradeTarget', operator: '=', value: true, action: 'releaseSniperEntry', enabled: true },
      { id: 'oco-cover', field: 'entryFilled', operator: '=', value: true, action: 'attachOcoCover', enabled: true },
    ] as AlgoSignalRule[],
    risk: {
      maxPosition: 1,
      maxLossAtr: 88,
      clipSchedule: 'layered',
      requireMarketOpen: true,
    } as AlgoRisk,
    midpointPeg: {
      enabled: false,
      source: '30m-vwap',
      label: 'Peg VWAP for midpoint',
      previousClose: false,
    } as AlgoMidpointPeg,
    entryPeg: {
      source: 'linear-regression',
      standardDeviations: 2,
    } as AlgoEntryPeg,
    layerPlan: {
      layerCount: 3,
      layerSpacingTicks: 2,
      maxLayers: 5,
      applySymmetrically: true,
      workBuySide: true,
      workSellSide: true,
    } as AlgoLayerPlan,
    syntheticOrderManager: {
      enabled: true,
      containerizedOrders: true,
      entryTechnique: 'sniper-market-if-target-price-achievable',
      holdUntilTriggered: true,
      releaseDestination: 'exchange-gateway',
    } as AlgoSyntheticOrderManager,
    exitPolicy: {
      attachOnEntryFill: true,
      oco: true,
      coverTicksFromFill: 6,
      profitTicksFromEntry: 6,
      stopTicksFromEntry: 88,
      stopType: 'market',
      coverLimitPlacement: 'above-bid-or-below-offer',
    } as AlgoExitPolicy,
    orderPolicy: {
      mode: 'synthetic-sniper',
      orderType: 'synthetic-held-market-release',
      priceReference: 'linear-regression-bands',
      doNotCrossInside: true,
      doNotCrossSelf: true,
      liveOrderEntryEnabled: false,
    } as AlgoOrderPolicy,
  }
}

function defaultAlgo(option: ProductOption | undefined, operator: string): AlgoDefinition {
  const symbol = option?.marketKey ?? option?.symbol ?? 'ES_NQ'
  const ceriousDefaults = defaultCeriousMeanReversionFields(symbol)
  return {
    id: `algo-${Date.now()}`,
    name: `${symbol} Mean Reversion`,
    template: 'mean-reversion-v2',
    ...ceriousDefaults,
    provider: option?.provider ?? 'cme',
    symbol,
    marketKey: option?.marketKey,
    side: 'both',
    orderType: 'limit',
    clipSize: 1,
    maxPosition: ceriousDefaults.risk.maxPosition,
    operator,
    status: 'held',
    updatedAt: Date.now(),
  }
}

function asTemplate(value: unknown): AlgoTemplate {
  const template = String(value ?? '')
  return template === 'mean-reversion-v2' || template === 'scale-in'
    ? template
    : 'mean-reversion-v2'
}

function asSignalRules(value: unknown): AlgoSignalRule[] {
  if (!Array.isArray(value)) return defaultCeriousMeanReversionFields('ES_NQ').signalRules
  return value.map((rule, index) => {
    const row = rule && typeof rule === 'object' ? rule as Record<string, unknown> : {}
    const rawValue = row.value
    const rawField = String(row.field ?? '')
    const fieldLower = rawField.toLowerCase()
    return {
      id: String(row.id ?? `rule-${index + 1}`),
      field: fieldLower.includes('linearregression') && fieldLower.includes('band') ? 'linearRegressionBands' : rawField,
      operator: String(row.operator ?? '='),
      value: typeof rawValue === 'boolean' || typeof rawValue === 'number' || typeof rawValue === 'string' ? rawValue : true,
      action: String(row.action ?? ''),
      enabled: row.enabled !== false,
    }
  })
}

function mergeObject<T extends object>(defaults: T, value: unknown): T {
  return {
    ...defaults,
    ...(value && typeof value === 'object' ? value as Partial<T> : {}),
  } as T
}

function normalizeCeriousFields(item: Partial<AlgoDefinition> | Record<string, unknown>, symbol: string) {
  const productKey = normalizeProductKey(symbol) || 'ES_NQ'
  const defaults = defaultCeriousMeanReversionFields(productKey)
  const entryPeg = mergeObject(defaults.entryPeg, item.entryPeg)
  const rawEntryPeg = item.entryPeg && typeof item.entryPeg === 'object' ? item.entryPeg as Record<string, unknown> : {}
  const migratedLookback = normalizedLookback(rawEntryPeg.lookback ?? entryPeg.lookback)
  if (migratedLookback !== null) entryPeg.lookback = migratedLookback
  if (String(entryPeg.source).toLowerCase().includes('linear-regression')) entryPeg.source = 'linear-regression'
  const layerPlan = mergeObject(defaults.layerPlan, item.layerPlan)
  const orderPolicy = mergeObject(defaults.orderPolicy, item.orderPolicy)
  if (String(orderPolicy.priceReference).toLowerCase().includes('27')) orderPolicy.priceReference = 'linear-regression-bands'
  return {
    templateId: String(item.templateId ?? defaults.templateId),
    version: String(item.version ?? defaults.version),
    instruments: [productKey],
    signalRules: asSignalRules(item.signalRules),
    risk: mergeObject(defaults.risk, item.risk),
    midpointPeg: mergeObject(defaults.midpointPeg, item.midpointPeg),
    entryPeg,
    layerPlan,
    syntheticOrderManager: mergeObject(defaults.syntheticOrderManager, item.syntheticOrderManager),
    exitPolicy: mergeObject(defaults.exitPolicy, item.exitPolicy),
    orderPolicy,
    notes: String(item.notes ?? ''),
  }
}

function loadAlgoLibrary(): AlgoDefinition[] {
  try {
    const raw = window.localStorage.getItem(ALGO_LIBRARY_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return normalizeAlgoLibrarySnapshot(parsed) ?? []
  } catch {
    return []
  }
}

function ceriousDefinitionToAlgo(item: Record<string, unknown>): AlgoDefinition | null {
  const id = String(item.id ?? '')
  const name = String(item.name ?? id)
  if (!id || !name) return null
  const instruments = Array.isArray(item.instruments) ? item.instruments.map(String) : []
  const risk = item.risk && typeof item.risk === 'object' ? item.risk as Record<string, unknown> : {}
  const layerPlan = item.layerPlan && typeof item.layerPlan === 'object' ? item.layerPlan as Record<string, unknown> : {}
  const templateId = String(item.templateId ?? 'mean-reversion-v2')
  const symbol = normalizeProductKey(item.marketKey ?? item.symbol) || normalizeProductKey(instruments[0]) || 'ES_NQ'
  const ceriousFields = normalizeCeriousFields(item, symbol)
  const statusRaw = String(item.status ?? 'held')
  const status = statusRaw === 'draft' || statusRaw === 'paused' ? statusRaw : 'held'
  const rawClipSize = Number(item.clipSize ?? item.contractsPerOrder ?? item.orderSize ?? risk.clipSize ?? risk.contractsPerOrder ?? 1)
  const rawMaxPosition = Number(item.maxPosition ?? risk.maxPosition ?? rawClipSize)
  const clipSize = Number.isFinite(rawClipSize) && rawClipSize > 0 ? rawClipSize : 1
  const maxPosition = Number.isFinite(rawMaxPosition) && rawMaxPosition > 0 ? rawMaxPosition : clipSize
  return {
    id,
    name,
    template: asTemplate(templateId),
    ...ceriousFields,
    provider: 'cme',
    symbol,
    marketKey: symbol,
    side: layerPlan.workSellSide === false ? 'bid' : layerPlan.workBuySide === false ? 'offer' : 'both',
    orderType: 'limit',
    clipSize,
    maxPosition,
    operator: 'Cerious Trader',
    status,
    updatedAt: Date.parse(String(item.updatedAt ?? item.createdAt ?? '')) || 0,
  }
}

function normalizeStoredAlgoDefinition(item: Partial<AlgoDefinition> | Record<string, unknown> | null | undefined): AlgoDefinition | null {
  if (!item || typeof item !== 'object') return null
  const id = String(item.id ?? '').trim()
  const name = String(item.name ?? id).trim()
  if (!id || !name) return null
  const symbol = algoMarketCandidates(item)[0] || 'ES_NQ'
  const ceriousFields = normalizeCeriousFields(item, symbol)
  const risk = ceriousFields.risk
  const statusRaw = String(item.status ?? 'held')
  const status: AlgoStatus = statusRaw === 'draft' || statusRaw === 'paused' || statusRaw === 'quoting' || statusRaw === 'held' ? statusRaw : 'held'
  const sideRaw = String(item.side ?? 'both')
  const side: AlgoDefinition['side'] = sideRaw === 'bid' || sideRaw === 'offer' || sideRaw === 'both' ? sideRaw : 'both'
  const orderTypeRaw = String(item.orderType ?? 'limit')
  const orderType: AlgoDefinition['orderType'] = orderTypeRaw === 'market' ? 'market' : 'limit'
  const riskRecord = risk as Record<string, unknown>
  const clipSize = Math.max(1, Number(item.clipSize ?? riskRecord.clipSize ?? riskRecord.contractsPerOrder ?? 1) || 1)
  const maxPosition = Math.max(1, Number(item.maxPosition ?? risk.maxPosition ?? clipSize) || clipSize)
  return {
    ...ceriousFields,
    id,
    name,
    template: asTemplate(item.template ?? item.templateId),
    provider: normalizeProviderKey(item.provider as ProviderKey | undefined),
    symbol,
    marketKey: String(item.marketKey ?? symbol),
    side,
    orderType,
    clipSize,
    maxPosition,
    operator: String(item.operator ?? DEFAULT_OPERATOR),
    status,
    updatedAt: Number(item.updatedAt ?? Date.now()),
  } as AlgoDefinition
}

function sortAlgoDefinitions(list: AlgoDefinition[]): AlgoDefinition[] {
  return [...list].sort((a, b) => {
    const symbolRank = normalizeProductKey(a.symbol).localeCompare(normalizeProductKey(b.symbol))
    if (symbolRank !== 0) return symbolRank
    const nameRank = a.name.localeCompare(b.name)
    if (nameRank !== 0) return nameRank
    return b.updatedAt - a.updatedAt
  })
}

function algoDefinitionForStorage(algo: AlgoDefinition): AlgoDefinition {
  return {
    ...algo,
    status: algo.status === 'quoting' ? 'held' : algo.status,
  } as AlgoDefinition
}

function publishAlgoLibrary(next: AlgoDefinition[]) {
  window.localStorage.setItem(ALGO_LIBRARY_KEY, JSON.stringify(next.map(algoDefinitionForStorage)))
  window.dispatchEvent(new CustomEvent(ALGO_LIBRARY_EVENT, { detail: next }))
}

async function saveAlgoDefinitionServer(definition: AlgoDefinition): Promise<boolean> {
  try {
    const response = await ceriousFetch('/api/algo-definitions/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition }),
    })
    return response.ok
  } catch {
    return false
  }
}

function useAlgoLibrary() {
  const [algos, setAlgos] = useState<AlgoDefinition[]>(loadAlgoLibrary)

  useEffect(() => {
    let cancelled = false
    const loadCeriousDefinitions = async () => {
      try {
        const response = await ceriousFetch('/api/algo-manager/state')
        if (!response.ok) return
        const payload = await response.json()
        const definitions = Array.isArray(payload.definitions) ? payload.definitions : []
        const mapped = definitions
          .map((definition: Record<string, unknown>) => ceriousDefinitionToAlgo(definition))
          .filter(Boolean) as AlgoDefinition[]
        if (cancelled || !mapped.length) return
        setAlgos(() => {
          const next = sortAlgoDefinitions(mapped)
          publishAlgoLibrary(next)
          return next
        })
      } catch {
        // Local staged algos remain usable if the service is down.
      }
    }
    loadCeriousDefinitions()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<AlgoDefinition[]>).detail
      setAlgos(Array.isArray(detail) ? sortAlgoDefinitions(detail) : loadAlgoLibrary())
    }
    window.addEventListener(ALGO_LIBRARY_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(ALGO_LIBRARY_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const commit = (updater: (current: AlgoDefinition[]) => AlgoDefinition[]) => {
    setAlgos(current => {
      const next = sortAlgoDefinitions(updater(current))
      publishAlgoLibrary(next)
      return next
    })
  }

  return {
    algos,
    upsertAlgo: (algo: AlgoDefinition) => commit(current => [
      { ...algo, updatedAt: Date.now() },
      ...current.filter(item => item.id !== algo.id),
    ]),
    updateAlgo: (id: string, patch: Partial<AlgoDefinition>) => commit(current => current.map(item => (
      item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item
    ))),
    removeAlgo: (id: string) => commit(current => current.filter(item => item.id !== id)),
  }
}

type CeriousSpreadStat = {
  key: string
  label: string
  spread: number
  lastTraded?: number
  mean: number
  longTermMean?: number
  lookbackMean?: number
  priorLookbackMean?: number
  lookbackDays?: number
  priorSettle?: number
  moveFromMean?: number
  movePctOfAtr?: number
  atr: number
  atr3?: number
  atr20?: number
  atr30?: number
  blendedAtr?: number
  halfAtr?: number
  vwapBasis?: number
  dayZ?: number
  z: number
  rawZ?: number
  signalThreshold?: number
  bias?: 'buy' | 'sell' | 'watch' | 'neutral'
  orderFlowScore?: number
  updateCadence?: string
  rvInterval?: string
  rvBars?: number
  rvUpdatedAt?: number
  publishedAt?: string
  publishReason?: string
  linearRegressionMean?: number
  linearRegressionUpper?: number
  linearRegressionLower?: number
  linearRegressionSigma?: number
  linearRegressionSlope?: number
  linearRegressionInterval?: string
  linearRegressionLookback?: number
  linearRegressionBars?: number
  linearRegressionUpdatedAt?: number
  linearRegressionIsForming?: boolean
  linearRegressionSource?: string
  theoreticalBid: number
  theoreticalAsk: number
  signal: string
  volume?: number
  live: boolean
  bars: Bar[]
}

type CeriousMacroFactorRow = {
  key: string
  value: number
  weight: number
  contribution: number
}

type CeriousMacroState = {
  service: string
  fetchedAt?: string
  label: string
  strength: number
  algo: string
  score: number
  factors: Record<string, number>
  factorRows: CeriousMacroFactorRow[]
  newsRead?: {
    bias: string
    score: number
    urgentCount: number
    summary: string
  }
  leadership?: Record<string, number>
  rtyVolumeShare?: number
  read: string
}

type CeriousSpreadConfig = {
  symbol: string
  label: string
  meaning: string
  legA: string
  legB: string
  ttRatio: string
  displayFormula: string
  syntheticTickValue: number
  leftMultiplier: number
  rightMultiplier: number
  ratio: number
}

type CeriousIntelligence = {
  goose?: {
    strategy: string
    direction: string
    risk: string
    confidence: string
    read: string
    evidence: Array<[string, string]>
    updateCadence?: string
    updatedAt?: string
    nextReviewSeconds?: number
  }
  spreadPack?: {
    spreads: CeriousSpreadStat[]
    strongest?: CeriousSpreadStat
  }
  spreadConfigs?: CeriousSpreadConfig[]
  macroRegime?: CeriousMacroState
  liveSpreadSignals?: Array<Pick<CeriousSpreadStat, 'key' | 'label' | 'spread' | 'lastTraded' | 'mean' | 'longTermMean' | 'lookbackMean' | 'lookbackDays' | 'priorSettle' | 'moveFromMean' | 'movePctOfAtr' | 'z' | 'atr' | 'atr3' | 'atr20' | 'atr30' | 'blendedAtr' | 'halfAtr' | 'vwapBasis' | 'dayZ' | 'signalThreshold' | 'bias' | 'orderFlowScore' | 'updateCadence' | 'rvInterval' | 'rvBars' | 'rvUpdatedAt' | 'publishedAt' | 'publishReason' | 'linearRegressionMean' | 'linearRegressionUpper' | 'linearRegressionLower' | 'linearRegressionSigma' | 'linearRegressionSlope' | 'linearRegressionInterval' | 'linearRegressionLookback' | 'linearRegressionBars' | 'linearRegressionUpdatedAt' | 'linearRegressionIsForming' | 'linearRegressionSource' | 'signal' | 'theoreticalBid' | 'theoreticalAsk' | 'volume' | 'live'>>
}

type CeriousChartMode = 'candles' | 'line'
type CeriousChartTimeframe = '1m' | '5m' | '30m' | '1h' | '1d'
type CeriousChartDisplayPreset = 'clean' | 'grid' | 'calendar' | 'outline'
type CeriousChartStudyType = 'regression-channel' | 'atr' | 'volume-at-price'

type CeriousChartStudy = {
  id: string
  type: CeriousChartStudyType
  lookback?: number
  upperDeviation?: number
  lowerDeviation?: number
  atrMultiplier?: number
  bins?: number
}

function defaultCeriousChartStudies(): CeriousChartStudy[] {
  return []
}

function isDefaultRegressionChartStudy(study: CeriousChartStudy) {
  void study
  return false
}

function initialCeriousChartStudies(settings?: CeriousChartSettings): CeriousChartStudy[] {
  const configured = settings?.studies?.filter(study => study && study.type) ?? []
  return configured.length ? configured : defaultCeriousChartStudies()
}

type CeriousChartSettings = {
  mode: CeriousChartMode
  timeframe: CeriousChartTimeframe
  displayPreset: CeriousChartDisplayPreset
  compressBlankSessions: boolean
  showGrid: boolean
  solidCandles: boolean
  studies: CeriousChartStudy[]
  studyType: CeriousChartStudyType
  studyLookback?: number
  upperDeviation: number
  lowerDeviation: number
  atrMultiplier: number
  volumePriceBins: number
}

type CeriousPositionRow = {
  instrumentId: string
  label?: string
  qty: number
  avgPrice: number
  markPrice: number
  markLive?: boolean
  multiplier?: number
  openPnl: number
  realizedPnl?: number
  account?: string
  lastFillAt?: string
  fillCount?: number
}

type CeriousOrderRow = {
  id: string
  instrumentId: string
  label?: string
  side: string
  qty: number
  price: number
  status: string
  held?: boolean
  source?: string
  orderClass?: string
  orderType?: string
  algoName?: string
  algoLegRole?: string
  updatedAt?: string
}

type CeriousPositionsOrdersState = {
  service: string
  fetchedAt: string
  fillsJournalUpdatedAt?: string
  runtimeUpdatedAt?: string
  simOrders?: SimOrder[]
  simPositions?: SimPosition[]
  fills?: Record<string, PolyTradeTick[]>
  simMessages?: string[]
  positions: CeriousPositionRow[]
  orders: CeriousOrderRow[]
  summary: {
    positionCount: number
    workingOrderCount: number
    fillCount: number
    openPnl: number
    closedPnl: number
    totalPnl: number
  }
}

function applyCeriousTradingSnapshot(payload?: Partial<CeriousPositionsOrdersState> | null) {
  if (!payload) return
  if (ceriousTradingSnapshotUnavailable(payload)) return
  if (payload.simOrders || payload.simPositions || payload.fills || payload.simMessages) {
    useStore.getState().setSimTradingState({
      simOrders: payload.simOrders,
      simPositions: payload.simPositions,
      fills: payload.fills,
      simMessages: payload.simMessages,
    })
  }
}

function ceriousTradingSnapshotUnavailable(payload?: Partial<CeriousPositionsOrdersState> | null): boolean {
  if (!payload) return true
  return (payload.simMessages ?? []).some(message => /EXCHANGE STATE UNAVAILABLE|STATE UNAVAILABLE/i.test(String(message)))
}

type CeriousNewsItem = {
  id: string
  source: string
  title: string
  link?: string
  pubDate?: string
  description?: string
  urgency?: 'high' | 'normal'
  bias?: 'risk-on' | 'risk-off' | 'mixed'
}

type CeriousNewsState = {
  service: string
  provider: string
  status: string
  fetchedAt: string
  items: CeriousNewsItem[]
  warnings?: string[]
  publicSourcesExpected?: number
  publicSourcesLive?: number
}

type CeriousAuditEntry = {
  id: string
  timestamp: string
  sequence?: string | number
  severity: 'info' | 'warn' | 'error'
  channel: string
  type: string
  source?: string
  summary: string
}

type CeriousAuditState = {
  service: string
  fetchedAt: string
  entries: CeriousAuditEntry[]
}

type CeriousDailySummaryState = {
  service: string
  fetchedAt: string
  summaryRead: string
  top: Array<{ label: string; value: string; note: string }>
  classification: Array<{ label: string; value: string; note: string }>
  sourcePills?: Array<{ label: string; tone?: 'blue' | 'amber' | 'red' | string }>
  eligibleSpreads?: Array<{
    key: string
    label: string
    score: number
    z: number
    bias: string
    approach: string
  }>
  gooseComplement?: string
}

type CeriousOpportunityState = {
  service: string
  fetchedAt: string
  rows: Array<{
    key: string
    label: string
    score: number
    z: number
    spread: number
    signal: string
    expression: string
    risk: string
    location: number
    confirmation: number
    regime: number
    liquidity: number
  }>
  playbookRows?: Array<{
    signalCombination: string
    interpretation: string
    expression: string
    risk: string
  }>
  productRows?: Array<{
    spread: string
    label: string
    tag: string
    formula: string
    buy: string
    sell: string
    nuance: string
  }>
  tradePlanRows?: Array<{
    title: string
    body: string
  }>
  riskChecklistRows?: Array<{
    risk: string
    control: string
  }>
}

type CeriousTradeAnalyticsState = {
  service: string
  fetchedAt: string
  status: string
  riskLevel: string
  metrics: {
    rows: number
    accountSize: number
    total: number
    returnPct: number
    winRate: number
    sharpe: number
    sortino: number
    calmar: number
    profitFactor: number
    expectancy: number
    drawdown: number
    drawdownPct: number
    studyCoverage: number
    largestLossPct?: number
    knownInstrumentRows?: number
    peakEquity?: number
    troughEquity?: number
    endEquity?: number
    productSummary?: string
    worstDrawdownPoint?: ImportedFillRecord | null
  }
  studies: Array<{ study: string; passed: boolean; result: string; read: string }>
  curve: Array<{ index: number; equity: number; drawdown: number; maxDrawdown: number }>
  productTotals: Array<{ instrument: string; pnl: number }>
  report?: Array<{ label: string; value: string; read: string }>
  records?: ImportedFillRecord[]
  source?: 'live' | 'imported'
  filename?: string
}

type ImportedFillRecord = {
  pnl: number
  cumulativePnl?: number | null
  accountMaxDrawdown?: number | null
  accountDrawdown?: number | null
  instrument: string
  side?: string
  qty?: number | null
  price?: number | null
  timestamp?: string
  displayTimestamp?: string
  timestampMs?: number
}

type CeriousNotionalState = {
  service: string
  fetchedAt: string
  rows: Array<{
    symbol: string
    label: string
    meaning: string
    legA: string
    legB: string
    ttRatio: string
    displayFormula: string
    syntheticTickValue: number
    leftPrice: number
    rightPrice: number
    displayValue: number
    basketDollarDiff: number
  }>
}

type CeriousContentState = {
  kind: string
  service: string
  fetchedAt: string
  sections?: Array<{ title: string; body: string }>
  rows?: string[][]
}

type ModelVariantDraft = {
  name: string
  version: string
  horizon: string
  owner: string
  objective: string
  notes: string
  changeLog: string
  reviewCriteria: string
  savedAt?: string
  schema?: string
}

function useCeriousEndpoint<T>(path: string, intervalMs = 10000) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const pull = async () => {
      try {
        const response = await fetch(path, { cache: 'no-store' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = await response.json() as T
        if (!cancelled) {
          setData(payload)
          setError('')
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Refresh failed')
      }
    }
    pull()
    const id = window.setInterval(pull, intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [intervalMs, path])

  return { data, error }
}

function parseCeriousCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '"' && quoted && next === '"') {
      cell += '"'
      i += 1
    } else if (ch === '"') {
      quoted = !quoted
    } else if (ch === ',' && !quoted) {
      row.push(cell)
      cell = ''
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && next === '\n') i += 1
      row.push(cell)
      if (row.some(value => value.trim())) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += ch
    }
  }
  row.push(cell)
  if (row.some(value => value.trim())) rows.push(row)
  return rows
}

function normalizeCsvHeader(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

function ceriousHeaderIndex(headers: string[], names: string[], options: { exclude?: string[] } = {}): number {
  const normalizedNames = names.map(normalizeCsvHeader)
  const excluded = (options.exclude ?? []).map(normalizeCsvHeader)
  const candidates = headers
    .map((header, index) => ({ header, normalized: normalizeCsvHeader(header), index }))
    .filter(item => !excluded.some(name => item.normalized === name || item.normalized.includes(name)))
  const exact = candidates.find(item => normalizedNames.some(name => item.normalized === name))
  if (exact) return exact.index
  const fuzzy = candidates.find(item => normalizedNames.some(name => item.normalized.includes(name)))
  return fuzzy ? fuzzy.index : -1
}

function csvNumber(value: unknown): number | null {
  const text = String(value ?? '').trim()
  const negative = /^\(.*\)$/.test(text)
  const cleaned = text.replace(/[()$,%\s,]/g, '')
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? (negative ? -Math.abs(parsed) : parsed) : null
}

function ceriousMean(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0
}

function ceriousStdev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = ceriousMean(values)
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function ceriousDownsideDeviation(returns: number[], target = 0): number {
  if (!returns.length) return 0
  return Math.sqrt(ceriousMean(returns.map(value => Math.min(0, value - target) ** 2)))
}

function ceriousMaxDrawdown(values: number[]): number {
  let peak = 0
  let worst = 0
  let equity = 0
  values.forEach(value => {
    equity += value
    peak = Math.max(peak, equity)
    worst = Math.min(worst, equity - peak)
  })
  return Math.abs(worst)
}

function parseTradeTimestamp(value: unknown): number {
  const text = String(value ?? '').trim()
  if (!text) return Number.NaN
  const direct = Date.parse(text)
  if (Number.isFinite(direct)) return direct
  const chicago = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+CT$/i)
  if (!chicago) return Number.NaN
  return new Date(
    Number(chicago[1]),
    Number(chicago[2]) - 1,
    Number(chicago[3]),
    Number(chicago[4]),
    Number(chicago[5]),
    Number(chicago[6]),
  ).getTime()
}

function equityCurveFromPnls(pnls: number[], accountSize = TRADE_ANALYTICS_ACCOUNT_SIZE): CeriousTradeAnalyticsState['curve'] {
  let cumulative = 0
  let peak = 0
  let maxDrawdown = 0
  return pnls.map((pnl, index) => {
    cumulative += pnl
    peak = Math.max(peak, cumulative)
    const drawdown = Math.max(0, peak - cumulative)
    maxDrawdown = Math.max(maxDrawdown, drawdown)
    return {
      index,
      equity: accountSize + cumulative,
      drawdown,
      maxDrawdown,
    }
  })
}

function tradeAnalyticsRiskLevel(metrics: CeriousTradeAnalyticsState['metrics']): string {
  if (metrics.drawdownPct >= 0.02 || metrics.total < 0 || metrics.sharpe < 0 || metrics.calmar < 0) return 'High'
  if (metrics.drawdownPct >= 0.01 || metrics.profitFactor < 1.2 || metrics.sharpe < 0.5) return 'Elevated'
  return 'Controlled'
}

function buildTradeAnalyticsStudies(metrics: CeriousTradeAnalyticsState['metrics']): CeriousTradeAnalyticsState['studies'] {
  const known = metrics.knownInstrumentRows ?? Math.round(metrics.studyCoverage * metrics.rows)
  return [
    {
      study: 'Risk assessment',
      passed: tradeAnalyticsRiskLevel(metrics) === 'Controlled',
      result: tradeAnalyticsRiskLevel(metrics),
      read: `Drawdown ${fmtPct(metrics.drawdownPct)}, Sharpe ${fmtNum(metrics.sharpe, 2)}, Calmar ${fmtNum(metrics.calmar, 2)}`,
    },
    {
      study: 'Account base',
      passed: metrics.returnPct >= 0,
      result: fmtPct(metrics.returnPct),
      read: `${fmtMoney(metrics.total)} on ${fmtMoney(metrics.accountSize)}`,
    },
    {
      study: 'Drawdown control',
      passed: metrics.drawdownPct <= 0.01,
      result: fmtPct(metrics.drawdownPct),
      read: metrics.drawdownPct <= 0.01 ? 'Inside 1% daily drawdown band' : 'Review size, stops, or sequencing',
    },
    {
      study: 'Expectancy',
      passed: metrics.expectancy > 0 && metrics.profitFactor >= 1,
      result: `${fmtMoney(metrics.expectancy)} / ${fmtNum(metrics.profitFactor, 2)} PF`,
      read: metrics.expectancy > 0 ? 'Positive average trade contribution' : 'Negative expectancy day',
    },
    {
      study: 'Loss concentration',
      passed: (metrics.largestLossPct ?? 0) <= 0.005,
      result: fmtPct(metrics.largestLossPct ?? 0),
      read: (metrics.largestLossPct ?? 0) <= 0.005 ? 'No single loss exceeded 0.5% of account' : 'Largest loss exceeded 0.5% of account',
    },
    {
      study: 'Study coverage',
      passed: metrics.studyCoverage >= 0.8,
      result: fmtPct(metrics.studyCoverage),
      read: `${known}/${metrics.rows} rows mapped to defined products or spreads`,
    },
  ]
}

function buildTradeAnalyticsReport(
  metrics: CeriousTradeAnalyticsState['metrics'],
  records: ImportedFillRecord[],
): NonNullable<CeriousTradeAnalyticsState['report']> {
  const best = records.reduce<ImportedFillRecord | null>((winner, record) => !winner || record.pnl > winner.pnl ? record : winner, null)
  const worst = records.reduce<ImportedFillRecord | null>((loser, record) => !loser || record.pnl < loser.pnl ? record : loser, null)
  return [
    {
      label: 'Risk assessment',
      value: tradeAnalyticsRiskLevel(metrics),
      read: metrics.total < 0
        ? 'Negative P&L with drawdown pressure. Reduce size or review trade selection before scaling.'
        : metrics.drawdownPct > 0.01
          ? 'Positive P&L, but drawdown exceeded 1% of the assumed account.'
          : 'P&L and drawdown are within the current risk envelope.',
    },
    {
      label: 'Session result',
      value: `${fmtMoney(metrics.total)} / ${fmtPct(metrics.returnPct)}`,
      read: metrics.total >= 0 ? 'Net positive against the account base.' : 'Net negative against the account base.',
    },
    {
      label: 'Risk-adjusted return',
      value: `Sharpe ${fmtNum(metrics.sharpe, 2)} | Sortino ${fmtNum(metrics.sortino, 2)} | Calmar ${fmtNum(metrics.calmar, 2)}`,
      read: 'Calculated from fill-level account returns using a zero risk-free/minimum acceptable return.',
    },
    {
      label: 'Drawdown',
      value: `${fmtMoney(metrics.drawdown)} / ${fmtPct(metrics.drawdownPct)}`,
      read: metrics.drawdown ? 'Peak-to-trough realized account P&L drawdown.' : 'No realized drawdown in the imported sequence.',
    },
    {
      label: 'Intraday curve',
      value: `Peak ${fmtMoney(metrics.peakEquity)} | Trough ${fmtMoney(metrics.troughEquity)} | End ${fmtMoney(metrics.endEquity)}`,
      read: metrics.worstDrawdownPoint ? `Max drawdown at ${metrics.worstDrawdownPoint.displayTimestamp || metrics.worstDrawdownPoint.timestamp || 'unknown time'}.` : 'No drawdown point available.',
    },
    {
      label: 'Expectancy',
      value: `${fmtMoney(metrics.expectancy)} per fill`,
      read: `${fmtPct(metrics.winRate)} win rate with ${fmtNum(metrics.profitFactor, 2)} profit factor.`,
    },
    {
      label: 'Product contribution',
      value: metrics.productSummary || '-',
      read: 'Realized P&L grouped by product from the imported fill rows.',
    },
    {
      label: 'Best fill',
      value: best ? `${fmtMoney(best.pnl)} ${best.instrument || ''}` : '-',
      read: best?.displayTimestamp || best?.timestamp || 'No timestamp available.',
    },
    {
      label: 'Worst fill',
      value: worst ? `${fmtMoney(worst.pnl)} ${worst.instrument || ''}` : '-',
      read: worst?.displayTimestamp || worst?.timestamp || 'No timestamp available.',
    },
  ]
}

function analyzeTradeAnalyticsCsv(text: string, filename = 'fills.csv'): CeriousTradeAnalyticsState {
  const rows = parseCeriousCsv(text)
  if (rows.length < 2) throw new Error('CSV needs a header row and at least one fill row')
  const headers = rows[0].map(value => value.trim())
  const pnlIndex = ceriousHeaderIndex(headers, ['realizedPnl', 'closedPnl', 'netPnl', 'tradePnl', 'pnl', 'profit', 'net', 'realized'], {
    exclude: ['openPnl', 'cumulativePnl', 'accountDrawdown', 'accountMaxDrawdown', 'accountEquity'],
  })
  if (pnlIndex < 0) throw new Error('Could not find a realized P&L column. Try realizedPnl, pnl, profit, net, or realized.')

  const instrumentIndex = ceriousHeaderIndex(headers, ['instrument', 'instrumentId', 'symbol', 'product', 'market'])
  const sideIndex = ceriousHeaderIndex(headers, ['side', 'buy/sell'])
  const qtyIndex = ceriousHeaderIndex(headers, ['qty', 'quantity', 'size'])
  const priceIndex = ceriousHeaderIndex(headers, ['price', 'fillPrice', 'fill price'])
  const timestampIndex = ceriousHeaderIndex(headers, ['timestamp'])
  const timestampChicagoIndex = ceriousHeaderIndex(headers, ['timestampChicago'])
  const timeIndex = ceriousHeaderIndex(headers, ['time', 'date'])
  const cumulativeIndex = ceriousHeaderIndex(headers, ['cumulativePnl'])
  const drawdownIndex = ceriousHeaderIndex(headers, ['accountMaxDrawdown', 'maxDrawdown'])
  const currentDrawdownIndex = ceriousHeaderIndex(headers, ['accountDrawdown', 'drawdown'])
  const knownProducts = new Set(['ES', 'NQ', 'YM', 'RTY', 'ES_NQ', 'YM_ES', 'RTY_ES', 'ES/NQ', 'YM/ES', 'RTY/ES', 'ZM', 'ZS', 'CL', 'GC'])

  const records = rows.slice(1).map(row => {
    const pnl = csvNumber(row[pnlIndex])
    const timestamp = timestampIndex >= 0 ? String(row[timestampIndex] || '').trim() : ''
    const displayTimestamp = timestampChicagoIndex >= 0 ? String(row[timestampChicagoIndex] || '').trim() : timestamp
    const fallbackTimestamp = timeIndex >= 0 ? String(row[timeIndex] || '').trim() : ''
    return {
      pnl: pnl ?? Number.NaN,
      cumulativePnl: cumulativeIndex >= 0 ? csvNumber(row[cumulativeIndex]) : null,
      accountMaxDrawdown: drawdownIndex >= 0 ? csvNumber(row[drawdownIndex]) : null,
      accountDrawdown: currentDrawdownIndex >= 0 ? csvNumber(row[currentDrawdownIndex]) : null,
      instrument: instrumentIndex >= 0 ? String(row[instrumentIndex] || '').trim().toUpperCase() : '',
      side: sideIndex >= 0 ? String(row[sideIndex] || '').trim() : '',
      qty: qtyIndex >= 0 ? csvNumber(row[qtyIndex]) : null,
      price: priceIndex >= 0 ? csvNumber(row[priceIndex]) : null,
      timestamp: timestamp || fallbackTimestamp,
      displayTimestamp: displayTimestamp || fallbackTimestamp,
      timestampMs: parseTradeTimestamp(timestamp || fallbackTimestamp || displayTimestamp),
    } satisfies ImportedFillRecord
  }).filter(record => Number.isFinite(record.pnl))

  records.sort((a, b) => {
    const left = Number(a.timestampMs)
    const right = Number(b.timestampMs)
    if (Number.isFinite(left) && Number.isFinite(right)) return left - right
    return 0
  })

  const pnls = records.map(record => record.pnl)
  if (!pnls.length) throw new Error('No numeric P&L rows found.')
  const total = pnls.reduce((sum, value) => sum + value, 0)
  const wins = pnls.filter(value => value > 0)
  const losses = pnls.filter(value => value < 0)
  const grossProfit = wins.reduce((sum, value) => sum + value, 0)
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0))
  const returns = pnls.map(value => value / TRADE_ANALYTICS_ACCOUNT_SIZE)
  const meanReturn = ceriousMean(returns)
  const sigma = ceriousStdev(returns)
  const downside = ceriousDownsideDeviation(returns, 0)
  const curve = equityCurveFromPnls(pnls)
  const reportedDrawdown = Math.max(0, ...records.map(record => Number(record.accountMaxDrawdown)).filter(Number.isFinite))
  const drawdown = reportedDrawdown || (curve.length ? curve[curve.length - 1].maxDrawdown : ceriousMaxDrawdown(pnls))
  const peakPoint = curve.reduce<CeriousTradeAnalyticsState['curve'][number] | null>((winner, point) => !winner || point.equity > winner.equity ? point : winner, null)
  const troughPoint = curve.reduce<CeriousTradeAnalyticsState['curve'][number] | null>((loser, point) => !loser || point.equity < loser.equity ? point : loser, null)
  const worstDrawdownPoint = records.reduce<ImportedFillRecord | null>((worst, record) => {
    const value = Number(record.accountDrawdown)
    if (!Number.isFinite(value)) return worst
    if (!worst || value > Number(worst.accountDrawdown)) return record
    return worst
  }, null)
  const productTotalsMap = records.reduce<Record<string, number>>((map, record) => {
    const key = record.instrument || 'UNKNOWN'
    map[key] = (map[key] || 0) + record.pnl
    return map
  }, {})
  const productTotals = Object.entries(productTotalsMap)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([instrument, pnl]) => ({ instrument, pnl }))
  const returnPct = total / TRADE_ANALYTICS_ACCOUNT_SIZE
  const drawdownPct = drawdown / TRADE_ANALYTICS_ACCOUNT_SIZE
  const knownInstrumentRows = records.filter(record => knownProducts.has(record.instrument)).length
  const metrics: CeriousTradeAnalyticsState['metrics'] = {
    rows: records.length,
    accountSize: TRADE_ANALYTICS_ACCOUNT_SIZE,
    total,
    returnPct,
    winRate: wins.length / records.length,
    sharpe: sigma ? meanReturn / sigma * Math.sqrt(returns.length) : 0,
    sortino: downside ? meanReturn / downside * Math.sqrt(returns.length) : 0,
    calmar: drawdownPct ? returnPct / drawdownPct : 0,
    profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit || 0,
    expectancy: ceriousMean(pnls),
    drawdown,
    drawdownPct,
    studyCoverage: records.length ? knownInstrumentRows / records.length : 0,
    largestLossPct: Math.abs(Math.min(0, ...pnls)) / TRADE_ANALYTICS_ACCOUNT_SIZE,
    knownInstrumentRows,
    peakEquity: peakPoint ? peakPoint.equity : TRADE_ANALYTICS_ACCOUNT_SIZE,
    troughEquity: troughPoint ? troughPoint.equity : TRADE_ANALYTICS_ACCOUNT_SIZE,
    endEquity: curve.length ? curve[curve.length - 1].equity : TRADE_ANALYTICS_ACCOUNT_SIZE,
    productSummary: productTotals.map(row => `${row.instrument} ${fmtMoney(row.pnl)}`).join(' | '),
    worstDrawdownPoint,
  }
  const studies = buildTradeAnalyticsStudies(metrics)
  const report = buildTradeAnalyticsReport(metrics, records)
  return {
    service: 'analytics.trade.imported',
    fetchedAt: new Date().toISOString(),
    status: `Imported ${records.length} row(s); account base ${fmtMoney(TRADE_ANALYTICS_ACCOUNT_SIZE)}.`,
    riskLevel: tradeAnalyticsRiskLevel(metrics),
    metrics,
    studies,
    curve,
    productTotals,
    report,
    records,
    source: 'imported',
    filename,
  }
}

function loadImportedTradeAnalytics(): CeriousTradeAnalyticsState | null {
  try {
    const raw = window.localStorage.getItem(TRADE_ANALYTICS_IMPORT_KEY)
    return raw ? JSON.parse(raw) as CeriousTradeAnalyticsState : null
  } catch {
    return null
  }
}

const CERIOUS_ADVISORY_REFRESH_MS = 30 * 60_000
const CERIOUS_ADVISORY_REFRESH_LABEL = 'Completed 30m advisory cadence'

function useCeriousIntelligence(intervalMs = CERIOUS_ADVISORY_REFRESH_MS): CeriousIntelligence | null {
  const [data, setData] = useState<CeriousIntelligence | null>(null)

  useEffect(() => {
    let cancelled = false
    const pull = async () => {
      try {
        const response = await fetch('/api/cerious/intelligence', { cache: 'no-store' })
        if (!response.ok || cancelled) return
        setData(await response.json())
      } catch {
        // Panels keep their previous data if the local service is restarting.
      }
    }
    pull()
    const id = window.setInterval(pull, intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [intervalMs])

  return data
}

async function submitSharedOrder(order: Partial<SimOrder> & {
  orderId: string
  marketKey: string
  side: 'bid' | 'offer'
  price: number
  size: number
  operator: string
  source: 'manual' | 'algo'
}): Promise<SimOrder | undefined> {
  const response = await ceriousFetch('/api/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(order),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload.ok) {
    throw new Error(String(payload.detail || payload.message || `Order rejected HTTP ${response.status}`))
  }
  if (payload.state) {
    useStore.getState().setSimTradingState({
      simOrders: payload.state.simOrders,
      simPositions: payload.state.simPositions,
      fills: payload.state.fills,
      simMessages: payload.state.simMessages,
    })
  }
  return payload.order as SimOrder | undefined
}

async function cancelSharedOrder(orderId: string): Promise<void> {
  const response = await ceriousFetch(`/api/cerious/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload.ok) {
    throw new Error(String(payload.detail || payload.message || `Cancel rejected HTTP ${response.status}`))
  }
  if (payload.state) {
    useStore.getState().setSimTradingState({
      simOrders: payload.state.simOrders,
      simPositions: payload.state.simPositions,
      fills: payload.state.fills,
      simMessages: payload.state.simMessages,
    })
  }
}

function useCeriousPositionsOrders() {
  const [data, setData] = useState<CeriousPositionsOrdersState | null>(null)
  const [error, setError] = useState('')

  const pull = async () => {
    try {
      const response = await ceriousFetch('/api/cerious/positions-orders', { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json() as CeriousPositionsOrdersState
      if (ceriousTradingSnapshotUnavailable(payload)) return
      setData(payload)
      applyCeriousTradingSnapshot(payload)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Positions refresh failed')
    }
  }

  useEffect(() => {
    let cancelled = false
    const safePull = async () => {
      if (cancelled) return
      await pull()
    }
    safePull()
    const id = window.setInterval(safePull, 2000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  return { data, error, refresh: pull }
}

function useCeriousTradingStateHydrator(intervalMs = 1000) {
  useEffect(() => {
    let cancelled = false
    const pull = async () => {
      try {
        const response = await ceriousFetch('/api/cerious/positions-orders', { cache: 'no-store' })
        if (!response.ok || cancelled) return
        const payload = await response.json() as CeriousPositionsOrdersState
        if (!cancelled) applyCeriousTradingSnapshot(payload)
      } catch {
        // Trading state hydration is retried on the next interval; service health UI reports readiness.
      }
    }
    void pull()
    const id = window.setInterval(() => { void pull() }, intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [intervalMs])
}

function useMarketBootstrap() {
  const setMarkets = useStore(s => s.setMarkets)

  useEffect(() => {
    let cancelled = false
    const pull = async () => {
      try {
        const response = await fetch('/api/markets')
        if (cancelled) return
        if (response.ok) {
          const payload = await response.json()
          if (!cancelled && Array.isArray(payload.markets)) setMarkets(payload.markets, true)
        }
      } catch {
        // The terminal can still run from websocket snapshots.
      }
    }
    pull()
    const id = window.setInterval(pull, 10_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [setMarkets])
}

type MarketDataStatusPayload = {
  ok?: boolean
  provider?: string
  dataset?: string
  schema?: string
  status?: string
  detail?: string
  running?: boolean
  connected?: boolean
  subscribed?: boolean
  heartbeatOk?: boolean
  priceReady?: boolean
  subscriptionAcks?: number
  mappings?: number
  definitions?: number
  records?: number
  lastStatusMs?: number
  lastHeartbeatMs?: number
  lastRecordMs?: number
  error?: string
  bookSymbols?: string[]
}

type ExecutionStatusPayload = {
  ok?: boolean
  destination?: string
  exchange?: string
  required?: boolean
  healthy?: boolean
  stateOwner?: string
}

type CeriousReadiness = {
  gatewayOk: boolean
  marketData: MarketDataStatusPayload | null
  execution: ExecutionStatusPayload | null
  connected: boolean
  priceReady: boolean
  executionReady: boolean
  detail: string
  checkedAt: number
}

const EMPTY_READINESS: CeriousReadiness = {
  gatewayOk: false,
  marketData: null,
  execution: null,
  connected: false,
  priceReady: false,
  executionReady: false,
  detail: 'Checking services',
  checkedAt: 0,
}

function useCeriousServiceReadiness(): CeriousReadiness {
  const setConnected = useStore(s => s.setConnected)
  const [readiness, setReadiness] = useState<CeriousReadiness>(EMPTY_READINESS)

  useEffect(() => {
    let cancelled = false
    const readJson = async <T,>(path: string): Promise<T | null> => {
      const response = await ceriousFetch(path, { cache: 'no-store' })
      if (!response.ok) return null
      return response.json() as Promise<T>
    }
    const pull = async () => {
      let gatewayOk = false
      let marketData: MarketDataStatusPayload | null = null
      let execution: ExecutionStatusPayload | null = null
      try {
        const [healthResult, marketResult, executionResult] = await Promise.allSettled([
          readJson<Record<string, unknown>>('/api/health'),
          readJson<MarketDataStatusPayload>('/api/market-data/status'),
          readJson<ExecutionStatusPayload>('/api/execution/status'),
        ])
        gatewayOk = healthResult.status === 'fulfilled' && Boolean(healthResult.value?.ok)
        marketData = marketResult.status === 'fulfilled' ? marketResult.value : null
        execution = executionResult.status === 'fulfilled' ? executionResult.value : null
      } catch {
        gatewayOk = false
      }
      if (cancelled) return
      const mdConnected = Boolean(marketData?.connected)
      const executionReady = Boolean(execution?.healthy)
      const priceReady = Boolean(marketData?.priceReady)
      const detail = !gatewayOk
        ? 'Gateway down'
        : !mdConnected
          ? marketData?.error || marketData?.detail || 'Market data connecting'
          : !priceReady
            ? 'Market data connected; waiting for first book'
            : !executionReady
              ? 'Execution service connecting'
              : 'Services ready'
      const next = {
        gatewayOk,
        marketData,
        execution,
        connected: gatewayOk && mdConnected && executionReady,
        priceReady,
        executionReady,
        detail,
        checkedAt: Date.now(),
      }
      setConnected(next.connected)
      setReadiness(next)
    }
    pull()
    const id = window.setInterval(pull, 2000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [setConnected])

  return readiness
}

function useProductOptions(): ProductOption[] {
  const markets = useStore(s => s.markets)

  return useMemo(() => {
    const serverAssetOrder = Array.from(new Set(markets.map(market => market.asset).filter(Boolean))) as Asset[]
    const assetRank = (asset?: Asset) => {
      const serverRank = serverAssetOrder.indexOf(asset as Asset)
      if (serverRank >= 0) return serverRank
      const fallbackRank = CME_PRODUCT_ASSETS.indexOf(asset ?? 'EVENT')
      return fallbackRank >= 0 ? serverAssetOrder.length + fallbackRank : Number.MAX_SAFE_INTEGER
    }
    return markets.map(market => ({
      provider: 'cme' as const,
      symbol: market.key,
      label: market.key,
      subtitle: market.question,
      marketKey: market.key,
      asset: market.asset,
      timeframe: market.timeframe,
      yes: market.up_pct,
      no: market.down_pct,
      truthYes: market.truth_up_pct,
      truthNo: market.truth_down_pct,
      spot: market.price_to_beat ?? market.resolution_price ?? market.start_price,
      priceToBeat: market.price_to_beat ?? market.start_price ?? market.resolution_price,
      expiryTs: market.expiry_ts,
      volume: market.volume,
      lastUpdate: market.last_update_ms,
      live: market.live,
      tickSize: market.tickSize,
      tickValue: market.tickValue,
      multiplier: market.multiplier,
    }))
      .sort((a, b) => {
        const rank = assetRank(a.asset) - assetRank(b.asset)
        if (rank !== 0) return rank
        return a.symbol.localeCompare(b.symbol)
      })
  }, [markets])
}

function mappedLiquidityProducts(options: ProductOption[], cryptoPrices: ReturnType<typeof useStore.getState>['cryptoPrices']): ProductOption[] {
  void cryptoPrices
  const serverAssetOrder = Array.from(new Set(options.map(option => option.asset).filter(Boolean))) as Asset[]
  const assetRank = (asset?: Asset) => {
    const serverRank = serverAssetOrder.indexOf(asset as Asset)
    if (serverRank >= 0) return serverRank
    const fallbackRank = CME_PRODUCT_ASSETS.indexOf(asset ?? 'EVENT')
    return fallbackRank >= 0 ? serverAssetOrder.length + fallbackRank : Number.MAX_SAFE_INTEGER
  }
  return [...options].sort((a, b) => {
    const providerRank = PROVIDERS.findIndex(provider => provider.key === a.provider) - PROVIDERS.findIndex(provider => provider.key === b.provider)
    if (providerRank !== 0) return providerRank
    const rank = assetRank(a.asset) - assetRank(b.asset)
    if (rank !== 0) return rank
    return a.symbol.localeCompare(b.symbol)
  })
}

function productOptionForSavedRow(options: ProductOption[], row: MarketRowConfig): ProductOption {
  const existing = options.find(item => item.provider === row.provider && item.symbol === row.symbol)
  if (existing) return existing
  const symbol = normalizeProductKey(row.symbol) || String(row.symbol || '').trim().toUpperCase()
  const asset = PRODUCT_ASSETS.includes(symbol as Asset) ? symbol as Asset : undefined
  return {
    provider: normalizeProviderKey(row.provider),
    symbol,
    label: symbol,
    subtitle: `${symbol} mapped product`,
    marketKey: symbol,
    asset,
    live: true,
  }
}

function ProductSelector({
  provider,
  symbol,
  onSelect,
  compact = false,
}: {
  provider: ProviderKey
  symbol: string
  onSelect: (provider: ProviderKey, symbol: string) => void
  compact?: boolean
}) {
  const options = useProductOptions()
  const setProvider = useStore(s => s.setMarketProvider)
  const setActiveMarketKey = useStore(s => s.setActiveMarketKey)
  const setActiveAsset = useStore(s => s.setActiveAsset)

  const activeProvider = normalizeProviderKey(provider)
  const providerOptions = options.filter(option => option.provider === activeProvider)
  const selected = options.find(option => option.provider === activeProvider && option.symbol === symbol)
  const loadedProviders = new Set(options.map(option => option.provider))
  const selectableProviders = PROVIDERS.filter(item => item.key === activeProvider || loadedProviders.has(item.key))

  const selectProvider = (nextProvider: ProviderKey) => {
    const normalizedProvider = normalizeProviderKey(nextProvider)
    const first = options.find(option => option.provider === normalizedProvider)
    const nextSymbol = first?.symbol ?? (PRODUCT_ASSETS[0] as string)
    setProvider(normalizedProvider)
    if (first?.marketKey) setActiveMarketKey(first.marketKey)
    if (first?.asset) setActiveAsset(first.asset)
    onSelect(normalizedProvider, nextSymbol)
  }

  const selectSymbol = (nextSymbol: string) => {
    const next = options.find(option => option.provider === activeProvider && option.symbol === nextSymbol)
    setProvider(activeProvider)
    if (next?.marketKey) setActiveMarketKey(next.marketKey)
    if (next?.asset) setActiveAsset(next.asset)
    onSelect(activeProvider, nextSymbol)
  }

  return (
    <div className={cx('grid gap-2', compact ? 'grid-cols-[120px_1fr]' : 'grid-cols-[150px_1fr]')}>
      <select
        value={activeProvider}
        onChange={event => selectProvider(event.target.value as ProviderKey)}
        className="input-field py-1 text-[11px]"
      >
        {selectableProviders.map(item => (
          <option key={item.key} value={item.key}>{item.label}</option>
        ))}
      </select>
      <select
        value={selected ? symbol : ''}
        onChange={event => selectSymbol(event.target.value)}
        className="input-field py-1 text-[11px]"
      >
        <option value="">{providerOptions.length === 0 ? 'No products loaded' : 'Select mapped product...'}</option>
        {providerOptions.map(option => (
          <option key={`${option.provider}-${option.symbol}`} value={option.symbol}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

function WorkspaceWindowFrame({
  item,
  active,
  onActivate,
  onMove,
  onResize,
  onToggleCollapse,
  onClone,
  onClose,
  getWorkspacePan,
  onDragPointerMove,
  onDragPointerEnd,
  children,
}: {
  item: WorkspaceWindow
  active: boolean
  onActivate: () => void
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, patch: Partial<Pick<WorkspaceWindow, 'x' | 'y' | 'w' | 'h'>>) => void
  onToggleCollapse: () => void
  onClone: () => void
  onClose: () => void
  getWorkspacePan: () => { x: number; y: number }
  onDragPointerMove: (event: PointerEvent) => void
  onDragPointerEnd: () => void
  children: ReactNode
}) {
  const displayTitle = item.kind === 'depthLadder' && item.symbol
    ? `${WINDOW_LABELS.depthLadder} - ${item.symbol}`
    : item.title

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, input, select')) return
    onActivate()
    const startX = event.clientX
    const startY = event.clientY
    const startLeft = item.x
    const startTop = item.y
    const startPan = getWorkspacePan()
    let latestX = startX
    let latestY = startY
    let dragFrame: number | null = null
    event.currentTarget.setPointerCapture(event.pointerId)

    const syncDrag = () => {
      const pan = getWorkspacePan()
      onMove(
        item.id,
        Math.max(8, startLeft + latestX - startX + (pan.x - startPan.x)),
        Math.max(48, startTop + latestY - startY + (pan.y - startPan.y)),
      )
      dragFrame = window.requestAnimationFrame(syncDrag)
    }

    const move = (ev: PointerEvent) => {
      latestX = ev.clientX
      latestY = ev.clientY
      onDragPointerMove(ev)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      onDragPointerEnd()
      if (dragFrame !== null) window.cancelAnimationFrame(dragFrame)
    }
    syncDrag()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const startResize = (direction: ResizeDirection) => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (item.collapsed) return
    onActivate()

    const startX = event.clientX
    const startY = event.clientY
    const startLeft = item.x
    const startTop = item.y
    const startWidth = item.w
    const startHeight = item.h
    const startPan = getWorkspacePan()
    const minWidth = 260
    const minHeight = 180
    event.currentTarget.setPointerCapture(event.pointerId)

    const move = (ev: PointerEvent) => {
      const pan = getWorkspacePan()
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      const panDx = pan.x - startPan.x
      const panDy = pan.y - startPan.y
      const patch: Partial<Pick<WorkspaceWindow, 'x' | 'y' | 'w' | 'h'>> = {}
      onDragPointerMove(ev)

      if (direction.includes('e')) {
        patch.w = clamp(startWidth + dx + panDx, minWidth, 2400)
      }
      if (direction.includes('s')) {
        patch.h = clamp(startHeight + dy + panDy, minHeight, 1800)
      }
      if (direction.includes('w')) {
        const maxDx = startWidth - minWidth
        const nextDx = clamp(dx + panDx, 8 - startLeft, maxDx)
        patch.x = startLeft + nextDx
        patch.w = startWidth - nextDx
      }
      if (direction.includes('n')) {
        const maxDy = startHeight - minHeight
        const nextDy = clamp(dy + panDy, 48 - startTop, maxDy)
        patch.y = startTop + nextDy
        patch.h = startHeight - nextDy
      }

      onResize(item.id, patch)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      onDragPointerEnd()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const resizeHandles: Array<{ direction: ResizeDirection; className: string }> = [
    { direction: 'n', className: 'left-3 right-3 top-0 h-1.5 cursor-ns-resize' },
    { direction: 's', className: 'bottom-0 left-3 right-3 h-1.5 cursor-ns-resize' },
    { direction: 'e', className: 'bottom-3 right-0 top-3 w-1.5 cursor-ew-resize' },
    { direction: 'w', className: 'bottom-3 left-0 top-3 w-1.5 cursor-ew-resize' },
    { direction: 'ne', className: 'right-0 top-0 h-3 w-3 cursor-nesw-resize' },
    { direction: 'nw', className: 'left-0 top-0 h-3 w-3 cursor-nwse-resize' },
    { direction: 'se', className: 'bottom-0 right-0 h-4 w-4 cursor-nwse-resize' },
    { direction: 'sw', className: 'bottom-0 left-0 h-4 w-4 cursor-nesw-resize' },
  ]
  const frameBorderColor = active ? '#6ea8ff' : '#4b5563'
  const frameShadow = active
    ? '0 0 0 1px rgba(110, 168, 255, .36), 0 12px 30px rgba(0, 0, 0, .48)'
    : '0 0 0 1px rgba(156, 163, 175, .18), 0 10px 22px rgba(0, 0, 0, .42)'

  return (
    <section
      data-window-frame="true"
      className={cx(
        'absolute overflow-hidden rounded-sm border-2',
      )}
      style={{
        left: item.x,
        top: item.y,
        width: item.w,
        height: item.collapsed ? 34 : item.h,
        zIndex: item.z,
        borderColor: frameBorderColor,
        boxShadow: frameShadow,
        background: '#11151b',
      }}
      onPointerDown={onActivate}
    >
      <div
        className="flex h-[34px] cursor-move select-none items-center justify-between border-b bg-surface-panel px-2"
        style={{ borderColor: frameBorderColor }}
        onPointerDown={startDrag}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className={cx('h-2 w-2 rounded-full', active ? 'bg-accent' : 'bg-muted/60')} />
          <span className="truncate text-[11px] font-bold uppercase tracking-normal text-white">{displayTitle}</span>
        </div>
        <div className="flex items-center gap-1">
          <button className="btn-neutral rounded p-1" title="Clone window" onClick={onClone}>
            <Copy size={13} />
          </button>
          <button className="btn-neutral rounded p-1" title={item.collapsed ? 'Expand' : 'Collapse'} onClick={onToggleCollapse}>
            {item.collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          </button>
          <button className="btn-neutral rounded p-1" title="Close" onClick={onClose}>
            <X size={13} />
          </button>
        </div>
      </div>
      {!item.collapsed && <div className="h-[calc(100%-34px)] min-h-0 overflow-hidden">{children}</div>}
      {!item.collapsed && resizeHandles.map(handle => (
        <div
          key={handle.direction}
          className={`absolute z-20 ${handle.className}`}
          onPointerDown={startResize(handle.direction)}
          title={`Resize ${handle.direction.toUpperCase()}`}
        />
      ))}
      {!item.collapsed && (
        <div
          className="absolute bottom-1 right-1 z-10 h-3 w-3 rounded-sm border-b border-r border-accent/60 opacity-80"
          aria-hidden="true"
        />
      )}
    </section>
  )
}

function fmtSignedPct(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '-'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function fmtCents(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '-'
  return `${n.toFixed(n >= 10 ? 1 : 2)}c`
}

function fmtCompact(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '-'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toFixed(0)
}

function fmtQuote(n: number | undefined, mode: 'money' | 'cents' | 'price'): string {
  if (n === undefined || Number.isNaN(n)) return '-'
  if (mode === 'price') return fmtLadderPrice(n)
  return mode === 'money' ? fmtMoney(n) : fmtCents(n)
}

function fmtSignedQuote(n: number | undefined, mode: 'money' | 'cents' | 'price'): string {
  if (n === undefined || Number.isNaN(n)) return '-'
  if (mode === 'price') return `${n >= 0 ? '+' : ''}${fmtLadderPrice(n)}`
  const abs = mode === 'money' ? fmtMoney(Math.abs(n)) : fmtCents(Math.abs(n))
  return `${n >= 0 ? '+' : '-'}${abs}`
}

function fmtTimestamp(ts: number | undefined): string {
  if (!ts || Number.isNaN(ts)) return '-'
  const d = new Date(ts)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const ss = d.getSeconds().toString().padStart(2, '0')
  const ms = d.getMilliseconds().toString().padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

function barStats(assetBars: Bar[]) {
  if (!assetBars.length) return {}
  const latest = assetBars.at(-1)
  const previous = assetBars.length > 1 ? assetBars.at(-2) : undefined
  return {
    open: assetBars[0]?.open,
    high: Math.max(...assetBars.map(bar => bar.high)),
    low: Math.min(...assetBars.map(bar => bar.low)),
    previousClose: previous?.close,
    last: latest?.close,
    volume: assetBars.reduce((sum, bar) => sum + (bar.volume ?? 0), 0),
    timestamp: latest?.timestamp,
  }
}

function probabilityStats(points: Array<{ ts: number; up_pct: number }>) {
  if (!points.length) return {}
  const latest = points.at(-1)
  const previous = points.length > 1 ? points.at(-2) : undefined
  return {
    open: points[0]?.up_pct,
    high: Math.max(...points.map(point => point.up_pct)),
    low: Math.min(...points.map(point => point.up_pct)),
    previousClose: previous?.up_pct,
    last: latest?.up_pct,
    volume: points.length,
    timestamp: latest?.ts,
  }
}

function latestTradeForMarket(ticks: PolyTradeTick[], fills: PolyTradeTick[]): PolyTradeTick | undefined {
  return [...ticks, ...fills].sort((a, b) => a.timestamp - b.timestamp).at(-1)
}

function yesPriceFromTrade(tick: PolyTradeTick | undefined): number | undefined {
  if (!tick) return undefined
  return tick.side === 'yes' ? tick.price : 100 - tick.price
}

function cmeBookToPolyCompat(cmeBook: CmeBook): PolyBook {
  const mark = cmeBook.ltp ?? cmeBook.mid
  return {
    market_key: cmeBook.symbol,
    question: `${cmeBook.symbol} CME depth`,
    up_token_id: cmeBook.symbol,
    bids: (cmeBook.bids ?? []).map(level => ({ price: level.price, size: level.size, count: level.count ?? level.ct })),
    asks: (cmeBook.asks ?? []).map(level => ({ price: level.price, size: level.size, count: level.count ?? level.ct })),
    best_bid: cmeBook.bestBid ?? cmeBook.bids?.[0]?.price ?? null,
    best_ask: cmeBook.bestAsk ?? cmeBook.asks?.[0]?.price ?? null,
    mid: cmeBook.mid ?? 0,
    spread_pct: cmeBook.spread ?? null,
    up_pct: mark ?? 0,
    down_pct: mark ?? 0,
    ltp: mark,
    ltp_size: cmeBook.ltpSize,
    expiry_ts: (cmeBook.tsMs ?? Date.now()) + 24 * 60 * 60 * 1000,
    live: true,
    timestamp_ms: cmeBook.tsMs ?? Date.now(),
    seen_ms: cmeBook.tsMs ?? Date.now(),
  }
}

function cmeTradeToPolyCompat(trade: CmeTradeTick): PolyTradeTick {
  return {
    timestamp: trade.timestamp,
    marketKey: trade.symbol,
    price: trade.price,
    size: trade.size,
    side: 'yes',
    displaySide: trade.side?.toUpperCase(),
    marketSide: trade.side,
  }
}

function useCmeMarketDataSubscriptions(symbols: string[]) {
  const symbolKey = symbols
    .map(symbol => String(symbol || '').trim().toUpperCase())
    .filter(Boolean)
    .sort()
    .filter((symbol, index, list) => index === 0 || symbol !== list[index - 1])
    .join('|')

  useEffect(() => {
    const targets = symbolKey ? symbolKey.split('|') : []
    if (!targets.length) return
    let alive = true
    const sockets: WebSocket[] = []
    const timers: number[] = []
    const store = () => useStore.getState()
    const wsBase = ceriousWsBase()

    const ingestBook = (target: string, book: CmeBook) => {
      if (!alive || book.symbol?.toUpperCase() !== target) return
      store().setPolyBook(target, cmeBookToPolyCompat(book))
    }

    const acceptTrade = (target: string, trade: CmeTradeTick) => {
      if (!alive || trade.symbol?.toUpperCase() !== target) return
      store().pushPolyTick(target, cmeTradeToPolyCompat(trade))
    }

    for (const target of targets) {
      const pullBook = () => {
        fetch(`/api/cme/book/${encodeURIComponent(target)}`)
          .then(response => response.ok ? response.json() : null)
          .then((payload: CmeBook | null) => {
            if (payload) ingestBook(target, payload)
          })
          .catch(() => undefined)
      }
      pullBook()
      timers.push(window.setInterval(pullBook, 1000))
      fetch(`/api/cme/trades/${encodeURIComponent(target)}`)
        .then(response => response.ok ? response.json() : null)
        .then((payload: { trades?: CmeTradeTick[] } | null) => {
          if (!alive || !Array.isArray(payload?.trades)) return
          for (const trade of payload.trades.slice(-20)) acceptTrade(target, trade)
        })
        .catch(() => undefined)

      if (ENABLE_LEGACY_BROWSER_WS) {
        const wsParams = new URLSearchParams({ provider: 'cme' })
        const token = workspaceSessionToken()
        if (token) wsParams.set('token', token)
        const ws = new WebSocket(`${wsBase}/${encodeURIComponent(target)}?${wsParams.toString()}`)
        ws.onmessage = event => {
          try {
            const payload = JSON.parse(event.data)
            if (payload.type === 'snapshot') {
              const cmeBooks = payload.cme_books as Record<string, CmeBook> | undefined
              const cmeTrades = payload.cme_trades as Record<string, CmeTradeTick[]> | undefined
              if (cmeBooks?.[target]) ingestBook(target, cmeBooks[target])
              for (const trade of cmeTrades?.[target] ?? []) acceptTrade(target, trade)
              return
            }
            if (payload.type === 'cme_book' && payload.symbol === target) ingestBook(target, payload.data as CmeBook)
            if (payload.type === 'cme_trade' && payload.symbol === target) acceptTrade(target, payload.data as CmeTradeTick)
            if (payload.type === 'markets') store().setMarkets(payload.data, true)
          } catch {
            // Ignore malformed feed messages and keep the stream alive.
          }
        }
        ws.onerror = () => ws.close()
        sockets.push(ws)
      }
    }

    return () => {
      alive = false
      for (const timer of timers) window.clearInterval(timer)
      for (const socket of sockets) socket.close()
    }
  }, [symbolKey])
}

function sumTradeNotional(ticks: PolyTradeTick[]): number {
  return ticks.reduce((sum, tick) => sum + (tick.price / 100) * tick.size, 0)
}

function sumTradeContracts(ticks: PolyTradeTick[]): number {
  return ticks.reduce((sum, tick) => sum + tick.size, 0)
}

function fmtTimeLeft(expiryTs: number | undefined): string {
  if (!expiryTs || Number.isNaN(expiryTs)) return '-'
  const ms = expiryTs - Date.now()
  if (ms <= 0) return 'expired'
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

function csvEscape(value: unknown): string {
  const text = value == null ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function exportCsv(filename: string, headers: string[], rows: Array<Record<string, unknown>>) {
  const csv = [
    headers.map(csvEscape).join(','),
    ...rows.map(row => headers.map(header => csvEscape(row[header])).join(',')),
  ].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

function playAlertSound(sound: AlertSound = 'system-chime'): AlertDeliveryResult {
  try {
    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) return { channel: 'audio', ok: false, message: 'Audio unavailable' }
    const ctx = new AudioContextCtor()
    if (ctx.state === 'suspended') void ctx.resume()
    const gain = ctx.createGain()
    gain.connect(ctx.destination)
    const profile: Record<AlertSound, Array<[number, number]>> = {
      'system-chime': [[880, 0], [1175, 0.12]],
      'system-bell': [[660, 0], [660, 0.18]],
      'system-alarm': [[440, 0], [880, 0.12], [440, 0.24]],
    }
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45)
    profile[sound].forEach(([freq, offset]) => {
      const osc = ctx.createOscillator()
      osc.type = sound === 'system-alarm' ? 'square' : 'sine'
      osc.frequency.setValueAtTime(freq, ctx.currentTime + offset)
      osc.connect(gain)
      osc.start(ctx.currentTime + offset)
      osc.stop(ctx.currentTime + offset + 0.16)
    })
    window.setTimeout(() => void ctx.close(), 700)
    return { channel: 'audio', ok: true, message: 'Audio sent' }
  } catch (error) {
    return { channel: 'audio', ok: false, message: error instanceof Error ? error.message : 'Audio blocked' }
  }
}

async function notifyDesktop(title: string, body: string): Promise<AlertDeliveryResult> {
  if (!('Notification' in window)) return { channel: 'desktop', ok: false, message: 'Desktop notifications unavailable' }
  const permission = Notification.permission === 'default'
    ? await Notification.requestPermission()
    : Notification.permission
  if (permission === 'granted') {
    new Notification(title, { body, tag: 'qst-fill-alert' })
    return { channel: 'desktop', ok: true, message: 'Desktop sent' }
  }
  return { channel: 'desktop', ok: false, message: `Desktop ${permission}` }
}

async function sendSmsAlert(phone: string | undefined, message: string): Promise<AlertDeliveryResult> {
  if (!phone?.trim()) return { channel: 'sms', ok: false, message: 'Text phone missing' }
  try {
    const response = await ceriousFetch('/api/alerts/sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: phone.trim(), message }),
    })
    const payload = await response.json().catch(() => ({})) as { ok?: boolean; configured?: boolean; dryRun?: boolean; error?: string; provider?: string; message?: string; carrierStatus?: string }
    if (response.ok && payload.ok !== false) {
      const provider = payload.provider ? ` via ${payload.provider}` : ''
      const carrier = payload.carrierStatus ? ` / ${payload.carrierStatus}` : ''
      const verb = payload.dryRun ? 'dry-run accepted' : 'accepted'
      return { channel: 'sms', ok: true, message: `Text ${verb}${provider}${carrier}` }
    }
    return { channel: 'sms', ok: false, message: payload.error ?? `Text failed (${response.status})` }
  } catch (error) {
    return { channel: 'sms', ok: false, message: error instanceof Error ? error.message : 'Text transport failed' }
  }
}

async function fetchSmsAlertStatus(): Promise<SmsAlertStatus> {
  try {
    const response = await ceriousFetch('/api/alerts/sms/status')
    const payload = await response.json().catch(() => ({})) as SmsAlertStatus
    return response.ok ? payload : { ok: false, ready: false, error: payload.error ?? `SMS status failed (${response.status})` }
  } catch (error) {
    return { ok: false, ready: false, error: error instanceof Error ? error.message : 'SMS status unavailable' }
  }
}

function TreeProductPicker({
  options,
  rows,
  onAdd,
  onClose,
}: {
  options: ProductOption[]
  rows: MarketRowConfig[]
  onAdd: (option: ProductOption) => void
  onClose: () => void
}) {
  const [expanded, setExpanded] = useState<ProviderKey>('cme')
  const [query, setQuery] = useState('')
  const existing = new Set(rows.map(row => `${row.provider}-${row.symbol}`))
  const mappedOptions = options.filter(option => option.asset)
  const serverAssetOrder = Array.from(new Set(mappedOptions.map(option => option.asset).filter(Boolean))) as Asset[]
  const assetRank = (asset?: Asset) => {
    const serverRank = serverAssetOrder.indexOf(asset as Asset)
    if (serverRank >= 0) return serverRank
    const fallbackRank = CME_PRODUCT_ASSETS.indexOf(asset ?? 'EVENT')
    return fallbackRank >= 0 ? serverAssetOrder.length + fallbackRank : Number.MAX_SAFE_INTEGER
  }

  const visibleForProvider = (provider: ProviderKey) => mappedOptions
    .filter(option => option.provider === provider)
    .filter(option => {
      const q = query.trim().toLowerCase()
      if (!q) return true
      return `${option.label} ${option.symbol} ${option.subtitle}`.toLowerCase().includes(q)
    })
    .sort((a, b) => {
      const ai = assetRank(a.asset)
      const bi = assetRank(b.asset)
      if (ai !== bi) return ai - bi
      return a.label.localeCompare(b.label)
    })

  return (
    <div className="absolute inset-x-3 top-[58px] z-30 max-h-[calc(100%-72px)] overflow-hidden rounded border border-accent/40 bg-[#080c14] shadow-2xl">
      <div className="flex items-center justify-between border-b border-surface-border bg-surface-panel px-3 py-2">
        <div className="flex items-center gap-2">
          <FolderOpen size={15} className="text-accent" />
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wide text-accent">Add Product</div>
            <div className="text-[10px] text-muted">Exchange folders show mapped products publishing into the terminal.</div>
          </div>
        </div>
        <button className="btn-neutral rounded p-1" title="Close" onClick={onClose}><X size={14} /></button>
      </div>
      <div className="border-b border-surface-border p-2">
        <div className="flex items-center gap-2 rounded border border-surface-border bg-surface-card px-2 py-1">
          <Search size={13} className="text-muted" />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="w-full bg-transparent text-[11px] text-slate-100 outline-none"
            placeholder="Search ES, NQ, RTY, ZS..."
          />
        </div>
      </div>
      <div className="max-h-[460px] overflow-y-auto p-2">
        {PROVIDERS.map(provider => {
          const list = visibleForProvider(provider.key)
          const open = expanded === provider.key
          return (
            <div key={provider.key} className="mb-1 rounded border border-surface-border bg-surface-card/50">
              <button
                className="flex w-full items-center justify-between px-2 py-2 text-left"
                onClick={() => setExpanded(open ? 'cme' : provider.key)}
              >
                <span className="flex items-center gap-2">
                  {open ? <FolderOpen size={14} className="text-accent" /> : <Folder size={14} className="text-muted" />}
                  <span className="text-[11px] font-bold uppercase text-slate-100">{provider.label}</span>
                  <span className="font-mono text-[9px] text-muted">{provider.service}</span>
                </span>
                <span className="font-mono text-[10px] text-muted">{list.length}</span>
              </button>
              {open && (
                <div className="border-t border-surface-border/70">
                  {list.map(option => {
                    const isAdded = existing.has(`${option.provider}-${option.symbol}`)
                    return (
                      <button
                        key={`${option.provider}-${option.symbol}`}
                        className="grid w-full grid-cols-[22px_76px_1fr_80px_80px] items-center gap-2 border-b border-surface-border/40 px-2 py-1.5 text-left font-mono text-[10px] hover:bg-surface-hover disabled:opacity-45"
                        onClick={() => onAdd(option)}
                        disabled={isAdded}
                      >
                        {isAdded ? <Check size={13} className="text-up" /> : <Plus size={13} className="text-accent" />}
                        <span className="font-bold text-slate-100">{option.asset}</span>
                        <span className="truncate text-slate-300">{option.label}</span>
                        <span className="text-right text-up">{fmtQuote(option.priceToBeat ?? option.spot ?? option.yes, option.provider === 'cme' ? 'price' : 'cents')}</span>
                        <span className="text-right text-muted">{fmtMoney(option.volume)}</span>
                      </button>
                    )
                  })}
                  {list.length === 0 && <div className="px-3 py-3 text-[11px] text-muted">No mapped products currently publishing here.</div>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function MarketDataWindow({
  rows,
  setRows,
}: {
  rows: MarketRowConfig[]
  setRows: Dispatch<SetStateAction<MarketRowConfig[]>>
}) {
  const [showPicker, setShowPicker] = useState(false)
  const [columnWidths, setColumnWidths] = useState<Record<MarketDataColumnKey, number>>(() => ({ ...DEFAULT_MARKET_DATA_COLUMN_WIDTHS }))
  const [fontSize, setFontSize] = useState(10)
  const options = useProductOptions()
  const polyBooks = useStore(s => s.polyBooks)
  const polyTicks = useStore(s => s.polyTicks)
  const fills = useStore(s => s.fills)
  const probHistory = useStore(s => s.probHistory)
  const bars = useStore(s => s.bars)
  const activeMarketKey = useStore(s => s.activeMarketKey)
  const setActiveMarketKey = useStore(s => s.setActiveMarketKey)
  const setActiveAsset = useStore(s => s.setActiveAsset)
  const setProvider = useStore(s => s.setMarketProvider)
  const marketDataGridTemplate = MARKET_DATA_COLUMNS.map(column => `${columnWidths[column.key]}px`).join(' ')
  const marketDataMinWidth = MARKET_DATA_COLUMNS.reduce((sum, column) => sum + columnWidths[column.key], 0) + (MARKET_DATA_COLUMNS.length - 1) * 4 + 12
  const marketHeaderClass = 'flex min-w-0 items-center justify-center truncate text-center'
  const marketCellClass = 'flex min-w-0 items-center justify-center truncate text-center'
  const cmeRowSymbols = useMemo(() => rows.flatMap(row => {
    const option = productOptionForSavedRow(options, row)
    if (option?.provider !== 'cme') return []
    return [String(option.marketKey ?? option.asset ?? option.symbol).toUpperCase()]
  }), [options, rows])
  useCmeMarketDataSubscriptions(cmeRowSymbols)

  const rowData = rows.map(row => {
    const option = productOptionForSavedRow(options, row)
    const book = option?.marketKey ? polyBooks[option.marketKey] : undefined
    const marketTicks = option?.marketKey ? (polyTicks[option.marketKey] ?? []) : []
    const marketFills = option?.marketKey ? (fills[option.marketKey] ?? []) : []
    const latestTrade = latestTradeForMarket(marketTicks, marketFills)
    const assetBars = option?.asset ? (bars[option.asset] ?? []) : []
    const pHistory = option?.marketKey ? (probHistory[option.marketKey] ?? []) : []
    const rawFuturesBook = bookUsesRawPrices(book, marketTicks)
    const quoteMode: 'money' | 'cents' | 'price' = rawFuturesBook || option?.provider === 'cme'
      ? 'price'
      : option?.spot != null && !book
        ? 'money'
        : 'cents'
    const stats = quoteMode === 'money' ? barStats(assetBars) : probabilityStats(pHistory)
    const futuresStats = quoteMode === 'price' ? barStats(assetBars) : {}
    const mid = quoteMode === 'price' ? option?.priceToBeat : option?.yes
    const tradeLast = yesPriceFromTrade(latestTrade)
    const bookLtpRaw = (book as (PolyBook & { ltp?: number }) | undefined)?.ltp
    const bookLtp = Number.isFinite(Number(bookLtpRaw))
      ? Number(bookLtpRaw)
      : quoteMode === 'price' && Number.isFinite(Number(book?.up_pct))
        ? Number(book?.up_pct)
        : undefined
    const lastPrice = quoteMode === 'price'
      ? bookLtp ?? latestTrade?.price ?? book?.mid ?? option?.priceToBeat ?? futuresStats.last ?? option?.yes
      : quoteMode === 'money'
        ? option?.spot ?? stats.last
        : tradeLast ?? (book?.mid != null ? book.mid * 100 : undefined) ?? stats.last ?? option?.yes
    const bid = book?.best_bid != null
      ? (quoteMode === 'cents' ? book.best_bid * 100 : book.best_bid)
      : quoteMode === 'money' && lastPrice != null
        ? lastPrice * 0.9999
        : quoteMode === 'price' && lastPrice != null
          ? lastPrice
        : mid != null
          ? Math.max(0, mid - 0.5)
          : undefined
    const ask = book?.best_ask != null
      ? (quoteMode === 'cents' ? book.best_ask * 100 : book.best_ask)
      : quoteMode === 'money' && lastPrice != null
        ? lastPrice * 1.0001
        : quoteMode === 'price' && lastPrice != null
          ? lastPrice
        : mid != null
          ? Math.min(100, mid + 0.5)
          : undefined
    const derivedQuoteSize = quoteMode === 'money' && stats.volume && lastPrice ? stats.volume / 2 : undefined
    const bidSize = book?.bids[0]?.size ?? derivedQuoteSize ?? (quoteMode === 'cents' ? sumTradeContracts(marketTicks.slice(-20)) : undefined)
    const askSize = book?.asks[0]?.size ?? derivedQuoteSize ?? (quoteMode === 'cents' ? sumTradeContracts(marketFills.slice(-20)) : undefined)
    const spread = book?.spread_pct ?? (bid != null && ask != null ? ask - bid : undefined)
    const bookSeen = book ? ((book as { seen_ms?: number }).seen_ms ?? book.timestamp_ms) : undefined
    const timestamp = bookSeen ?? latestTrade?.timestamp ?? futuresStats.timestamp ?? stats.timestamp ?? option?.lastUpdate
    const hasLiveQuote = option?.live && (lastPrice != null || bid != null || ask != null)
    const status = hasLiveQuote ? 'OPEN' : timestamp ? (Date.now() - timestamp < 30_000 ? 'OPEN' : 'STALE') : option?.live ? 'OPEN' : 'WAIT'
    const previousClose = quoteMode === 'price'
      ? futuresStats.previousClose ?? option?.priceToBeat
      : stats.previousClose ?? (quoteMode === 'money' && option?.spot != null ? option.spot : undefined)
    const change = lastPrice != null && previousClose != null ? lastPrice - previousClose : undefined
    const change24h = change != null && previousClose ? (change / previousClose) * 100 : undefined
    const edge = option?.truthYes != null && option.yes != null ? option.truthYes - option.yes : undefined
    const tapeVolume = sumTradeNotional(marketTicks) + sumTradeNotional(marketFills)
    const volume = option?.volume ?? futuresStats.volume ?? stats.volume ?? tapeVolume
    const open = futuresStats.open ?? stats.open ?? lastPrice
    const high = futuresStats.high ?? stats.high ?? lastPrice
    const low = futuresStats.low ?? stats.low ?? lastPrice
    return { row, option, quoteMode, lastPrice, bid, ask, bidSize, askSize, spread, status, change24h, edge, volume, open, high, low, previousClose, change, timestamp }
  })

  const addProduct = (option: ProductOption) => {
    setRows(current => {
      if (current.some(row => row.provider === option.provider && row.symbol === option.symbol)) return current
      return [...current, { id: `row-${Date.now()}-${option.provider}-${option.symbol}`, provider: option.provider, symbol: option.symbol }]
    })
    setShowPicker(false)
  }

  const selectRow = (option: ProductOption | undefined) => {
    if (!option) return
    setProvider(option.provider)
    if (option.asset) setActiveAsset(option.asset)
    if (option.marketKey) setActiveMarketKey(option.marketKey)
  }

  const startColumnResize = (column: (typeof MARKET_DATA_COLUMNS)[number]) => (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!column.resizable) return
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = columnWidths[column.key]
    const move = (ev: PointerEvent) => {
      const nextWidth = clamp(startWidth + ev.clientX - startX, column.min, column.max)
      setColumnWidths(current => ({ ...current, [column.key]: nextWidth }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="relative flex h-full flex-col bg-surface text-xs">
      <div className="flex items-center justify-between gap-2 border-b border-surface-border bg-surface-panel px-3 py-2">
        <div className="flex items-center gap-1 rounded border border-surface-border bg-surface-card p-0.5 font-mono text-[10px]">
          <button
            className="btn-neutral h-6 w-6 p-0 text-[12px] font-black"
            onClick={() => setFontSize(current => clamp(current - 1, 8, 14))}
            title="Decrease market data font"
          >
            -
          </button>
          <span className="w-10 text-center text-muted">{fontSize}px</span>
          <button
            className="btn-neutral h-6 w-6 p-0 text-[12px] font-black"
            onClick={() => setFontSize(current => clamp(current + 1, 8, 14))}
            title="Increase market data font"
          >
            +
          </button>
        </div>
        <button className="btn-accent flex items-center gap-1 px-2 py-1 text-[11px]" onClick={() => setShowPicker(true)}>
          <FolderOpen size={13} /> Add Product
        </button>
      </div>
      <div className="overflow-x-auto border-b border-surface-border bg-surface-card">
        <div
          className="grid gap-1 px-1.5 py-1 font-bold uppercase tracking-wide text-muted"
          style={{ gridTemplateColumns: marketDataGridTemplate, minWidth: marketDataMinWidth, fontSize: Math.max(8, fontSize - 1) }}
        >
          {MARKET_DATA_COLUMNS.map(column => (
            <span key={column.key} className={cx(marketHeaderClass, 'relative pr-1')}>
              {column.label}
              {column.resizable && (
                <span
                  className="absolute bottom-0 right-0 top-0 w-1.5 cursor-col-resize hover:bg-accent/50"
                  onPointerDown={startColumnResize(column)}
                  title={`Resize ${column.label}`}
                />
              )}
            </span>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {rowData.map(({ row, option, quoteMode, lastPrice, bid, ask, bidSize, askSize, status, change24h, volume, open, high, low, previousClose, change, timestamp }) => (
          <button
            key={row.id}
            className={cx(
              'grid items-center gap-1 border-b border-surface-border/50 px-1.5 py-1.5 font-mono hover:bg-surface-hover',
              option?.marketKey === activeMarketKey && 'bg-accent/10',
            )}
            style={{ gridTemplateColumns: marketDataGridTemplate, minWidth: marketDataMinWidth, fontSize }}
            onClick={() => selectRow(option)}
          >
            <span className={cx(marketCellClass, 'font-bold')} style={{ color: option ? PROVIDER_COLORS[option.provider] : undefined }}>
              {option ? providerLabel(option.provider) : row.provider}
            </span>
            <span className={cx(marketCellClass, 'font-bold text-slate-100')} title={option?.label ?? row.symbol}>
              {option?.asset ?? option?.symbol ?? row.symbol}
            </span>
            <span className={cx(marketCellClass, 'text-slate-200')}>{fmtQuote(lastPrice, quoteMode)}</span>
            <span className={cx(marketCellClass, 'text-up')}>{fmtQuote(bid, quoteMode)}</span>
            <span className={cx(marketCellClass, 'text-down')}>{fmtQuote(ask, quoteMode)}</span>
            <span className={cx(marketCellClass, 'text-muted')}>{fmtCompact(bidSize)}</span>
            <span className={cx(marketCellClass, 'text-muted')}>{fmtCompact(askSize)}</span>
            <span className={cx(marketCellClass, 'text-muted')}>{fmtCompact(volume)}</span>
            <span className={cx(marketCellClass, 'text-slate-300')}>{fmtQuote(open, quoteMode)}</span>
            <span className={cx(marketCellClass, 'text-up')}>{fmtQuote(high, quoteMode)}</span>
            <span className={cx(marketCellClass, 'text-down')}>{fmtQuote(low, quoteMode)}</span>
            <span className={cx(marketCellClass, 'text-muted')}>{fmtQuote(previousClose, quoteMode)}</span>
            <span className={cx(marketCellClass, 'font-bold', (change ?? 0) >= 0 ? 'text-up' : 'text-down')}>{fmtSignedQuote(change, quoteMode)}</span>
            <span className={cx(marketCellClass, 'font-bold', (change24h ?? 0) >= 0 ? 'text-up' : 'text-down')}>{fmtSignedPct(change24h)}</span>
            <span className={cx(marketCellClass, 'text-muted')}>{fmtTimestamp(timestamp)}</span>
            <span className={cx(marketCellClass, 'text-muted')}>{fmtTimeLeft(option?.expiryTs)}</span>
            <span className={cx(marketCellClass, 'text-[9px] font-black', status === 'OPEN' ? 'text-up' : status === 'STALE' ? 'text-warn' : 'text-muted')}>{status}</span>
            <span
              role="button"
              tabIndex={0}
              className="flex items-center justify-center rounded p-1 text-muted hover:bg-down/10 hover:text-down"
              onClick={event => {
                event.stopPropagation()
                setRows(current => current.filter(item => item.id !== row.id))
              }}
              title="Remove row"
            >
              <Trash2 size={13} />
            </span>
          </button>
        ))}
        {rows.length === 0 && (
          <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-3 text-center text-muted">
            <FolderOpen size={28} className="text-accent" />
            <div>
              <div className="text-sm font-bold text-slate-200">No products added</div>
              <div className="mt-1 text-[11px]">Use Add Product to browse exchange folders and build this market data window.</div>
            </div>
            <button className="btn-accent flex items-center gap-1 px-3 py-1.5 text-[11px]" onClick={() => setShowPicker(true)}>
              <Plus size={13} /> Add first product
            </button>
          </div>
        )}
      </div>
      {showPicker && <TreeProductPicker options={options} rows={rows} onAdd={addProduct} onClose={() => setShowPicker(false)} />}
    </div>
  )
}

function GenericLadder({ option }: { option: ProductOption | undefined }) {
  const center = Math.round(option?.yes ?? 50)
  const rows = Array.from({ length: 31 }, (_, index) => Math.max(1, Math.min(99, center + 15 - index)))
  return (
    <div className="flex h-full flex-col bg-[#05070b] font-mono text-[10px]">
      <div className="border-b border-surface-border bg-surface-panel px-2 py-1">
        <div className="truncate text-[11px] font-black uppercase tracking-wide text-accent">
          {option?.label ?? 'Select product'}
        </div>
        <div className="truncate text-[9px] font-bold uppercase tracking-wide text-muted" title={option?.subtitle}>
          {option?.subtitle ?? 'Common binary adapter'}
        </div>
      </div>
      <div className="grid grid-cols-[1fr_70px_1fr] border-b border-surface-border bg-surface-card px-2 py-1 text-[10px] font-bold uppercase text-muted">
        <span>YES Depth</span>
        <span className="text-center">Price</span>
        <span className="text-right">NO Depth</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.map(price => {
          const near = Math.abs(price - center) <= 1
          const yesDepth = Math.max(0, 1000 - Math.abs(price - center) * 55)
          const noDepth = Math.max(0, 880 - Math.abs(100 - price - (option?.no ?? 50)) * 45)
          return (
            <div key={price} className={cx('grid grid-cols-[1fr_70px_1fr] border-b border-surface-border/30', near && 'bg-warn/20')}>
              <div className="relative px-2 py-1 text-up">
                <span className="absolute inset-y-0 right-0 bg-up/20" style={{ width: `${Math.min(100, yesDepth / 10)}%` }} />
                <span className="relative">{yesDepth.toFixed(0)}</span>
              </div>
              <div className="border-x border-surface-border/60 px-2 py-1 text-center font-bold text-slate-100">{price}c</div>
              <div className="relative px-2 py-1 text-right text-down">
                <span className="absolute inset-y-0 left-0 bg-down/20" style={{ width: `${Math.min(100, noDepth / 10)}%` }} />
                <span className="relative">{noDepth.toFixed(0)}</span>
              </div>
            </div>
          )
        })}
      </div>
      <div className="border-t border-surface-border p-2 text-[10px] text-muted">
        This ladder is using the common binary adapter. Venue-native depth will plug in behind the same selector as each provider service matures.
      </div>
    </div>
  )
}

function LadderWindow({
  provider,
  symbol,
  onSelect,
  operatorName,
}: {
  provider: ProviderKey
  symbol: string
  onSelect: (provider: ProviderKey, symbol: string) => void
  operatorName: string
}) {
  const options = useProductOptions()
  const option = options.find(item => item.provider === provider && item.symbol === symbol)
  const marketKey = option?.marketKey ?? (provider === 'polymarket' && symbol ? symbol : undefined)

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="border-b border-surface-border bg-surface-panel p-2">
        <ProductSelector provider={provider} symbol={symbol} onSelect={onSelect} />
      </div>
      <div className="flex items-center justify-between border-b border-surface-border bg-surface-card px-3 py-1 text-[10px] font-mono">
        <span className="text-muted">{option?.subtitle ?? 'Select a product'}</span>
        <span className="font-bold" style={{ color: PROVIDER_COLORS[provider] }}>{providerLabel(provider)}</span>
      </div>
      <div className="min-h-0 flex-1">
        {!symbol ? (
          <div className="flex h-full items-center justify-center bg-[#05070b] p-6 text-center">
            <div className="max-w-sm rounded border border-surface-border bg-surface-card p-5">
              <div className="text-sm font-black uppercase tracking-wide text-slate-100">Depth Ladder</div>
              <div className="mt-2 text-[11px] leading-relaxed text-muted">
                Select a mapped product from the ladder product menu above to load CME depth.
              </div>
            </div>
          </div>
        ) : provider === 'polymarket' ? (
          <OrderBook2
            marketKey={marketKey}
            productLabel={option?.label ?? symbol}
            productSubtitle={option?.subtitle}
            operatorName={operatorName}
          />
        ) : <GenericLadder option={option} />}
      </div>
    </div>
  )
}

type DepthOrderSide = 'BID' | 'ASK'

type LocalDepthOrder = {
  id: string
  side: DepthOrderSide
  priceKey: string
  size: number
  orderType: 'limit' | 'market'
  status: 'pending' | 'working' | 'filled' | 'rejected'
  fillPrice?: number
  filledAt?: number
  createdAt: number
  source?: 'manual' | 'algo'
  strategy?: string
  legId?: string
  orderTag?: string
  algoRole?: 'entry' | 'cover'
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
}

function isRawDepthPrice(price: unknown): price is number {
  return typeof price === 'number' && Number.isFinite(price) && (price < 0 || price > 1)
}

function bookUsesRawPrices(book: PolyBook | undefined, ticks?: PolyTradeTick[]): boolean {
  const bookPrices = [
    book?.best_bid,
    book?.best_ask,
    book?.mid,
    ...(book?.bids ?? []).map(level => level.price),
    ...(book?.asks ?? []).map(level => level.price),
  ]
  return bookPrices.some(isRawDepthPrice) || (ticks ?? []).some(tick => isRawDepthPrice(tick.price))
}

type DepthLevelMatrixValue = {
  size: number
  count: number
}

function aggregateDepthLevels(
  levels: Array<{ price: number; size: number; count?: number; ct?: number }> | undefined,
  rowStep: number,
): Map<string, DepthLevelMatrixValue> {
  const next = new Map<string, DepthLevelMatrixValue>()
  if (!Number.isFinite(rowStep) || rowStep <= 0) return next
  for (const level of levels ?? []) {
    const price = finiteDepthPrice(level.price)
    const size = Number(level.size)
    if (price === undefined || !Number.isFinite(size) || size <= 0) continue
    const count = Math.max(0, Math.trunc(Number(level.count ?? level.ct ?? 0))) || 0
    const key = fmtLadderPrice(roundToTick(price, rowStep), rowStep)
    const current = next.get(key) ?? { size: 0, count: 0 }
    next.set(key, { size: current.size + size, count: current.count + count })
  }
  return next
}

function useDepthMarketStream(asset: Asset | string | undefined, provider: ProviderKey) {
  const marketProvider = normalizeProviderKey(provider)
  const [state, setState] = useState<{ status: 'idle' | 'connecting' | 'live' | 'retrying'; lastEventAt: number; source: 'ws' | 'snapshot' | 'rest' | '' }>({
    status: 'idle',
    lastEventAt: 0,
    source: '',
  })
  const [book, setBook] = useState<CmeBook | null>(null)
  const [trades, setTrades] = useState<CmeTradeTick[]>([])

  useEffect(() => {
    if (!asset) {
      setState({ status: 'idle', lastEventAt: 0, source: '' })
      setBook(null)
      setTrades([])
      return
    }
    let alive = true
    let retryId: ReturnType<typeof setTimeout> | undefined
    let ws: WebSocket | null = null
    let endpointIndex = 0
    const configuredWsBase = (import.meta.env.VITE_CERIOUS_WS_BASE as string | undefined)?.trim()
    const endpoints = [configuredWsBase || ceriousWsBase()]
    const target = String(asset).toUpperCase()

    const ingestBook = (nextBook: CmeBook, source: 'ws' | 'snapshot' | 'rest') => {
      if (!alive || nextBook.symbol?.toUpperCase() !== target) return
      setBook(nextBook)
      const store = useStore.getState()
      store.setPolyBook(target, cmeBookToPolyCompat(nextBook))
      setState({ status: 'live', lastEventAt: Date.now(), source })
    }

    const acceptTrade = (trade: CmeTradeTick, source: 'ws' | 'snapshot' | 'rest') => {
      if (!alive || trade.symbol?.toUpperCase() !== target) return
      setTrades(current => [...current.slice(-199), trade])
      const store = useStore.getState()
      const compat = cmeTradeToPolyCompat(trade)
      store.pushPolyTick(target, compat)
      setState({ status: 'live', lastEventAt: Date.now(), source })
    }

    const pullRestBook = () => {
      fetch(`/api/cme/book/${encodeURIComponent(target)}`)
        .then(response => response.ok ? response.json() : null)
        .then((payload: CmeBook | null) => {
          if (payload) ingestBook(payload, 'rest')
        })
        .catch(() => undefined)
    }

    const ingestSnapshot = (snapshot: Record<string, unknown>) => {
      const store = useStore.getState()
      store.loadSnapshot(target as Asset, snapshot)
      const cmeBooks = snapshot.cme_books as Record<string, CmeBook> | undefined
      const cmeTrades = snapshot.cme_trades as Record<string, CmeTradeTick[]> | undefined
      if (cmeBooks?.[target]) ingestBook(cmeBooks[target], 'snapshot')
      for (const trade of cmeTrades?.[target] ?? []) acceptTrade(trade, 'snapshot')
    }

    const ingestMessage = (msg: WsMsg | { type: 'cme_book'; symbol: string; data: CmeBook } | { type: 'cme_trade'; symbol: string; data: CmeTradeTick }) => {
      const store = useStore.getState()
      if (msg.type === 'book' && msg.asset === target) store.setBook(msg.asset, msg.data)
      if (msg.type === 'tick' && msg.asset === target) store.pushTick(msg.asset, msg.data)
      if (msg.type === 'cme_book' && msg.symbol === target) ingestBook(msg.data, 'ws')
      if (msg.type === 'cme_trade' && msg.symbol === target) acceptTrade(msg.data, 'ws')
      if (msg.type === 'markets') store.setMarkets(msg.data, true)
    }

    const connect = () => {
      if (!alive) return
      const base = endpoints[endpointIndex] ?? endpoints[0]
      setState(current => ({ ...current, status: current.lastEventAt ? 'retrying' : 'connecting' }))
      const wsParams = new URLSearchParams({ provider: marketProvider })
      const token = workspaceSessionToken()
      if (token) wsParams.set('token', token)
      ws = new WebSocket(`${base}/${encodeURIComponent(target)}?${wsParams.toString()}`)

      ws.onopen = () => {
        if (!alive) return
        endpointIndex = 0
        setState(current => ({ ...current, status: 'live' }))
      }
      ws.onmessage = event => {
        try {
          const payload = JSON.parse(event.data)
          if (payload.type === 'snapshot') {
            ingestSnapshot(payload)
            return
          }
          ingestMessage(payload as WsMsg)
        } catch {
          // Keep the stream alive if a malformed message arrives.
        }
      }
      ws.onclose = () => {
        if (!alive) return
        endpointIndex = (endpointIndex + 1) % endpoints.length
        setState(current => ({ ...current, status: 'retrying' }))
        retryId = window.setTimeout(connect, 1200)
      }
      ws.onerror = () => ws?.close()
    }

    if (ENABLE_LEGACY_BROWSER_WS) connect()
    pullRestBook()
    const restBookId = window.setInterval(pullRestBook, 1000)
    fetch(`/api/cme/trades/${encodeURIComponent(target)}`)
      .then(response => response.ok ? response.json() : null)
      .then((payload: { trades?: CmeTradeTick[] } | null) => {
        if (!alive || !Array.isArray(payload?.trades)) return
        for (const trade of payload.trades.slice(-50)) acceptTrade(trade, 'rest')
      })
      .catch(() => undefined)
    return () => {
      alive = false
      if (retryId) window.clearTimeout(retryId)
      window.clearInterval(restBookId)
      ws?.close()
    }
  }, [asset, marketProvider])

  return { ...state, book, trades }
}

function NormalDepthLadderWindow({
  provider,
  symbol,
  onSelect,
  operatorName,
  settings,
  onSettingsChange,
  onSaveDefault,
}: {
  provider: ProviderKey
  symbol: string
  onSelect: (provider: ProviderKey, symbol: string) => void
  operatorName: string
  settings?: DepthLadderSettings
  onSettingsChange: (settings: DepthLadderSettings) => void
  onSaveDefault: (settings: DepthLadderSettings) => void
}) {
  const initialSettings = useMemo(() => normalizeDepthLadderSettings(settings ?? loadDepthLadderDefaultSettings()), [settings])
  const options = useProductOptions()
  const activeProvider = normalizeProviderKey(provider)
  const activeSymbol = symbol || ''
  const option = activeSymbol ? options.find(item => item.provider === activeProvider && item.symbol === activeSymbol) : undefined
  const marketKey = option?.marketKey ?? (activeSymbol ? activeSymbol.toUpperCase() : undefined)
  const ladderMarketAliases = useMemo(() => productAliasSet(option, activeSymbol), [activeSymbol, option])
  const streamAsset = useMemo(() => {
    const raw = option?.marketKey ?? option?.asset ?? activeSymbol
    const key = String(raw || '').trim().toUpperCase()
    return key || undefined
  }, [activeSymbol, option?.asset, option?.marketKey])
  const depthStream = useDepthMarketStream(streamAsset, activeProvider)
  const serviceConnected = useStore(s => s.connected)
  const simulationEnabled = useStore(s => s.simulationEnabled)
  const simOrders = useStore(s => s.simOrders)
  const simPositions = useStore(s => s.simPositions)
  const simMessages = useStore(s => s.simMessages)
  const book = depthStream.book ?? undefined
  const ticks = depthStream.trades
  const latestDepthTick = ticks?.at(-1)
  const latestDepthTradePrice = finiteDepthPrice(latestDepthTick?.price)
  const latestDepthLtp = finiteDepthPrice(book?.ltp)
  const latestDepthTickTs = Number(latestDepthTick?.timestamp ?? 0)
  const latestDepthBookTs = Number(book?.tsMs ?? 0)
  const depthBookLtpIsFresh = latestDepthLtp !== undefined && latestDepthBookTs >= latestDepthTickTs
  const latestDepthLastPrice = depthBookLtpIsFresh ? latestDepthLtp : latestDepthTradePrice ?? latestDepthLtp
  const latestDepthLastSize = Number(depthBookLtpIsFresh ? book?.ltpSize ?? latestDepthTick?.size ?? 0 : latestDepthTick?.size ?? book?.ltpSize ?? 0)
  const [activeOrders, setActiveOrders] = useState<LocalDepthOrder[]>([])
  const [draggingOrder, setDraggingOrder] = useState<LocalDepthOrder | null>(null)
  const [dragTargetPriceKey, setDragTargetPriceKey] = useState<string | null>(null)
  const [defaultSize, setDefaultSize] = useState(1)
  const [actionMode, setActionMode] = useState<'limit' | 'market'>(initialSettings.actionMode)
  const [fastTrade, setFastTrade] = useState(initialSettings.fastTrade)
  const [showSettings, setShowSettings] = useState(false)
  const [defaultStatus, setDefaultStatus] = useState('')
  const [softGrid, setSoftGrid] = useState(initialSettings.softGrid)
  const [density, setDensity] = useState<DepthLadderDensity>(initialSettings.density)
  const [priceMultiplier, setPriceMultiplier] = useState(initialSettings.priceMultiplier)
  const [columnOrder, setColumnOrder] = useState<DepthColumnKey[]>(initialSettings.columnOrder)
  const [columnWidths, setColumnWidths] = useState<Record<DepthColumnKey, number>>(initialSettings.columnWidths)
  const [draggingColumn, setDraggingColumn] = useState<DepthColumnKey | null>(null)
  const [ladderAnchor, setLadderAnchor] = useState<{ marketKey: string; center: number; tick: number } | null>(null)
  const initialCenterMarketRef = useRef<string | null>(null)
  const orderSequenceRef = useRef(0)
  const ladderBodyRef = useRef<HTMLDivElement | null>(null)
  const [ladderBodyNode, setLadderBodyNode] = useState<HTMLDivElement | null>(null)
  const [ladderBodyHeight, setLadderBodyHeight] = useState(0)
  const setSimulationEnabled = useStore(s => s.setSimulationEnabled)
  const densitySpec = {
    small: { rowHeight: 18, fontSize: 9, priceFont: 10, priceWidth: 78 },
    medium: { rowHeight: 24, fontSize: 11, priceFont: 12, priceWidth: 96 },
    large: { rowHeight: 34, fontSize: 13, priceFont: 16, priceWidth: 124 },
  }[density]
  const columnMinWidths: Record<DepthColumnKey, number> = { orders: 48, bid: 64, price: 68, ask: 64 }
  const ladderGridTemplate = columnOrder.map(column => `minmax(${columnMinWidths[column]}px, ${columnWidths[column]}fr)`).join(' ')
  const buyColor = {
    bg: '#1f6fff',
    bgSoft: 'rgba(31, 111, 255, .25)',
    bgHover: 'rgba(31, 111, 255, .38)',
    bar: 'rgba(31, 111, 255, .5)',
    text: '#eff6ff',
    strong: '#9fc5ff',
    border: '#e6fbff',
  }
  const sellColor = {
    bg: '#ff1744',
    bgSoft: 'rgba(255, 23, 68, .24)',
    bgHover: 'rgba(255, 23, 68, .38)',
    bar: 'rgba(255, 23, 68, .5)',
    text: '#fee2e2',
    strong: '#ff8fa3',
    border: '#fff2a8',
  }
  const gridLine = softGrid ? '#263241' : '#111827'
  const rowLine = softGrid ? '#1b2533' : '#0b0f17'
  const mdCellLine = softGrid ? 'rgba(148, 163, 184, .18)' : 'rgba(148, 163, 184, .11)'
  const mdRowLine = softGrid ? 'rgba(148, 163, 184, .14)' : 'rgba(148, 163, 184, .08)'
  const laneGrey = '#687384'
  const laneGreyInside = '#7b8798'
  const laneText = '#f8fafc'
  const bidColumnBg = '#061a3b'
  const bidColumnBgHover = '#082652'
  const bidDepthBg = '#1f6fff'
  const bidDepthBgSoft = '#114fb8'
  const bidDepthBgHover = '#2f82ff'
  const askColumnBg = '#26070d'
  const askColumnBgHover = '#3a0a12'
  const askDepthBg = '#9f1028'
  const askDepthBgStrong = '#d10f2f'
  const askDepthBgHover = '#ff1744'
  const depthDisplayContract = useMemo(() => {
    return resolveDepthDisplayContract({
      publishedTickSize: book?.tickSize,
      productTickSize: option?.tickSize,
      bids: book?.bids,
      asks: book?.asks,
    })
  }, [book, option?.tickSize])
  const depthMultiplierTick = depthDisplayContract.priceIncrement
  const priceMultiplierOptions = useMemo(() => depthMultiplierOptionsForTick(depthMultiplierTick), [depthMultiplierTick])

  const setLadderBodyElement = useCallback((node: HTMLDivElement | null) => {
    ladderBodyRef.current = node
    setLadderBodyNode(node)
  }, [])

  useEffect(() => {
    if (!ladderBodyNode) {
      setLadderBodyHeight(0)
      return
    }
    let frameId = 0
    const updateHeight = () => {
      if (frameId) window.cancelAnimationFrame(frameId)
      frameId = window.requestAnimationFrame(() => {
        setLadderBodyHeight(ladderBodyNode.getBoundingClientRect().height)
      })
    }
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(ladderBodyNode)
    window.addEventListener('resize', updateHeight)
    return () => {
      if (frameId) window.cancelAnimationFrame(frameId)
      observer.disconnect()
      window.removeEventListener('resize', updateHeight)
    }
  }, [ladderBodyNode])

  useEffect(() => {
    if (!priceMultiplierOptions.includes(priceMultiplier)) {
      setPriceMultiplier(priceMultiplierOptions[0] ?? DEFAULT_DEPTH_LADDER_SETTINGS.priceMultiplier)
    }
  }, [priceMultiplier, priceMultiplierOptions])

  const currentDepthSettings = useMemo(() => normalizeDepthLadderSettings({
    columnOrder,
    columnWidths,
    density,
    priceMultiplier,
    softGrid,
    actionMode,
    fastTrade,
  }), [actionMode, columnOrder, columnWidths, density, fastTrade, priceMultiplier, softGrid])

  useEffect(() => {
    onSettingsChange(currentDepthSettings)
  }, [currentDepthSettings, onSettingsChange])

  useEffect(() => {
    if (!defaultStatus) return
    const id = window.setTimeout(() => setDefaultStatus(''), 1600)
    return () => window.clearTimeout(id)
  }, [defaultStatus])

  const saveAsDepthDefault = () => {
    const savedSettings = saveDepthLadderDefaultSettings(currentDepthSettings)
    onSaveDefault(savedSettings)
    setDefaultStatus('Default saved')
  }

  useEffect(() => {
    setActiveOrders([])
    setDraggingOrder(null)
    setDragTargetPriceKey(null)
    setLadderAnchor(null)
    initialCenterMarketRef.current = null
  }, [marketKey])

  const ladderModel = useMemo(() => {
    const latestTick = ticks?.at(-1)
    const tickLast = finiteDepthPrice(latestTick?.price)
    const bookLast = finiteDepthPrice(book?.ltp)
    const tickTs = Number(latestTick?.timestamp ?? 0)
    const bookTs = Number(book?.tsMs ?? 0)
    const preferBookLast = bookLast !== undefined && bookTs >= tickTs
    const lastTrade = preferBookLast ? bookLast : tickLast ?? bookLast
    const normalizedBids = (book?.bids ?? [])
      .map(level => ({ price: finiteDepthPrice(level.price), size: Number(level.size), count: Number(level.count ?? level.ct ?? 0) }))
      .filter((level): level is { price: number; size: number; count: number } => level.price !== undefined && Number.isFinite(level.size))
      .sort((a, b) => b.price - a.price)
    const normalizedAsks = (book?.asks ?? [])
      .map(level => ({ price: finiteDepthPrice(level.price), size: Number(level.size), count: Number(level.count ?? level.ct ?? 0) }))
      .filter((level): level is { price: number; size: number; count: number } => level.price !== undefined && Number.isFinite(level.size))
      .sort((a, b) => a.price - b.price)
    const bestBid = finiteDepthPrice(book?.bestBid) ?? normalizedBids[0]?.price
    const bestAsk = finiteDepthPrice(book?.bestAsk) ?? normalizedAsks[0]?.price
    const bookMid = finiteDepthPrice(book?.mid)
    const bookCenter = bookMid ?? (bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : undefined)
    const fallbackLast = lastTrade ?? bookCenter ?? finiteDepthPrice(option?.spot) ?? finiteDepthPrice(option?.priceToBeat) ?? 0
    const contract = resolveDepthDisplayContract({
      publishedTickSize: book?.tickSize,
      productTickSize: option?.tickSize,
      bids: normalizedBids,
      asks: normalizedAsks,
    })
    const tick = contract.priceIncrement ?? 0
    const rowStep = tick > 0 ? Math.max(tick, tick * priceMultiplier) : 0
    const bid = bestBid ?? (bestAsk !== undefined && tick > 0 ? bestAsk - tick : fallbackLast)
    const ask = bestAsk ?? (bestBid !== undefined && tick > 0 ? bestBid + tick : fallbackLast)
    const mid = bookMid ?? (Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : fallbackLast)
    const priceKey = (price: number) => rowStep > 0 ? fmtLadderPrice(roundToTick(price, rowStep), rowStep) : fmtLadderPrice(price, tick || undefined)
    const bidMap = aggregateDepthLevels(normalizedBids, rowStep)
    const askMap = aggregateDepthLevels(normalizedAsks, rowStep)
    const lastTradeKey = lastTrade !== undefined ? priceKey(lastTrade) : undefined
    const lastTradeSize = Number(preferBookLast ? book?.ltpSize ?? latestTick?.size ?? 0 : latestTick?.size ?? book?.ltpSize ?? 0)
    return { fallbackLast, bid, ask, mid, tick, rowStep, bidMap, askMap, bidKey: priceKey(bid), askKey: priceKey(ask), lastTradeKey, lastTradeSize }
  }, [book, option?.priceToBeat, option?.spot, option?.tickSize, priceMultiplier, ticks])
  const depthDefinitionReady = depthDisplayContract.ready && Number.isFinite(ladderModel.rowStep) && ladderModel.rowStep > 0
  const depthDefinitionMessage = depthDisplayContract.message ?? 'Waiting for price service product definition.'
  const depthPriceReady = latestDepthLastPrice !== undefined
    || finiteDepthPrice(book?.bestBid) !== undefined
    || finiteDepthPrice(book?.bestAsk) !== undefined
    || finiteDepthPrice(book?.mid) !== undefined
    || finiteDepthPrice(option?.spot) !== undefined
    || finiteDepthPrice(option?.priceToBeat) !== undefined

  const simDepthOrders = useMemo(() => {
    if (!marketKey || !Number.isFinite(ladderModel.rowStep) || ladderModel.rowStep <= 0) return []
    return simOrders
      .filter(order => ladderMarketAliases.has(normalizeProductKey(order.marketKey)) && (order.status === 'working' || order.status === 'partially_filled') && order.remaining > 0)
      .map(order => ({
        id: order.id,
        side: order.side === 'bid' ? 'BID' as const : 'ASK' as const,
        price: order.price,
        priceKey: fmtLadderPrice(roundToTick(order.price, ladderModel.rowStep), ladderModel.rowStep),
        size: order.remaining,
        orderType: order.orderType,
        status: 'working' as const,
        createdAt: order.createdAt,
        source: order.source,
        strategy: order.strategy,
        legId: order.legId,
        orderTag: order.orderTag ?? (order.source === 'algo' ? 'ALGO ENTRY' : 'MANUAL'),
        algoRole: order.algoRole,
        algoId: order.algoId,
        algoName: order.algoName,
        parentOrderId: order.parentOrderId,
        layer: order.layer,
        trigger: order.trigger,
        coverTicksFromFill: order.coverTicksFromFill,
        coverTickSize: order.coverTickSize,
        tickSize: order.tickSize,
        tickValue: order.tickValue,
        multiplier: order.multiplier,
      }))
  }, [ladderMarketAliases, ladderModel.rowStep, marketKey, simOrders])

  const displayActiveOrders = useMemo(() => {
    if (simulationEnabled) return []
    const simIds = new Set(simOrders.map(order => order.id))
    return activeOrders.filter(order => !simIds.has(order.id))
  }, [activeOrders, simOrders, simulationEnabled])

  useEffect(() => {
    if (!marketKey) return
    if (initialCenterMarketRef.current === marketKey) return
    if (!book) return
    if (!Number.isFinite(ladderModel.mid) || !Number.isFinite(ladderModel.tick) || ladderModel.tick <= 0) return
    const liveCenter = roundToTick(ladderModel.mid, ladderModel.rowStep)
    setLadderAnchor({ marketKey, center: liveCenter, tick: ladderModel.tick })
    initialCenterMarketRef.current = marketKey
  }, [book?.tsMs, ladderModel.mid, ladderModel.rowStep, ladderModel.tick, marketKey])

  const recenterLadder = () => {
    if (!marketKey || !Number.isFinite(ladderModel.mid) || !Number.isFinite(ladderModel.tick) || ladderModel.tick <= 0) return
    setLadderAnchor({ marketKey, center: roundToTick(ladderModel.mid, ladderModel.rowStep), tick: ladderModel.tick })
    initialCenterMarketRef.current = marketKey
  }

  const shiftLadderRows = (rows: number) => {
    if (!marketKey || !Number.isFinite(ladderModel.rowStep) || ladderModel.rowStep <= 0) return
    setLadderAnchor(current => {
      const currentCenter = current?.marketKey === marketKey
        ? current.center
        : roundToTick(ladderModel.mid || ladderModel.fallbackLast || 0, ladderModel.rowStep)
      return {
        marketKey,
        center: roundToTick(currentCenter + rows * ladderModel.rowStep, ladderModel.rowStep),
        tick: ladderModel.tick,
      }
    })
  }

  const wheelScrollLadder = (deltaY: number, shiftKey = false, altKey = false) => {
    const rows = shiftKey ? 10 : altKey ? 1 : 3
    shiftLadderRows(deltaY > 0 ? -rows : rows)
  }

  useEffect(() => {
    const node = ladderBodyNode
    if (!node) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      wheelScrollLadder(event.deltaY, event.shiftKey, event.altKey)
    }
    node.addEventListener('wheel', handleWheel, { passive: false })
    return () => node.removeEventListener('wheel', handleWheel)
  }, [ladderBodyNode, ladderModel.rowStep, ladderModel.tick, marketKey])

  const levels = useMemo(() => {
    const anchor = ladderAnchor?.marketKey === marketKey ? ladderAnchor : null
    if (!anchor) return []
    const rowStep = ladderModel.rowStep
    const center = anchor.center
    const measuredBodyHeight = ladderBodyHeight || 504
    const measuredRowCount = Math.max(9, Math.min(241, Math.ceil(measuredBodyHeight / densitySpec.rowHeight) + 2))
    const rowCount = measuredRowCount % 2 === 0 ? Math.min(241, measuredRowCount + 1) : measuredRowCount
    const centerIndex = Math.floor(rowCount / 2)
    return Array.from({ length: rowCount }, (_, index) => {
      const price = center + (centerIndex - index) * rowStep
      const key = fmtLadderPrice(roundToTick(price, rowStep), rowStep)
      const bidCell = ladderModel.bidMap.get(key)
      const askCell = ladderModel.askMap.get(key)
      const myBidSize = displayActiveOrders
        .filter(order => order.side === 'BID' && order.priceKey === key && (order.status === 'pending' || order.status === 'working'))
        .reduce((sum, order) => sum + order.size, 0)
        + simDepthOrders.filter(order => order.side === 'BID' && order.priceKey === key).reduce((sum, order) => sum + order.size, 0)
      const myAskSize = displayActiveOrders
        .filter(order => order.side === 'ASK' && order.priceKey === key && (order.status === 'pending' || order.status === 'working'))
        .reduce((sum, order) => sum + order.size, 0)
        + simDepthOrders.filter(order => order.side === 'ASK' && order.priceKey === key).reduce((sum, order) => sum + order.size, 0)
      return {
        price,
        key,
        bidSize: bidCell?.size ?? 0,
        bidCount: bidCell?.count ?? 0,
        askSize: askCell?.size ?? 0,
        askCount: askCell?.count ?? 0,
        myBidSize,
        myAskSize,
        inside: Number.isFinite(ladderModel.bid) && Number.isFinite(ladderModel.ask) && price >= ladderModel.bid - rowStep / 2 && price <= ladderModel.ask + rowStep / 2,
        bestBid: Number.isFinite(ladderModel.bid) && key === ladderModel.bidKey,
        bestAsk: Number.isFinite(ladderModel.ask) && key === ladderModel.askKey,
        lastTrade: ladderModel.lastTradeKey === key,
        lastTradeSize: ladderModel.lastTradeSize,
      }
    })
  }, [densitySpec.rowHeight, displayActiveOrders, ladderAnchor, ladderBodyHeight, ladderModel, marketKey, simDepthOrders])

  const activeWorkingCount = displayActiveOrders.filter(order => order.status === 'working').length + simDepthOrders.length
  const filledCount = activeOrders.filter(order => order.status === 'filled').length
  const workingTotals = useMemo(() => {
    const working = [
      ...displayActiveOrders.filter(order => order.status === 'pending' || order.status === 'working'),
      ...simDepthOrders,
    ]
    const bidOrders = working.filter(order => order.side === 'BID').length
    const askOrders = working.filter(order => order.side === 'ASK').length
    const bidContracts = working
      .filter(order => order.side === 'BID')
      .reduce((sum, order) => sum + Number(order.size || 0), 0)
    const askContracts = working
      .filter(order => order.side === 'ASK')
      .reduce((sum, order) => sum + Number(order.size || 0), 0)
    return { bidOrders, askOrders, bidContracts, askContracts, totalOrders: bidOrders + askOrders, totalContracts: bidContracts + askContracts }
  }, [displayActiveOrders, simDepthOrders])
  const activeForSide = (side: DepthOrderSide) => (
    displayActiveOrders.some(order => order.side === side && (order.status === 'pending' || order.status === 'working'))
    || simDepthOrders.some(order => order.side === side)
  )
  const localDepthPosition = useMemo(() => {
    const livePositions = marketKey
      ? simPositions.filter(position => ladderMarketAliases.has(normalizeProductKey(position.marketKey)) && position.status === 'open')
      : []
    if (livePositions.length > 0) {
      const net = livePositions.reduce((sum, position) => sum + Number(position.size || 0), 0)
      const gross = livePositions.reduce((sum, position) => sum + Math.abs(Number(position.size || 0)), 0)
      const notional = livePositions.reduce((sum, position) => sum + (Number(position.avgPrice) || 0) * Math.abs(Number(position.size || 0)), 0)
      const openPnl = livePositions.reduce((sum, position) => sum + (Number(position.openPnl) || 0), 0)
      return {
        net,
        avg: gross > 0 ? notional / gross : undefined,
        openPnl,
      }
    }
    return {
      net: 0,
      avg: undefined,
      openPnl: 0,
    }
  }, [ladderMarketAliases, marketKey, simPositions])

  const applyDepthOrderState = (order: LocalDepthOrder): LocalDepthOrder => {
    if (simulationEnabled) {
      return { ...order, status: order.orderType === 'market' ? 'pending' : 'working' }
    }
    return { ...order, status: fastTrade ? 'working' : 'pending' }
  }

  const submitDepthOrder = async (side: DepthOrderSide, priceKey: string) => {
    if (!marketKey) return
    if (!depthDefinitionReady) {
      setDefaultStatus('Definition pending')
      return
    }
    orderSequenceRef.current += 1
    const id = `fut-${marketKey}-${side}-${priceKey}-${Date.now()}-${orderSequenceRef.current}`
    const nextOrderType = simulationEnabled ? 'limit' : actionMode
    const order = applyDepthOrderState({
      id,
      side,
      priceKey,
      size: defaultSize,
      orderType: nextOrderType,
      status: 'pending',
      createdAt: Date.now(),
    })
    if (simulationEnabled) {
      setDefaultStatus(`Sending ${side} ${priceKey}`)
      await submitSharedOrder({
        orderId: id,
        marketKey,
        outcome: 'yes',
        side: side === 'BID' ? 'bid' : 'offer',
        orderType: nextOrderType,
        price: Number(priceKey),
        size: defaultSize,
        operator: operatorName,
        source: 'manual',
        strategy: 'depth-ladder',
        legId: `depth-${marketKey}-${priceKey}-${side}`,
        tickSize: book?.tickSize ?? option?.tickSize,
        tickValue: book?.tickValue ?? option?.tickValue,
        multiplier: book?.multiplier ?? option?.multiplier,
      })
      return
    }
    setActiveOrders(current => [order, ...current].slice(0, 80))
    if (fastTrade && !simulationEnabled) {
      try {
        await ceriousFetch('/api/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId: id,
            clientOrderId: id,
            product: marketKey,
            marketKey,
            symbol: marketKey,
            side,
            price: Number(priceKey),
            size: defaultSize,
            qty: defaultSize,
            orderType: actionMode,
            source: 'depth-ladder',
          }),
        })
      } catch {
        setActiveOrders(current => current.map(item => item.id === order.id ? { ...item, status: 'rejected' } : item))
      }
    }
  }

  const submitPendingOrders = (side: DepthOrderSide, priceKey: string) => {
    const pending = activeOrders.filter(order => order.side === side && order.priceKey === priceKey && order.status === 'pending')
    setActiveOrders(current => current.map(item => (
      item.side === side && item.priceKey === priceKey && item.status === 'pending'
        ? applyDepthOrderState({ ...item, status: 'working' })
        : item
    )))
    if (simulationEnabled) return
    pending.forEach(order => {
      void ceriousFetch('/api/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: order.id,
          clientOrderId: order.id,
          product: marketKey,
          marketKey,
          symbol: marketKey,
          side: order.side,
          price: Number(order.priceKey),
          size: order.size,
          qty: order.size,
          orderType: order.orderType,
          source: 'depth-ladder',
        }),
      }).catch(() => {
        setActiveOrders(current => current.map(item => item.id === order.id ? { ...item, status: 'rejected' } : item))
      })
    })
  }

  const cancelOrderGroup = (event: React.MouseEvent, side: DepthOrderSide, priceKey: string) => {
    event.stopPropagation()
    setActiveOrders(current => current.filter(order => !(order.side === side && order.priceKey === priceKey)))
    setDefaultStatus(`Cancel requested ${side} ${priceKey}`)
    simDepthOrders
      .filter(order => order.side === side && order.priceKey === priceKey)
      .forEach(order => {
        void cancelSharedOrder(order.id)
          .then(() => setDefaultStatus(`Cancelled ${side} ${priceKey}`))
          .catch(err => setDefaultStatus(`Cancel failed ${side} ${priceKey}: ${err instanceof Error ? err.message : 'gateway unavailable'}`))
      })
  }

  const moveOrder = (targetPriceKey: string) => {
    if (!draggingOrder || !marketKey) return
    const orderToMove = draggingOrder
    if (targetPriceKey === draggingOrder.priceKey) {
      setDraggingOrder(null)
      setDragTargetPriceKey(null)
      return
    }
    setActiveOrders(current => current.map(order => (
      order.id === draggingOrder.id ? applyDepthOrderState({ ...order, priceKey: targetPriceKey, status: 'pending', fillPrice: undefined, filledAt: undefined }) : order
    )))
    if (simulationEnabled) {
      setDefaultStatus(`Modify requested ${orderToMove.id}`)
      void (async () => {
        try {
          await cancelSharedOrder(orderToMove.id)
          await submitSharedOrder({
            orderId: orderToMove.id,
            marketKey: marketKey ?? '',
            outcome: 'yes',
            side: orderToMove.side === 'BID' ? 'bid' : 'offer',
            orderType: 'limit',
            price: Number(targetPriceKey),
            size: orderToMove.size,
            operator: operatorName,
            source: orderToMove.source ?? 'manual',
            strategy: orderToMove.strategy ?? 'depth-ladder',
            legId: orderToMove.legId ?? `depth-${marketKey}-${targetPriceKey}-${orderToMove.side}`,
            orderTag: orderToMove.orderTag,
            algoRole: orderToMove.algoRole,
            algoId: orderToMove.algoId,
            algoName: orderToMove.algoName,
            parentOrderId: orderToMove.parentOrderId,
            layer: orderToMove.layer,
            trigger: orderToMove.trigger,
            coverTicksFromFill: orderToMove.coverTicksFromFill,
            coverTickSize: orderToMove.coverTickSize,
            tickSize: orderToMove.tickSize ?? book?.tickSize ?? option?.tickSize,
            tickValue: orderToMove.tickValue ?? book?.tickValue ?? option?.tickValue,
            multiplier: orderToMove.multiplier ?? book?.multiplier ?? option?.multiplier,
          })
          setDefaultStatus(`Modified ${orderToMove.id}`)
        } catch (err) {
          setDefaultStatus(`Modify failed ${orderToMove.id}: ${err instanceof Error ? err.message : 'gateway unavailable'}`)
        }
      })()
    }
    setDraggingOrder(null)
    setDragTargetPriceKey(null)
  }

  useEffect(() => {
    if (!draggingOrder) return
    const handlePointerUp = (event: PointerEvent) => {
      if (event.button !== 2) return
      event.preventDefault()
      event.stopPropagation()
      if (dragTargetPriceKey) {
        moveOrder(dragTargetPriceKey)
      } else {
        setDraggingOrder(null)
      }
    }
    window.addEventListener('pointerup', handlePointerUp, { capture: true })
    return () => window.removeEventListener('pointerup', handlePointerUp, { capture: true })
  }, [dragTargetPriceKey, draggingOrder, marketKey])

  const clearSide = (side?: DepthOrderSide) => {
    setActiveOrders(current => side ? current.filter(order => order.side !== side) : [])
    setDefaultStatus(side ? `Cancel requested ${side}` : 'Cancel requested all')
    simDepthOrders
      .filter(order => !side || order.side === side)
      .forEach(order => {
        void cancelSharedOrder(order.id)
          .then(() => setDefaultStatus(side ? `Cancelled ${side}` : 'Cancelled all working orders'))
          .catch(err => setDefaultStatus(`Cancel failed: ${err instanceof Error ? err.message : 'gateway unavailable'}`))
      })
  }

  const moveDepthColumn = (target: DepthColumnKey) => {
    if (!draggingColumn || draggingColumn === target) {
      setDraggingColumn(null)
      return
    }
    setColumnOrder(current => {
      const withoutDragged = current.filter(column => column !== draggingColumn)
      const targetIndex = withoutDragged.indexOf(target)
      return [
        ...withoutDragged.slice(0, targetIndex),
        draggingColumn,
        ...withoutDragged.slice(targetIndex),
      ]
    })
    setDraggingColumn(null)
  }

  const columnDragProps = (column: DepthColumnKey) => ({
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.effectAllowed = 'move'
      setDraggingColumn(column)
    },
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault()
      moveDepthColumn(column)
    },
    onDragEnd: () => setDraggingColumn(null),
  })

  const columnResizeBounds = (column: DepthColumnKey) => {
    if (column === 'orders') return { min: 48, max: 150 }
    if (column === 'price') return { min: 68, max: 180 }
    return { min: 64, max: 260 }
  }

  const startColumnResize = (column: DepthColumnKey) => (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const grid = event.currentTarget.closest('[data-depth-grid="true"]') as HTMLElement | null
    const gridWidth = Math.max(1, grid?.getBoundingClientRect().width ?? 1)
    const startWidths = { ...columnWidths }
    const columnIndex = columnOrder.indexOf(column)
    const partner = columnOrder[columnIndex + 1] ?? columnOrder[columnIndex - 1]
    if (!partner) return
    const direction = columnOrder[columnIndex + 1] ? 1 : -1
    const columnBounds = columnResizeBounds(column)
    const partnerBounds = columnResizeBounds(partner)
    const pairTotal = startWidths[column] + startWidths[partner]

    const move = (ev: PointerEvent) => {
      const delta = ((ev.clientX - startX) / gridWidth) * pairTotal * direction
      const nextWidth = clamp(startWidths[column] + delta, columnBounds.min, Math.min(columnBounds.max, pairTotal - partnerBounds.min))
      const nextPartnerWidth = clamp(pairTotal - nextWidth, partnerBounds.min, partnerBounds.max)
      setColumnWidths(current => ({ ...current, [column]: nextWidth, [partner]: nextPartnerWidth }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const resizeGrip = (column: DepthColumnKey) => (
    <span
      className="absolute bottom-0 right-0 top-0 z-30 w-2 cursor-col-resize border-r border-[#ffe800]/40 bg-[#ffe800]/0 hover:bg-[#ffe800]/20"
      onPointerDown={startColumnResize(column)}
      onClick={event => {
        event.preventDefault()
        event.stopPropagation()
      }}
      title="Resize column"
    />
  )

  const mdGridStyle = (column: DepthColumnKey, extra: CSSProperties = {}): CSSProperties => ({
    ...extra,
    borderRight: columnOrder.at(-1) === column ? extra.borderRight : `1px solid ${mdCellLine}`,
    boxShadow: [
      extra.boxShadow,
      `inset 0 -1px 0 ${mdRowLine}`,
    ].filter(Boolean).join(', '),
  })

  const renderOrderFlag = (priceKey: string, side: DepthOrderSide) => {
    const orders = displayActiveOrders.filter(item => item.side === side && item.priceKey === priceKey)
    const sharedOrders = simDepthOrders.filter(item => item.side === side && item.priceKey === priceKey)
    if (!orders.length && !sharedOrders.length) return null
    const orderTickets = orders.length + sharedOrders.length
    const workingOrder = orders.find(order => order.status === 'working')
    const pendingOrder = orders.find(order => order.status === 'pending')
    const filledOrder = orders.find(order => order.status === 'filled')
    const draggableOrder = workingOrder ?? pendingOrder ?? filledOrder ?? orders[0] ?? sharedOrders[0]
    const totalContracts = orders.reduce((sum, order) => sum + order.size, 0) + sharedOrders.reduce((sum, order) => sum + order.size, 0)
    const contractLabel = fmtCompact(totalContracts)
    const status = sharedOrders.length || workingOrder ? 'working' : pendingOrder ? 'pending' : filledOrder ? 'filled' : 'rejected'
    const sideColor = side === 'BID' ? buyColor.bg : sellColor.bg
    const primaryTag = sharedOrders[0]?.orderTag
    const colors = status === 'pending'
      ? { bg: '#ffe800', fg: '#151200', label: contractLabel, border: sideColor }
      : status === 'filled'
        ? { bg: '#22c55e', fg: '#001407', label: contractLabel, border: '#bbf7d0' }
        : status === 'rejected'
          ? { bg: '#7f1d1d', fg: '#fff0f2', label: density === 'small' ? 'R' : 'REJ', border: sellColor.bg }
          : { bg: sideColor, fg: side === 'BID' ? '#001014' : '#fff0f2', label: contractLabel, border: side === 'BID' ? buyColor.border : sellColor.border }
    return (
      <button
        className={cx(
          'relative flex h-[78%] w-full min-w-0 cursor-pointer select-none items-center justify-center overflow-hidden border px-1 font-black shadow',
          side === 'BID' ? 'rounded-l-sm' : 'rounded-r-sm',
        )}
        style={{
          backgroundColor: colors.bg,
          color: colors.fg,
          borderColor: colors.border,
          boxShadow: `0 0 ${density === 'small' ? 5 : 9}px ${colors.bg}`,
          fontSize: density === 'small' ? 8 : 10,
          cursor: draggingOrder?.id === draggableOrder?.id ? 'grabbing' : 'grab',
        }}
        title={`${primaryTag ? `${primaryTag} ` : ''}${status.toUpperCase()} ${orderTickets} order ticket${orderTickets === 1 ? '' : 's'} / ${totalContracts} contract${totalContracts === 1 ? '' : 's'} ${side === 'BID' ? 'BUY' : 'SELL'} @ ${priceKey}. Right-click drag to modify price.`}
        onClick={event => cancelOrderGroup(event, side, priceKey)}
        onDoubleClick={event => {
          event.preventDefault()
          event.stopPropagation()
          submitPendingOrders(side, priceKey)
        }}
        onPointerDown={event => {
          if (!draggableOrder || event.button !== 2 || draggableOrder.status === 'filled') return
          event.preventDefault()
          event.stopPropagation()
          setDraggingOrder(draggableOrder)
          setDragTargetPriceKey(priceKey)
        }}
        onContextMenu={event => {
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        {orderTickets > 1 && (
          <span
            className="absolute -top-px left-1/2 z-30 -translate-x-1/2 border px-0.5 text-[7px] leading-[9px]"
            style={{ backgroundColor: '#d1d5db', borderColor: sideColor, color: sideColor }}
          >
            o{orderTickets}
          </span>
        )}
        <span className="mr-0.5 text-[8px]">{primaryTag?.includes('ALGO') ? 'A' : side === 'BID' ? 'B' : 'S'}</span>
        <span className="min-w-0 truncate">{colors.label}</span>
      </button>
    )
  }

  const renderOrderStack = (priceKey: string) => {
    const hasOrders = displayActiveOrders.some(item => item.priceKey === priceKey) || simDepthOrders.some(item => item.priceKey === priceKey)
    return (
      <div
        className="grid h-full grid-cols-2 items-center gap-px px-1"
        style={{
          backgroundColor: laneGrey,
          color: laneText,
          boxShadow: `inset 0 -1px 0 ${mdRowLine}, inset 1px 0 0 ${mdCellLine}, inset -1px 0 0 ${mdCellLine}`,
        }}
        title={hasOrders ? `My orders @ ${priceKey}` : 'My orders'}
      >
        {hasOrders ? (
          <>
            <div className="flex h-full min-w-0 items-center">{renderOrderFlag(priceKey, 'BID')}</div>
            <div className="flex h-full min-w-0 items-center">{renderOrderFlag(priceKey, 'ASK')}</div>
          </>
        ) : (
          <>
            <span />
            <span />
          </>
        )}
      </div>
    )
  }

  const renderDepthHeaderCell = (column: DepthColumnKey) => {
    if (column === 'orders') {
      return (
        <button
          key={column}
          {...columnDragProps(column)}
          className={cx('relative px-1 py-1 text-center', draggingColumn === column && 'opacity-60')}
          style={mdGridStyle(column, { backgroundColor: laneGrey, color: laneText })}
          onClick={() => clearSide()}
          title="Drag to move this column. Click to clear my working orders."
        >
          Orders
          {resizeGrip(column)}
        </button>
      )
    }
    if (column === 'bid') {
      return (
        <button
          key={column}
          {...columnDragProps(column)}
          className={cx('relative border-r px-1 py-1 text-center text-[10px]', draggingColumn === column && 'opacity-60')}
          style={mdGridStyle(column, {
            borderColor: gridLine,
            backgroundColor: bidColumnBg,
            color: activeForSide('BID') ? '#ffe800' : buyColor.bg,
            boxShadow: activeForSide('BID') ? 'inset 0 -2px 0 rgba(255,232,0,.75)' : undefined,
          })}
          onClick={() => clearSide('BID')}
          title="Drag to move this column. Click to cancel bid-side working orders."
        >
          Bid {activeForSide('BID') ? 'CXL' : ''}
          {resizeGrip(column)}
        </button>
      )
    }
    if (column === 'price') {
      return (
        <button
          key={column}
          {...columnDragProps(column)}
          className={cx('relative border-r px-1 py-1 text-center', draggingColumn === column && 'opacity-60')}
          style={mdGridStyle(column, { borderColor: gridLine, backgroundColor: laneGrey, color: laneText })}
          onDoubleClick={recenterLadder}
          title="Drag to move this column. Double-click to recenter the static ladder."
        >
          Price
          {resizeGrip(column)}
        </button>
      )
    }
    return (
      <button
        key={column}
        {...columnDragProps(column)}
        className={cx('relative px-1 py-1 text-center text-[10px]', draggingColumn === column && 'opacity-60')}
        style={mdGridStyle(column, {
          borderColor: gridLine,
          backgroundColor: askColumnBg,
          color: activeForSide('ASK') ? '#ffe800' : sellColor.bg,
          boxShadow: activeForSide('ASK') ? 'inset 0 -2px 0 rgba(255,232,0,.75)' : undefined,
        })}
        onClick={() => clearSide('ASK')}
        title="Drag to move this column. Click to cancel ask-side working orders."
      >
        Ask {activeForSide('ASK') ? 'CXL' : ''}
        {resizeGrip(column)}
      </button>
    )
  }

  const renderDepthCell = (
    level: {
      key: string
      bidSize: number
      bidCount: number
      askSize: number
      askCount: number
      myBidSize: number
      myAskSize: number
      bestBid: boolean
      bestAsk: boolean
      inside: boolean
      lastTrade: boolean
      lastTradeSize: number
    },
    column: DepthColumnKey,
  ) => {
    if (column === 'orders') {
      return (
        <div key={column} className="relative z-10 h-full" style={mdGridStyle(column, { backgroundColor: laneGrey })}>
          {renderOrderStack(level.key)}
        </div>
      )
    }
    if (column === 'price') {
      return (
        <div
          key={column}
          className="flex h-full items-center justify-center border-r px-2 font-black"
          style={mdGridStyle(column, {
            borderColor: gridLine,
            backgroundColor: level.lastTrade ? '#ffe800' : level.inside ? laneGreyInside : laneGrey,
            color: level.lastTrade ? '#111827' : laneText,
            fontSize: densitySpec.priceFont,
            boxShadow: level.lastTrade ? 'inset 0 0 0 1px #fff6a3' : undefined,
          })}
          onDoubleClick={recenterLadder}
          title="Double-click to recenter the static price ladder"
        >
          <span>{level.key}</span>
          {level.lastTrade && (
            <span className="ml-1 rounded-sm bg-[#111827] px-1 text-[8px] font-black leading-[12px] text-[#ffe800]">
              x{fmtCompact(level.lastTradeSize)}
            </span>
          )}
        </div>
      )
    }
    if (column === 'bid') {
      const bookSize = Number(level.bidSize) || 0
      const visibleSize = bookSize + (Number(level.myBidSize) || 0)
      const hasDepth = visibleSize > 0
      const cellBg = hasDepth ? (level.myBidSize ? bidDepthBg : bidDepthBgSoft) : bidColumnBg
      return (
        <button
          key={column}
          className="relative h-full cursor-pointer overflow-hidden border-r px-1 text-right font-semibold hover:brightness-125"
          style={mdGridStyle(column, { borderColor: gridLine, color: hasDepth ? '#f8fbff' : buyColor.text, backgroundColor: cellBg })}
          onMouseEnter={event => { event.currentTarget.style.backgroundColor = hasDepth ? bidDepthBgHover : bidColumnBgHover }}
          onMouseLeave={event => { event.currentTarget.style.backgroundColor = cellBg }}
          onClick={() => submitDepthOrder('BID', level.key)}
          title={`${actionMode.toUpperCase()} BID @ ${level.key}${level.bidCount > 0 && bookSize > 0 ? `; book ${fmtCompact(bookSize)} contracts / ${fmtCompact(level.bidCount)} order${level.bidCount === 1 ? '' : 's'}` : ''}`}
        >
          <span className="relative z-10 inline-flex items-center justify-end gap-1">
            {level.myBidSize > 0 && <span className="rounded-sm bg-[#00d8ff] px-0.5 text-[8px] font-black text-[#001014]">ME</span>}
            {visibleSize ? fmtCompact(visibleSize) : ''}
            {bookSize > 0 && level.bidCount > 0 && (
              <span className="text-[8px] font-black opacity-70">({fmtCompact(level.bidCount)})</span>
            )}
          </span>
        </button>
      )
    }
    const bookSize = Number(level.askSize) || 0
    const visibleSize = bookSize + (Number(level.myAskSize) || 0)
    const hasDepth = visibleSize > 0
    const cellBg = hasDepth ? (level.myAskSize ? askDepthBgStrong : askDepthBg) : askColumnBg
    return (
      <button
          key={column}
          className="relative h-full cursor-pointer overflow-hidden px-1 text-left font-semibold hover:brightness-125"
        style={mdGridStyle(column, { color: hasDepth ? '#fff7f8' : sellColor.text, backgroundColor: cellBg })}
        onMouseEnter={event => { event.currentTarget.style.backgroundColor = hasDepth ? askDepthBgHover : askColumnBgHover }}
        onMouseLeave={event => { event.currentTarget.style.backgroundColor = cellBg }}
        onClick={() => submitDepthOrder('ASK', level.key)}
        title={`${actionMode.toUpperCase()} ASK @ ${level.key}${level.askCount > 0 && bookSize > 0 ? `; book ${fmtCompact(bookSize)} contracts / ${fmtCompact(level.askCount)} order${level.askCount === 1 ? '' : 's'}` : ''}`}
      >
        <span className="relative z-10 inline-flex items-center gap-1">
          {visibleSize ? fmtCompact(visibleSize) : ''}
          {bookSize > 0 && level.askCount > 0 && (
            <span className="text-[8px] font-black opacity-70">({fmtCompact(level.askCount)})</span>
          )}
          {level.myAskSize > 0 && <span className="rounded-sm bg-[#ff3045] px-0.5 text-[8px] font-black text-white">ME</span>}
        </span>
      </button>
    )
  }

  const bidAskLabel = Number.isFinite(ladderModel.bid) && Number.isFinite(ladderModel.ask)
    ? `B ${fmtLadderPrice(ladderModel.bid, ladderModel.rowStep || ladderModel.tick)} / A ${fmtLadderPrice(ladderModel.ask, ladderModel.rowStep || ladderModel.tick)}`
    : simulationEnabled ? 'Sim active' : ''
  const lastTradeLabel = latestDepthLastPrice !== undefined
    ? `Last ${fmtLadderPrice(latestDepthLastPrice, ladderModel.rowStep || ladderModel.tick)} x${fmtCompact(latestDepthLastSize)}`
    : ''
  const controlButtonClass = 'h-8 border px-2 text-[11px] font-black uppercase leading-none'

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#05070b] font-mono">
      <div className="border-b p-2" style={{ backgroundColor: '#08101d', borderColor: rowLine }}>
        <ProductSelector provider={activeProvider} symbol={activeSymbol} onSelect={onSelect} />
      </div>
      <div className="grid h-[54px] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 overflow-hidden border-b px-2 py-1.5" style={{ borderColor: rowLine, backgroundColor: '#070a10' }}>
        <div className="min-w-0" title={option?.subtitle}>
          <div className="truncate text-[13px] font-black uppercase tracking-normal" style={{ color: buyColor.strong }}>
            {(option?.asset ?? activeSymbol) || 'Depth Ladder'}
          </div>
          <div className="truncate text-[10px] font-bold uppercase tracking-wide text-[#8b929e]">
            {bidAskLabel}
          </div>
          {lastTradeLabel && (
            <div className="truncate text-[10px] font-bold uppercase tracking-wide text-[#cbd5e1]">
              {lastTradeLabel}
            </div>
          )}
        </div>
        <div className="flex max-w-full items-center justify-center gap-1.5 overflow-hidden">
          {(['small', 'medium', 'large'] as DepthLadderDensity[]).map(size => (
            <button
              key={size}
              className={controlButtonClass}
              style={{
                borderColor: density === size ? '#ffe800' : gridLine,
                backgroundColor: density === size ? '#2a2500' : '#121212',
                color: density === size ? '#ffe800' : '#8b929e',
              }}
              onClick={() => setDensity(size)}
            >
              {size === 'small' ? 'SM' : size === 'medium' ? 'MD' : 'LG'}
            </button>
          ))}
          <select
            value={priceMultiplier}
            onChange={event => setPriceMultiplier(Number(event.target.value) || 1)}
            className="h-8 cursor-pointer border bg-[#121212] px-2 text-[11px] font-black uppercase leading-none text-[#ffe800] outline-none hover:border-[#ffe800]"
            style={{ borderColor: rowLine }}
            title="Price multiplier: row step = exchange tick x multiplier. Higher values consolidate rows."
          >
            {priceMultiplierOptions.map(multiplier => <option key={multiplier} value={multiplier}>x{multiplier}</option>)}
          </select>
          <button
            onClick={() => setActionMode(mode => mode === 'limit' ? 'market' : 'limit')}
            className={cx(controlButtonClass, actionMode === 'limit' ? 'bg-[#0b2a63] text-white' : 'bg-[#4a0000] text-[#ffe0e0]')}
            style={{ borderColor: rowLine }}
          >
            {actionMode === 'limit' ? 'LMT' : 'MKT'}
          </button>
          <button
            onClick={() => setFastTrade(value => !value)}
            className={cx(controlButtonClass, fastTrade ? 'bg-[#ffe800] text-black' : 'bg-[#121212] text-[#a0a0a0]')}
            style={{ borderColor: fastTrade ? '#ffe800' : rowLine }}
            title="Fast order send"
          >
            FAST
          </button>
          <span className={cx(controlButtonClass, 'inline-flex items-center bg-[#121212] text-[#00d8ff]')} style={{ borderColor: rowLine }} title="Working order tickets, not contract quantity">W {activeWorkingCount}</span>
          <span className={cx(controlButtonClass, 'inline-flex items-center bg-[#121212] text-[#22c55e]')} style={{ borderColor: rowLine }} title="Local fill events in this ladder window">F {filledCount}</span>
          <button
            onClick={() => setSimulationEnabled(!simulationEnabled)}
            className={cx(controlButtonClass, simulationEnabled ? 'bg-[#163300] text-[#74ff8d]' : 'bg-[#121212] text-[#8b929e]')}
            style={{ borderColor: simulationEnabled ? '#22c55e' : rowLine }}
            title="Toggle Sim Exchange order placement for this terminal"
          >
            SIM
          </button>
          <button onClick={() => setShowSettings(value => !value)} className={cx(controlButtonClass, 'bg-[#121212] text-[#d1d5db]')} style={{ borderColor: rowLine }}>SET</button>
          <button onClick={saveAsDepthDefault} className={cx(controlButtonClass, 'bg-[#121212] text-[#00d8ff]')} style={{ borderColor: rowLine }} title="Save this depth ladder shape as the default for future ladders">DFLT</button>
          <span
            className={cx(controlButtonClass, 'inline-flex w-36 shrink-0 items-center overflow-hidden bg-[#06111d] text-[#00d8ff]', !defaultStatus && 'opacity-0')}
            style={{ borderColor: '#00d8ff' }}
            title={defaultStatus || undefined}
          >
            <span className="truncate">{defaultStatus || 'status'}</span>
          </span>
        </div>
        <span />
      </div>
      {showSettings && (
        <div className="border-b bg-[#0b0f17] p-1" style={{ borderColor: rowLine }}>
          <div className="grid grid-cols-[1fr_auto] gap-1">
            <div className="grid grid-cols-6 border text-[8px] uppercase" style={{ borderColor: rowLine }}>
              <span className="border-r px-1 py-0.5 text-[#aab2c0]" style={{ borderColor: gridLine }}>Grid</span>
              <button onClick={() => setSoftGrid(value => !value)} className={cx('border-r px-1 py-0.5 font-bold', softGrid ? 'bg-[#d1d5db] text-black' : 'bg-[#121212] text-[#a0a0a0]')} style={{ borderColor: gridLine }}>{softGrid ? 'Soft Grey' : 'Hard Dark'}</button>
              <span className="border-r px-1 py-0.5 text-[#aab2c0]" style={{ borderColor: gridLine }}>Action</span>
              <button onClick={() => setActionMode('limit')} className={cx('border-r px-1 py-0.5 font-bold', actionMode === 'limit' ? 'bg-[#0b2a63] text-white' : 'bg-[#121212] text-[#a0a0a0]')} style={{ borderColor: gridLine }}>Limit</button>
              <button onClick={() => setActionMode('market')} className={cx('border-r px-1 py-0.5 font-bold', actionMode === 'market' ? 'bg-[#4a0000] text-[#ffe0e0]' : 'bg-[#121212] text-[#a0a0a0]')} style={{ borderColor: gridLine }}>Market</button>
              <button onClick={() => clearSide()} className="px-1 py-0.5 font-bold text-[#ffe800] bg-[#2a2500]">Clear</button>
            </div>
            <button onClick={() => setShowSettings(false)} className="border border-[#ffe800] bg-[#2a2500] px-2 text-[8px] font-bold text-[#ffe800]">SAVE</button>
          </div>
        </div>
      )}
      <div data-depth-grid="true" className="grid border-b text-[8px] font-bold uppercase" style={{ gridTemplateColumns: ladderGridTemplate, borderColor: rowLine, backgroundColor: '#070a10' }}>
        {columnOrder.map(column => renderDepthHeaderCell(column))}
      </div>
      {!symbol ? (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-[#05070b] p-6 text-center">
          <div className="max-w-sm rounded border border-surface-border bg-surface-card p-5">
            <div className="text-sm font-black uppercase tracking-wide text-slate-100">Depth Ladder</div>
            <div className="mt-2 text-[11px] leading-relaxed text-muted">
              Select a mapped CME product from the ladder product menu above.
            </div>
          </div>
        </div>
      ) : (
        <div
          ref={setLadderBodyElement}
          data-depth-ladder-body="true"
          className="min-h-0 flex-1 overflow-hidden bg-[#05070b]"
          onContextMenu={event => event.preventDefault()}
          onWheel={event => {
            event.preventDefault()
            event.stopPropagation()
            wheelScrollLadder(event.deltaY, event.shiftKey, event.altKey)
          }}
          style={{ fontSize: densitySpec.fontSize }}
        >
          {!depthDefinitionReady ? (
            <div className="flex h-full items-center justify-center p-6 text-center">
              <div className="max-w-sm border bg-[#070a10] p-4" style={{ borderColor: gridLine }}>
                <div className="text-[12px] font-black uppercase tracking-wide text-[#ffe800]">Product Definition Pending</div>
                <div className="mt-2 text-[10px] leading-relaxed text-[#aab2c0]">{depthDefinitionMessage}</div>
              </div>
            </div>
          ) : !depthPriceReady || levels.length === 0 ? (
            <div className="flex h-full items-center justify-center p-6 text-center">
              <div className="max-w-sm border bg-[#070a10] p-4" style={{ borderColor: gridLine }}>
                <div className="text-[12px] font-black uppercase tracking-wide text-[#ffe800]">
                  {serviceConnected ? 'Waiting for First Book' : 'Market Data Connecting'}
                </div>
                <div className="mt-2 text-[10px] leading-relaxed text-[#aab2c0]">
                  {streamAsset ? `${streamAsset} is mapped. The ladder will center when the C++ price service publishes the first live MBP-1 book or trade.` : 'Select a mapped CME product from the menu above.'}
                </div>
              </div>
            </div>
          ) : levels.map(level => (
            <div
              key={level.key}
              data-depth-ladder-row="true"
              className="grid select-none border-b"
              style={{
                gridTemplateColumns: ladderGridTemplate,
                borderColor: level.inside ? 'rgba(250, 204, 21, .38)' : mdRowLine,
                backgroundColor: dragTargetPriceKey === level.key ? 'rgba(255, 232, 0, .18)' : level.inside ? 'rgba(250, 204, 21, .09)' : '#05070b',
                height: densitySpec.rowHeight,
                lineHeight: `${densitySpec.rowHeight}px`,
                boxShadow: dragTargetPriceKey === level.key ? 'inset 0 0 0 1px #ffe800' : undefined,
              }}
              onPointerEnter={() => {
                if (draggingOrder) setDragTargetPriceKey(level.key)
              }}
              onPointerMove={() => {
                if (draggingOrder && dragTargetPriceKey !== level.key) setDragTargetPriceKey(level.key)
              }}
              onDragOver={event => {
                if (!draggingOrder) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                if (dragTargetPriceKey !== level.key) setDragTargetPriceKey(level.key)
              }}
              onDrop={event => {
                if (!draggingOrder) return
                event.preventDefault()
                moveOrder(level.key)
              }}
            >
              {columnOrder.map(column => renderDepthCell(level, column))}
            </div>
          ))}
        </div>
      )}
      <div className="h-[68px] shrink-0 overflow-hidden border-t p-1" style={{ borderColor: rowLine, backgroundColor: '#05070b' }}>
        <div className="mb-1 flex items-center gap-1">
          <div className="grid min-w-0 flex-1 grid-cols-[1fr_1fr_1.25fr] gap-px text-[8px] uppercase">
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine, backgroundColor: '#07111f' }}>
              <div className="text-[#8b929e]">Bid Orders</div>
              <div className="truncate text-[11px] font-black" style={{ color: buyColor.strong }}>
                {workingTotals.bidOrders}o / {fmtCompact(workingTotals.bidContracts)}c
              </div>
            </div>
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine, backgroundColor: '#17070a' }}>
              <div className="text-[#8b929e]">Sell Orders</div>
              <div className="truncate text-[11px] font-black" style={{ color: sellColor.strong }}>
                {workingTotals.askOrders}o / {fmtCompact(workingTotals.askContracts)}c
              </div>
            </div>
            <div
              className={cx('border px-1 py-0.5 font-bold', localDepthPosition.net > 0 ? 'text-white' : localDepthPosition.net < 0 ? 'text-white' : 'text-[#d1d5db]')}
              style={{
                borderColor: gridLine,
                backgroundColor: localDepthPosition.net > 0
                  ? 'rgba(37, 99, 235, .68)'
                  : localDepthPosition.net < 0
                    ? 'rgba(153, 27, 27, .76)'
                    : '#121212',
              }}
            >
              <div className={cx('text-[#dbeafe]', localDepthPosition.net < 0 && 'text-white')}>Net Position</div>
              <div className="truncate text-[11px] font-black">
                {localDepthPosition.net === 0
                  ? 'FLAT 0'
                  : `${localDepthPosition.net > 0 ? 'LONG' : 'SHORT'} ${fmtCompact(Math.abs(localDepthPosition.net))}${localDepthPosition.avg !== undefined ? ` @ ${fmtLadderPrice(localDepthPosition.avg, ladderModel.rowStep || ladderModel.tick)}` : ''}`}
              </div>
            </div>
          </div>
          <label className="grid w-20 grid-rows-[12px_1fr] border bg-[#121212]" style={{ borderColor: gridLine }} title="Custom order quantity">
            <span className="px-1 text-[8px] uppercase text-[#8b929e]">Cntr</span>
            <input
              type="number"
              min={1}
              value={defaultSize}
              onChange={event => setDefaultSize(Math.max(1, Number(event.target.value) || 1))}
              className="min-w-0 bg-transparent px-1 pb-0.5 text-right text-[11px] font-black text-slate-100 outline-none"
            />
          </label>
        </div>
        <div
          className={cx('mt-1 truncate border px-1 py-0.5 text-[8px] font-bold uppercase text-[#74ff8d]', !(simulationEnabled && simMessages[0]) && 'opacity-0')}
          style={{ borderColor: '#1f5f2f', backgroundColor: '#07120a' }}
        >
          {simulationEnabled && simMessages[0] ? simMessages[0] : 'status'}
        </div>
      </div>
    </div>
  )
}

type ExecutionSource = 'manual' | 'algo'

type AccountExecutionRow = {
  id: string
  row_type: 'fill' | 'order'
  timestamp: number
  account: string
  exchange: string
  provider: ProviderKey | 'execution' | 'sim'
  product: string
  market_key: string
  order_id: string
  source: ExecutionSource
  order_tag: string
  algo_role?: string
  operator: string
  strategy: string
  leg_id: string
  side: string
  price: number | string
  size: number | string
  status: string
  pnl: number
  notional: number
  order_details: string
  synthetic_legs?: SyntheticFillLeg[]
}

type FillSideBucket = 'buy' | 'sell' | 'unknown'

type SyntheticFillLeg = {
  symbol: string
  side: FillSideBucket
  size: number
  price?: number
  pnl?: number
  ratio?: number
  legId?: string
}

type ProductFillRollup = {
  product: string
  buys: number
  sells: number
  pnl: number
  notional: number
  fills: number
  synthetic: boolean
  syntheticLegs: SyntheticFillLeg[]
  legDetailReady: boolean
}

function simOrderTag(source: ExecutionSource, role?: string, fallback?: string): string {
  if (fallback) return fallback
  if (source === 'algo' && role === 'cover') return 'ALGO COVER'
  if (source === 'algo') return 'ALGO ENTRY'
  return 'MANUAL'
}

function executionSideLabel(fill: PolyTradeTick, marketKey: string, raw?: Record<string, unknown>): string {
  if (executionRawPrice(fill.price, marketKey, raw)) {
    const normalized = String(raw?.displaySide ?? raw?.marketSide ?? raw?.orderSide ?? '').toLowerCase()
    if (normalized === 'sell' || normalized === 'offer' || normalized === 'ask') return 'SELL'
    if (normalized === 'buy' || normalized === 'bid') return 'BUY'
    return fill.side === 'no' ? 'SELL' : 'BUY'
  }
  return fill.side.toUpperCase()
}

function executionOrderSideLabel(order: Pick<SimOrder, 'marketKey' | 'outcome' | 'side' | 'price' | 'multiplier'>): string {
  if (executionRawPrice(order.price, order.marketKey, order as unknown as Record<string, unknown>)) {
    return order.side === 'bid' ? 'BUY' : 'SELL'
  }
  return `${order.outcome.toUpperCase()} ${order.side.toUpperCase()}`
}

function executionSideClassName(side: string): string {
  if (side === 'BUY' || side === 'BID' || side === 'YES' || side === 'UP') return 'font-bold text-up'
  if (side === 'SELL' || side === 'ASK' || side === 'NO' || side === 'DOWN') return 'font-bold text-down'
  return 'text-muted'
}

function inferSource(raw: Record<string, unknown>, model?: string | null): ExecutionSource {
  const source = String(raw.source ?? raw.origin ?? raw.placement ?? '').toLowerCase()
  if (source.includes('manual') || source.includes('depth-ladder')) return 'manual'
  if (source.includes('algo') || source.includes('bot') || source.includes('agent')) return 'algo'
  const modelText = String(model ?? '').toLowerCase()
  if (!modelText || modelText === 'manual' || modelText.includes('depth-ladder')) return 'manual'
  return 'algo'
}

function executionRawPrice(price: number, marketKey: string, raw?: Record<string, unknown>): boolean {
  return isKnownFuturesProduct(marketKey)
    || (typeof raw?.multiplier === 'number' && raw.multiplier > 1)
    || (Number.isFinite(price) && (price < 0 || price > 100))
}

function executionMultiplier(marketKey: string, raw: Record<string, unknown> | undefined, price: number): number {
  const rawMultiplier = Number(raw?.multiplier)
  if (Number.isFinite(rawMultiplier) && rawMultiplier > 0) return rawMultiplier
  if (executionRawPrice(price, marketKey, raw)) return resolveFuturesMultiplier(marketKey, rawMultiplier, price)
  return 0.01
}

function executionPriceLabel(price: number, marketKey: string, raw?: Record<string, unknown>): string {
  if (!Number.isFinite(price)) return '-'
  if (executionRawPrice(price, marketKey, raw)) return price.toFixed(Math.abs(price) >= 100 ? 2 : 3)
  return `${price.toFixed(1)}c`
}

function executionNotional(price: number, size: number, marketKey: string, raw?: Record<string, unknown>): number {
  return calculateFuturesMarketValue(price, size, executionMultiplier(marketKey, raw, price))
}

function isAccountFillTick(raw: Record<string, unknown>): boolean {
  const exchange = String(raw.exchange ?? '')
  return exchange === 'Sim Exchange'
    || raw.orderId != null
    || raw.order_id != null
    || raw.fillId != null
    || raw.fill_id != null
    || raw.account != null
    || raw.operator != null
    || raw.legId != null
    || raw.leg_id != null
    || raw.orderTag != null
    || raw.realizedPnl != null
}

function fillSideBucket(side: string): FillSideBucket {
  const normalized = side.toUpperCase()
  if (normalized.includes('SELL') || normalized.includes('OFFER') || normalized.includes('ASK') || normalized === 'NO' || normalized === 'DOWN') return 'sell'
  if (normalized.includes('BUY') || normalized.includes('BID') || normalized === 'YES' || normalized === 'UP') return 'buy'
  return 'unknown'
}

function formatContractCount(value: number): string {
  return value.toFixed(Number.isInteger(value) ? 0 : 2)
}

function isSyntheticProductKey(value: string): boolean {
  return value.includes('_') || /\/| spread/i.test(value)
}

function normalizeSyntheticFillLegs(raw: Record<string, unknown>): SyntheticFillLeg[] {
  const candidates = [raw.syntheticLegs, raw.synthetic_legs, raw.legs, raw.fillLegs, raw.fill_legs]
  const legPayload = candidates.find(Array.isArray)
  if (!Array.isArray(legPayload)) return []
  return legPayload.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return []
    const leg = item as Record<string, unknown>
    const symbol = String(leg.symbol ?? leg.asset ?? leg.marketKey ?? leg.market_key ?? leg.instrument ?? `LEG-${index + 1}`)
    const side = fillSideBucket(String(leg.side ?? leg.action ?? leg.orderSide ?? leg.order_side ?? ''))
    const size = Number(leg.size ?? leg.qty ?? leg.quantity ?? leg.contracts ?? 0)
    const price = Number(leg.price ?? leg.fillPrice ?? leg.fill_price)
    const pnl = Number(leg.pnl ?? leg.realizedPnl ?? leg.realized_pnl)
    const ratio = Number(leg.ratio ?? leg.weight ?? leg.hedgeRatio ?? leg.hedge_ratio)
    return [{
      symbol,
      side,
      size: Number.isFinite(size) ? Math.abs(size) : 0,
      price: Number.isFinite(price) ? price : undefined,
      pnl: Number.isFinite(pnl) ? pnl : undefined,
      ratio: Number.isFinite(ratio) ? ratio : undefined,
      legId: String(leg.legId ?? leg.leg_id ?? `${symbol}-${index + 1}`),
    }]
  })
}

function productLookup(options: ProductOption[]): Map<string, ProductOption> {
  const byKey = new Map<string, ProductOption>()
  for (const option of options) {
    byKey.set(option.symbol, option)
    if (option.marketKey) byKey.set(option.marketKey, option)
    if (option.asset) byKey.set(option.asset, option)
  }
  return byKey
}

function simOrderToCeriousOrderRow(order: SimOrder, option: ProductOption | undefined): CeriousOrderRow {
  const side = executionOrderSideLabel(order)
  const tag = simOrderTag(order.source, order.algoRole, order.orderTag)
  const remaining = executionNumber(order.remaining)
  const size = executionNumber(order.size)
  const price = executionNumber(order.price)
  const updatedAt = executionNumber(order.updatedAt, Date.now())
  return {
    id: order.id,
    instrumentId: option?.label ?? order.marketKey,
    label: option?.subtitle ?? order.marketKey,
    side,
    qty: remaining > 0 ? remaining : size,
    price,
    status: order.status,
    held: false,
    source: order.source,
    orderClass: tag,
    orderType: order.orderType,
    algoName: order.algoName ?? (order.source === 'algo' ? order.strategy : undefined),
    algoLegRole: order.algoRole ? (order.algoRole === 'cover' ? 'ALGO COVER' : 'ALGO ENTRY') : undefined,
    updatedAt: new Date(updatedAt).toISOString(),
  }
}

function simPositionToCeriousPositionRow(position: SimPosition, option: ProductOption | undefined): CeriousPositionRow {
  const multiplier = executionMultiplier(position.marketKey, position as unknown as Record<string, unknown>, position.avgPrice)
  const openPnl = calculateOpenFuturesPnl(position.avgPrice, position.markPrice, position.size, multiplier)
  return {
    instrumentId: option?.label ?? position.marketKey,
    label: `${position.source === 'algo' ? (position.algoName ?? position.strategy) : 'Manual'}${position.algoRole ? ` / ${position.algoRole}` : ''}`,
    qty: position.size,
    avgPrice: position.avgPrice,
    markPrice: position.markPrice,
    markLive: true,
    multiplier,
    openPnl,
    realizedPnl: position.realizedPnl,
    account: position.operator,
    lastFillAt: new Date(position.closedAt ?? position.openedAt).toISOString(),
    fillCount: 1,
  }
}

function buildExecutionRows({
  options,
  fillsByMarket,
  executionPositions,
  simOrders,
  simPositions,
  markets,
  operatorName,
}: {
  options: ProductOption[]
  fillsByMarket: Record<string, PolyTradeTick[]>
  executionPositions: ReturnType<typeof useStore.getState>['executionPositions']
  simOrders: SimOrder[]
  simPositions: SimPosition[]
  markets: ReturnType<typeof useStore.getState>['markets']
  operatorName: string
}): AccountExecutionRow[] {
  const productByMarketKey = productLookup(options)
  void executionPositions

  const fillRows = Object.entries(fillsByMarket).flatMap(([marketKey, fills]) => {
    const option = productByMarketKey.get(marketKey)
    const market = markets.find(item => item.key === marketKey)
    return fills.filter(fill => isAccountFillTick(fill as unknown as Record<string, unknown>)).map((fill, index) => {
      const raw = fill as PolyTradeTick & Record<string, unknown>
      const fillTimestamp = executionNumber(fill.timestamp, Date.now())
      const fillPrice = executionNumber(fill.price)
      const fillSize = executionNumber(fill.size)
      const exchange = String(raw.exchange ?? providerLabel(option?.provider ?? 'cme'))
      const source = inferSource(raw, typeof raw.model === 'string' ? raw.model : undefined)
      const venue: ProviderKey | 'sim' = exchange === 'Sim Exchange' ? 'sim' : option?.provider ?? 'cme'
      const orderId = String(raw.order_id ?? raw.orderId ?? raw.trade_id ?? raw.tradeId ?? `${option?.provider ?? 'cme'}-${marketKey}-${fillTimestamp}-${index}`)
      const product = option?.label ?? market?.key ?? fill.marketKey ?? marketKey
      const priceLabel = executionPriceLabel(fillPrice, marketKey, raw)
      const notional = executionNotional(fillPrice, fillSize, marketKey, raw)
      const sideLabel = executionSideLabel(fill, marketKey, raw)
      const syntheticLegs = normalizeSyntheticFillLegs(raw)
      return {
        id: `fill-${marketKey}-${fillTimestamp}-${fillPrice}-${fillSize}-${index}`,
        row_type: 'fill' as const,
        timestamp: fillTimestamp,
        account: 'Parent',
        exchange,
        provider: venue,
        product,
        market_key: marketKey,
        order_id: orderId,
        source,
        order_tag: simOrderTag(source, String(raw.algoRole ?? ''), String(raw.orderTag ?? '')),
        algo_role: typeof raw.algoRole === 'string' ? raw.algoRole : undefined,
        operator: String(raw.operator ?? raw.user ?? operatorName),
        strategy: String(raw.model ?? raw.strategy ?? (source === 'algo' ? 'algo-router' : 'manual')),
        leg_id: String(raw.leg_id ?? raw.legId ?? `${orderId}-L${index + 1}`),
        side: sideLabel,
        price: priceLabel,
        size: fillSize.toFixed(0),
        status: 'FILLED',
        pnl: typeof raw.realizedPnl === 'number' ? raw.realizedPnl : 0,
        notional,
        order_details: `${simOrderTag(source, String(raw.algoRole ?? ''), String(raw.orderTag ?? ''))} ${exchange} ${product} ${sideLabel} ${fillSize.toFixed(0)} @ ${priceLabel}`,
        synthetic_legs: syntheticLegs,
      }
    })
  })

  const simOrderRows = simOrders.map(order => {
    const option = productByMarketKey.get(order.marketKey)
    const position = simPositions.find(item => item.legId === order.legId && item.marketKey === order.marketKey)
    const tag = simOrderTag(order.source, order.algoRole, order.orderTag)
    const triggerDetail = order.trigger ? ` trigger ${order.trigger}` : ''
    const layerDetail = order.layer ? ` L${order.layer}` : ''
    const parentDetail = order.parentOrderId ? ` parent ${order.parentOrderId}` : ''
    const price = executionNumber(order.price)
    const size = executionNumber(order.size)
    const filledSize = executionNumber(order.filledSize)
    const updatedAt = executionNumber(order.updatedAt, Date.now())
    const priceLabel = executionPriceLabel(price, order.marketKey, order as unknown as Record<string, unknown>)
    const notional = executionNotional(price, size, order.marketKey, order as unknown as Record<string, unknown>)
    const sideLabel = executionOrderSideLabel(order)
    return {
      id: `sim-order-${order.id}`,
      row_type: 'order' as const,
      timestamp: updatedAt,
      account: 'Parent',
      exchange: 'Sim Exchange',
      provider: 'sim' as const,
      product: option?.label ?? order.marketKey,
      market_key: order.marketKey,
      order_id: order.id,
      source: order.source,
      order_tag: tag,
      algo_role: order.algoRole,
      operator: order.operator,
      strategy: order.strategy,
      leg_id: order.legId,
      side: sideLabel,
      price: priceLabel,
      size: `${filledSize.toFixed(0)} / ${size.toFixed(0)}`,
      status: order.status,
      pnl: position?.totalPnl ?? 0,
      notional,
      order_details: `${tag}${layerDetail} ${sideLabel} ${String(order.orderType ?? 'limit').toUpperCase()} ${order.status} ${filledSize.toFixed(0)}/${size.toFixed(0)} @ ${priceLabel}${triggerDetail}${parentDetail}`,
    }
  })

  return [...fillRows, ...simOrderRows].sort((a, b) => b.timestamp - a.timestamp)
}

function OrderBookWindow({ operatorName }: { operatorName: string }) {
  const options = useProductOptions()
  const [providerFilter, setProviderFilter] = useState<ProviderKey | 'sim' | 'all'>('all')
  const [productFilter, setProductFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('working')
  const [sourceFilter, setSourceFilter] = useState<ExecutionSource | 'all'>('all')
  const [cancelStatus, setCancelStatus] = useState('')
  const simOrders = useStore(s => s.simOrders)
  const simPositions = useStore(s => s.simPositions)
  const simulationEnabled = useStore(s => s.simulationEnabled)

  const allRows = useMemo(
    () => buildExecutionRows({ options, fillsByMarket: {}, executionPositions: [], simOrders, simPositions, markets: [], operatorName })
      .filter(row => row.row_type === 'order'),
    [operatorName, options, simOrders, simPositions],
  )

  const productOptions = useMemo(() => {
    const seen = new Set<string>()
    return allRows
      .filter(row => providerFilter === 'all' || row.provider === providerFilter)
      .filter(row => {
        if (seen.has(row.product)) return false
        seen.add(row.product)
        return true
      })
      .map(row => row.product)
      .sort()
  }, [allRows, providerFilter])

  const visibleRows = allRows.filter(row => {
    const providerOk = providerFilter === 'all' || row.provider === providerFilter
    const productOk = productFilter === 'all' || row.product === productFilter
    const sourceOk = sourceFilter === 'all' || row.source === sourceFilter
    const statusOk = statusFilter === 'all'
      || (statusFilter === 'working' ? !/closed|filled|cancel/i.test(row.status) : row.status.toLowerCase() === statusFilter)
    return providerOk && productOk && sourceOk && statusOk
  })

  const summaryRows = allRows.filter(row => {
    const providerOk = providerFilter === 'all' || row.provider === providerFilter
    const productOk = productFilter === 'all' || row.product === productFilter
    const sourceOk = sourceFilter === 'all' || row.source === sourceFilter
    return providerOk && productOk && sourceOk
  })
  const openStatus = (status: string) => !/closed|filled|cancel/i.test(status)
  const workingCount = summaryRows.filter(row => openStatus(row.status)).length
  const workingNotional = summaryRows
    .filter(row => openStatus(row.status))
    .reduce((sum, row) => sum + row.notional, 0)
  const [splitPct, setSplitPct] = useState(86)
  const [selectedRowId, setSelectedRowId] = useState('')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  const selectedRow = visibleRows.find(row => row.id === selectedRowId) ?? visibleRows[0]

  const startSplitDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const startPct = splitPct
    const height = splitContainerRef.current?.clientHeight ?? 1
    const handleMove = (moveEvent: PointerEvent) => {
      const deltaPct = ((moveEvent.clientY - startY) / height) * 100
      setSplitPct(clamp(startPct + deltaPct, 42, 92))
    }
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
  }

  const cancelOrderRow = async (row: AccountExecutionRow) => {
    if (!row || /closed|filled|cancel/i.test(row.status)) return
    if (row.provider === 'sim') {
      try {
        await cancelSharedOrder(row.order_id)
        setCancelStatus(`Cancelled ${row.order_tag} ${row.order_id}`)
      } catch (err) {
        setCancelStatus(`Cancel failed for ${row.order_id}: ${err instanceof Error ? err.message : 'gateway unavailable'}`)
      }
      return
    }
    setCancelStatus(`Cancelling ${row.order_id}...`)
    try {
      const response = await ceriousFetch(`/api/cerious/orders/${encodeURIComponent(row.order_id)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      setCancelStatus(response.ok ? `Cancel accepted for ${row.order_id}` : `Cancel rejected for ${row.order_id}`)
    } catch {
      setCancelStatus(`Cancel failed for ${row.order_id}`)
    }
  }

  const cancelAllOrders = async () => {
    setCancelStatus(simulationEnabled ? 'Cancelling Sim Exchange orders...' : 'Cancelling working orders...')
    const ceriousCancel = await ceriousFetch('/api/cerious/orders/cancel-all', { method: 'POST' }).catch(() => null)
    let ceriousCount = 0
    if (ceriousCancel?.ok) {
      const payload = await ceriousCancel.json().catch(() => ({}))
      ceriousCount = Number(payload.count ?? 0)
      if (payload.state) {
        useStore.getState().setSimTradingState({
          simOrders: payload.state.simOrders,
          simPositions: payload.state.simPositions,
          fills: payload.state.fills,
          simMessages: payload.state.simMessages,
        })
      }
    }
    setCancelStatus(ceriousCancel?.ok
      ? `Cancel all accepted by order service; ${ceriousCount} server order${ceriousCount === 1 ? '' : 's'} cancelled.`
      : 'Cancel-all failed; no order service acknowledged.')
  }

  const exportOrders = () => {
    exportCsv(
      `orders-${Date.now()}.csv`,
      ['row_type', 'timestamp', 'account', 'exchange', 'product', 'market_key', 'order_id', 'source', 'order_tag', 'algo_role', 'operator', 'strategy', 'leg_id', 'side', 'price', 'size', 'status', 'pnl', 'notional', 'order_details'],
      visibleRows.map(row => ({ ...row, timestamp: new Date(row.timestamp).toISOString() })),
    )
  }

  return (
    <div className="flex h-full flex-col bg-surface font-mono text-[11px]">
      <div className="border-b border-surface-border bg-surface-panel p-2">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div />
          <div className="flex items-center gap-2">
            <button className="btn-neutral flex items-center gap-1 px-2 py-1 text-[10px]" onClick={exportOrders} title="Export orders to CSV">
              <Download size={12} /> Export CSV
            </button>
            <button
              className="flex items-center gap-2 rounded border border-red-300 bg-red-600 px-4 py-2 text-[12px] font-black uppercase tracking-wide text-white shadow-[0_0_18px_rgba(239,68,68,0.45)] hover:bg-red-500"
              onClick={cancelAllOrders}
              title="Emergency cancel all working orders across all exchanges and order books"
            >
              <AlertTriangle size={15} /> Cancel All
            </button>
          </div>
        </div>
        <div className="grid grid-cols-[120px_140px_1fr_120px_120px] gap-2">
          <select className="input-field py-1 text-[10px]" value="parent" disabled title="Account">
            <option value="parent">Parent Account</option>
          </select>
          <select
            className="input-field py-1 text-[10px]"
            value={providerFilter}
            onChange={event => {
              setProviderFilter(event.target.value as ProviderKey | 'sim' | 'all')
              setProductFilter('all')
            }}
          >
            <option value="all">All exchanges</option>
            <option value="sim">Sim Exchange</option>
            {PROVIDERS.map(provider => <option key={provider.key} value={provider.key}>{provider.label}</option>)}
          </select>
          <select className="input-field py-1 text-[10px]" value={productFilter} onChange={event => setProductFilter(event.target.value)}>
            <option value="all">All products</option>
            {productOptions.map(product => <option key={product} value={product}>{product}</option>)}
          </select>
          <select className="input-field py-1 text-[10px]" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
            <option value="working">Working</option>
            <option value="all">All statuses</option>
            <option value="open">Open</option>
            <option value="pending">Pending</option>
            <option value="closed">Closed</option>
          </select>
          <select className="input-field py-1 text-[10px]" value={sourceFilter} onChange={event => setSourceFilter(event.target.value as ExecutionSource | 'all')}>
            <option value="all">All order types</option>
            <option value="manual">Manual</option>
            <option value="algo">Algo</option>
          </select>
        </div>
      </div>
      <div ref={splitContainerRef} className="min-h-0 flex flex-1 flex-col overflow-hidden bg-[#050912]">
        <div className="min-h-[120px] shrink-0 overflow-hidden" style={{ flexBasis: `${splitPct}%` }}>
          <div className="grid grid-cols-[78px_88px_1fr_96px_74px_74px_88px_58px_58px_72px_70px_1.2fr_58px] border-b border-surface-border bg-surface-card px-2 py-1 text-[10px] font-bold uppercase text-muted">
            <span>Time</span>
            <span>Exchange</span>
            <span>Product</span>
            <span>Order ID</span>
            <span>Type</span>
            <span>Operator</span>
            <span>Leg</span>
            <span>Side</span>
            <span className="text-right">Price</span>
            <span className="text-right">Contracts</span>
            <span className="text-right">P&L</span>
            <span>Status / Details</span>
            <span className="text-right">Action</span>
          </div>
          <div className="h-[calc(100%-24px)] overflow-auto">
            {visibleRows.map(row => (
              <div
                key={row.id}
                className={cx(
                  'grid w-full cursor-pointer grid-cols-[78px_88px_1fr_96px_74px_74px_88px_58px_58px_72px_70px_1.2fr_58px] gap-1 border-b border-surface-border/40 px-2 py-1 text-left hover:bg-surface-hover',
                  selectedRow?.id === row.id && 'bg-blue-500/10',
                )}
                onClick={() => setSelectedRowId(row.id)}
                role="button"
                tabIndex={0}
              >
                <span className="text-muted">{new Date(row.timestamp).toLocaleTimeString()}</span>
                <span className="truncate font-bold" style={{ color: venueColor(row.provider) }}>{row.exchange}</span>
                <span className="truncate text-slate-200">{row.product}</span>
                <span className="truncate text-muted" title={row.order_id}>{row.order_id}</span>
                <span className={row.source === 'algo' ? 'font-bold text-warn' : 'font-bold text-accent'} title={row.source.toUpperCase()}>{row.order_tag}</span>
                <span className="truncate text-slate-200">{row.operator}</span>
                <span className="truncate text-muted" title={row.leg_id}>{row.leg_id}</span>
                <span className={executionSideClassName(row.side)}>{row.side}</span>
                <span className="text-right">{row.price}</span>
                <span className="text-right">{row.size}</span>
                <span className={cx('text-right font-bold', row.pnl >= 0 ? 'text-up' : 'text-down')}>{row.pnl >= 0 ? '+' : ''}${row.pnl.toFixed(2)}</span>
                <span className="truncate text-muted" title={row.order_details}>{row.status} - {row.order_details}</span>
                <button
                  className="justify-self-end rounded border border-red-400/40 px-1.5 py-0.5 text-[10px] font-black text-red-300 hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={/closed|filled|cancel/i.test(row.status)}
                  onClick={event => {
                    event.stopPropagation()
                    void cancelOrderRow(row)
                  }}
                  title={`Cancel ${row.order_id}`}
                >
                  CXL
                </button>
              </div>
            ))}
            {visibleRows.length === 0 && (
              <div className="p-4 text-center text-muted">No working orders match this view.</div>
            )}
          </div>
        </div>

        <div
          className="group flex h-3 cursor-row-resize items-center border-y border-surface-border bg-surface-panel"
          onPointerDown={startSplitDrag}
          title="Drag to resize order grid and details pane"
        >
          <div className="mx-auto h-1 w-28 rounded bg-surface-border group-hover:bg-accent" />
        </div>

        <div className="min-h-[54px] flex-1 overflow-auto bg-[#08101b] p-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] uppercase">
            <div className="flex flex-wrap items-center gap-2">
              <div className="rounded border border-surface-border bg-surface-card px-2 py-1">
                <span className="text-muted">Working Orders </span>
                <span className="font-black text-slate-100">{workingCount}</span>
              </div>
              <div className="rounded border border-surface-border bg-surface-card px-2 py-1">
                <span className="text-muted">Working Notional </span>
                <span className="font-black text-slate-100">{fmtMoney(workingNotional)}</span>
              </div>
              <div className="rounded border border-surface-border bg-surface-card px-2 py-1">
                <span className="text-muted">Visible </span>
                <span className="font-black text-accent">{visibleRows.length}</span>
              </div>
              <div className="min-w-[180px] rounded border border-surface-border bg-surface-card px-2 py-1">
                <span className="text-muted">Selected </span>
                <span className="font-black text-slate-100">{selectedRow?.order_id ?? '-'}</span>
              </div>
            </div>
            <button
              className="btn-neutral flex items-center gap-1 px-2 py-1 text-[10px]"
              onClick={() => setDetailsOpen(open => !open)}
              title="Expand selected order details"
            >
              {detailsOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />} Details
            </button>
          </div>

          {detailsOpen && (
            <div className="mt-2 grid grid-cols-[1.1fr_1fr_1fr_1.2fr] gap-2 text-[10px]">
              <div className="rounded border border-surface-border bg-surface-card p-2">
                <div className="font-bold uppercase text-muted">Selected Order</div>
                <div className="mt-1 truncate text-sm font-black text-slate-100">{selectedRow?.product ?? 'No order selected'}</div>
                <div className="truncate text-muted">{selectedRow?.order_id ?? '-'}</div>
              </div>
              <div className="rounded border border-surface-border bg-surface-card p-2">
                <div className="font-bold uppercase text-muted">Route / Tag</div>
                <div className={cx('mt-1 font-black', selectedRow?.source === 'algo' ? 'text-warn' : 'text-accent')}>{selectedRow?.order_tag ?? '-'}</div>
                <div className="truncate text-muted">{selectedRow?.exchange ?? '-'} / {selectedRow?.side ?? '-'}</div>
              </div>
              <div className="rounded border border-surface-border bg-surface-card p-2">
                <div className="font-bold uppercase text-muted">Price / Size</div>
                <div className="mt-1 font-black text-slate-100">{selectedRow ? `${selectedRow.price} x ${selectedRow.size}` : '-'}</div>
                <div className={cx('text-muted', selectedRow && selectedRow.pnl >= 0 ? 'text-up' : selectedRow ? 'text-down' : '')}>{selectedRow ? `${selectedRow.pnl >= 0 ? '+' : ''}$${selectedRow.pnl.toFixed(2)}` : '-'}</div>
              </div>
              <div className="rounded border border-surface-border bg-surface-card p-2">
                <div className="font-bold uppercase text-muted">Status</div>
                <div className="mt-1 truncate font-black text-slate-100">{selectedRow?.status ?? '-'}</div>
                <div className="truncate text-muted" title={selectedRow?.order_details}>{selectedRow?.order_details ?? 'Select a row to inspect details.'}</div>
              </div>
            </div>
          )}

          <div className="mt-2 flex items-center justify-between border-t border-surface-border pt-2 text-[10px] text-muted">
            <span>Filled and cancelled orders leave the working book automatically.</span>
            <span className={cancelStatus.includes('accepted') || cancelStatus.includes('cancelled') ? 'text-up' : cancelStatus ? 'text-warn' : ''}>{cancelStatus || 'Cancel all cancels working orders only; positions remain open until offset.'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

type FillsPositionsView = 'fills' | 'positions' | 'summary'

type PositionMonitorRow = {
  id: string
  provider: ProviderKey | 'execution' | 'sim'
  exchange: string
  product: string
  symbol: string
  marketKey: string
  position: number
  avgPrice: number
  marketPrice: number
  marketValue: number
  openPnl: number
  closedPnl: number
  dayPnl: number
  status: string
  source: ExecutionSource
  strategy: string
  updatedAt: number
  details: string
}

function executionSizeValue(value: number | string | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const first = String(value ?? '0').split('/').at(0)?.trim() ?? '0'
  const parsed = Number(first)
  return Number.isFinite(parsed) ? parsed : 0
}

function executionNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeCeriousPositionRow(row: Partial<CeriousPositionRow> & Record<string, unknown>): CeriousPositionRow {
  const avgPrice = executionNumber(row.avgPrice)
  const markPrice = executionNumber(row.markPrice, avgPrice)
  return {
    instrumentId: String(row.instrumentId ?? row.marketKey ?? row.symbol ?? 'UNKNOWN'),
    label: row.label == null ? undefined : String(row.label),
    qty: executionNumber(row.qty),
    avgPrice,
    markPrice,
    markLive: Boolean(row.markLive),
    multiplier: row.multiplier == null ? undefined : executionNumber(row.multiplier),
    openPnl: executionNumber(row.openPnl),
    realizedPnl: row.realizedPnl == null ? undefined : executionNumber(row.realizedPnl),
    account: row.account == null ? undefined : String(row.account),
    lastFillAt: row.lastFillAt == null ? undefined : String(row.lastFillAt),
    fillCount: row.fillCount == null ? undefined : executionNumber(row.fillCount),
  }
}

function normalizeCeriousOrderRow(row: Partial<CeriousOrderRow> & Record<string, unknown>): CeriousOrderRow {
  return {
    id: String(row.id ?? row.order_id ?? row.orderId ?? 'unknown-order'),
    instrumentId: String(row.instrumentId ?? row.marketKey ?? row.symbol ?? 'UNKNOWN'),
    label: row.label == null ? undefined : String(row.label),
    side: String(row.side ?? ''),
    qty: executionNumber(row.qty),
    price: executionNumber(row.price),
    status: String(row.status ?? 'unknown'),
    held: Boolean(row.held),
    source: row.source == null ? undefined : String(row.source),
    orderClass: row.orderClass == null ? undefined : String(row.orderClass),
    orderType: row.orderType == null ? undefined : String(row.orderType),
    algoName: row.algoName == null ? undefined : String(row.algoName),
    algoLegRole: row.algoLegRole == null ? undefined : String(row.algoLegRole),
    updatedAt: row.updatedAt == null ? undefined : String(row.updatedAt),
  }
}

function buildProductFillRollups(rows: AccountExecutionRow[]): ProductFillRollup[] {
  const byProduct = new Map<string, ProductFillRollup>()
  for (const row of rows) {
    const current = byProduct.get(row.product) ?? {
      product: row.product,
      buys: 0,
      sells: 0,
      pnl: 0,
      notional: 0,
      fills: 0,
      synthetic: false,
      syntheticLegs: [],
      legDetailReady: true,
    }
    const size = Math.abs(executionSizeValue(row.size))
    const side = fillSideBucket(row.side)
    if (side === 'buy') current.buys += size
    if (side === 'sell') current.sells += size
    current.pnl += row.pnl
    current.notional += row.notional
    current.fills += 1
    current.synthetic = current.synthetic || isSyntheticProductKey(row.market_key) || isSyntheticProductKey(row.product)
    current.syntheticLegs.push(...(row.synthetic_legs ?? []))
    current.legDetailReady = !current.synthetic || current.syntheticLegs.length > 0
    byProduct.set(row.product, current)
  }
  return [...byProduct.values()].sort((a, b) => a.product.localeCompare(b.product))
}

function signedExecutionPositionSize(direction: string, size: number): number {
  const normalized = direction.toUpperCase()
  if (normalized.includes('DOWN') || normalized.includes('SHORT') || normalized.includes('SELL')) return -Math.abs(size)
  return Math.abs(size)
}

function positionSideLabel(size: number): string {
  const qty = executionNumber(size)
  if (qty > 0) return `LONG ${Math.abs(qty).toFixed(Number.isInteger(qty) ? 0 : 2)}`
  if (qty < 0) return `SHORT ${Math.abs(qty).toFixed(Number.isInteger(qty) ? 0 : 2)}`
  return 'FLAT'
}

function monitorPriceLabel(price: number, marketKey: string, raw?: Record<string, unknown>): string {
  if (!Number.isFinite(price)) return '-'
  return executionPriceLabel(price, marketKey, raw)
}

function simPositionToMonitorRow(position: SimPosition, option: ProductOption | undefined): PositionMonitorRow {
  const size = executionNumber(position.size)
  const avgPrice = executionNumber(position.avgPrice)
  const marketPrice = executionNumber(position.markPrice, avgPrice)
  const realizedPnl = executionNumber(position.realizedPnl)
  const openedAt = executionNumber(position.openedAt, Date.now())
  const closedAt = position.closedAt == null ? undefined : executionNumber(position.closedAt)
  const multiplier = executionMultiplier(position.marketKey, position as unknown as Record<string, unknown>, avgPrice)
  const openPnl = calculateOpenFuturesPnl(avgPrice, marketPrice, size, multiplier)
  return {
    id: `sim-position-${position.id}`,
    provider: 'sim',
    exchange: 'Sim Exchange',
    product: option?.label ?? position.marketKey,
    symbol: option?.asset ?? option?.symbol ?? position.marketKey,
    marketKey: position.marketKey,
    position: position.status === 'closed' ? 0 : size,
    avgPrice,
    marketPrice,
    marketValue: calculateFuturesMarketValue(marketPrice, size, multiplier),
    openPnl,
    closedPnl: realizedPnl,
    dayPnl: realizedPnl + openPnl,
    status: position.status,
    source: position.source,
    strategy: position.algoName ?? position.strategy,
    updatedAt: closedAt ?? openedAt,
    details: `${simOrderTag(position.source, position.algoRole, position.orderTag)} ${position.status.toUpperCase()} ${positionSideLabel(size)} @ ${monitorPriceLabel(avgPrice, position.marketKey, position as unknown as Record<string, unknown>)}`,
  }
}

function executionPositionToMonitorRow(
  position: ReturnType<typeof useStore.getState>['executionPositions'][number],
  option: ProductOption | undefined,
): PositionMonitorRow {
  const marketKey = option?.marketKey ?? position.asset
  const signedSize = signedExecutionPositionSize(position.direction, Number(position.size) || 0)
  const multiplier = executionMultiplier(marketKey, position as unknown as Record<string, unknown>, Number(position.entry_price) || 0)
  const entryPrice = Number(position.entry_price)
  const currentPrice = Number(position.current_price)
  const hasLiveMark = Number.isFinite(entryPrice) && Number.isFinite(currentPrice)
  const backendOpenPnl = Number(position.unrealized_pnl)
  const openPnl = hasLiveMark
    ? calculateOpenFuturesPnl(entryPrice, currentPrice, signedSize, multiplier)
    : Number.isFinite(backendOpenPnl) ? backendOpenPnl : 0
  const displayEntryPrice = Number.isFinite(entryPrice) ? entryPrice : 0
  const displayCurrentPrice = Number.isFinite(currentPrice) ? currentPrice : displayEntryPrice
  return {
    id: `execution-position-${position.position_id}`,
    provider: option?.provider ?? 'execution',
    exchange: providerLabel(option?.provider ?? 'cme'),
    product: option?.label ?? position.asset,
    symbol: option?.asset ?? option?.symbol ?? position.asset,
    marketKey,
    position: /closed|filled|cancel/i.test(position.status) ? 0 : signedSize,
    avgPrice: displayEntryPrice,
    marketPrice: displayCurrentPrice,
    marketValue: calculateFuturesMarketValue(displayCurrentPrice, signedSize, multiplier),
    openPnl,
    closedPnl: /closed|filled|cancel/i.test(position.status) ? openPnl : 0,
    dayPnl: openPnl,
    status: position.status,
    source: 'algo',
    strategy: position.model ?? 'ExecutionAgent',
    updatedAt: Date.now(),
    details: `Execution position ${position.position_id} ${position.direction} ${position.size} ${position.asset}`,
  }
}

function FillsWindow({ operatorName }: { operatorName: string }) {
  const options = useProductOptions()
  const [viewMode, setViewMode] = useState<FillsPositionsView>('fills')
  const [providerFilter, setProviderFilter] = useState<ProviderKey | 'sim' | 'all'>('all')
  const [productFilter, setProductFilter] = useState('all')
  const [expandedPositionId, setExpandedPositionId] = useState('')
  const fillsByMarket = useStore(s => s.fills)
  const executionPositions = useStore(s => s.executionPositions)
  const simPositions = useStore(s => s.simPositions)
  const markets = useStore(s => s.markets)
  const productByKey = useMemo(() => productLookup(options), [options])

  const allFillRows = useMemo(
    () => buildExecutionRows({ options, fillsByMarket, executionPositions, simOrders: [], simPositions, markets, operatorName })
      .filter(row => row.row_type === 'fill'),
    [executionPositions, fillsByMarket, markets, operatorName, options, simPositions],
  )

  const allPositionRows = useMemo(() => {
    const simRows = simPositions.map(position => simPositionToMonitorRow(position, productByKey.get(position.marketKey)))
    const executionRows = executionPositions.map(position => {
      const option = options.find(item => item.asset === position.asset || item.symbol === position.asset || item.marketKey === position.asset)
      return executionPositionToMonitorRow(position, option)
    })
    return [...simRows, ...executionRows].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [executionPositions, options, productByKey, simPositions])

  const providerMatches = (provider: ProviderKey | 'execution' | 'sim') => providerFilter === 'all' || provider === providerFilter
  const productMatches = (product: string) => productFilter === 'all' || product === productFilter

  const productOptions = useMemo(() => {
    const seen = new Set<string>()
    for (const row of allFillRows) {
      if (!providerMatches(row.provider) || seen.has(row.product)) continue
      seen.add(row.product)
    }
    for (const row of allPositionRows) {
      if (!providerMatches(row.provider) || seen.has(row.product)) continue
      seen.add(row.product)
    }
    return [...seen].sort()
  }, [allFillRows, allPositionRows, providerFilter])

  const visibleFillRows = allFillRows.filter(row => {
    const providerOk = providerFilter === 'all' || row.provider === providerFilter
    const productOk = productFilter === 'all' || row.product === productFilter
    return providerOk && productOk
  })

  const visiblePositionRows = allPositionRows.filter(row => providerMatches(row.provider) && productMatches(row.product))
  const openPositionRows = visiblePositionRows.filter(row => Math.abs(row.position) > 0 && !/closed|flat/i.test(row.status))
  const productFillRollups = useMemo(() => buildProductFillRollups(visibleFillRows), [visibleFillRows])

  const pnlSummary = useMemo(() => {
    const byLeg = new Map<string, { leg: string; product: string; pnl: number; notional: number; rows: number }>()
    for (const row of visibleFillRows) {
      const leg = byLeg.get(row.leg_id) ?? { leg: row.leg_id, product: row.product, pnl: 0, notional: 0, rows: 0 }
      leg.pnl += row.pnl
      leg.notional += row.notional
      leg.rows += 1
      byLeg.set(row.leg_id, leg)
    }
    const products = productFillRollups.slice().sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, 5)
    const legs = Array.from(byLeg.values()).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, 5)
    const topProduct = products[0]
    const positionClosedPnl = visiblePositionRows.reduce((sum, row) => sum + row.closedPnl, 0)
    const fillClosedPnl = visibleFillRows.reduce((sum, row) => sum + row.pnl, 0)
    const closedPnl = positionClosedPnl !== 0 ? positionClosedPnl : fillClosedPnl
    const openPnl = openPositionRows.reduce((sum, row) => sum + row.openPnl, 0)
    return {
      pnl: fillClosedPnl,
      notional: visibleFillRows.reduce((sum, row) => sum + row.notional, 0),
      fills: visibleFillRows.length,
      filledContracts: visibleFillRows.reduce((sum, row) => sum + Math.abs(executionSizeValue(row.size)), 0),
      totalBuys: productFillRollups.reduce((sum, row) => sum + row.buys, 0),
      totalSells: productFillRollups.reduce((sum, row) => sum + row.sells, 0),
      netPosition: openPositionRows.reduce((sum, row) => sum + row.position, 0),
      openPnl,
      closedPnl,
      dayPnl: openPnl + closedPnl,
      productCount: products.length,
      products,
      legs,
      topProduct,
    }
  }, [openPositionRows, productFillRollups, visibleFillRows, visiblePositionRows])

  const exportFills = () => {
    if (viewMode === 'positions') {
      exportCsv(
        `positions-${Date.now()}.csv`,
        ['symbol', 'product', 'exchange', 'position', 'avgPrice', 'marketPrice', 'marketValue', 'openPnl', 'closedPnl', 'dayPnl', 'status', 'source', 'strategy', 'details'],
        visiblePositionRows,
      )
      return
    }
    exportCsv(
      `fills-${Date.now()}.csv`,
      ['row_type', 'timestamp', 'account', 'exchange', 'product', 'market_key', 'order_id', 'source', 'order_tag', 'algo_role', 'operator', 'strategy', 'leg_id', 'side', 'price', 'size', 'status', 'pnl', 'notional', 'synthetic_legs', 'order_details'],
      visibleFillRows.map(row => ({
        ...row,
        timestamp: new Date(row.timestamp).toISOString(),
        synthetic_legs: JSON.stringify(row.synthetic_legs ?? []),
      })),
    )
  }

  return (
    <div className="flex h-full flex-col bg-surface font-mono text-[11px]">
      <div className="border-b border-surface-border bg-surface-panel p-2">
        <div className="mb-2 flex items-center justify-between gap-2">
          <select
            className="input-field h-8 w-36 py-1 text-[10px]"
            value={viewMode}
            onChange={event => setViewMode(event.target.value as FillsPositionsView)}
            title="Select monitor view"
          >
            <option value="fills">Fills</option>
            <option value="positions">Positions</option>
            <option value="summary">Summary</option>
          </select>
          <button className="btn-accent flex items-center gap-1 px-2 py-1 text-[10px]" onClick={exportFills}>
            <Download size={12} /> Export CSV
          </button>
        </div>
        <div className="grid grid-cols-[120px_140px_1fr] gap-2">
          <select className="input-field py-1 text-[10px]" value="parent" disabled title="Account">
            <option value="parent">Parent Account</option>
          </select>
          <select
            className="input-field py-1 text-[10px]"
            value={providerFilter}
            onChange={event => {
              setProviderFilter(event.target.value as ProviderKey | 'sim' | 'all')
              setProductFilter('all')
            }}
          >
            <option value="all">All exchanges</option>
            <option value="sim">Sim Exchange</option>
            {PROVIDERS.map(provider => <option key={provider.key} value={provider.key}>{provider.label}</option>)}
          </select>
          <select className="input-field py-1 text-[10px]" value={productFilter} onChange={event => setProductFilter(event.target.value)}>
            <option value="all">All products</option>
            {productOptions.map(product => <option key={product} value={product}>{product}</option>)}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-[1fr_1fr_1fr_1fr_1fr] gap-2 border-b border-surface-border bg-[#08101b] p-2 uppercase leading-tight">
        <div className="rounded border border-surface-border bg-surface-card px-2 py-1.5">
          <div className="text-[10px] font-bold text-muted">Total Contracts</div>
          <div className="mt-0.5 text-[15px] font-black leading-none text-slate-100">
            B {formatContractCount(pnlSummary.totalBuys)} / S {formatContractCount(pnlSummary.totalSells)}
          </div>
          <div className="mt-1 text-[9px] font-bold text-muted">{formatContractCount(pnlSummary.filledContracts)} filled</div>
        </div>
        <div className="rounded border border-surface-border bg-surface-card px-2 py-1.5">
          <div className="text-[10px] font-bold text-muted">Net Position</div>
          <div className={cx('mt-0.5 text-[17px] font-black leading-none', pnlSummary.netPosition > 0 ? 'text-up' : pnlSummary.netPosition < 0 ? 'text-down' : 'text-slate-100')}>
            {positionSideLabel(pnlSummary.netPosition)}
          </div>
        </div>
        <div className="rounded border border-surface-border bg-surface-card px-2 py-1.5">
          <div className="text-[10px] font-bold text-muted">Open P&L</div>
          <div className={cx('mt-0.5 text-[17px] font-black leading-none', pnlSummary.openPnl >= 0 ? 'text-up' : 'text-down')}>{fmtMoney(pnlSummary.openPnl)}</div>
        </div>
        <div className="rounded border border-surface-border bg-surface-card px-2 py-1.5">
          <div className="text-[10px] font-bold text-muted">Closed P&L</div>
          <div className={cx('mt-0.5 text-[17px] font-black leading-none', pnlSummary.closedPnl >= 0 ? 'text-up' : 'text-down')}>{fmtMoney(pnlSummary.closedPnl)}</div>
        </div>
        <div className="min-w-0 rounded border border-surface-border bg-surface-card px-2 py-1.5">
          <div className="text-[10px] font-bold text-muted">Day P&L</div>
          <div className={cx('mt-0.5 text-[17px] font-black leading-none', pnlSummary.dayPnl >= 0 ? 'text-up' : 'text-down')}>{fmtMoney(pnlSummary.dayPnl)}</div>
        </div>
      </div>
      {viewMode === 'positions' && (
        <>
          <div className="grid grid-cols-[92px_84px_84px_84px_104px_92px_92px_78px] border-b border-surface-border bg-surface-card px-2 py-1 text-center text-[10px] font-bold uppercase text-muted">
            <span>Symbol</span>
            <span>Pos</span>
            <span>Avg Px</span>
            <span>Mkt Px</span>
            <span>Market Value</span>
            <span>P&L Open</span>
            <span>P&L Day</span>
            <span>Status</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {visiblePositionRows.map(row => (
              <div key={row.id} className="border-b border-surface-border/40">
                <div
                  className="grid cursor-pointer grid-cols-[92px_84px_84px_84px_104px_92px_92px_78px] items-center gap-1 px-2 py-1.5 text-center hover:bg-surface-hover"
                  onClick={() => setExpandedPositionId(current => current === row.id ? '' : row.id)}
                  role="button"
                  tabIndex={0}
                >
                  <span className="truncate font-black text-slate-100" title={row.product}>{row.symbol}</span>
                  <span className={cx('rounded border px-1.5 py-0.5 font-black', row.position > 0 ? 'border-blue-400/50 bg-blue-500/15 text-blue-200' : row.position < 0 ? 'border-red-400/50 bg-red-500/15 text-red-200' : 'border-surface-border text-muted')}>
                    {row.position > 0 ? '+' : ''}{row.position.toFixed(Number.isInteger(row.position) ? 0 : 2)}
                  </span>
                  <span className="text-slate-200">{monitorPriceLabel(row.avgPrice, row.marketKey)}</span>
                  <span className="text-accent">{monitorPriceLabel(row.marketPrice, row.marketKey)}</span>
                  <span className="text-slate-200">{fmtMoney(row.marketValue)}</span>
                  <span className={cx('font-black', row.openPnl >= 0 ? 'text-up' : 'text-down')}>{fmtMoney(row.openPnl)}</span>
                  <span className={cx('font-black', row.dayPnl >= 0 ? 'text-up' : 'text-down')}>{fmtMoney(row.dayPnl)}</span>
                  <span className="truncate text-muted">{row.status}</span>
                </div>
                {expandedPositionId === row.id && (
                  <div className="grid grid-cols-[1.2fr_1fr_1fr_1fr] gap-2 bg-[#07101b] px-2 py-2 text-[10px]">
                    <div className="min-w-0">
                      <div className="font-bold uppercase text-muted">Product</div>
                      <div className="truncate font-black text-slate-100">{row.product}</div>
                    </div>
                    <div>
                      <div className="font-bold uppercase text-muted">Source</div>
                      <div className={row.source === 'algo' ? 'font-black text-warn' : 'font-black text-accent'}>{row.source.toUpperCase()} / {row.strategy}</div>
                    </div>
                    <div>
                      <div className="font-bold uppercase text-muted">Closed P&L</div>
                      <div className={cx('font-black', row.closedPnl >= 0 ? 'text-up' : 'text-down')}>{fmtMoney(row.closedPnl)}</div>
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold uppercase text-muted">Details</div>
                      <div className="truncate text-slate-200" title={row.details}>{row.details}</div>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {visiblePositionRows.length === 0 && (
              <div className="p-4 text-center text-muted">No positions match this view.</div>
            )}
          </div>
        </>
      )}
      {viewMode === 'summary' && (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <div className="grid grid-cols-2 gap-2 text-[10px] uppercase">
            <div className="rounded border border-surface-border bg-surface-card p-2">
              <div className="font-bold text-muted">Fill Rollup</div>
              <div className="mt-1 text-sm font-black text-slate-100">
                Buys {formatContractCount(pnlSummary.totalBuys)} / Sells {formatContractCount(pnlSummary.totalSells)}
              </div>
              <div className={cx('mt-1 font-black', pnlSummary.pnl >= 0 ? 'text-up' : 'text-down')}>Net P&L {fmtMoney(pnlSummary.pnl)}</div>
            </div>
            <div className="rounded border border-surface-border bg-surface-card p-2">
              <div className="font-bold text-muted">Position Rollup</div>
              <div className="mt-1 text-sm font-black text-slate-100">{openPositionRows.length} open position row(s)</div>
              <div className={cx('mt-1 font-black', pnlSummary.openPnl >= 0 ? 'text-up' : 'text-down')}>Open {fmtMoney(pnlSummary.openPnl)} / Day {fmtMoney(pnlSummary.dayPnl)}</div>
            </div>
          </div>
          <div className="mt-2 rounded border border-surface-border bg-[#07101b]">
            <div className="grid grid-cols-[88px_82px_82px_104px_1fr] border-b border-surface-border px-2 py-1 text-[10px] font-black uppercase text-muted">
              <span>Product</span>
              <span className="text-right">Buys</span>
              <span className="text-right">Sells</span>
              <span className="text-right">Total P&L</span>
              <span className="pl-2">Synthetic Legs</span>
            </div>
            {productFillRollups.map(row => (
              <div key={`fill-rollup-${row.product}`} className="border-b border-surface-border/40">
                <div className="grid grid-cols-[88px_82px_82px_104px_1fr] items-center gap-1 px-2 py-1.5 text-[10px]">
                  <span className="truncate font-black text-slate-100" title={row.product}>{row.product}</span>
                  <span className="text-right font-black text-blue-200">{formatContractCount(row.buys)}</span>
                  <span className="text-right font-black text-red-200">{formatContractCount(row.sells)}</span>
                  <span className={cx('text-right font-black', row.pnl >= 0 ? 'text-up' : 'text-down')}>{fmtMoney(row.pnl)}</span>
                  <span className="min-w-0 pl-2 text-muted">
                    {row.synthetic
                      ? row.legDetailReady
                        ? `${row.syntheticLegs.length} leg fill${row.syntheticLegs.length === 1 ? '' : 's'} published`
                        : 'Leg detail pending from synthetic spread fill publisher'
                      : 'Outright'}
                  </span>
                </div>
                {row.syntheticLegs.length > 0 && (
                  <div className="grid gap-1 bg-[#050912] px-2 pb-2 pl-[90px] text-[9px]">
                    {row.syntheticLegs.map((leg, index) => (
                      <div key={`${row.product}-${leg.legId ?? index}`} className="grid grid-cols-[72px_54px_64px_80px_1fr] gap-2 rounded border border-surface-border/60 bg-surface-card px-2 py-1">
                        <span className="font-black text-slate-100">{leg.symbol}</span>
                        <span className={leg.side === 'buy' ? 'font-black text-blue-200' : leg.side === 'sell' ? 'font-black text-red-200' : 'font-black text-muted'}>{leg.side.toUpperCase()}</span>
                        <span className="text-right text-slate-200">{formatContractCount(leg.size)}</span>
                        <span className="text-right text-muted">{leg.price === undefined ? '-' : leg.price.toFixed(Math.abs(leg.price) >= 100 ? 2 : 3)}</span>
                        <span className={cx('text-right font-black', (leg.pnl ?? 0) >= 0 ? 'text-up' : 'text-down')}>{leg.pnl === undefined ? '-' : fmtMoney(leg.pnl)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {productFillRollups.length > 0 && (
              <div className="grid grid-cols-[88px_82px_82px_104px_1fr] items-center gap-1 border-t border-surface-border bg-surface-card px-2 py-1.5 text-[10px] font-black uppercase">
                <span className="text-slate-100">Total</span>
                <span className="text-right text-blue-200">{formatContractCount(pnlSummary.totalBuys)}</span>
                <span className="text-right text-red-200">{formatContractCount(pnlSummary.totalSells)}</span>
                <span className={cx('text-right', pnlSummary.pnl >= 0 ? 'text-up' : 'text-down')}>{fmtMoney(pnlSummary.pnl)}</span>
                <span className="pl-2 text-muted">All fill rows in this filtered view</span>
              </div>
            )}
            {!productFillRollups.length && (
              <div className="p-4 text-center text-muted">No fills to summarize.</div>
            )}
          </div>
          <div className="mt-2 rounded border border-surface-border bg-[#07101b]">
            <div className="border-b border-surface-border px-2 py-1 text-[10px] font-black uppercase text-muted">Open Position Waterfall</div>
            {openPositionRows.map(row => (
              <div key={`summary-${row.id}`} className="grid grid-cols-[92px_1fr_90px_90px_90px] items-center gap-2 border-b border-surface-border/40 px-2 py-1.5 text-[10px]">
                <span className="font-black text-slate-100">{row.symbol}</span>
                <span className="truncate text-muted">{row.product}</span>
                <span className={cx('text-center font-black', row.position >= 0 ? 'text-up' : 'text-down')}>{positionSideLabel(row.position)}</span>
                <span className={cx('text-right font-black', row.openPnl >= 0 ? 'text-up' : 'text-down')}>{fmtMoney(row.openPnl)}</span>
                <span className={cx('text-right font-black', row.dayPnl >= 0 ? 'text-up' : 'text-down')}>{fmtMoney(row.dayPnl)}</span>
              </div>
            ))}
            {!openPositionRows.length && (
              <div className="p-4 text-center text-muted">No open positions.</div>
            )}
          </div>
        </div>
      )}
      {viewMode === 'fills' && (
        <>
          <div className="grid grid-cols-[78px_88px_1fr_96px_74px_74px_88px_58px_58px_72px_70px_1.2fr] border-b border-surface-border bg-surface-card px-2 py-1 text-[10px] font-bold uppercase text-muted">
            <span>Time</span>
            <span>Exchange</span>
            <span>Product</span>
            <span>Order ID</span>
            <span>Type</span>
            <span>Operator</span>
            <span>Leg</span>
            <span>Side</span>
            <span className="text-right">Price</span>
            <span className="text-right">Contracts</span>
            <span className="text-right">P&L</span>
            <span>Details</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {visibleFillRows.map(row => (
              <div key={row.id} className="grid grid-cols-[78px_88px_1fr_96px_74px_74px_88px_58px_58px_72px_70px_1.2fr] gap-1 border-b border-surface-border/40 px-2 py-1">
                <span className="text-muted">{new Date(row.timestamp).toLocaleTimeString()}</span>
                <span className="truncate font-bold" style={{ color: venueColor(row.provider) }}>{row.exchange}</span>
                <span className="truncate text-slate-200">{row.product}</span>
                <span className="truncate text-muted" title={row.order_id}>{row.order_id}</span>
                <span className={row.source === 'algo' ? 'font-bold text-warn' : 'font-bold text-accent'} title={row.source.toUpperCase()}>{row.order_tag}</span>
                <span className="truncate text-slate-200">{row.operator}</span>
                <span className="truncate text-muted" title={row.leg_id}>{row.leg_id}</span>
                <span className={executionSideClassName(row.side)}>{row.side}</span>
                <span className="text-right">{row.price}</span>
                <span className="text-right">{row.size}</span>
                <span className={cx('text-right font-bold', row.pnl >= 0 ? 'text-up' : 'text-down')}>{row.pnl >= 0 ? '+' : ''}${row.pnl.toFixed(2)}</span>
                <span className="truncate text-muted" title={row.order_details}>{row.order_details}</span>
              </div>
            ))}
            {visibleFillRows.length === 0 && (
              <div className="p-4 text-center text-muted">No fills yet.</div>
            )}
          </div>
        </>
      )}
      <div className="flex items-center justify-between border-t border-surface-border px-2 py-1 text-[10px] text-muted">
        <span>{visibleFillRows.length} visible fill tickets, {visiblePositionRows.length} visible position rows</span>
        <span>Filled orders leave the order book and publish here with live position P&L.</span>
      </div>
    </div>
  )
}

function AlgoBuilderWindow({
  provider,
  symbol,
  operatorName,
  onSelect,
}: {
  provider: ProviderKey
  symbol: string
  operatorName: string
  onSelect: (provider: ProviderKey, symbol: string) => void
}) {
  const options = useProductOptions()
  const selectedOption = options.find(option => option.provider === provider && option.symbol === symbol)
  const { upsertAlgo } = useAlgoLibrary()
  const [draft, setDraft] = useState<AlgoDefinition>(() => defaultAlgo(selectedOption, operatorName))

  useEffect(() => {
    setDraft(current => ({
      ...current,
      provider,
      symbol,
      marketKey: selectedOption?.marketKey,
      name: current.name || `${selectedOption?.asset ?? symbol} Mean Reversion`,
      operator: operatorName,
    }))
  }, [operatorName, provider, selectedOption?.marketKey, symbol])

  const saveDraft = (status: AlgoStatus = 'held') => {
    const saveSymbol = selectedOption?.marketKey ?? symbol
    const ceriousFields = normalizeCeriousFields({
      ...draft,
      instruments: draft.instruments?.length ? draft.instruments : [saveSymbol],
    }, saveSymbol)
    const saveSide: AlgoDefinition['side'] = ceriousFields.layerPlan.workBuySide && ceriousFields.layerPlan.workSellSide
      ? 'both'
      : ceriousFields.layerPlan.workBuySide
        ? 'bid'
        : ceriousFields.layerPlan.workSellSide
          ? 'offer'
          : 'both'
    const savedStatus: AlgoStatus = status === 'draft' ? 'draft' : 'held'
    const savedAlgo: AlgoDefinition = {
      ...draft,
      ...ceriousFields,
      id: draft.id || `algo-${Date.now()}`,
      provider,
      symbol: saveSymbol,
      marketKey: selectedOption?.marketKey ?? saveSymbol,
      instruments: [saveSymbol],
      side: saveSide,
      entryPeg: { ...ceriousFields.entryPeg, source: 'linear-regression' },
      orderPolicy: { ...ceriousFields.orderPolicy, priceReference: 'linear-regression-bands' },
      operator: operatorName,
      status: savedStatus,
      updatedAt: Date.now(),
    }
    upsertAlgo(savedAlgo)
    void saveAlgoDefinitionServer(savedAlgo)
    setDraft(defaultAlgo(selectedOption, operatorName))
  }
  const ceriousDraft = normalizeCeriousFields(draft, draft.marketKey ?? draft.symbol)
  const signalRules = draft.signalRules ?? ceriousDraft.signalRules
  const risk = draft.risk ?? ceriousDraft.risk
  const entryPeg = draft.entryPeg ?? ceriousDraft.entryPeg
  const layerPlan = draft.layerPlan ?? ceriousDraft.layerPlan
  const syntheticOrderManager = draft.syntheticOrderManager ?? ceriousDraft.syntheticOrderManager
  const exitPolicy = draft.exitPolicy ?? ceriousDraft.exitPolicy
  const orderPolicy = draft.orderPolicy ?? ceriousDraft.orderPolicy
  const sniperMode = String(orderPolicy.mode || syntheticOrderManager.entryTechnique || '').toLowerCase().includes('sniper')
  const setTemplate = (template: AlgoTemplate) => {
    setDraft(current => {
      const symbolKey = selectedOption?.marketKey ?? current.symbol
      const ceriousFields = template === 'mean-reversion-v2' ? normalizeCeriousFields(current, symbolKey) : {}
      return { ...current, ...ceriousFields, template, templateId: template }
    })
  }
  const updateRule = (index: number, patch: Partial<AlgoSignalRule>) => {
    setDraft(current => {
      const rules = [...(current.signalRules ?? ceriousDraft.signalRules)]
      rules[index] = { ...rules[index], ...patch }
      return { ...current, signalRules: rules }
    })
  }
  const updateRisk = (patch: Partial<AlgoRisk>) => setDraft(current => ({ ...current, risk: { ...(current.risk ?? ceriousDraft.risk), ...patch } }))
  const updateEntryPeg = (patch: Partial<AlgoEntryPeg>) => setDraft(current => ({ ...current, entryPeg: { ...(current.entryPeg ?? ceriousDraft.entryPeg), ...patch } }))
  const updateLayerPlan = (patch: Partial<AlgoLayerPlan>) => setDraft(current => ({ ...current, layerPlan: { ...(current.layerPlan ?? ceriousDraft.layerPlan), ...patch } }))
  const updateExitPolicy = (patch: Partial<AlgoExitPolicy>) => setDraft(current => ({ ...current, exitPolicy: { ...(current.exitPolicy ?? ceriousDraft.exitPolicy), ...patch } }))
  const updateOrderPolicy = (patch: Partial<AlgoOrderPolicy>) => setDraft(current => ({ ...current, orderPolicy: { ...(current.orderPolicy ?? ceriousDraft.orderPolicy), ...patch } }))
  const setSniperMode = (enabled: boolean) => {
    setDraft(current => {
      const currentFields = normalizeCeriousFields(current, current.marketKey ?? current.symbol)
      return {
        ...current,
        orderType: 'limit',
        syntheticOrderManager: {
          ...(current.syntheticOrderManager ?? currentFields.syntheticOrderManager),
          entryTechnique: enabled ? 'sniper-market-if-target-price-achievable' : 'regular-limit',
          holdUntilTriggered: enabled,
        },
        orderPolicy: {
          ...(current.orderPolicy ?? currentFields.orderPolicy),
          mode: enabled ? 'synthetic-sniper' : 'regular-limit',
          orderType: enabled ? 'synthetic-held-market-release' : 'limit',
        },
      }
    })
  }

  return (
    <div className="flex h-full flex-col bg-surface text-xs">
      <div className="border-b border-surface-border bg-surface-panel p-2">
        <ProductSelector provider={provider} symbol={symbol} onSelect={onSelect} compact />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_190px] gap-2 overflow-hidden p-2">
        <div className="min-h-0 overflow-y-auto">
          <div className="grid grid-cols-2 gap-2">
            <label className="col-span-2 text-[10px] uppercase text-muted">
              Name
              <input className="input-field mt-1 w-full py-1 text-[11px]" value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} />
            </label>
            <label className="text-[10px] uppercase text-muted">
              Template
              <select className="input-field mt-1 w-full py-1 text-[11px]" value={draft.template} onChange={event => setTemplate(event.target.value as AlgoTemplate)}>
                <option value="mean-reversion-v2">Mean Reversion v2</option>
                <option value="scale-in">Scale In</option>
              </select>
            </label>
            <label className="flex items-center gap-2 rounded border border-surface-border bg-surface-card px-2 py-2 text-[10px] uppercase text-muted">
              <input type="checkbox" checked={sniperMode} onChange={event => setSniperMode(event.target.checked)} />
              <span className="font-bold text-slate-200">Sniper</span>
              <span className="ml-auto font-mono text-[10px] text-muted">{sniperMode ? 'Sniper' : 'Limit'}</span>
            </label>
            {[
              ['Clip Size', 'clipSize', 1, 'Contracts per order ticket. Separate from layers.'],
              ['Max Position', 'maxPosition', 1, 'Per-side cap in synthetic spread units. Max 5 means up to 5 long units and separately up to 5 short units.'],
            ].map(([label, key, step, help]) => (
              <label key={String(key)} className="text-[10px] uppercase text-muted">
                <span title={String(help)}>{label}</span>
                <input
                  type="number"
                  step={Number(step)}
                  className="input-field mt-1 w-full py-1 text-[11px]"
                  value={Number(draft[key as keyof AlgoDefinition])}
                  onChange={event => {
                    const value = Number(event.target.value)
                    setDraft(current => ({
                      ...current,
                      [key]: value,
                      ...(key === 'maxPosition' ? { risk: { ...(current.risk ?? ceriousDraft.risk), maxPosition: value } } : {}),
                    }))
                  }}
                />
              </label>
            ))}
          </div>
          <div className="mt-2 rounded border border-surface-border bg-[#08101b] p-2">
            <div className="mb-2 flex items-center justify-between font-mono text-[10px] font-black uppercase text-accent">
              <span>Rules / Triggers</span>
              <span>{signalRules.filter(rule => rule.enabled).length}/{signalRules.length} armed</span>
            </div>
            <div className="space-y-1">
              {signalRules.map((rule, index) => (
                <div key={rule.id} className="grid grid-cols-[24px_1fr_38px_70px_1fr] items-center gap-1 font-mono text-[10px]">
                  <input type="checkbox" checked={rule.enabled} onChange={event => updateRule(index, { enabled: event.target.checked })} />
                  <input className="input-field py-1 text-[10px]" value={rule.field} onChange={event => updateRule(index, { field: event.target.value })} title="Rule field" />
                  <input className="input-field py-1 text-center text-[10px]" value={rule.operator} onChange={event => updateRule(index, { operator: event.target.value })} title="Operator" />
                  <input className="input-field py-1 text-[10px]" value={String(rule.value)} onChange={event => updateRule(index, { value: event.target.value })} title="Trigger value" />
                  <input className="input-field py-1 text-[10px]" value={rule.action} onChange={event => updateRule(index, { action: event.target.value })} title="Action" />
                </div>
              ))}
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="rounded border border-surface-border bg-surface-card p-2">
              <div className="mb-2 font-mono text-[10px] font-black uppercase text-accent">Regression Entry Peg</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[10px] uppercase text-muted">
                  Lookback
                  <input
                    type="number"
                    min={2}
                    className="input-field mt-1 w-full py-1 text-[11px]"
                    value={entryPeg.lookback ?? ''}
                    onChange={event => updateEntryPeg({ lookback: event.target.value === '' ? undefined : Number(event.target.value) })}
                  />
                </label>
                <label className="text-[10px] uppercase text-muted">
                  Std Dev
                  <input type="number" step={0.25} className="input-field mt-1 w-full py-1 text-[11px]" value={entryPeg.standardDeviations} onChange={event => updateEntryPeg({ standardDeviations: Number(event.target.value) || 0 })} />
                </label>
                <label className="col-span-2 text-[10px] uppercase text-muted">
                  Calculator
                  <input className="input-field mt-1 w-full py-1 text-[11px]" value="linear-regression" readOnly />
                </label>
              </div>
            </div>
            <div className="rounded border border-surface-border bg-surface-card p-2">
              <div className="mb-2 font-mono text-[10px] font-black uppercase text-accent">Layer Plan</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[10px] uppercase text-muted">
                  <span title="Number of order rows or bands to layer off the market. Separate from clip size.">Layers</span>
                  <input type="number" className="input-field mt-1 w-full py-1 text-[11px]" value={layerPlan.layerCount} onChange={event => updateLayerPlan({ layerCount: Number(event.target.value) || 1 })} />
                </label>
                <label className="text-[10px] uppercase text-muted">
                  Spacing Ticks
                  <input type="number" className="input-field mt-1 w-full py-1 text-[11px]" value={layerPlan.layerSpacingTicks} onChange={event => updateLayerPlan({ layerSpacingTicks: Number(event.target.value) || 0 })} />
                </label>
                <label className="flex items-center gap-2 text-[10px] uppercase text-muted"><input type="checkbox" checked={layerPlan.workBuySide} onChange={event => updateLayerPlan({ workBuySide: event.target.checked })} /> Work bid</label>
                <label className="flex items-center gap-2 text-[10px] uppercase text-muted"><input type="checkbox" checked={layerPlan.workSellSide} onChange={event => updateLayerPlan({ workSellSide: event.target.checked })} /> Work ask</label>
              </div>
            </div>
            <div className="rounded border border-surface-border bg-surface-card p-2">
              <div className="mb-2 font-mono text-[10px] font-black uppercase text-accent">Risk Controls</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="col-span-2 text-[10px] uppercase text-muted">
                  Max Loss ATR
                  <input type="number" className="input-field mt-1 w-full py-1 text-[11px]" value={risk.maxLossAtr} onChange={event => updateRisk({ maxLossAtr: Number(event.target.value) || 0 })} />
                </label>
                <label className="flex items-center gap-2 text-[10px] uppercase text-muted"><input type="checkbox" checked={risk.requireMarketOpen} onChange={event => updateRisk({ requireMarketOpen: event.target.checked })} /> RTH required</label>
              </div>
            </div>
            <div className="rounded border border-surface-border bg-surface-card p-2">
              <div className="mb-2 font-mono text-[10px] font-black uppercase text-accent">Exit / Order Policy</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[10px] uppercase text-muted">
                  Cover Ticks
                  <input type="number" className="input-field mt-1 w-full py-1 text-[11px]" value={exitPolicy.coverTicksFromFill} onChange={event => updateExitPolicy({ coverTicksFromFill: Number(event.target.value) || 0 })} />
                </label>
                <label className="text-[10px] uppercase text-muted">
                  Stop Ticks
                  <input type="number" className="input-field mt-1 w-full py-1 text-[11px]" value={exitPolicy.stopTicksFromEntry} onChange={event => updateExitPolicy({ stopTicksFromEntry: Number(event.target.value) || 0 })} />
                </label>
                <label className="col-span-2 text-[10px] uppercase text-muted">
                  Price Reference
                  <input className="input-field mt-1 w-full py-1 text-[11px]" value={orderPolicy.priceReference} onChange={event => updateOrderPolicy({ priceReference: event.target.value })} />
                </label>
                <label className="flex items-center gap-2 text-[10px] uppercase text-muted"><input type="checkbox" checked={orderPolicy.doNotCrossInside} onChange={event => updateOrderPolicy({ doNotCrossInside: event.target.checked })} /> Do not cross</label>
                <label className="flex items-center gap-2 text-[10px] uppercase text-muted"><input type="checkbox" checked={exitPolicy.oco} onChange={event => updateExitPolicy({ oco: event.target.checked })} /> OCO cover</label>
              </div>
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button className="btn-neutral py-2 text-[11px] font-bold" onClick={() => saveDraft('held')}>Stage Held</button>
            <button className="btn-accent py-2 text-[11px] font-bold" onClick={() => saveDraft('held')}>Save to Manager</button>
          </div>
        </div>
        <div className="rounded border border-surface-border bg-surface-card p-2 font-mono">
          <div className="text-[10px] font-black uppercase text-accent">Deployment Contract</div>
          <div className="mt-2 grid grid-cols-2 gap-y-1 text-[10px]">
            <span className="text-muted">Send Peg</span><span className="text-right font-black text-slate-100">Linear Regression lookback {entryPeg.lookback ? `${entryPeg.lookback}` : 'X'} +/-{entryPeg.standardDeviations}</span>
            <span className="text-muted">Order Type</span><span className="text-right font-black text-slate-100">{sniperMode ? 'Sniper' : 'Limit'}</span>
            <span className="text-muted">Lookback</span><span className="text-right font-black text-slate-100">{entryPeg.lookback ? `${entryPeg.lookback} bars` : 'Required'}</span>
            <span className="text-muted">Layers</span><span className="text-right font-black text-slate-100">{layerPlan.layerCount}</span>
            <span className="text-muted">Spacing</span><span className="text-right font-black text-slate-100">{layerPlan.layerSpacingTicks} ticks</span>
            <span className="text-muted">Clip</span><span className="text-right font-black text-slate-100">{draft.clipSize}</span>
            <span className="text-muted">Max/Side</span><span className="text-right font-black text-slate-100">{draft.maxPosition}</span>
          </div>
          <div className="mt-2 text-[9px] leading-relaxed text-muted">
            Server deploy reads the saved definition, resolves its linear-regression send peg, and sends only valid orders.
          </div>
        </div>
      </div>
    </div>
  )
}

type AlgoDeploymentOrder = {
  side: 'bid' | 'offer'
  price: number
  size: number
  layer: number
  trigger: string
  coverTicksFromFill: number
  coverTickSize: number
}

type AlgoDeploymentBuildResult = {
  orders: AlgoDeploymentOrder[]
  missingSendPrices: string[]
}

type RegressionBandValues = {
  mean?: number
  upper?: number
  lower?: number
  sigma?: number
  slope?: number
  interval?: string
  lookback?: number
  updatedAt?: number
  label: string
}

type RegressionStudySnapshot = {
  ok: boolean
  runtime?: string
  source?: string
  study?: string
  symbol: string
  interval: string
  lookback: number
  standardDeviations: number
  bars: number
  includesLiveMark: boolean
  updatedAt: number
  mean?: number
  upper?: number
  lower?: number
  sigma?: number
  slope?: number
  intercept?: number
  label?: string
  error?: string
}

function finiteOptional(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizedLookback(value: unknown, minimum = 2, maximum = 2000): number | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  const lookback = Math.floor(parsed)
  if (lookback < minimum) return null
  return Math.min(maximum, lookback)
}

function regressionBandsForPeg(stat: CeriousSpreadStat | undefined, lookback: number | undefined, deviations: number): RegressionBandValues | null {
  const requestedLookback = normalizedLookback(lookback)
  if (requestedLookback === null) return null
  const statLookback = Math.floor(Number(stat?.linearRegressionLookback) || 0)
  const std = Math.max(0, Number(deviations) || 2)
  if (statLookback > 0 && statLookback !== requestedLookback) return null
  const mean = finiteOptional(stat?.linearRegressionMean)
  const upper = finiteOptional(stat?.linearRegressionUpper)
  const lower = finiteOptional(stat?.linearRegressionLower)
  if (upper === undefined || lower === undefined) return null
  const interval = stat?.linearRegressionInterval || '30m'
  return {
    mean,
    upper,
    lower,
    sigma: finiteOptional(stat?.linearRegressionSigma),
    slope: finiteOptional(stat?.linearRegressionSlope),
    interval,
    lookback: requestedLookback,
    updatedAt: finiteOptional(stat?.linearRegressionUpdatedAt),
    label: `Linear Regression lookback ${requestedLookback} ${interval} +/-${std}`,
  }
}

function regressionStudyKey(symbol: string, interval: string, lookback: number, standardDeviations: number) {
  const normalized = normalizedLookback(lookback)
  if (normalized === null) throw new Error('regression lookback is not defined')
  return `${normalizeProductKey(symbol)}|${String(interval || '30m').toLowerCase()}|${normalized}|${Number(standardDeviations || 2).toFixed(4)}`
}

async function fetchRegressionStudySnapshot(
  symbol: string,
  interval: string,
  lookback: number,
  standardDeviations: number,
  signal?: AbortSignal,
): Promise<RegressionStudySnapshot> {
  const normalized = normalizedLookback(lookback)
  if (normalized === null) throw new Error('regression lookback is not defined')
  const params = new URLSearchParams({
    interval: String(interval || '30m'),
    lookback: String(normalized),
    stdDev: String(Number(standardDeviations || 2)),
  })
  const response = await ceriousFetch(`/api/studies/regression/${encodeURIComponent(normalizeProductKey(symbol))}?${params.toString()}`, {
    cache: 'no-store',
    signal,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(String(payload.detail || payload.error || `HTTP ${response.status}`))
  }
  return payload as RegressionStudySnapshot
}

function regressionBandsFromSnapshot(snapshot: RegressionStudySnapshot | undefined): RegressionBandValues | null {
  if (!snapshot?.ok) return null
  const mean = finiteOptional(snapshot.mean)
  const upper = finiteOptional(snapshot.upper)
  const lower = finiteOptional(snapshot.lower)
  if (upper === undefined || lower === undefined) return null
  const lookback = normalizedLookback(snapshot.lookback)
  if (lookback === null) return null
  const std = Math.max(0, Number(snapshot.standardDeviations) || 2)
  return {
    mean,
    upper,
    lower,
    sigma: finiteOptional(snapshot.sigma),
    slope: finiteOptional(snapshot.slope),
    interval: snapshot.interval,
    lookback,
    updatedAt: finiteOptional(snapshot.updatedAt),
    label: snapshot.label || `Linear Regression lookback ${lookback} ${snapshot.interval || '30m'} +/-${std}`,
  }
}

function algoUsesRegressionPeg(algo: AlgoDefinition, entryPeg: AlgoEntryPeg): boolean {
  const source = [
    entryPeg.source,
    entryPeg.lookback,
    algo.orderPolicy?.priceReference,
    ...(algo.signalRules ?? []).map(rule => `${rule.field} ${rule.action}`),
  ].join(' ').toLowerCase()
  return source.includes('regression')
    || source.includes('least-squares')
    || source.includes('rls')
    || source.includes('band')
}

function resolveAlgoSendBands(
  algo: AlgoDefinition,
  entryPeg: AlgoEntryPeg,
  spreadStat: CeriousSpreadStat | undefined,
  studySnapshot?: RegressionStudySnapshot,
): RegressionBandValues | null {
  if (!algoUsesRegressionPeg(algo, entryPeg)) return null
  const snapshotBands = regressionBandsFromSnapshot(studySnapshot)
  if (snapshotBands) return snapshotBands
  return regressionBandsForPeg(spreadStat, entryPeg.lookback, entryPeg.standardDeviations)
}

function algoRegressionStudyRequest(algo: AlgoDefinition, option?: ProductOption) {
  const symbol = resolveAlgoMarketKey(algo, option)
  const ceriousFields = normalizeCeriousFields(algo, symbol)
  const entryPeg = algo.entryPeg ?? ceriousFields.entryPeg
  if (!algoUsesRegressionPeg(algo, entryPeg)) return null
  const interval = String(entryPeg.interval ?? entryPeg.timeframe ?? '30m').toLowerCase()
  const lookback = normalizedLookback(entryPeg.lookback)
  if (lookback === null) return null
  const standardDeviations = Math.max(0, Number(entryPeg.standardDeviations) || 2)
  return {
    key: regressionStudyKey(symbol, interval, lookback, standardDeviations),
    symbol,
    interval,
    lookback,
    standardDeviations,
  }
}

function buildAlgoDeploymentOrders(
  algo: AlgoDefinition,
  option: ProductOption | undefined,
  spreadStat?: CeriousSpreadStat,
  studySnapshot?: RegressionStudySnapshot,
): AlgoDeploymentBuildResult {
  const symbol = resolveAlgoMarketKey(algo, option)
  const ceriousFields = normalizeCeriousFields(algo, symbol)
  const layerPlan = algo.layerPlan ?? ceriousFields.layerPlan
  const entryPeg = algo.entryPeg ?? ceriousFields.entryPeg
  const exitPolicy = algo.exitPolicy ?? ceriousFields.exitPolicy
  const tick = finiteDepthPrice(option?.tickSize)
  if (tick === undefined || tick <= 0) return { orders: [], missingSendPrices: [`${algo.name}: product tick size missing`] }
  const requestedLookback = normalizedLookback(entryPeg.lookback)
  if (algoUsesRegressionPeg(algo, entryPeg) && requestedLookback === null) {
    return { orders: [], missingSendPrices: [`${algo.name}: regression lookback is not defined`] }
  }
  const pegBands = resolveAlgoSendBands(algo, entryPeg, spreadStat, studySnapshot)
  const layers = clamp(Math.floor(Number(layerPlan.layerCount) || 1), 1, 100)
  const spacingTicks = Number(layerPlan.layerSpacingTicks) || 0
  const size = Math.max(1, Number(algo.clipSize) || 1)
  const sides: Array<'bid' | 'offer'> = []
  if ((algo.side === 'both' || algo.side === 'bid') && layerPlan.workBuySide !== false) sides.push('bid')
  if ((algo.side === 'both' || algo.side === 'offer') && layerPlan.workSellSide !== false) sides.push('offer')
  const buyBase = pegBands?.lower
  const sellBase = pegBands?.upper
  const missingSendPrices: string[] = []
  if (sides.includes('bid') && buyBase === undefined) {
    missingSendPrices.push(`${algo.name}: buy send peg ${entryPeg.source} -${entryPeg.standardDeviations} not published`)
  }
  if (sides.includes('offer') && sellBase === undefined) {
    missingSendPrices.push(`${algo.name}: sell send peg ${entryPeg.source} +${entryPeg.standardDeviations} not published`)
  }
  const orders: AlgoDeploymentOrder[] = []
  for (let layer = 0; layer < layers; layer += 1) {
    const layerOffset = layer * spacingTicks
    if (sides.includes('bid') && buyBase !== undefined) {
      orders.push({
        side: 'bid',
        price: roundToTick(buyBase - (layerOffset * tick), tick),
        size,
        layer: layer + 1,
        trigger: `${pegBands?.label ?? `Linear Regression lookback ${requestedLookback ?? ''}`.trim()} lower`,
        coverTicksFromFill: Number(exitPolicy.coverTicksFromFill) || 0,
        coverTickSize: tick,
      })
    }
    if (sides.includes('offer') && sellBase !== undefined) {
      orders.push({
        side: 'offer',
        price: roundToTick(sellBase + (layerOffset * tick), tick),
        size,
        layer: layer + 1,
        trigger: `${pegBands?.label ?? `Linear Regression lookback ${requestedLookback ?? ''}`.trim()} upper`,
        coverTicksFromFill: Number(exitPolicy.coverTicksFromFill) || 0,
        coverTickSize: tick,
      })
    }
  }
  return { orders, missingSendPrices }
}

function AlgoManagerWindow() {
  const { algos, updateAlgo, removeAlgo } = useAlgoLibrary()
  const options = useProductOptions()
  const intelligence = useCeriousIntelligence(30000)
  const simOrders = useStore(s => s.simOrders)
  const initialManagerState = useMemo(loadAlgoManagerWorkspaceState, [])
  const [statusFilter, setStatusFilter] = useState<AlgoStatus | 'all'>(initialManagerState.statusFilter ?? 'all')
  const [algoToLoad, setAlgoToLoad] = useState('')
  const [stagedAlgoIds, setStagedAlgoIds] = useState<string[]>([])
  const [selectedDeployIds, setSelectedDeployIds] = useState<string[]>([])
  const [deployStatus, setDeployStatus] = useState(initialManagerState.deployStatus ?? '')
  const [deploying, setDeploying] = useState(false)
  const [regressionSnapshots, setRegressionSnapshots] = useState<Record<string, RegressionStudySnapshot>>({})
  const activeAlgoOrderCount = simOrders.filter(order => (
    order.source === 'algo'
    && order.remaining > 0
    && (order.status === 'working' || order.status === 'partially_filled')
  )).length
  const filtered = algos.filter(algo => statusFilter === 'all' || algo.status === statusFilter)
  const stagedAlgos = stagedAlgoIds
    .map(id => algos.find(algo => algo.id === id))
    .filter((algo): algo is AlgoDefinition => !!algo)
  const spreadStatsByKey = useMemo(() => {
    const map = new Map<string, CeriousSpreadStat>()
    ;(intelligence?.spreadPack?.spreads ?? []).forEach(stat => {
      map.set(String(stat.key).toUpperCase(), stat)
    })
    return map
  }, [intelligence?.spreadPack?.spreads])
  const stagedStudyRequests = useMemo(() => {
    const requests = new Map<string, NonNullable<ReturnType<typeof algoRegressionStudyRequest>>>()
    stagedAlgos.forEach(algo => {
      const option = findProductOptionForAlgo(options, algo)
      const request = algoRegressionStudyRequest(algo, option)
      if (request) requests.set(request.key, request)
    })
    return [...requests.values()]
  }, [options, stagedAlgos])
  const stagedStudyRequestKey = stagedStudyRequests.map(request => request.key).sort().join('|')
  const counts = algos.reduce<Record<AlgoStatus, number>>((acc, algo) => {
    acc[algo.status] += 1
    return acc
  }, { draft: 0, held: 0, quoting: 0, paused: 0 })
  useEffect(() => {
    if (!stagedStudyRequests.length) {
      setRegressionSnapshots({})
      return
    }
    const controller = new AbortController()
    let cancelled = false
    Promise.all(stagedStudyRequests.map(async request => {
      try {
        const snapshot = await fetchRegressionStudySnapshot(
          request.symbol,
          request.interval,
          request.lookback,
          request.standardDeviations,
          controller.signal,
        )
        return [request.key, snapshot] as const
      } catch (err) {
        const snapshot: RegressionStudySnapshot = {
          ok: false,
          symbol: request.symbol,
          interval: request.interval,
          lookback: request.lookback,
          standardDeviations: request.standardDeviations,
          bars: 0,
          includesLiveMark: false,
          updatedAt: 0,
          error: err instanceof Error ? err.message : 'regression unavailable',
        }
        return [request.key, snapshot] as const
      }
    })).then(entries => {
      if (cancelled) return
      setRegressionSnapshots(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [stagedStudyRequestKey])
  useEffect(() => {
    saveAlgoManagerWorkspaceState({
      stagedAlgoIds,
      selectedDeployIds,
      statusFilter,
      deployStatus: '',
      updatedAt: Date.now(),
    })
  }, [selectedDeployIds, stagedAlgoIds, statusFilter])
  useEffect(() => {
    const sync = () => {
      const next = loadAlgoManagerWorkspaceState()
      setStatusFilter(next.statusFilter ?? 'all')
      setStagedAlgoIds([])
      setSelectedDeployIds([])
      setDeployStatus(next.deployStatus ?? '')
    }
    window.addEventListener(ALGO_MANAGER_STATE_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(ALGO_MANAGER_STATE_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  const loadAlgo = () => {
    if (!algoToLoad) return
    setStagedAlgoIds(current => current.includes(algoToLoad) ? current : [...current, algoToLoad])
    setSelectedDeployIds(current => current.includes(algoToLoad) ? current : [...current, algoToLoad])
    setAlgoToLoad('')
  }
  const toggleDeploySelection = (id: string) => {
    setSelectedDeployIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
  }
  const deployAlgoDefinitions = async (selected: AlgoDefinition[]) => {
    if (!selected.length) {
      setDeployStatus('Select algo rows to deploy')
      return 0
    }
    setDeploying(true)
    try {
      setDeployStatus('Deploying selected algos...')
      const response = await ceriousFetch('/api/algo-manager/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algoIds: selected.map(algo => algo.id) }),
      })
      const payload = await response.json().catch(() => ({}))
      if (payload.state) {
        useStore.getState().setSimTradingState({
          simOrders: payload.state.simOrders,
          simPositions: payload.state.simPositions,
          fills: payload.state.fills,
          simMessages: payload.state.simMessages,
        })
      }
      if (!response.ok || !payload.ok) {
        const errors = Array.isArray(payload.errors) ? payload.errors : []
        const detail = payload.detail || errors.slice(0, 2).join(' | ') || `HTTP ${response.status}`
        setDeployStatus(`DEPLOY ERROR: ${detail}${errors.length > 2 ? ` (+${errors.length - 2} more)` : ''}`)
        return 0
      }
      selected.forEach(algo => updateAlgo(algo.id, { status: 'quoting' }))
      const accepted = Number(payload.acceptedCount ?? 0)
      const notes = Array.isArray(payload.notes) ? payload.notes.filter(Boolean) : []
      setDeployStatus(`Released ${accepted} algo order${accepted === 1 ? '' : 's'} from server study engine.${notes.length ? ` ${notes[0]}` : ''}`)
      return accepted
    } catch (err) {
      setDeployStatus(`DEPLOY ERROR: ${err instanceof Error ? err.message : 'deployment failed'}`)
      return 0
    } finally {
      setDeploying(false)
    }
  }
  const deploySelected = () => {
    const selected = stagedAlgos.filter(algo => selectedDeployIds.includes(algo.id))
    void deployAlgoDefinitions(selected)
  }
  const killAllAlgos = async () => {
    const pausedCount = algos.filter(algo => algo.status !== 'draft').length
    try {
      const response = await ceriousFetch('/api/cerious/orders/cancel-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'algo' }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload.ok) {
        throw new Error(String(payload.detail || payload.message || `HTTP ${response.status}`))
      }
      if (payload.state) {
        useStore.getState().setSimTradingState({
          simOrders: payload.state.simOrders,
          simPositions: payload.state.simPositions,
          fills: payload.state.fills,
          simMessages: payload.state.simMessages,
        })
      }
    } catch (err) {
      setDeployStatus(`KILL ALL FAILED: ${err instanceof Error ? err.message : 'gateway unavailable'}`)
      return
    }
    algos.forEach(algo => {
      if (algo.status !== 'draft') updateAlgo(algo.id, { status: 'paused' })
    })
    setStagedAlgoIds([])
    setSelectedDeployIds([])
    setDeployStatus(`KILL ALL: paused ${pausedCount} algo${pausedCount === 1 ? '' : 's'} and cancelled ${activeAlgoOrderCount} working algo order${activeAlgoOrderCount === 1 ? '' : 's'}.`)
  }

  return (
    <div className="flex h-full flex-col bg-surface text-xs">
      <div className="grid grid-cols-[1fr_auto_120px] gap-2 border-b border-surface-border bg-surface-panel p-2">
        <div className="grid grid-cols-4 gap-1 font-mono text-[10px]">
          {(['held', 'quoting', 'paused', 'draft'] as AlgoStatus[]).map(status => (
            <div key={status} className="rounded border border-surface-border bg-surface-card px-2 py-1">
              <span className="text-muted">{status}</span>
              <span className="float-right font-black text-slate-100">{counts[status]}</span>
            </div>
          ))}
        </div>
        <button
          className="flex items-center gap-2 rounded border border-red-300 bg-red-600 px-3 py-1 text-[11px] font-black uppercase tracking-wide text-white shadow-[0_0_18px_rgba(239,68,68,0.45)] hover:bg-red-500"
          onClick={killAllAlgos}
          title="Emergency stop all algo logic and cancel all working algo orders from the shared order book"
        >
          <AlertTriangle size={14} /> Kill All
        </button>
        <select className="input-field py-1 text-[11px]" value={statusFilter} onChange={event => setStatusFilter(event.target.value as AlgoStatus | 'all')}>
          <option value="all">All status</option>
          <option value="held">Held</option>
          <option value="quoting">Quoting</option>
          <option value="paused">Paused</option>
          <option value="draft">Draft</option>
        </select>
      </div>
      <div className="border-b border-surface-border bg-[#08101b] p-2">
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2">
          <select className="input-field py-1 text-[11px]" value={algoToLoad} onChange={event => setAlgoToLoad(event.target.value)}>
            <option value="">Select algo to load...</option>
            {algos.map(algo => <option key={algo.id} value={algo.id}>{algo.name} / {algo.symbol} / {algo.status}</option>)}
          </select>
          <button className="btn-neutral px-2 py-1 text-[11px] font-bold" onClick={loadAlgo}>Load Row</button>
          <button className="btn-accent px-3 py-1 text-[11px] font-black" onClick={deploySelected} disabled={deploying}>{deploying ? 'Deploying...' : 'Deploy Selected'}</button>
          <button className="btn-neutral px-2 py-1 text-[11px]" onClick={() => { setStagedAlgoIds([]); setSelectedDeployIds([]) }}>Clear</button>
        </div>
        <div className="mt-2 grid grid-cols-[26px_1fr_80px_66px_58px_58px_76px_70px_70px] border border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] font-bold uppercase text-muted">
          <span />
          <span>Deploy Queue</span>
          <span>Product</span>
          <span>Side</span>
          <span className="text-right" title="Order rows or bands layered off the market">Layers</span>
          <span className="text-right">Rules</span>
          <span className="text-right">First Bid</span>
          <span className="text-right">First Ask</span>
          <span className="text-right" title="Contracts per order ticket">Clip</span>
        </div>
        <div className="max-h-40 overflow-y-auto border-x border-b border-surface-border">
          {stagedAlgos.map(algo => {
            const option = findProductOptionForAlgo(options, algo)
            const marketKey = resolveAlgoMarketKey(algo, option)
            const studyRequest = algoRegressionStudyRequest(algo, option)
            const deploymentBuild = buildAlgoDeploymentOrders(algo, option, spreadStatsByKey.get(marketKey), studyRequest ? regressionSnapshots[studyRequest.key] : undefined)
            const firstBid = deploymentBuild.orders.find(order => order.side === 'bid')
            const firstAsk = deploymentBuild.orders.find(order => order.side === 'offer')
            const activeRules = (algo.signalRules ?? []).filter(rule => rule.enabled).length
            const layerCount = algo.layerPlan?.layerCount ?? deploymentBuild.orders.reduce((max, order) => Math.max(max, order.layer), 0)
            return (
              <label key={algo.id} className="grid cursor-pointer grid-cols-[26px_1fr_80px_66px_58px_58px_76px_70px_70px] items-center gap-1 border-b border-surface-border/50 px-2 py-1.5 font-mono text-[10px] hover:bg-surface-hover">
                <input type="checkbox" checked={selectedDeployIds.includes(algo.id)} onChange={() => toggleDeploySelection(algo.id)} />
                <span className="truncate font-black text-slate-100">{algo.name}</span>
                <span className="truncate text-accent">{algo.symbol}</span>
                <span className="uppercase text-slate-300">{algo.side}</span>
                <span className="text-right text-slate-200">{layerCount}</span>
                <span className="text-right text-slate-200">{activeRules}</span>
                <span className="text-right text-blue-300">{firstBid ? fmtNum(firstBid.price, Math.abs(firstBid.price) > 100 ? 2 : 3) : '-'}</span>
                <span className="text-right text-red-300">{firstAsk ? fmtNum(firstAsk.price, Math.abs(firstAsk.price) > 100 ? 2 : 3) : '-'}</span>
                <span className="text-right text-slate-100">{algo.clipSize}</span>
              </label>
            )
          })}
          {stagedAlgos.length === 0 && <div className="p-3 text-center font-mono text-[10px] text-muted">Load algos here, select rows, then deploy them together.</div>}
        </div>
        <div className={cx('mt-1 h-4 font-mono text-[10px]', deployStatus ? 'text-accent' : 'text-muted')}>{deployStatus || `${selectedDeployIds.length} selected for release`}</div>
      </div>
      <div className="grid grid-cols-[1.2fr_82px_82px_70px_74px_76px_108px] border-b border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] font-bold uppercase text-muted">
        <span>Algo</span><span>Product</span><span>Template</span><span>Status</span><span className="text-right" title="Contracts per order ticket">Clip</span><span className="text-right" title="Per-side cap in synthetic spread units">Max Pos/Side</span><span className="text-right">Controls</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.map(algo => (
          <div key={algo.id} className="grid grid-cols-[1.2fr_82px_82px_70px_74px_76px_108px] items-center gap-1 border-b border-surface-border/50 px-2 py-1.5 font-mono text-[10px]">
            <div className="min-w-0">
              <div className="truncate font-black text-slate-100">{algo.name}</div>
              <div className="truncate text-[9px] text-muted">{algo.operator}</div>
            </div>
            <span className="truncate text-accent">{algo.symbol}</span>
            <span className="truncate text-slate-300">{algoTemplateLabel(algo.template)}</span>
            <span className={cx('font-black uppercase', algo.status === 'quoting' ? 'text-up' : algo.status === 'held' ? 'text-warn' : 'text-muted')}>{algo.status}</span>
            <span className="text-right text-slate-200">{algo.clipSize}</span>
            <span className="text-right text-slate-200">{algo.maxPosition}</span>
            <div className="flex justify-end gap-1">
              <button className="rounded border border-up/40 px-1 py-0.5 text-up disabled:opacity-50" disabled={deploying} onClick={() => { void deployAlgoDefinitions([algo]) }}>Run</button>
              <button className="rounded border border-warn/40 px-1 py-0.5 text-warn" onClick={() => updateAlgo(algo.id, { status: 'held' })}>Hold</button>
              <button className="rounded border border-down/40 px-1 py-0.5 text-down" onClick={() => removeAlgo(algo.id)}>Del</button>
            </div>
          </div>
        ))}
        {filtered.length === 0 && <div className="p-4 text-center text-muted">No algos staged yet. Add one from Algo Builder.</div>}
      </div>
    </div>
  )
}

function LiquidityMapWindow() {
  const [providerFilter, setProviderFilter] = useState<ProviderKey | 'all'>('all')
  const [minVolume, setMinVolume] = useState(0)
  const rawOptions = useProductOptions()
  const cryptoPrices = useStore(s => s.cryptoPrices)
  const polyBooks = useStore(s => s.polyBooks)
  const polyTicks = useStore(s => s.polyTicks)
  const fills = useStore(s => s.fills)
  const options = useMemo(() => mappedLiquidityProducts(rawOptions, cryptoPrices), [cryptoPrices, rawOptions])

  const rows = useMemo(() => {
    const enriched = options.map(option => {
      const book = option.marketKey ? polyBooks[option.marketKey] : undefined
      const ticks = option.marketKey ? (polyTicks[option.marketKey] ?? []) : []
      const fillRows = option.marketKey ? (fills[option.marketKey] ?? []) : []
      const bidDepth = book ? book.bids.reduce((sum, level) => sum + level.size, 0) : 0
      const askDepth = book ? book.asks.reduce((sum, level) => sum + level.size, 0) : 0
      const bookDepth = bidDepth + askDepth
      const bookNotional = book
        ? [...book.bids, ...book.asks].reduce((sum, level) => sum + level.size * level.price, 0)
        : 0
      const tapeVolume = option.marketKey
        ? ticks.reduce((sum, tick) => sum + (tick.price / 100) * tick.size, 0)
        : 0
      const tapeContracts = ticks.reduce((sum, tick) => sum + tick.size, 0)
      const fillVolume = option.marketKey
        ? fillRows.reduce((sum, tick) => sum + (tick.price / 100) * tick.size, 0)
        : 0
      const fillContracts = fillRows.reduce((sum, tick) => sum + tick.size, 0)
      const providerVolume = option.volume ?? 0
      const activity = providerVolume + tapeVolume + fillVolume
      const oiProxy = option.openInterest ?? bookNotional + fillVolume + Math.max(activity * 0.18, 0)
      const spread = book?.spread_pct ?? (option.live
        ? option.provider === 'hyperliquid'
          ? 0.02
          : Math.max(0.5, 8 - Math.log10(Math.max(activity, 1)))
        : undefined)
      const hasQuote = option.spot !== undefined || option.yes !== undefined || book?.mid !== undefined
      const hasVenueData = providerVolume > 0 || !!book || ticks.length > 0 || fillRows.length > 0
      const feedState = hasVenueData ? 'live' : hasQuote || option.live ? 'partial' : 'awaiting'
      const last = option.spot ?? option.yes ?? (book?.mid !== undefined ? book.mid * 100 : undefined)
      const dataFields = [
        providerVolume > 0,
        oiProxy > 0,
        bookDepth > 0,
        tapeContracts > 0,
        fillContracts > 0,
        spread !== undefined,
        last !== undefined,
      ].filter(Boolean).length
      const liquidityScore = clamp(
        Math.log10(activity + 1) * 16
        + Math.log10(oiProxy + 1) * 10
        + Math.log10(bookDepth + 1) * 8
        + Math.log10(tapeContracts + 1) * 5
        + dataFields * 3
        + (feedState === 'live' ? 10 : feedState === 'partial' ? 3 : 0)
        - (spread ?? 10) * 1.25,
        0,
        100,
      )
      return {
        option,
        activity,
        providerVolume,
        oiProxy,
        spread,
        bookDepth,
        bidDepth,
        askDepth,
        tapeContracts,
        fillContracts,
        fillVolume,
        dataFields,
        feedState,
        last,
        liquidityScore,
      }
    })
    return enriched
      .filter(row => providerFilter === 'all' || row.option.provider === providerFilter)
      .filter(row => row.activity >= minVolume)
      .sort((a, b) => b.liquidityScore - a.liquidityScore)
  }, [fills, minVolume, options, polyBooks, polyTicks, providerFilter])

  const providerStats = useMemo(() => PROVIDERS.map(provider => {
    const providerRows = rows.filter(row => row.option.provider === provider.key)
    return {
      provider,
      rows: providerRows.length,
      live: providerRows.filter(row => row.feedState === 'live').length,
      partial: providerRows.filter(row => row.feedState === 'partial').length,
      awaiting: providerRows.filter(row => row.feedState === 'awaiting').length,
      activity: providerRows.reduce((sum, row) => sum + row.activity, 0),
    }
  }), [rows])

  const maxVolume = Math.max(1, ...rows.map(row => row.activity))
  const maxOi = Math.max(1, ...rows.map(row => row.oiProxy))
  const maxDepth = Math.max(1, ...rows.map(row => row.bookDepth))

  return (
    <div className="flex h-full flex-col bg-surface text-xs">
      <div className="border-b border-surface-border bg-surface-panel p-2">
        <div className="mb-2 flex items-center gap-2">
          <SlidersHorizontal size={14} className="text-accent" />
          <div className="text-[10px] text-muted">All mapped venues: volume, OI proxy, book depth, tape, fills, spread, and feed coverage.</div>
        </div>
        <div className="mb-2 grid grid-cols-5 gap-1">
          {providerStats.map(stat => (
            <div key={stat.provider.key} className="rounded border border-surface-border bg-surface-card px-2 py-1 font-mono">
              <div className="truncate text-[9px] font-black uppercase" style={{ color: PROVIDER_COLORS[stat.provider.key] }}>{stat.provider.label}</div>
              <div className="mt-0.5 flex justify-between text-[9px] text-muted">
                <span>{stat.rows} rows</span>
                <span>{stat.live}/{stat.partial}/{stat.awaiting}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-[1fr_130px] gap-2">
          <select value={providerFilter} onChange={event => setProviderFilter(event.target.value as ProviderKey | 'all')} className="input-field py-1 text-[11px]">
            <option value="all">All venues</option>
            {PROVIDERS.map(provider => <option key={provider.key} value={provider.key}>{provider.label}</option>)}
          </select>
          <input
            type="number"
            value={minVolume}
            onChange={event => setMinVolume(Math.max(0, Number(event.target.value) || 0))}
            className="input-field py-1 text-[11px]"
            title="Minimum activity"
          />
        </div>
      </div>
      <div className="grid grid-cols-[28px_88px_1.35fr_72px_78px_78px_70px_58px_58px_60px_58px] border-b border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] font-bold uppercase text-muted">
        <span>#</span>
        <span>Venue</span>
        <span>Contract</span>
        <span className="text-right">Last</span>
        <span className="text-right">Volume</span>
        <span className="text-right">OI</span>
        <span className="text-right">Depth</span>
        <span className="text-right">Tape</span>
        <span className="text-right">Fills</span>
        <span className="text-right">Spread</span>
        <span className="text-right">Score</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.map((row, index) => (
          <div key={`${row.option.provider}-${row.option.symbol}`} className="grid grid-cols-[28px_88px_1.35fr_72px_78px_78px_70px_58px_58px_60px_58px] items-center gap-1 border-b border-surface-border/50 px-2 py-1.5 font-mono">
            <span className="text-muted">{index + 1}</span>
            <div className="min-w-0">
              <div className="truncate font-bold" style={{ color: PROVIDER_COLORS[row.option.provider] }}>{providerLabel(row.option.provider)}</div>
              <div className={cx('text-[8px] uppercase', row.feedState === 'live' ? 'text-up' : row.feedState === 'partial' ? 'text-warn' : 'text-muted')}>{row.feedState}</div>
            </div>
            <div className="min-w-0">
              <div className="truncate font-bold text-slate-100">{row.option.label}</div>
              <div className="truncate text-[9px] text-muted">{row.option.subtitle}</div>
              <div className="mt-1 grid grid-cols-3 gap-1">
                <div className="h-1 overflow-hidden rounded bg-surface-card"><div className="h-full bg-accent" style={{ width: `${(row.activity / maxVolume) * 100}%` }} /></div>
                <div className="h-1 overflow-hidden rounded bg-surface-card"><div className="h-full bg-warn" style={{ width: `${(row.oiProxy / maxOi) * 100}%` }} /></div>
                <div className="h-1 overflow-hidden rounded bg-surface-card"><div className="h-full bg-up" style={{ width: `${(row.bookDepth / maxDepth) * 100}%` }} /></div>
              </div>
            </div>
            <span className="text-right text-slate-200">{row.option.provider === 'cme' ? (Number.isFinite(row.last) ? fmtLadderPrice(Number(row.last)) : '-') : row.option.provider === 'hyperliquid' ? fmtMoney(row.last) : fmtCents(row.last)}</span>
            <span className="text-right text-slate-200">{fmtMoney(row.activity)}</span>
            <span className="text-right text-slate-200">{fmtMoney(row.oiProxy)}</span>
            <span className="text-right text-slate-200" title={`Bid depth ${fmtCompact(row.bidDepth)} / Ask depth ${fmtCompact(row.askDepth)}`}>{fmtCompact(row.bookDepth)}</span>
            <span className="text-right text-slate-200">{fmtCompact(row.tapeContracts)}</span>
            <span className="text-right text-slate-200">{fmtCompact(row.fillContracts)}</span>
            <span className="text-right text-muted">{row.spread === undefined ? '-' : `${row.spread.toFixed(row.spread < 1 ? 2 : 1)}`}</span>
            <span className={cx('text-right font-black', row.liquidityScore > 70 ? 'text-up' : row.liquidityScore > 45 ? 'text-warn' : 'text-muted')}>
              {row.liquidityScore.toFixed(0)}
            </span>
          </div>
        ))}
        {rows.length === 0 && <div className="p-4 text-center text-muted">No contracts match this liquidity filter.</div>}
      </div>
    </div>
  )
}

function AlertsWindow({
  alerts,
  setAlerts,
}: {
  alerts: AlertRule[]
  setAlerts: Dispatch<SetStateAction<AlertRule[]>>
}) {
  const options = useProductOptions()
  const markets = useStore(s => s.markets)
  const polyTicks = useStore(s => s.polyTicks)
  const fills = useStore(s => s.fills)
  const [deliveryStatus, setDeliveryStatus] = useState<Record<string, AlertDeliveryStatus>>({})
  const [smsStatus, setSmsStatus] = useState<SmsAlertStatus | null>(null)

  const defaultOption = options.find(option => option.provider === 'cme' && option.symbol === 'ES') ?? options[0]

  useEffect(() => {
    let cancelled = false
    void fetchSmsAlertStatus().then(status => {
      if (!cancelled) setSmsStatus(status)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const smsStatusLabel = useMemo(() => {
    if (!smsStatus) return 'SMS checking'
    if (!smsStatus.ready) return 'SMS not configured'
    if (smsStatus.dryRun) return 'SMS dry-run ready'
    return `SMS ${smsStatus.provider ?? 'transport'} ready`
  }, [smsStatus])

  const isMoneyProduct = (option: ProductOption | undefined) => option?.provider !== 'cme' && option?.spot !== undefined

  const findOption = (alert: AlertRule) => {
    const provider = normalizeProviderKey(alert.provider)
    const symbol = alert.productSymbol
      ?? options.find(option => option.provider === provider && option.asset === alert.symbol)?.symbol
    return options.find(option => option.provider === provider && option.symbol === symbol)
      ?? options.find(option => option.asset === alert.symbol && option.provider === provider)
      ?? defaultOption
  }

  const normalizeThreshold = (alert: AlertRule, moneyProduct: boolean) => {
    if (moneyProduct) return alert.value
    if (alert.valueMode === 'price') return alert.value
    if (alert.valueMode === 'cents') return alert.value <= 1 ? alert.value * 100 : alert.value
    return alert.value
  }

  const formatThreshold = (alert: AlertRule, moneyProduct: boolean) => {
    if (moneyProduct) return fmtMoney(alert.value)
    if (alert.valueMode === 'price') return fmtLadderPrice(alert.value)
    if (alert.valueMode === 'cents') return alert.value <= 1 ? `$${alert.value.toFixed(2)}` : `${alert.value.toFixed(1)}c`
    return `${alert.value.toFixed(1)}%`
  }

  const compare = (actual: number | undefined, alert: AlertRule, threshold: number) => {
    if (actual === undefined || Number.isNaN(actual)) return false
    if (alert.op === '>') return actual > threshold
    if (alert.op === '>=') return actual >= threshold
    if (alert.op === '<') return actual < threshold
    return actual <= threshold
  }

  const addAlert = () => {
    const option = defaultOption
    setAlerts(current => [
      ...current,
      {
        id: `alert-${Date.now()}`,
        symbol: option?.asset ?? 'ES',
        provider: option?.provider ?? 'cme',
        productSymbol: option?.symbol ?? 'ES',
        field: 'last',
        op: '>=',
        value: option?.priceToBeat ?? option?.spot ?? 0,
        valueMode: option?.provider === 'cme' ? 'price' : isMoneyProduct(option) ? 'money' : 'percent',
        enabled: true,
        delivery: { audio: true, desktop: false, sms: false, sound: 'system-chime' },
      },
    ])
  }

  const firedAlertKeys = useRef<Record<string, string>>({})
  const armedAlertRules = useRef<Record<string, boolean>>({})
  const alertConfigKeys = useRef<Record<string, string>>({})

  const alertRuleKey = (alert: AlertRule, threshold: number) => [
    normalizeProviderKey(alert.provider),
    alert.productSymbol ?? alert.symbol ?? '',
    alert.field,
    alert.op,
    alert.valueMode ?? '',
    Number.isFinite(threshold) ? threshold.toFixed(8) : '',
  ].join('|')

  const deliverAlert = useCallback(async (alert: AlertRule, title: string, message: string) => {
    const delivery = alert.delivery ?? {}
    const syncResults: AlertDeliveryResult[] = []
    const asyncResults: Array<Promise<AlertDeliveryResult>> = []
    if (delivery.audio) syncResults.push(playAlertSound(delivery.sound ?? 'system-chime'))
    if (delivery.desktop) asyncResults.push(notifyDesktop(title, message))
    if (delivery.sms) asyncResults.push(sendSmsAlert(delivery.phone, message))
    const results = [...syncResults, ...await Promise.all(asyncResults)]
    if (results.length === 0) {
      setDeliveryStatus(current => ({ ...current, [alert.id]: { ok: false, message: 'No delivery channel selected', at: Date.now() } }))
      return
    }
    const ok = results.every(result => result.ok)
    setDeliveryStatus(current => ({
      ...current,
      [alert.id]: {
        ok,
        message: results.map(result => `${result.channel}: ${result.message}`).join(' | '),
        at: Date.now(),
      },
    }))
  }, [])

  const readAlert = (alert: AlertRule) => {
    const option = findOption(alert)
    const moneyProduct = isMoneyProduct(option)
    const market = option?.marketKey
      ? markets.find(item => item.key === option.marketKey)
      : markets.find(item => item.asset === option?.asset && item.live)
    const productFills = option?.marketKey ? (fills[option.marketKey] ?? []) : []
    const productTicks = option?.marketKey ? (polyTicks[option.marketKey] ?? []) : []
    const lastFill = productFills.at(-1)
    const lastTick = productTicks.at(-1)
    const last = option?.provider === 'cme'
      ? lastTick?.price ?? option?.priceToBeat ?? option?.spot ?? market?.price_to_beat
      : moneyProduct
        ? option?.spot
        : lastTick?.price ?? (market?.up_pct ?? option?.yes)
    const lastFillPrice = executionNumber(lastFill?.price)
    const lastFillSize = executionNumber(lastFill?.size)
    const fillMessage = lastFill
      ? `${providerLabel(option?.provider ?? 'cme')} ${option?.label ?? option?.symbol ?? 'product'} ${executionSideLabel(lastFill, option?.marketKey ?? option?.symbol ?? lastFill.marketKey, lastFill as PolyTradeTick & Record<string, unknown>)} fill ${lastFillSize.toFixed(0)} @ ${option?.provider === 'cme' ? fmtLadderPrice(lastFillPrice) : `${lastFillPrice.toFixed(1)}c`}`
      : 'No fills yet'
    const fillKey = lastFill
      ? `${option?.marketKey ?? option?.symbol ?? 'product'}-${lastFill.timestamp}-${lastFill.price}-${lastFill.size}-${lastFill.side}-${(lastFill as PolyTradeTick & Record<string, unknown>).orderId ?? (lastFill as PolyTradeTick & Record<string, unknown>).order_id ?? ''}`
      : undefined
    if (alert.field === 'last') return { option, actual: last, message: `Last traded ${option?.provider === 'cme' ? fmtLadderPrice(Number(last)) : moneyProduct ? fmtMoney(last) : fmtCents(last)}`, moneyProduct }
    if (alert.field === 'fill') return { option, actual: lastFill?.timestamp, message: fillMessage, moneyProduct: false, fillKey }
    return { option, actual: last, message: `Last traded ${option?.provider === 'cme' ? fmtLadderPrice(Number(last)) : moneyProduct ? fmtMoney(last) : fmtCents(last)}`, moneyProduct }
  }

  useEffect(() => {
    alerts.forEach(alert => {
      const read = readAlert(alert)
      const threshold = normalizeThreshold(alert, read.moneyProduct)
      const ruleKey = alertRuleKey(alert, threshold)
      if (alertConfigKeys.current[alert.id] !== ruleKey) {
        alertConfigKeys.current[alert.id] = ruleKey
        armedAlertRules.current[alert.id] = true
      }
      if (!alert.enabled) {
        armedAlertRules.current[alert.id] = true
        return
      }
      const label = read.option?.label ?? alert.productSymbol ?? 'product'
      if (alert.field === 'fill') {
        if (!read.fillKey) return
        if (firedAlertKeys.current[alert.id] === read.fillKey) return
        firedAlertKeys.current[alert.id] = read.fillKey
        void deliverAlert(alert, `Fill alert: ${label}`, read.message)
        return
      }
      const hit = compare(read.actual, alert, threshold)
      if (!hit) {
        armedAlertRules.current[alert.id] = true
        return
      }
      if (armedAlertRules.current[alert.id] === false) return
      armedAlertRules.current[alert.id] = false
      void deliverAlert(alert, `Alert: ${label}`, `${read.message} ${alert.op} ${formatThreshold(alert, read.moneyProduct)}`)
    })
  }, [alerts, fills, markets, polyTicks, deliverAlert])

  return (
    <div className="flex h-full flex-col bg-surface text-xs">
      <div className="flex items-center justify-between border-b border-surface-border bg-surface-panel px-3 py-2">
        <div className="flex items-center gap-2 text-[10px] text-muted">
          <span>Alert Manager</span>
          <span className={cx(
            'rounded border px-2 py-0.5 font-mono',
            smsStatus?.ready ? 'border-up/40 text-up' : 'border-warn/40 text-warn',
          )} title={smsStatus?.error ?? smsStatus?.provider ?? 'SMS status'}>
            {smsStatusLabel}
          </span>
        </div>
        <button className="btn-accent flex items-center gap-1 px-2 py-1 text-[11px]" onClick={addAlert}>
          <Plus size={13} /> Add
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {alerts.map(alert => {
          const read = readAlert(alert)
          const option = read.option
          const moneyProduct = read.moneyProduct
          const threshold = normalizeThreshold(alert, moneyProduct)
          const hit = alert.enabled && (alert.field === 'fill'
            ? read.actual !== undefined
            : compare(read.actual, alert, threshold))
          const provider = normalizeProviderKey(option?.provider ?? alert.provider)
          const symbol = option?.symbol ?? alert.productSymbol ?? 'ES'
          return (
            <div key={alert.id} className={cx('mb-2 rounded border p-2', hit ? 'border-warn bg-warn/10' : 'border-surface-border bg-surface-card/60')}>
              <div className="grid grid-cols-[84px_minmax(130px,1fr)_92px_54px_42px_86px_26px] gap-1">
                <select
                  value={provider}
                  onChange={event => {
                    const nextProvider = event.target.value as ProviderKey
                    const nextOption = options.find(item => item.provider === nextProvider) ?? option
                    setAlerts(current => current.map(item => item.id === alert.id ? {
                      ...item,
                      provider: nextProvider,
                      productSymbol: nextOption?.symbol,
                      symbol: nextOption?.asset,
                      valueMode: nextOption?.provider === 'cme' ? 'price' : isMoneyProduct(nextOption) ? 'money' : 'percent',
                    } : item))
                  }}
                  className="input-field py-1 text-[10px]"
                >
                  {PROVIDERS.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
                </select>
                <select
                  value={symbol}
                  onChange={event => {
                    const nextOption = options.find(item => item.provider === provider && item.symbol === event.target.value)
                    setAlerts(current => current.map(item => item.id === alert.id ? {
                      ...item,
                      productSymbol: event.target.value,
                      symbol: nextOption?.asset,
                      valueMode: nextOption?.provider === 'cme' ? 'price' : isMoneyProduct(nextOption) ? 'money' : 'percent',
                    } : item))
                  }}
                  className="input-field py-1 text-[10px]"
                >
                  {options.filter(item => item.provider === provider).map(item => <option key={`${item.provider}-${item.symbol}`} value={item.symbol}>{item.label}</option>)}
                </select>
                <select
                  value={alert.field}
                  onChange={event => setAlerts(current => current.map(item => item.id === alert.id ? {
                    ...item,
                    field: event.target.value as AlertRule['field'],
                    delivery: event.target.value === 'fill'
                      ? { audio: true, desktop: item.delivery?.desktop ?? false, sms: item.delivery?.sms ?? false, sound: item.delivery?.sound ?? 'system-chime', phone: item.delivery?.phone }
                      : item.delivery,
                  } : item))}
                  className="input-field py-1 text-[10px]"
                >
                  <option value="last">last trade</option>
                  <option value="fill">fill message</option>
                </select>
                {alert.field === 'fill' ? (
                  <span className="rounded border border-surface-border bg-surface px-1 py-1 text-center text-[10px] font-bold text-muted">any fill</span>
                ) : (
                  <select
                    value={alert.op}
                    onChange={event => setAlerts(current => current.map(item => item.id === alert.id ? { ...item, op: event.target.value as AlertRule['op'] } : item))}
                    className="input-field py-1 text-[10px]"
                  >
                    <option value=">">&gt;</option>
                    <option value=">=">&gt;=</option>
                    <option value="<">&lt;</option>
                    <option value="<=">&lt;=</option>
                  </select>
                )}
                {!moneyProduct && alert.field !== 'fill' ? (
                  <select
                    value={alert.valueMode ?? 'percent'}
                    onChange={event => setAlerts(current => current.map(item => item.id === alert.id ? { ...item, valueMode: event.target.value as AlertRule['valueMode'] } : item))}
                    className="input-field py-1 text-[10px]"
                    title="Prediction value input mode"
                  >
                    <option value="price">px</option>
                    <option value="percent">%</option>
                    <option value="cents">c</option>
                  </select>
                ) : (
                  <span className="rounded border border-surface-border bg-surface px-1 py-1 text-center text-[10px] font-bold text-muted">{option?.provider === 'cme' ? 'px' : moneyProduct ? '$' : '-'}</span>
                )}
                <input
                  type="number"
                  value={alert.value}
                  disabled={alert.field === 'fill'}
                  onChange={event => setAlerts(current => current.map(item => item.id === alert.id ? { ...item, value: Number(event.target.value) } : item))}
                  className="input-field py-1 text-[10px]"
                />
                <button
                  className="rounded text-muted hover:bg-down/10 hover:text-down"
                  onClick={() => setAlerts(current => current.filter(item => item.id !== alert.id))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="mt-1 grid grid-cols-[78px_96px_92px_minmax(170px,1fr)_56px] gap-1 text-[10px]">
                <label className="flex items-center gap-1 rounded border border-surface-border bg-surface px-2 py-1 text-muted">
                  <input
                    type="checkbox"
                    checked={alert.delivery?.audio ?? true}
                    onChange={event => setAlerts(current => current.map(item => item.id === alert.id ? { ...item, delivery: { ...item.delivery, audio: event.target.checked, sound: item.delivery?.sound ?? 'system-chime' } } : item))}
                  />
                  audio
                </label>
                <select
                  value={alert.delivery?.sound ?? 'system-chime'}
                  onChange={event => setAlerts(current => current.map(item => item.id === alert.id ? { ...item, delivery: { ...item.delivery, sound: event.target.value as AlertSound } } : item))}
                  className="input-field py-1 text-[10px]"
                >
                  <option value="system-chime">system chime</option>
                  <option value="system-bell">system bell</option>
                  <option value="system-alarm">system alarm</option>
                </select>
                <label className="flex items-center gap-1 rounded border border-surface-border bg-surface px-2 py-1 text-muted">
                  <input
                    type="checkbox"
                    checked={alert.delivery?.desktop ?? false}
                    onChange={event => {
                      const checked = event.target.checked
                      if (checked && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
                      setAlerts(current => current.map(item => item.id === alert.id ? { ...item, delivery: { ...item.delivery, desktop: checked } } : item))
                    }}
                  />
                  desktop
                </label>
                <div className="grid grid-cols-[72px_1fr] gap-1">
                  <label className="flex items-center gap-1 rounded border border-surface-border bg-surface px-2 py-1 text-muted">
                    <input
                      type="checkbox"
                      checked={alert.delivery?.sms ?? false}
                      onChange={event => setAlerts(current => current.map(item => item.id === alert.id ? { ...item, delivery: { ...item.delivery, sms: event.target.checked } } : item))}
                    />
                    SMS
                  </label>
                  <input
                    value={alert.delivery?.phone ?? ''}
                    onChange={event => setAlerts(current => current.map(item => item.id === alert.id ? { ...item, delivery: { ...item.delivery, phone: event.target.value } } : item))}
                    className="input-field py-1 text-[10px]"
                    placeholder="+15551234567"
                  />
                </div>
                <button
                  className="rounded border border-surface-border bg-surface px-2 py-1 font-bold text-accent hover:border-accent"
                  onClick={() => void deliverAlert(alert, `Test alert: ${option?.label ?? symbol}`, `Test alert for ${option?.label ?? symbol}`)}
                >
                  Test
                </button>
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px] font-mono">
                <span className={hit ? 'font-bold text-warn' : 'text-muted'}>{hit ? 'TRIGGERED' : 'watching'}</span>
                <span className="truncate text-slate-300">{read.message} {alert.field !== 'fill' ? `${alert.op} ${formatThreshold(alert, moneyProduct)}` : ''}</span>
              </div>
              {deliveryStatus[alert.id] && (
                <div className={cx('mt-1 truncate text-[10px] font-mono', deliveryStatus[alert.id].ok ? 'text-up' : 'text-warn')}>
                  {deliveryStatus[alert.id].message}
                </div>
              )}
            </div>
          )
        })}
        {alerts.length === 0 && <div className="p-4 text-center text-muted">No alerts configured.</div>}
      </div>
    </div>
  )
}

function ServiceMapWindow() {
  return (
    <div className="h-full overflow-y-auto bg-surface p-3">
      <div className="mb-3 flex items-center gap-2">
        <Server size={16} className="text-accent" />
        <div className="text-[10px] text-muted">UI modules are mapped to future service boundaries.</div>
      </div>
      <div className="space-y-2">
        {SERVICE_BLUEPRINT.map(service => (
          <div key={service.key} className="rounded border border-surface-border bg-surface-card p-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-100">{service.label}</span>
              <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[9px] font-mono text-accent">{service.key}</span>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-muted">{service.role}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {service.dependsOn.map(dep => (
                <span key={dep} className="rounded bg-surface px-1.5 py-0.5 text-[9px] font-mono text-muted">{dep}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const CERIOUS_SPREAD_PRODUCTS = [
  { symbol: 'ES_NQ', label: 'ES / NQ', legs: 'ES - 0.2666667 x NQ', service: 'price.synthetic-spread' },
  { symbol: 'YM_ES', label: 'YM / ES', legs: 'YM - 6.6666667 x ES', service: 'price.synthetic-spread' },
  { symbol: 'RTY_ES', label: 'RTY / ES', legs: 'RTY - 0.4285714 x ES', service: 'price.synthetic-spread' },
]

const CERIOUS_PANEL_DETAILS: Partial<Record<WorkspaceWindowKind, { service: string; body: string; bullets: string[] }>> = {
  goose: {
    service: 'advisor.goose',
    body: 'Macro advisor window restored as a native Cerious window. This is parked as its own boundary so the advisor feed can run independently of the trading canvas.',
    bullets: ['Macro context', 'Operator notes', 'Signal commentary'],
  },
  streamingNews: {
    service: 'news.stream',
    body: 'Streaming News window reserved for the real-time news ingestion feed.',
    bullets: ['Timestamped feed', 'Source attribution', 'Spread impact tags'],
  },
  liveApiArchitecture: {
    service: 'terminal.gateway',
    body: 'Live API Architecture view for watching the service split as CME ingress, pricing, algos, orders, fills, alerts, and sim exchange move apart.',
    bullets: ['CME ingress only', 'Gateway fanout', 'Microservice readiness'],
  },
  tradeAnalytics: {
    service: 'analytics.trade',
    body: 'Trade Analytics workspace fed by fills, orders, spread marks, and operator tags.',
    bullets: ['P&L attribution', 'Operator/source split', 'Export-ready rows'],
  },
  positionsOrders: {
    service: 'order.service',
    body: 'Positions & Orders window. This keeps the old workflow visible while routing the new build toward a dedicated order service.',
    bullets: ['Open orders', 'Positions', 'Cancel/replace path'],
  },
  auditTrail: {
    service: 'audit.journal',
    body: 'Audit Trail restored as a native Cerious window, intended to capture every operator action, algo state change, order event, and fill.',
    bullets: ['Operator activity', 'Algo events', 'Gateway responses'],
  },
  spreadConfigurations: {
    service: 'product-library',
    body: 'Spread Configurations window for Cerious synthetic products and leg definitions.',
    bullets: CERIOUS_SPREAD_PRODUCTS.map(product => `${product.symbol}: ${product.legs}`),
  },
  relativeSpreadVisuals: {
    service: 'visuals.relative-spread',
    body: 'Relative Spread Visuals reserved for cross-spread visual diagnostics.',
    bullets: ['Spread value', 'Leg pressure', 'Dislocation state'],
  },
  notionalCalculator: {
    service: 'risk.notional',
    body: 'Notional Calculator restored as a native Cerious operator utility and future risk-service client.',
    bullets: ['Leg ratio sizing', 'Dollar notional', 'Spread exposure'],
  },
  macroRegimeSummary: {
    service: 'macro.regime',
    body: 'Macro Regime Summary ready for the macro advisor and market-state feed.',
    bullets: ['Regime state', 'Volatility context', 'Session profile'],
  },
  liveSpreadSignals: {
    service: 'signal.spread',
    body: 'Live Spread Signals window, fed by synthetic marks, z-score, ATR, and trigger criteria.',
    bullets: ['ES/NQ', 'YM/ES', 'RTY/ES'],
  },
  atrZScoreEngine: {
    service: 'signal.atr-zscore',
    body: 'ATR and Z-Score Engine preserved as a signal service target.',
    bullets: ['Rolling z-score', 'ATR bands', 'Trigger thresholds'],
  },
  executionRules: {
    service: 'risk.execution-rules',
    body: 'Execution Rules window for the operating checklist around held orders and releases.',
    bullets: ['Entry gating', 'Cancel logic', 'Throttle rules'],
  },
  orderLayeringTechniques: {
    service: 'algo.layering',
    body: 'Order Layering Techniques reference window for the algo builder and manager.',
    bullets: ['Layer spacing', 'Clip size', 'Pull-forward behavior'],
  },
  moneyManagement: {
    service: 'risk.money-management',
    body: 'Money Management window, staged for max risk, loss limits, and account-level notional controls.',
    bullets: ['Max position', 'Daily limit', 'Strategy cap'],
  },
  crossSpreadOpportunityMap: {
    service: 'signal.cross-spread',
    body: 'Cross-Spread Opportunity Map intended to compare all synthetic spread products.',
    bullets: ['Relative z-score', 'Best opportunity', 'Correlation check'],
  },
  riskChecklist: {
    service: 'risk.checklist',
    body: 'Risk Checklist window restored for operator workflow and pre-release checks.',
    bullets: ['Data live', 'Risk armed', 'Algo state checked'],
  },
  sourceNotes: {
    service: 'knowledge.notes',
    body: 'Source Notes kept for model assumptions, data-source comments, and operator notes.',
    bullets: ['Model notes', 'Data notes', 'Change notes'],
  },
  modelResearchGovernance: {
    service: 'knowledge.governance',
    body: 'Model Research & Governance window reserved for model versioning and review state.',
    bullets: ['Version registry', 'Research status', 'Approval state'],
  },
}

function CeriousDepthTraderWindow({
  symbol,
  onSelect,
  operatorName,
}: {
  symbol: string
  onSelect: (provider: ProviderKey, symbol: string) => void
  operatorName: string
}) {
  return <LadderWindow provider="polymarket" symbol={symbol} onSelect={onSelect} operatorName={operatorName} />
}

function ceriousChartStudyLabel(study: CeriousChartStudy) {
  if (study.type === 'atr') return `ATR ${study.lookback ?? 'X'} x${(study.atrMultiplier ?? 2).toFixed(2)}`
  if (study.type === 'volume-at-price') return `Volume at Price ${study.bins ?? 28}`
  return `Linear Regression lookback ${study.lookback ?? 'X'} +${(study.upperDeviation ?? 2).toFixed(2)}/-${(study.lowerDeviation ?? 2).toFixed(2)}`
}

function ceriousAverage(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0
}

function ceriousRegressionChannel(bars: Bar[], study: CeriousChartStudy) {
  if (study.type !== 'regression-channel') return null
  const lookback = normalizedLookback(study.lookback)
  if (lookback === null) return null
  const endIndex = bars.length - 1
  const startIndex = endIndex - lookback + 1
  if (startIndex < 0) return null
  const sample = bars.slice(startIndex, endIndex + 1).map(bar => Number(bar.close))
  if (!sample.every(Number.isFinite)) return null
  const n = sample.length
  const xMean = (n - 1) / 2
  const yMean = ceriousAverage(sample)
  let numerator = 0
  let denominator = 0
  sample.forEach((value, index) => {
    numerator += (index - xMean) * (value - yMean)
    denominator += (index - xMean) ** 2
  })
  const slope = denominator ? numerator / denominator : 0
  const intercept = yMean - slope * xMean
  const residuals = sample.map((value, index) => value - (intercept + slope * index))
  const sigma = Math.sqrt(ceriousAverage(residuals.map(value => value ** 2)) || 0)
  const points = sample.map((_value, sampleIndex) => {
    const barIndex = startIndex + sampleIndex
    const mean = intercept + slope * sampleIndex
    return {
      index: barIndex,
      time: bars[barIndex].timestamp,
      mean,
      upper: mean + Math.max(0, study.upperDeviation ?? 2) * sigma,
      lower: mean - Math.max(0, study.lowerDeviation ?? 2) * sigma,
      sigma,
      slope,
    }
  })
  return { study, points }
}

function chartRegressionStudyRequest(symbol: string, timeframe: CeriousChartTimeframe, study: CeriousChartStudy) {
  if (study.type !== 'regression-channel') return null
  const lookback = normalizedLookback(study.lookback)
  if (lookback === null) return null
  const upper = Number(study.upperDeviation ?? 2)
  const lower = Number(study.lowerDeviation ?? 2)
  const standardDeviations = Math.max(
    0,
    Number.isFinite(upper) ? upper : 2,
    Number.isFinite(lower) ? lower : 2,
  )
  const interval = String(timeframe || '30m').toLowerCase()
  return {
    key: regressionStudyKey(symbol, interval, lookback, standardDeviations),
    symbol,
    interval,
    lookback,
    standardDeviations,
  }
}

function serverRegressionChannel(rows: Bar[], study: CeriousChartStudy, snapshot?: RegressionStudySnapshot) {
  if (study.type !== 'regression-channel' || !snapshot?.ok || !rows.length) return null
  const latestMean = finiteOptional(snapshot.mean)
  const sigma = finiteOptional(snapshot.sigma)
  if (latestMean === undefined || sigma === undefined) return null
  const slope = finiteOptional(snapshot.slope) ?? 0
  const lookback = normalizedLookback(snapshot.lookback ?? study.lookback)
  if (lookback === null) return null
  const updatedAt = finiteOptional(snapshot.updatedAt)
  const eligibleRows = updatedAt !== undefined && updatedAt > 0
    ? rows.filter(row => row.timestamp <= updatedAt)
    : rows
  const studyRows = eligibleRows.slice(-lookback)
  if (studyRows.length < 2) return null
  const upperDeviation = Math.max(0, Number(study.upperDeviation ?? snapshot.standardDeviations ?? 2) || 0)
  const lowerDeviation = Math.max(0, Number(study.lowerDeviation ?? snapshot.standardDeviations ?? 2) || 0)
  const lastIndex = studyRows.length - 1
  const points = studyRows.map((row, index) => {
    const mean = latestMean - slope * (lastIndex - index)
    return {
      time: ceriousChartTime(row),
      mean,
      upper: mean + upperDeviation * sigma,
      lower: mean - lowerDeviation * sigma,
    }
  })
  return {
    mean: points.map(point => ({ time: point.time, value: point.mean })),
    upper: points.map(point => ({ time: point.time, value: point.upper })),
    lower: points.map(point => ({ time: point.time, value: point.lower })),
    label: snapshot.label || `Linear Regression lookback ${lookback} ${snapshot.interval || ''}`.trim(),
  }
}

function ceriousChartBucketMs(timeframe: CeriousChartTimeframe): number {
  if (timeframe === '1m') return 60_000
  if (timeframe === '5m') return 5 * 60_000
  if (timeframe === '30m') return 30 * 60_000
  if (timeframe === '1h') return 60 * 60_000
  return 24 * 60 * 60_000
}

function ceriousChartBucketStart(timestamp: number, timeframe: CeriousChartTimeframe): number {
  if (timeframe !== '1d') return Math.floor(timestamp / ceriousChartBucketMs(timeframe)) * ceriousChartBucketMs(timeframe)
  const date = new Date(timestamp)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function ceriousChartSeriesBars(rows: Bar[], timeframe: CeriousChartTimeframe): Bar[] {
  const bucketed = new Map<number, Bar>()
  for (const row of rows) {
    if (![row.open, row.high, row.low, row.close, row.timestamp].every(Number.isFinite)) continue
    const timestamp = ceriousChartBucketStart(row.timestamp, timeframe)
    const existing = bucketed.get(timestamp)
    if (!existing) {
      bucketed.set(timestamp, { ...row, timestamp })
    } else {
      existing.high = Math.max(existing.high, row.high)
      existing.low = Math.min(existing.low, row.low)
      existing.close = row.close
      existing.volume = (existing.volume ?? 0) + (row.volume ?? 0)
    }
  }
  return [...bucketed.values()].sort((a, b) => a.timestamp - b.timestamp)
}

function ceriousCompletedStudyRows(rows: Bar[], timeframe: CeriousChartTimeframe): Bar[] {
  const periodMs = ceriousChartBucketMs(timeframe)
  const now = Date.now()
  return rows.filter(row => Number.isFinite(row.timestamp) && row.timestamp + periodMs <= now)
}

function ceriousChartWithLiveLast(rows: Bar[], timeframe: CeriousChartTimeframe, book: PolyBook | undefined, ticks: PolyTradeTick[]): Bar[] {
  const prepared = ceriousChartSeriesBars(rows, timeframe)
  const latestTick = ticks.at(-1)
  const tickPrice = finiteOptional(latestTick?.price)
  const bookPrice = finiteOptional(book?.ltp) ?? finiteOptional(book?.up_pct)
  const tickTimestamp = finiteOptional(latestTick?.timestamp) ?? 0
  const bookTimestamp = finiteOptional(book?.timestamp_ms) ?? finiteOptional((book as PolyBook & { seen_ms?: number } | undefined)?.seen_ms) ?? 0
  const livePrice = tickPrice !== undefined && tickTimestamp >= bookTimestamp ? tickPrice : bookPrice ?? tickPrice
  if (livePrice === undefined) return prepared
  const liveTimestamp = Math.max(tickTimestamp, bookTimestamp) || Date.now()
  const liveSize = tickPrice !== undefined && tickTimestamp >= bookTimestamp
    ? Math.max(0, latestTick?.size ?? 0)
    : Math.max(0, book?.ltp_size ?? latestTick?.size ?? 0)
  const bucket = ceriousChartBucketStart(liveTimestamp, timeframe)
  const latest = prepared.at(-1)
  if (latest && latest.timestamp === bucket) {
    return [
      ...prepared.slice(0, -1),
      {
        ...latest,
        high: Math.max(latest.high, livePrice),
        low: Math.min(latest.low, livePrice),
        close: livePrice,
        volume: (latest.volume ?? 0) + liveSize,
      },
    ]
  }
  return [
    ...prepared,
    {
      timestamp: bucket,
      open: latest?.close ?? livePrice,
      high: Math.max(latest?.close ?? livePrice, livePrice),
      low: Math.min(latest?.close ?? livePrice, livePrice),
      close: livePrice,
      volume: liveSize,
    },
  ]
}

function ceriousChartTime(row: Pick<Bar, 'timestamp'>) {
  return Math.floor(row.timestamp / 1000) as any
}

const CERIOUS_CHART_TIME_ZONE = 'America/Chicago'
const CERIOUS_INTRADAY_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: CERIOUS_CHART_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const CERIOUS_HOVER_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: CERIOUS_CHART_TIME_ZONE,
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const CERIOUS_DAILY_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: CERIOUS_CHART_TIME_ZONE,
  month: 'short',
  day: '2-digit',
})

function ceriousChartDateFromLightweightTime(time: unknown): Date | null {
  if (typeof time === 'number' && Number.isFinite(time)) return new Date(time * 1000)
  if (time && typeof time === 'object') {
    const row = time as { year?: number; month?: number; day?: number }
    if (Number.isFinite(row.year) && Number.isFinite(row.month) && Number.isFinite(row.day)) {
      return new Date(Date.UTC(Number(row.year), Number(row.month) - 1, Number(row.day)))
    }
  }
  return null
}

function ceriousFormatChartTime(time: unknown, timeframe: CeriousChartTimeframe, includeDate = false): string {
  const date = ceriousChartDateFromLightweightTime(time)
  if (!date) return ''
  if (timeframe === '1d') return CERIOUS_DAILY_TIME_FORMATTER.format(date)
  return includeDate ? CERIOUS_HOVER_TIME_FORMATTER.format(date) : CERIOUS_INTRADAY_TIME_FORMATTER.format(date)
}

function ceriousAtrBands(rows: Bar[], study: CeriousChartStudy) {
  const lookback = normalizedLookback(study.lookback, 2, 500)
  if (lookback === null) return []
  const multiplier = Math.max(0, Number(study.atrMultiplier ?? 2))
  if (rows.length < lookback + 1) return []
  const trueRanges: number[] = []
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]
    const prior = rows[index - 1]
    trueRanges.push(Math.max(
      row.high - row.low,
      Math.abs(row.high - prior.close),
      Math.abs(row.low - prior.close),
    ))
  }
  return rows.map((row, index) => {
    if (index < lookback) return null
    const atr = ceriousAverage(trueRanges.slice(index - lookback, index))
    return {
      time: ceriousChartTime(row),
      upper: row.close + atr * multiplier,
      lower: row.close - atr * multiplier,
    }
  }).filter((row): row is { time: any; upper: number; lower: number } => Boolean(row))
}

function ceriousVolumeAtPriceBuckets(rows: Bar[], studies: CeriousChartStudy[]) {
  const study = studies.find(item => item.type === 'volume-at-price')
  if (!study || rows.length < 2) return []
  const prices = rows.flatMap(row => [row.low, row.high, row.close]).filter(Number.isFinite)
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return []
  const bins = Math.max(8, Math.min(80, Math.floor(study.bins ?? 28)))
  const step = (max - min) / bins
  const buckets = Array.from({ length: bins }, (_, index) => ({ low: min + index * step, high: min + (index + 1) * step, volume: 0 }))
  for (const row of rows) {
    const typical = (row.high + row.low + row.close) / 3
    const index = clamp(Math.floor((typical - min) / step), 0, bins - 1)
    buckets[index].volume += Math.max(0, row.volume ?? 0)
  }
  const maxVolume = Math.max(1, ...buckets.map(bucket => bucket.volume))
  return buckets
    .filter(bucket => bucket.volume > 0)
    .map(bucket => ({
      ...bucket,
      pct: bucket.volume / maxVolume,
      y: ((max - (bucket.low + bucket.high) / 2) / (max - min)) * 100,
      h: Math.max(1.2, (step / (max - min)) * 100),
    }))
}

function CeriousStudyChart({
  symbol,
  timeframe,
  mode,
  compressBlankSessions,
  showGrid,
  solidCandles,
  studies,
}: {
  symbol: string
  timeframe: CeriousChartTimeframe
  mode: CeriousChartMode
  compressBlankSessions: boolean
  showGrid: boolean
  solidCandles: boolean
  studies: CeriousChartStudy[]
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<any>(null)
  const candleRef = useRef<any>(null)
  const lineRef = useRef<any>(null)
  const volumeRef = useRef<any>(null)
  const studySeriesRef = useRef<any[]>([])
  const chartFitKeyRef = useRef('')
  const livePriceLineRef = useRef<{ series: any; line: any } | null>(null)
  const [bars, setBars] = useState<Bar[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [regressionSnapshots, setRegressionSnapshots] = useState<Record<string, RegressionStudySnapshot>>({})
  const normalizedSymbol = String(symbol || 'ES_NQ').trim().toUpperCase()
  const chartSubscriptionSymbols = useMemo(() => [normalizedSymbol], [normalizedSymbol])
  useCmeMarketDataSubscriptions(chartSubscriptionSymbols)
  const book = useStore(state => state.polyBooks[normalizedSymbol])
  const ticks = useStore(state => state.polyTicks[normalizedSymbol] ?? EMPTY_TRADE_TICKS)
  const axisMode = compressBlankSessions ? 'service-session-axis' : 'calendar-axis'
  const showVolumeStudy = studies.some(study => study.type === 'volume-at-price')
  const regressionStudyRequests = useMemo(() => {
    const requests = new Map<string, NonNullable<ReturnType<typeof chartRegressionStudyRequest>>>()
    studies.forEach(study => {
      const request = chartRegressionStudyRequest(normalizedSymbol, timeframe, study)
      if (request) requests.set(request.key, request)
    })
    return [...requests.values()]
  }, [normalizedSymbol, studies, timeframe])
  const regressionStudyRequestKey = regressionStudyRequests.map(request => request.key).sort().join('|')

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#05070b' },
        textColor: '#a8b4c4',
      },
      localization: {
        timeFormatter: (time: unknown) => ceriousFormatChartTime(time, timeframe, true),
      },
      grid: {
        vertLines: { color: showGrid ? 'rgba(46, 63, 87, .62)' : 'rgba(46, 63, 87, .12)', style: LineStyle.Dotted },
        horzLines: { color: showGrid ? 'rgba(46, 63, 87, .62)' : 'rgba(46, 63, 87, .12)', style: LineStyle.Dotted },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: '#2a3b50',
        scaleMargins: { top: 0.05, bottom: 0.12 },
      },
      timeScale: {
        borderColor: '#2a3b50',
        timeVisible: timeframe !== '1d',
        secondsVisible: false,
        rightOffset: 4,
        tickMarkFormatter: (time: unknown) => ceriousFormatChartTime(time, timeframe),
      },
      autoSize: true,
    })
    chartRef.current = chart
    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: '#006dff',
      downColor: '#ff3045',
      borderUpColor: solidCandles ? '#f8fbff' : '#00d8ff',
      borderDownColor: solidCandles ? '#f8fbff' : '#ff7a89',
      wickUpColor: '#e6f1ff',
      wickDownColor: '#e6f1ff',
      priceLineVisible: false,
      lastValueVisible: false,
    })
    lineRef.current = chart.addSeries(LineSeries, {
      color: '#00d8ff',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    })
    volumeRef.current = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    })
    volumeRef.current.applyOptions({ visible: false })
    volumeRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } })

    return () => {
      if (livePriceLineRef.current) {
        try { livePriceLineRef.current.series.removePriceLine(livePriceLineRef.current.line) } catch { /* ignore */ }
      }
      livePriceLineRef.current = null
      for (const series of studySeriesRef.current) {
        try { chart.removeSeries(series) } catch { /* ignore */ }
      }
      studySeriesRef.current = []
      chart.remove()
    }
  }, [])

  useEffect(() => {
    chartRef.current?.applyOptions({
      localization: {
        timeFormatter: (time: unknown) => ceriousFormatChartTime(time, timeframe, true),
      },
      grid: {
        vertLines: { color: showGrid ? 'rgba(46, 63, 87, .62)' : 'rgba(46, 63, 87, .12)', style: LineStyle.Dotted },
        horzLines: { color: showGrid ? 'rgba(46, 63, 87, .62)' : 'rgba(46, 63, 87, .12)', style: LineStyle.Dotted },
      },
      timeScale: {
        timeVisible: timeframe !== '1d',
        tickMarkFormatter: (time: unknown) => ceriousFormatChartTime(time, timeframe),
      },
    })
    candleRef.current?.applyOptions({
      visible: mode === 'candles',
      borderUpColor: solidCandles ? '#f8fbff' : '#00d8ff',
      borderDownColor: solidCandles ? '#f8fbff' : '#ff7a89',
      priceLineVisible: false,
      lastValueVisible: false,
    })
    lineRef.current?.applyOptions({ visible: mode === 'line', priceLineVisible: false, lastValueVisible: false })
  }, [mode, showGrid, solidCandles, timeframe])

  useEffect(() => {
    let cancelled = false
    let timeoutId = 0
    const pull = async () => {
      setLoading(true)
      let delay = 15_000
      try {
        const next = await fetchBars(normalizedSymbol, timeframe, 1200, 45_000)
        if (!cancelled) {
          setBars(next)
          setError(next.length ? '' : 'No bars returned from Cerious price service')
        }
      } catch (err) {
        delay = 7_500
        if (!cancelled) setError(err instanceof Error ? err.message : 'Chart bars unavailable')
      } finally {
        if (!cancelled) {
          setLoading(false)
          timeoutId = window.setTimeout(pull, delay)
        }
      }
    }
    pull()
    return () => {
      cancelled = true
      if (timeoutId) window.clearTimeout(timeoutId)
    }
  }, [normalizedSymbol, timeframe])

  useEffect(() => {
    if (!regressionStudyRequests.length) {
      setRegressionSnapshots({})
      return
    }
    const controller = new AbortController()
    let cancelled = false
    let timeoutId = 0
    const pull = async () => {
      try {
        const entries = await Promise.all(regressionStudyRequests.map(async request => {
          try {
            const snapshot = await fetchRegressionStudySnapshot(
              request.symbol,
              request.interval,
              request.lookback,
              request.standardDeviations,
              controller.signal,
            )
            return [request.key, snapshot] as const
          } catch (err) {
            const snapshot: RegressionStudySnapshot = {
              ok: false,
              symbol: request.symbol,
              interval: request.interval,
              lookback: request.lookback,
              standardDeviations: request.standardDeviations,
              bars: 0,
              includesLiveMark: false,
              updatedAt: 0,
              error: err instanceof Error ? err.message : 'regression unavailable',
            }
            return [request.key, snapshot] as const
          }
        }))
        if (!cancelled) setRegressionSnapshots(Object.fromEntries(entries))
      } finally {
        if (!cancelled) timeoutId = window.setTimeout(pull, 30_000)
      }
    }
    pull()
    return () => {
      cancelled = true
      controller.abort()
      if (timeoutId) window.clearTimeout(timeoutId)
    }
  }, [regressionStudyRequestKey])

  const historicalDisplayBars = useMemo(
    () => ceriousChartSeriesBars(bars, timeframe),
    [bars, timeframe],
  )

  const displayBars = useMemo(
    () => ceriousChartWithLiveLast(bars, timeframe, book, ticks),
    [bars, book, ticks, timeframe],
  )

  const volumeProfile = useMemo(
    () => ceriousVolumeAtPriceBuckets(displayBars.slice(-240), studies),
    [displayBars, studies],
  )

  useEffect(() => {
    const chart = chartRef.current
    const candle = candleRef.current
    const line = lineRef.current
    const volume = volumeRef.current
    if (!chart || !candle || !line || !historicalDisplayBars.length) return
    const unique = new Map<number, Bar>()
    for (const row of historicalDisplayBars) unique.set(row.timestamp, row)
    const rows = [...unique.values()].sort((a, b) => a.timestamp - b.timestamp)
    const candleData = rows.map(row => ({
      time: ceriousChartTime(row),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
    }))
    const lineData = rows.map(row => ({ time: ceriousChartTime(row), value: row.close }))
    const volumeData = rows.map(row => ({
      time: ceriousChartTime(row),
      value: Math.max(0, row.volume ?? 0),
      color: row.close >= row.open ? 'rgba(0, 109, 255, .28)' : 'rgba(255, 48, 69, .28)',
    }))
    candle.setData(candleData)
    line.setData(lineData)
    volume?.applyOptions({ visible: showVolumeStudy })
    volume?.setData(showVolumeStudy ? volumeData : [])

    for (const series of studySeriesRef.current) {
      try { chart.removeSeries(series) } catch { /* ignore */ }
    }
    studySeriesRef.current = []
    const studyRows = ceriousCompletedStudyRows(rows, timeframe)

    studies.forEach((study, index) => {
      if (study.type === 'regression-channel') {
        const request = chartRegressionStudyRequest(normalizedSymbol, timeframe, study)
        const snapshot = request ? regressionSnapshots[request.key] : undefined
        if (snapshot?.ok) {
          const channel = serverRegressionChannel(studyRows, study, snapshot)
          if (!channel) return
          const mean = channel.mean
            ? chart.addSeries(LineSeries, { color: '#facc15', lineWidth: 2, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false })
            : null
          const upper = chart.addSeries(LineSeries, { color: '#facc15', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
          const lower = chart.addSeries(LineSeries, { color: '#facc15', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
          if (mean && channel.mean) mean.setData(channel.mean)
          upper.setData(channel.upper)
          lower.setData(channel.lower)
          studySeriesRef.current.push(...[mean, upper, lower].filter(Boolean))
          return
        }
        const channel = ceriousRegressionChannel(studyRows, study)
        if (!channel) return
        const palette = ['#facc15', '#fde68a', '#f59e0b', '#fff0b3'][index % 4]
        const mean = chart.addSeries(LineSeries, { color: palette, lineWidth: 2, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false })
        const upper = chart.addSeries(LineSeries, { color: palette, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
        const lower = chart.addSeries(LineSeries, { color: palette, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
        mean.setData(channel.points.map(point => ({ time: Math.floor(point.time / 1000) as any, value: point.mean })))
        upper.setData(channel.points.map(point => ({ time: Math.floor(point.time / 1000) as any, value: point.upper })))
        lower.setData(channel.points.map(point => ({ time: Math.floor(point.time / 1000) as any, value: point.lower })))
        studySeriesRef.current.push(mean, upper, lower)
      } else if (study.type === 'atr') {
        const bands = ceriousAtrBands(studyRows, study)
        if (!bands.length) return
        const upper = chart.addSeries(LineSeries, { color: '#38bdf8', lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false })
        const lower = chart.addSeries(LineSeries, { color: '#fb7185', lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false })
        upper.setData(bands.map(point => ({ time: point.time, value: point.upper })))
        lower.setData(bands.map(point => ({ time: point.time, value: point.lower })))
        studySeriesRef.current.push(upper, lower)
      }
    })
    const fitKey = `${normalizedSymbol}|${timeframe}|${rows[0]?.timestamp ?? 0}|${rows.length}`
    if (chartFitKeyRef.current !== fitKey) {
      chart.timeScale().fitContent()
      chartFitKeyRef.current = fitKey
    }
  }, [
    historicalDisplayBars,
    normalizedSymbol,
    regressionSnapshots,
    showVolumeStudy,
    studies,
    timeframe,
  ])

  useEffect(() => {
    const candle = candleRef.current
    const line = lineRef.current
    const volume = volumeRef.current
    if (!candle || !line || !displayBars.length) return
    const latest = displayBars.at(-1)
    if (!latest || ![latest.open, latest.high, latest.low, latest.close, latest.timestamp].every(Number.isFinite)) return
    const time = ceriousChartTime(latest)
    candle.update({
      time,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      close: latest.close,
    })
    line.update({ time, value: latest.close })
    if (showVolumeStudy) {
      volume?.update({
        time,
        value: Math.max(0, latest.volume ?? 0),
        color: latest.close >= latest.open ? 'rgba(0, 109, 255, .28)' : 'rgba(255, 48, 69, .28)',
      })
    }
    if (livePriceLineRef.current) {
      try { livePriceLineRef.current.series.removePriceLine(livePriceLineRef.current.line) } catch { /* ignore */ }
      livePriceLineRef.current = null
    }
    const priceLineSeries = mode === 'line' ? line : candle
    livePriceLineRef.current = {
      series: priceLineSeries,
      line: priceLineSeries.createPriceLine({
        price: latest.close,
        color: '#facc15',
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        lineVisible: false,
        axisLabelVisible: true,
        title: '',
      }),
    }
  }, [displayBars, mode, showVolumeStudy])

  return (
    <div className="relative h-full w-full overflow-hidden rounded bg-[#05070b]">
      <div ref={containerRef} className="h-full w-full" data-axis-mode={axisMode} />
      {volumeProfile.length > 0 && (
        <div className="pointer-events-none absolute right-[46px] top-2 h-[calc(100%-38px)] w-[22%]">
          {volumeProfile.map(bucket => (
            <div
              key={`${bucket.low}-${bucket.high}`}
              className="absolute right-0 rounded-l bg-cyan-300/20"
              style={{
                top: `${bucket.y - bucket.h / 2}%`,
                height: `${bucket.h}%`,
                width: `${Math.max(4, bucket.pct * 100)}%`,
              }}
              title={`${bucket.low.toFixed(2)}-${bucket.high.toFixed(2)} ${bucket.volume.toFixed(0)}`}
            />
          ))}
        </div>
      )}
      {(loading || error || !displayBars.length) && (
        <div className={cx('pointer-events-none absolute left-2 top-2 rounded border px-2 py-1 font-mono text-[10px]', error ? 'border-down/40 bg-down/10 text-down' : 'border-cyan-300/30 bg-cyan-400/10 text-cyan-200')}>
          {error || (loading ? `Loading ${normalizedSymbol} ${timeframe} bars from Cerious price service...` : 'Waiting for bars')}
        </div>
      )}
    </div>
  )
}

function CeriousSingleChartWindow({
  provider,
  symbol,
  onSelect,
  settings,
  onSettingsChange,
}: {
  provider: ProviderKey
  symbol: string
  onSelect: (provider: ProviderKey, symbol: string) => void
  settings?: CeriousChartSettings
  onSettingsChange: (settings: CeriousChartSettings) => void
}) {
  const [mode, setMode] = useState<CeriousChartMode>(settings?.mode ?? 'candles')
  const [timeframe, setTimeframe] = useState<CeriousChartTimeframe>(settings?.timeframe ?? '30m')
  const [compressBlankSessions, setCompressBlankSessions] = useState(settings?.compressBlankSessions ?? true)
  const [showGrid, setShowGrid] = useState(settings?.showGrid ?? false)
  const [solidCandles, setSolidCandles] = useState(settings?.solidCandles ?? true)
  const [displayPreset, setDisplayPreset] = useState<CeriousChartDisplayPreset>(settings?.displayPreset ?? 'clean')
  const [showStudyBuilder, setShowStudyBuilder] = useState(false)
  const [studyType, setStudyType] = useState<CeriousChartStudyType>(settings?.studyType ?? 'regression-channel')
  const [studyLookback, setStudyLookback] = useState(settings?.studyLookback ? String(settings.studyLookback) : '')
  const [upperDeviation, setUpperDeviation] = useState(settings?.upperDeviation ?? 2)
  const [lowerDeviation, setLowerDeviation] = useState(settings?.lowerDeviation ?? 2)
  const [atrMultiplier, setAtrMultiplier] = useState(settings?.atrMultiplier ?? 2)
  const [volumePriceBins, setVolumePriceBins] = useState(settings?.volumePriceBins ?? 28)
  const [studies, setStudies] = useState<CeriousChartStudy[]>(() => initialCeriousChartStudies(settings))
  const selectedSymbol = symbol || 'ES_NQ'
  const studyStatus = studies.length ? studies.map(ceriousChartStudyLabel).join(' | ') : 'No studies'
  const optionalStudyCount = studies.filter(study => !isDefaultRegressionChartStudy(study)).length
  const settingsRef = useRef(onSettingsChange)

  useEffect(() => {
    settingsRef.current = onSettingsChange
  }, [onSettingsChange])

  useEffect(() => {
    settingsRef.current({
      mode,
      timeframe,
      displayPreset,
      compressBlankSessions,
      showGrid,
      solidCandles,
      studies,
      studyType,
      studyLookback: normalizedLookback(studyLookback, 2, 500) ?? undefined,
      upperDeviation,
      lowerDeviation,
      atrMultiplier,
      volumePriceBins,
    })
  }, [atrMultiplier, compressBlankSessions, displayPreset, lowerDeviation, mode, showGrid, solidCandles, studies, studyLookback, studyType, timeframe, upperDeviation, volumePriceBins])

  const addStudy = () => {
    const lookback = normalizedLookback(studyLookback, 2, 500)
    if (studyType !== 'volume-at-price' && lookback === null) return
    const upper = Number(Math.max(0, Math.min(10, upperDeviation || 0)).toFixed(2))
    const lower = Number(Math.max(0, Math.min(10, lowerDeviation || 0)).toFixed(2))
    const multiplier = Number(Math.max(0, Math.min(20, atrMultiplier || 0)).toFixed(2))
    const bins = Math.max(8, Math.min(80, Math.floor(volumePriceBins || 28)))
    const common = {
      id: `study-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      type: studyType,
      ...(lookback !== null ? { lookback } : {}),
    }
    const nextStudy: CeriousChartStudy = studyType === 'regression-channel'
      ? { ...common, type: 'regression-channel', upperDeviation: upper, lowerDeviation: lower }
      : studyType === 'atr'
        ? { ...common, type: 'atr', atrMultiplier: multiplier }
        : { ...common, type: 'volume-at-price', bins }
    setStudies(current => [
      ...current,
      nextStudy,
    ])
  }

  const clearOptionalStudies = () => {
    setStudies(defaultCeriousChartStudies())
  }

  const applyDisplayPreset = (preset: CeriousChartDisplayPreset) => {
    setDisplayPreset(preset)
    if (preset === 'clean') {
      setCompressBlankSessions(true)
      setShowGrid(false)
      setSolidCandles(true)
    } else if (preset === 'grid') {
      setCompressBlankSessions(true)
      setShowGrid(true)
      setSolidCandles(true)
    } else if (preset === 'calendar') {
      setCompressBlankSessions(false)
      setShowGrid(false)
      setSolidCandles(true)
    } else {
      setCompressBlankSessions(true)
      setShowGrid(false)
      setSolidCandles(false)
    }
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-border bg-surface-panel px-2 py-1">
        <div className="min-w-[280px] flex-1">
          <ProductSelector provider={provider} symbol={selectedSymbol} onSelect={onSelect} compact />
        </div>
        <select className="input-field h-8 w-[112px] py-1 text-[10px] font-bold uppercase" value={mode} onChange={event => setMode(event.target.value as CeriousChartMode)} title="Chart style">
          <option value="candles">Candles</option>
          <option value="line">Line</option>
        </select>
        <select className="input-field h-8 w-[92px] py-1 font-mono text-[10px] font-bold uppercase" value={timeframe} onChange={event => setTimeframe(event.target.value as CeriousChartTimeframe)} title="Chart timeframe">
          <option value="1m">1m</option>
          <option value="5m">5m</option>
          <option value="30m">30m</option>
          <option value="1h">1h</option>
          <option value="1d">1d</option>
        </select>
        <select className="input-field h-8 w-[132px] py-1 text-[10px] font-bold uppercase" value={displayPreset} onChange={event => applyDisplayPreset(event.target.value as CeriousChartDisplayPreset)} title="Display preset">
          <option value="clean">Clean</option>
          <option value="grid">Grid</option>
          <option value="calendar">Calendar</option>
          <option value="outline">Outline</option>
        </select>
        <button
          className={cx('btn-neutral flex h-8 items-center gap-1 px-2 text-[10px] font-black uppercase', showStudyBuilder && 'border-accent/60 text-accent')}
          onClick={() => setShowStudyBuilder(current => !current)}
          title={`Linear regression is controlled by chart settings. Optional studies: ${optionalStudyCount}. ${studyStatus}`}
        >
          <SlidersHorizontal size={13} /> Studies {studies.length}
        </button>
      </div>
      {showStudyBuilder && (
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-border bg-[#07101b] px-2 py-1">
        <span className="font-mono text-[10px] font-black uppercase text-muted">Optional Studies</span>
        <select className="input-field h-7 w-40 py-0 text-[10px] font-bold" value={studyType} onChange={event => setStudyType(event.target.value as CeriousChartStudyType)}>
          <option value="regression-channel">Linear Regression</option>
          <option value="atr">ATR</option>
          <option value="volume-at-price">Volume at Price</option>
        </select>
        {studyType !== 'volume-at-price' && <label className="flex items-center gap-1 font-mono text-[10px] text-muted">Lookback
          <input className="input-field h-7 w-16 px-2 py-0 text-[10px]" type="number" min={2} max={500} step={1} value={studyLookback} onChange={event => setStudyLookback(event.target.value)} />
        </label>}
        {studyType === 'regression-channel' && <label className="flex items-center gap-1 font-mono text-[10px] text-muted">Std +
          <input className="input-field h-7 w-16 px-2 py-0 text-[10px]" type="number" min={0} max={10} step={0.01} value={upperDeviation} onChange={event => setUpperDeviation(Number(event.target.value))} />
        </label>}
        {studyType === 'regression-channel' && <label className="flex items-center gap-1 font-mono text-[10px] text-muted">Std -
          <input className="input-field h-7 w-16 px-2 py-0 text-[10px]" type="number" min={0} max={10} step={0.01} value={lowerDeviation} onChange={event => setLowerDeviation(Number(event.target.value))} />
        </label>}
        {studyType === 'atr' && <label className="flex items-center gap-1 font-mono text-[10px] text-muted">ATR x
          <input className="input-field h-7 w-16 px-2 py-0 text-[10px]" type="number" min={0} max={20} step={0.01} value={atrMultiplier} onChange={event => setAtrMultiplier(Number(event.target.value))} />
        </label>}
        {studyType === 'volume-at-price' && <label className="flex items-center gap-1 font-mono text-[10px] text-muted">Bins
          <input className="input-field h-7 w-16 px-2 py-0 text-[10px]" type="number" min={8} max={80} step={1} value={volumePriceBins} onChange={event => setVolumePriceBins(Number(event.target.value))} />
        </label>}
        <button className="btn-accent h-7 px-2 text-[10px]" onClick={addStudy}>Add Study</button>
        <button className="btn-neutral h-7 px-2 text-[10px]" onClick={clearOptionalStudies} disabled={!optionalStudyCount}>Clear Optional</button>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {studies.map(study => (
            <button
              key={study.id}
              className="shrink-0 rounded border border-cyan-300/35 bg-cyan-400/10 px-2 py-1 font-mono text-[10px] font-bold text-cyan-100"
              onClick={() => setStudies(current => current.filter(item => item.id !== study.id))}
              title="Remove study"
            >
              {ceriousChartStudyLabel(study)}
            </button>
          ))}
        </div>
      </div>
      )}
      <div className="min-h-0 flex-1 p-2">
        <div className="h-full rounded border border-surface-border bg-[#05070b] p-1">
          <CeriousStudyChart
            symbol={selectedSymbol}
            timeframe={timeframe}
            mode={mode}
            compressBlankSessions={compressBlankSessions}
            showGrid={showGrid}
            solidCandles={solidCandles}
            studies={studies}
          />
        </div>
      </div>
      <div className="border-t border-surface-border bg-surface-panel px-2 py-1 font-mono text-[9px] text-muted">
        Cerious Chart | {selectedSymbol} | {timeframe} service bars | {mode === 'candles' ? 'Candlesticks' : 'Line'} | {compressBlankSessions ? 'No blank sessions' : 'Calendar time'} | {showGrid ? 'Grid' : 'No grid'} | {studyStatus}
      </div>
    </div>
  )
}

function spreadTone(stat?: Partial<CeriousSpreadStat>) {
  const z = Number(stat?.z ?? 0)
  const bias = stat?.bias ?? (z <= -1.5 ? 'buy' : z >= 1.5 ? 'sell' : Math.abs(z) >= 1 ? 'watch' : 'neutral')
  if (bias === 'buy') {
    return {
      label: 'Cheap / buy spread',
      text: 'text-blue-200',
      accent: 'text-blue-300',
      border: 'border-blue-500/45',
      bg: 'bg-blue-500/10',
      fill: '#38bdf8',
      soft: 'rgba(56, 189, 248, .16)',
    }
  }
  if (bias === 'sell') {
    return {
      label: 'Rich / sell spread',
      text: 'text-red-200',
      accent: 'text-red-300',
      border: 'border-red-500/45',
      bg: 'bg-red-500/10',
      fill: '#fb7185',
      soft: 'rgba(251, 113, 133, .16)',
    }
  }
  if (bias === 'watch') {
    return {
      label: z > 0 ? 'Rich watch' : 'Cheap watch',
      text: 'text-amber-100',
      accent: 'text-amber-300',
      border: 'border-amber-500/45',
      bg: 'bg-amber-500/10',
      fill: '#fbbf24',
      soft: 'rgba(251, 191, 36, .14)',
    }
  }
  return {
    label: 'Fair value',
    text: 'text-slate-200',
    accent: 'text-slate-300',
    border: 'border-surface-border',
    bg: 'bg-surface-card',
    fill: '#94a3b8',
    soft: 'rgba(148, 163, 184, .12)',
  }
}

function spreadSignalFromZ(z: number) {
  if (z <= -1.5) return 'Buy spread setup'
  if (z >= 1.5) return 'Sell spread setup'
  if (z <= -1.0) return 'Cheap watch; wait for reclaim'
  if (z >= 1.0) return 'Rich watch; wait for fade'
  if (Math.abs(z) < 0.5) return 'Neutral / fair value'
  return z > 0 ? 'Rich, wait or fade' : 'Cheap, wait or confirm'
}

function liveSpreadLast(row: Pick<CeriousSpreadStat, 'lastTraded' | 'spread'> & { key: string }, books: Record<string, PolyBook>, ticks: Record<string, PolyTradeTick[]>) {
  const liveBook = books[row.key]
  const liveTick = ticks[row.key]?.at(-1)
  const liveBookLtp = Number.isFinite(Number(liveBook?.ltp))
    ? Number(liveBook?.ltp)
    : Number.isFinite(Number(liveBook?.up_pct))
      ? Number(liveBook?.up_pct)
      : undefined
  return liveBookLtp ?? liveTick?.price ?? row.lastTraded ?? row.spread
}

function liveSpreadLocation(row: Partial<CeriousSpreadStat>, last: number) {
  const meanValue = finiteOptional(row.longTermMean) ?? finiteOptional(row.lookbackMean) ?? finiteOptional(row.mean) ?? last
  const atrValue = Math.max(finiteOptional(row.blendedAtr) ?? finiteOptional(row.atr) ?? 0, 0)
  const halfAtr = Math.max(finiteOptional(row.halfAtr) ?? atrValue / 2, 0)
  const vwapBasis = finiteOptional(row.vwapBasis) ?? meanValue
  const z = atrValue ? (last - meanValue) / atrValue : finiteOptional(row.z) ?? 0
  const dayZ = halfAtr ? (last - vwapBasis) / halfAtr : z
  return {
    meanValue,
    atrValue,
    halfAtr,
    vwapBasis,
    z,
    dayZ,
    signal: spreadSignalFromZ(dayZ),
  }
}

function gooseTone(label: string, value?: string) {
  const text = `${label} ${value ?? ''}`.toLowerCase()
  if (/short|sell|risk-off|aggressive/.test(text)) return { border: 'border-red-500/40', bg: 'bg-red-500/10', text: 'text-red-200', accent: 'text-red-300' }
  if (/long|buy|risk-on|high/.test(text)) return { border: 'border-blue-500/40', bg: 'bg-blue-500/10', text: 'text-blue-200', accent: 'text-blue-300' }
  if (/moderate|medium|mixed|watch|mean/.test(text)) return { border: 'border-amber-500/40', bg: 'bg-amber-500/10', text: 'text-amber-100', accent: 'text-amber-300' }
  return { border: 'border-surface-border', bg: 'bg-surface-card', text: 'text-slate-200', accent: 'text-accent' }
}

function dailySummaryPillClass(tone?: string) {
  const raw = String(tone ?? '').toLowerCase()
  if (raw === 'red') return 'border-red-500/35 bg-red-500/15 text-red-300'
  if (raw === 'amber') return 'border-amber-500/35 bg-amber-500/15 text-amber-300'
  return 'border-blue-500/35 bg-blue-500/15 text-blue-300'
}

function FormulaLightScale({ value, polarity = 'risk-on', label }: { value: number; polarity?: 'risk-on' | 'risk-off' | 'order-flow'; label?: string }) {
  const normalized = clamp(Number.isFinite(value) ? value : 0, 0, 100)
  const lit = Math.round(normalized / 10)
  const color = polarity === 'risk-off' ? '#fb7185' : polarity === 'order-flow' ? '#fbbf24' : '#38bdf8'
  return (
    <div className="min-w-0">
      {label && (
        <div className="mb-1 flex items-center justify-between font-mono text-[9px] uppercase text-muted">
          <span>{label}</span>
          <span className="text-slate-300">{Math.round(normalized)}/100</span>
        </div>
      )}
      <div className="grid grid-cols-10 gap-1">
        {Array.from({ length: 10 }, (_, index) => (
          <span
            key={index}
            className="h-3 rounded-sm border border-surface-border"
            style={{
              background: index < lit ? color : 'rgba(8, 13, 20, .9)',
              boxShadow: index < lit ? `0 0 10px ${color}` : 'none',
              opacity: index < lit ? 1 : 0.55,
            }}
          />
        ))}
      </div>
    </div>
  )
}

function CeriousDailySummaryWindow() {
  const { data, error } = useCeriousEndpoint<CeriousDailySummaryState>('/api/cerious/daily-summary', CERIOUS_ADVISORY_REFRESH_MS)
  const topRows = data?.top ?? []
  const classifications = data?.classification ?? []
  const eligible = data?.eligibleSpreads ?? []

  return (
    <div className="h-full overflow-y-auto bg-surface p-3 text-xs">
      <div className="mb-3 rounded border border-accent/35 bg-accent/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-xs font-black uppercase tracking-wide text-slate-100">Daily Summary</div>
            <div className="mt-1 font-mono text-[10px] text-accent">{data?.service ?? 'cerious.daily.summary'}</div>
          </div>
          <div className="font-mono text-[10px] text-muted">
            {error || (data?.fetchedAt ? `Updated ${new Date(data.fetchedAt).toLocaleString()}` : 'Waiting for summary payload')}
          </div>
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-slate-100">{data?.summaryRead ?? 'Waiting for the daily summary payload.'}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
        {topRows.map(row => (
          <div key={row.label} className="rounded border border-surface-border bg-surface-card p-2">
            <div className="font-mono text-[9px] font-black uppercase text-muted">{row.label}</div>
            <div className="mt-1 font-mono text-[13px] font-black text-accent">{row.value}</div>
            <div className="mt-1 text-[10px] leading-relaxed text-muted">{row.note}</div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-1">
        {(data?.sourcePills ?? []).map(pill => (
          <span key={pill.label} className={cx('rounded border px-2 py-1 font-mono text-[10px] font-black uppercase', dailySummaryPillClass(pill.tone))}>
            {pill.label}
          </span>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-4">
        {classifications.map(row => (
          <div key={row.label} className="rounded border border-surface-border bg-surface-card p-2">
            <div className="font-mono text-[9px] font-black uppercase text-muted">{row.label}</div>
            <div className="mt-1 font-mono text-[12px] font-black text-slate-100">{row.value}</div>
            <div className="mt-1 text-[10px] leading-relaxed text-muted">{row.note}</div>
          </div>
        ))}
      </div>

      <div className="mt-3 overflow-hidden rounded border border-surface-border">
        <div className="grid grid-cols-[92px_64px_60px_1fr_1.3fr] border-b border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] font-black uppercase text-muted">
          <span>Spread</span>
          <span>Score</span>
          <span>Z</span>
          <span>Bias</span>
          <span>Approach</span>
        </div>
        {eligible.map(row => (
          <div key={row.key} className="grid grid-cols-[92px_64px_60px_1fr_1.3fr] border-b border-surface-border/60 px-2 py-2 font-mono text-[10px]">
            <span className="font-black text-accent">{row.label}</span>
            <span className={row.score >= 65 ? 'font-black text-blue-300' : row.score >= 45 ? 'font-black text-amber-300' : 'text-muted'}>{row.score}/100</span>
            <span className={row.z >= 0 ? 'text-down' : 'text-up'}>{fmtNum(row.z, 2)}</span>
            <span className="text-slate-200">{row.bias}</span>
            <span className="text-muted">{row.approach}</span>
          </div>
        ))}
        {!eligible.length && <div className="p-4 text-center font-mono text-[10px] text-muted">Waiting for eligible spread classification.</div>}
      </div>

      {data?.gooseComplement && (
        <div className="mt-3 rounded border border-blue-500/25 bg-blue-500/10 p-3 text-[11px] leading-relaxed text-slate-200">
          {data.gooseComplement}
        </div>
      )}
    </div>
  )
}

function CeriousGooseWindow() {
  const data = useCeriousIntelligence(CERIOUS_ADVISORY_REFRESH_MS)
  const gooseData = data?.goose
  const macro = data?.macroRegime
  const strongest = data?.spreadPack?.strongest
  const orderFlow = strongest?.orderFlowScore ?? Math.min(100, Math.abs(strongest?.z ?? 0) * 42)
  return (
    <div className="h-full overflow-y-auto bg-surface p-3 text-xs">
      <div className="grid grid-cols-4 gap-2">
        {[
          ['Primary Strategy', gooseData?.strategy ?? 'Waiting'],
          ['Direction', gooseData?.direction ?? '-'],
          ['Risk Posture', gooseData?.risk ?? '-'],
          ['Confidence', gooseData?.confidence ?? '-'],
        ].map(([label, value]) => {
          const tone = gooseTone(label, value)
          return (
          <div key={label} className={cx('rounded border p-2', tone.border, tone.bg)}>
            <div className="text-[9px] font-bold uppercase text-muted">{label}</div>
            <div className={cx('mt-1 font-mono text-[11px] font-black', tone.accent)}>{value}</div>
          </div>
          )
        })}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded border border-surface-border bg-surface-card p-2">
          <FormulaLightScale value={macro?.strength ?? 50} polarity={macro?.label === 'Risk-Off' ? 'risk-off' : 'risk-on'} label="Risk-on ranking" />
        </div>
        <div className="rounded border border-surface-border bg-surface-card p-2">
          <FormulaLightScale value={orderFlow} polarity="order-flow" label="Order-flow status" />
        </div>
      </div>
      <div className="mt-3 rounded border border-accent/30 bg-accent/10 p-3 leading-relaxed text-slate-200">
        {gooseData?.read ?? 'GOOSE is waiting for live spread intelligence.'}
        <div className="mt-2 font-mono text-[10px] text-muted">
          {gooseData?.updateCadence ?? CERIOUS_ADVISORY_REFRESH_LABEL}
          {gooseData?.updatedAt ? ` | last review ${new Date(gooseData.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
        </div>
      </div>
      <div className="mt-3 overflow-hidden rounded border border-surface-border">
        {(gooseData?.evidence ?? []).map(([left, right]) => (
          <div key={left} className="grid grid-cols-[160px_1fr] border-b border-surface-border/60 bg-surface-card px-2 py-1.5 font-mono text-[10px] last:border-b-0">
            <span className="font-black text-slate-100">{left}</span>
            <span className="text-muted">{right}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function CeriousLiveSpreadSignalsWindow() {
  const data = useCeriousIntelligence(CERIOUS_ADVISORY_REFRESH_MS)
  const rows = data?.liveSpreadSignals ?? []
  return (
    <div className="flex h-full flex-col bg-surface text-xs">
      <div className="grid grid-cols-[86px_1fr_72px_72px_72px_58px_68px_1.1fr] border-b border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] font-black uppercase text-muted">
        <span>Spread</span><span>Last vs 30D</span><span className="text-right">Lin Reg -2</span><span className="text-right">Lin Reg Mid</span><span className="text-right">Lin Reg +2</span><span className="text-right">Z</span><span className="text-right">Flow</span><span className="text-right">Signal</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.map(row => {
          const last = finiteOptional(row.lastTraded) ?? finiteOptional(row.spread) ?? 0
          const location = liveSpreadLocation(row, last)
          const tone = spreadTone({ z: location.dayZ })
          const baseline = location.meanValue
          const regressionTitle = `${row.linearRegressionBars ?? 0} x ${row.linearRegressionInterval ?? '30m'}${row.linearRegressionIsForming ? ' including active bar' : ''}`
          return (
            <div key={row.key} className={cx('grid grid-cols-[86px_1fr_72px_72px_72px_58px_68px_1.1fr] border-b px-2 py-2 font-mono text-[10px]', tone.border, tone.bg)}>
              <span className={cx('font-black', tone.accent)}>{row.label}</span>
              <span className="text-slate-200">
                {fmtNum(last, 2)}
                <span className="text-muted"> vs {fmtNum(baseline, 2)} </span>
                <span className={tone.accent}>({fmtNum(last - baseline, 2)})</span>
                <span className="ml-1 text-muted">ATR {fmtNum(location.atrValue, 2)}</span>
              </span>
              <span className="text-right text-blue-300" title={regressionTitle}>{fmtNum(finiteOptional(row.linearRegressionLower), 2)}</span>
              <span className="text-right text-amber-200" title={regressionTitle}>{fmtNum(finiteOptional(row.linearRegressionMean), 2)}</span>
              <span className="text-right text-red-300" title={regressionTitle}>{fmtNum(finiteOptional(row.linearRegressionUpper), 2)}</span>
              <span className={cx('text-right font-black', tone.accent)}>{fmtNum(location.dayZ, 2)}</span>
              <span className="text-right"><span className={cx('rounded px-1.5 py-0.5 font-black', tone.bg, tone.accent)}>{Math.round(displayNumber(row.orderFlowScore, Math.abs(displayNumber(location.z)) * 42))}</span></span>
              <span className="text-right text-muted">{location.signal}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CeriousRelativeSpreadVisualsWindow() {
  const data = useCeriousIntelligence(CERIOUS_ADVISORY_REFRESH_MS)
  const rows = data?.spreadPack?.spreads ?? []
  const macro = data?.macroRegime
  const avgFlow = rows.length ? rows.reduce((sum, row) => sum + Number(row.orderFlowScore ?? Math.abs(row.z) * 42), 0) / rows.length : 0
  return (
    <div className="h-full overflow-y-auto bg-surface p-3">
      <div className="mb-3 grid grid-cols-2 gap-2">
        <div className="rounded border border-surface-border bg-surface-card p-2">
          <FormulaLightScale value={macro?.strength ?? 50} polarity={macro?.label === 'Risk-Off' ? 'risk-off' : 'risk-on'} label="Risk-on ranking" />
        </div>
        <div className="rounded border border-surface-border bg-surface-card p-2">
          <FormulaLightScale value={avgFlow} polarity="order-flow" label="Order-flow status" />
        </div>
      </div>
      <div className="grid gap-3">
        {rows.map(row => {
          const last = finiteOptional(row.lastTraded) ?? finiteOptional(row.spread) ?? 0
          const location = liveSpreadLocation(row, last)
          const x = clamp(50 + clamp(location.z, -2, 2) * 25, 0, 100)
          const tone = spreadTone({ z: location.z })
          const baseline = location.meanValue
          const leftZone = 'linear-gradient(90deg, rgba(56,189,248,.26), rgba(56,189,248,.08), rgba(15,23,42,.45), rgba(251,113,133,.08), rgba(251,113,133,.26))'
          return (
            <div key={row.key} className={cx('rounded border p-3', tone.border, tone.bg)}>
              <div className="mb-2 flex items-center justify-between font-mono text-[11px]">
                <span className={cx('font-black', tone.accent)}>{row.label}</span>
                <span className={cx('font-black', tone.accent)}>z {fmtNum(location.z, 2)} | {tone.label}</span>
              </div>
              <div className="relative h-8 rounded border border-surface-border bg-[#05070b]" style={{ background: leftZone }}>
                <div className="absolute left-1/4 top-0 h-full w-px bg-blue-300/25" />
                <div className="absolute left-1/2 top-0 h-full w-px bg-muted/50" />
                <div className="absolute left-3/4 top-0 h-full w-px bg-red-300/25" />
                <div className="absolute top-1 h-6 w-1.5 rounded" style={{ left: `${x}%`, background: tone.fill, boxShadow: `0 0 12px ${tone.fill}` }} />
              </div>
              <div className="mt-1 flex justify-between font-mono text-[9px] text-muted"><span>-2 ATR cheap</span><span>30D Mean</span><span>+2 ATR rich</span></div>
              <div className="mt-2 grid grid-cols-5 gap-2 font-mono text-[10px] text-muted">
                <span>Last <b className="text-slate-200">{fmtNum(last, 3)}</b></span>
                <span>30D <b className="text-slate-200">{fmtNum(baseline, 3)}</b></span>
                <span>ATR <b className="text-slate-200">{fmtNum(location.atrValue, 3)}</b></span>
                <span>Vol <b className="text-slate-200">{fmtCompact(row.volume ?? 0)}</b></span>
                <span className={tone.accent}>{location.signal}</span>
              </div>
              <div className="mt-1 font-mono text-[9px] text-muted">
                Session anchor {fmtNum(location.vwapBasis, 3)} | 3/30 ATR {fmtNum(row.atr3, 3)} / {fmtNum(row.atr30 ?? row.atr20, 3)} | Lin Reg {fmtNum(row.linearRegressionMean, 2)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CeriousSpreadConfigurationsWindow() {
  const data = useCeriousIntelligence(CERIOUS_ADVISORY_REFRESH_MS)
  const rows = data?.spreadPack?.spreads ?? []
  const fallbackConfigs: CeriousSpreadConfig[] = CERIOUS_SPREAD_PRODUCTS.map(product => ({
    symbol: product.symbol,
    label: product.label,
    meaning: 'Waiting for spread configuration service.',
    legA: product.symbol.split('_')[0] ?? '',
    legB: product.symbol.split('_')[1] ?? '',
    ttRatio: '-',
    displayFormula: product.legs.replace(' x ', ' * '),
    syntheticTickValue: 0,
    leftMultiplier: 0,
    rightMultiplier: 0,
    ratio: 0,
  }))
  const configs = data?.spreadConfigs?.length ? data.spreadConfigs : fallbackConfigs
  const symbols = useMemo(
    () => [...new Set([...configs.map(config => config.symbol), ...rows.map(row => row.key)].filter(Boolean))],
    [configs, rows],
  )
  useCmeMarketDataSubscriptions(symbols)
  const polyBooks = useStore(s => s.polyBooks)
  const polyTicks = useStore(s => s.polyTicks)
  const spreadByKey = useMemo(() => new Map(rows.map(row => [row.key, row])), [rows])

  return (
    <div className="flex h-full flex-col bg-surface text-xs">
      <div className="grid grid-cols-[92px_1.2fr_96px_86px_88px_88px_88px_88px] border-b border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] font-black uppercase text-muted">
        <span>Spread</span><span>Formula</span><span>Ratio</span><span className="text-right">Tick</span><span className="text-right">Last</span><span className="text-right">Bid</span><span className="text-right">Ask</span><span className="text-right">Lin Reg Mid</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {configs.map(config => {
          const stat = spreadByKey.get(config.symbol)
          const book = polyBooks[config.symbol]
          const ticks = polyTicks[config.symbol] ?? []
          const fallbackLast = finiteOptional(book?.ltp) ?? finiteOptional(book?.up_pct) ?? finiteOptional(stat?.lastTraded) ?? finiteOptional(stat?.spread) ?? 0
          const last = stat ? liveSpreadLast(stat, polyBooks, polyTicks) : fallbackLast
          const location = liveSpreadLocation(stat ?? { mean: last, atr: 0 }, last)
          const tone = spreadTone({ z: location.dayZ })
          const bid = finiteOptional(book?.best_bid)
          const ask = finiteOptional(book?.best_ask)
          const isLive = Boolean(book || ticks.length || stat?.live)
          return (
            <div key={config.symbol} className={cx('grid grid-cols-[92px_1.2fr_96px_86px_88px_88px_88px_88px] border-b px-2 py-2 font-mono text-[10px]', tone.border, isLive ? tone.bg : 'bg-surface')}>
              <span className={cx('font-black', tone.accent)}>
                {config.label}
                <span className="ml-1 text-[8px] text-muted">{isLive ? 'LIVE' : 'WAIT'}</span>
              </span>
              <span className="truncate text-slate-200" title={config.meaning}>{config.displayFormula}</span>
              <span className="truncate text-muted" title={config.meaning}>{config.ttRatio}</span>
              <span className="text-right text-slate-200">{config.syntheticTickValue ? fmtMoney(config.syntheticTickValue) : '-'}</span>
              <span className={cx('text-right font-black', tone.accent)}>{fmtNum(last, 2)}</span>
              <span className="text-right text-blue-300">{fmtNum(bid, 2)}</span>
              <span className="text-right text-red-300">{fmtNum(ask, 2)}</span>
              <span className="text-right text-amber-200">{fmtNum(finiteOptional(stat?.linearRegressionMean), 2)}</span>
            </div>
          )
        })}
        {!configs.length && <div className="p-4 text-center font-mono text-[10px] text-muted">Waiting for spread configuration service.</div>}
      </div>
    </div>
  )
}

function CeriousRelativeSpreadSvg({ stat }: { stat: CeriousSpreadStat }) {
  const width = 420
  const height = 170
  const left = 38
  const right = 14
  const top = 18
  const bottom = 28
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const points = (stat.bars ?? []).slice(-90).filter(row => Number.isFinite(row.close))
  if (points.length < 2) return <div className="p-4 text-[11px] text-muted">Need more bars for {stat.label}.</div>
  const closes = points.map(row => Number(row.close))
  const last = points[points.length - 1]
  const liveLast = finiteOptional(stat.lastTraded) ?? finiteOptional(stat.spread) ?? Number(last.close)
  const meanValue = Number(stat.mean)
  const upper = meanValue + 2 * Number(stat.atr)
  const lower = meanValue - 2 * Number(stat.atr)
  const values = [...closes, liveLast, meanValue, upper, lower].filter(Number.isFinite)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const x = (index: number) => left + (points.length <= 1 ? 0 : (index / (points.length - 1)) * plotWidth)
  const y = (value: number) => top + ((max - value) / span) * plotHeight
  const line = points.map((row, index) => `${x(index).toFixed(1)},${y(Number(row.close)).toFixed(1)}`).join(' ')
  const firstDate = new Date(points[0].timestamp).toLocaleDateString()
  const lastDate = new Date(last.timestamp).toLocaleDateString()
  const horizontal = (value: number, color: string, label: string, dash: string) => {
    const yy = y(value)
    return (
      <g key={label}>
        <line x1={left} y1={yy} x2={left + plotWidth} y2={yy} stroke={color} strokeWidth={1} strokeDasharray={dash} />
        <text x={left + plotWidth - 4} y={Math.max(12, yy - 3)} textAnchor="end" fill={color} fontSize={10}>{label}</text>
      </g>
    )
  }
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${stat.label} spread chart`} className="h-full w-full">
      <rect x={0} y={0} width={width} height={height} fill="rgba(8,13,20,.18)" />
      <line x1={left} y1={top} x2={left} y2={top + plotHeight} stroke="rgba(142,160,180,.32)" />
      <line x1={left} y1={top + plotHeight} x2={left + plotWidth} y2={top + plotHeight} stroke="rgba(142,160,180,.32)" />
      {horizontal(upper, 'rgba(255,204,102,.72)', '+2 ATR', '4 4')}
      {horizontal(meanValue, 'rgba(142,160,180,.72)', 'Mean', '3 3')}
      {horizontal(lower, 'rgba(77,163,255,.72)', '-2 ATR', '4 4')}
      <polyline points={line} fill="none" stroke="#7dd3fc" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(points.length - 1)} cy={y(Number(last.close))} r={3.5} fill="#e6f1ff" />
      <circle cx={x(points.length - 1)} cy={y(liveLast)} r={4.5} fill="#facc15" stroke="#05070b" strokeWidth={1.2} />
      <text x={left} y={height - 8} fill="rgba(230,241,255,.62)" fontSize={10}>{firstDate}</text>
      <text x={left + plotWidth} y={height - 8} textAnchor="end" fill="rgba(230,241,255,.62)" fontSize={10}>{lastDate}</text>
    </svg>
  )
}

function CeriousRelativeSpreadChartsWindow() {
  const data = useCeriousIntelligence(CERIOUS_ADVISORY_REFRESH_MS)
  const rows = data?.spreadPack?.spreads ?? []
  return (
    <div className="h-full overflow-y-auto bg-surface p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-[10px] text-muted">Daily synthetic closes with 30-session mean and +/-2 blended ATR bands. Forecast rails update on completed study history.</div>
        <span className="rounded border border-accent/30 bg-accent/10 px-2 py-1 font-mono text-[10px] font-bold text-accent">{rows.length} spreads</span>
      </div>
      <div className="grid gap-3">
        {rows.map(stat => {
          const bars = stat.bars ?? []
          const liveLast = finiteOptional(stat.lastTraded) ?? finiteOptional(stat.spread) ?? finiteOptional(bars[bars.length - 1]?.close) ?? 0
          const location = liveSpreadLocation(stat, liveLast)
          const liveStat = { ...stat, spread: liveLast, lastTraded: liveLast, z: location.z, dayZ: location.dayZ, signal: location.signal }
          return (
            <div key={stat.key} className="rounded border border-surface-border bg-surface-card p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-mono text-[12px] font-black text-slate-100">{liveStat.label}</h3>
                <span className={cx('font-mono text-[10px] font-black', displayNumber(liveStat.z) >= 0 ? 'text-down' : 'text-up')}>z {fmtNum(liveStat.z, 2)}</span>
              </div>
              <div className="h-44 rounded border border-surface-border bg-[#05070b]">
                <CeriousRelativeSpreadSvg stat={liveStat} />
              </div>
              <div className="mt-2 flex justify-between font-mono text-[10px] text-muted">
                <span>{bars.length} bars</span>
                <span>{finiteOptional(liveLast) !== undefined ? `${fmtNum(liveLast, 3)} live | ${liveStat.signal}` : 'Waiting'}</span>
              </div>
            </div>
          )
        })}
        {!rows.length && <div className="rounded border border-surface-border bg-surface-card p-4 text-center text-muted">Loading chart data...</div>}
      </div>
    </div>
  )
}

function CeriousStreamingNewsWindow() {
  const { data, error } = useCeriousEndpoint<CeriousNewsState>('/api/cerious/news', 60000)
  const items = data?.items ?? []
  const statusClass = data?.status === 'ok' ? 'bg-blue-500/15 text-blue-300 border-blue-500/35' : 'bg-amber-500/15 text-amber-300 border-amber-500/35'
  return (
    <div className="flex h-full flex-col bg-surface text-xs">
      <div className="flex items-center justify-between gap-2 border-b border-surface-border bg-surface-panel px-3 py-2">
        <span className={cx('rounded border px-2 py-1 font-mono text-[10px] font-black uppercase', statusClass)}>
          {error || (data?.status === 'ok' ? `News stream ${data.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString() : 'active'}` : 'Waiting')}
        </span>
        <span className="font-mono text-[10px] text-muted">{items.length} headlines | {data?.publicSourcesLive ?? 0}/{data?.publicSourcesExpected ?? 0} public feeds</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="grid gap-2">
          {items.slice(0, 18).map(item => (
            <div key={item.id} className="rounded border border-surface-border bg-surface-card p-2">
              <div className="font-bold leading-snug text-slate-100">
                {item.link ? <a href={item.link} target="_blank" rel="noreferrer" className="hover:text-accent">{item.title}</a> : item.title}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1 font-mono text-[9px]">
                <span className={cx('rounded px-1.5 py-0.5 font-black uppercase', item.urgency === 'high' ? 'bg-red-500/15 text-red-300' : 'bg-blue-500/15 text-blue-300')}>{item.urgency ?? 'normal'}</span>
                <span className={cx('rounded px-1.5 py-0.5 font-black uppercase', item.bias === 'risk-off' ? 'bg-red-500/15 text-red-300' : item.bias === 'risk-on' ? 'bg-blue-500/15 text-blue-300' : 'bg-amber-500/15 text-amber-300')}>{item.bias ?? 'mixed'}</span>
                <span className="text-muted">{item.source} | {item.pubDate ? new Date(item.pubDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'new'}</span>
              </div>
            </div>
          ))}
          {!items.length && <div className="rounded border border-surface-border bg-surface-card p-4 text-center text-muted">Waiting for incoming financial headlines.</div>}
        </div>
      </div>
    </div>
  )
}

function CeriousAuditTrailWindow() {
  const { data, error } = useCeriousEndpoint<CeriousAuditState>('/api/cerious/audit', 5000)
  const [channel, setChannel] = useState('')
  const [severity, setSeverity] = useState('')
  const entries = (data?.entries ?? []).filter(entry => (!channel || entry.channel === channel) && (!severity || entry.severity === severity))
  const channels = Array.from(new Set((data?.entries ?? []).map(entry => entry.channel))).sort()
  return (
    <div className="flex h-full flex-col bg-surface text-xs">
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-border bg-surface-panel px-2 py-1">
        <select className="input-field h-8 w-36 py-1 text-[10px]" value={channel} onChange={event => setChannel(event.target.value)}>
          <option value="">All channels</option>
          {channels.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
        <select className="input-field h-8 w-32 py-1 text-[10px]" value={severity} onChange={event => setSeverity(event.target.value)}>
          <option value="">All severities</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>
        <span className="ml-auto font-mono text-[10px] text-muted">{error || `${data?.entries.length ?? 0} retained event(s), showing ${entries.length}`}</span>
      </div>
      <div className="grid grid-cols-[82px_54px_64px_96px_112px_1fr] border-b border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] font-black uppercase text-muted">
        <span>Time</span><span>Seq</span><span>Severity</span><span>Channel</span><span>Type</span><span>Summary</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.map(entry => (
          <div key={entry.id} className="grid grid-cols-[82px_54px_64px_96px_112px_1fr] border-b border-surface-border/60 px-2 py-1.5 font-mono text-[10px]">
            <span className="text-muted">{new Date(entry.timestamp).toLocaleTimeString()}</span>
            <span className="truncate text-muted">{entry.sequence ?? '-'}</span>
            <span className={cx('font-black uppercase', entry.severity === 'error' ? 'text-down' : entry.severity === 'warn' ? 'text-amber-300' : 'text-blue-300')}>{entry.severity}</span>
            <span className="truncate text-accent">{entry.channel}</span>
            <span className="truncate text-slate-200">{entry.type}</span>
            <span className="text-muted">{entry.summary}</span>
          </div>
        ))}
        {!entries.length && <div className="p-4 text-center text-muted">No audit events match the current filters.</div>}
      </div>
    </div>
  )
}

function CeriousMacroRegimeWindow() {
  const { data, error } = useCeriousEndpoint<CeriousMacroState>('/api/cerious/macro-regime', CERIOUS_ADVISORY_REFRESH_MS)
  const rows = data?.factorRows ?? []
  const regimeTone = data?.label === 'Risk-Off' ? 'risk-off' : 'risk-on'
  const orderFlow = rows.length ? clamp(rows.reduce((sum, row) => sum + Math.abs(row.value) * row.weight * 100, 0), 0, 100) : 0
  return (
    <div className="h-full overflow-y-auto bg-surface p-3 text-xs">
      <div className="grid grid-cols-3 gap-2">
        {[
          ['Regime', data?.label ?? 'Waiting'],
          ['Score', data ? `${data.strength}/100` : '-'],
          ['Approach', data?.algo ?? '-'],
        ].map(([label, value]) => (
          <div key={label} className="rounded border border-surface-border bg-surface-card p-2">
            <div className="text-[9px] font-bold uppercase text-muted">{label}</div>
            <div className="mt-1 font-mono text-[13px] font-black text-accent">{value}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded border border-surface-border bg-surface-card p-2">
          <FormulaLightScale value={data?.strength ?? 50} polarity={regimeTone} label="Risk-on ranking" />
        </div>
        <div className="rounded border border-surface-border bg-surface-card p-2">
          <FormulaLightScale value={orderFlow} polarity="order-flow" label="Factor pressure" />
        </div>
      </div>
      <div className="mt-3 rounded border border-accent/30 bg-accent/10 p-3 text-[11px] leading-relaxed text-slate-200">{error || data?.read || 'Macro regime engine is waiting for market data.'}</div>
      <div className="mt-3 grid gap-2">
        {rows.map(row => {
          const pct = clamp((row.value + 1) * 50, 0, 100)
          const tone = row.value >= 0.15 ? 'bg-blue-400' : row.value <= -0.15 ? 'bg-red-400' : 'bg-amber-300'
          return (
            <div key={row.key} className="rounded border border-surface-border bg-surface-card p-2">
              <div className="mb-1 flex justify-between font-mono text-[10px]">
                <span className="font-black uppercase text-slate-100">{row.key}</span>
                <span className={row.value >= 0 ? 'text-blue-300' : 'text-down'}>{fmtNum(row.value, 2)} | w {fmtPct(row.weight)}</span>
              </div>
              <div className="h-2 rounded bg-[#05070b]"><div className={cx('h-full rounded', tone)} style={{ width: `${pct}%` }} /></div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CeriousOpportunityMapWindow() {
  const { data, error } = useCeriousEndpoint<CeriousOpportunityState>('/api/cerious/opportunity-map', CERIOUS_ADVISORY_REFRESH_MS)
  const rows = data?.rows ?? []
  const playbookRows = data?.playbookRows ?? []
  const productRows = data?.productRows ?? []
  const riskRows = data?.riskChecklistRows ?? []
  return (
    <div className="h-full overflow-y-auto bg-surface text-xs">
      <div className="border-b border-surface-border bg-surface-panel px-3 py-2 font-mono text-[10px] text-muted">{error || 'Cross-spread ranking from z-location, leadership confirmation, regime, source breadth, and liquidity.'}</div>
      <div className="grid grid-cols-[90px_66px_70px_1fr_1.2fr] border-b border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] font-black uppercase text-muted">
        <span>Spread</span><span>Score</span><span>Z</span><span>Expression</span><span>Risk Check</span>
      </div>
      <div>
        {rows.map(row => (
          <div key={row.key} className="grid grid-cols-[90px_66px_70px_1fr_1.2fr] border-b border-surface-border/60 px-2 py-2 font-mono text-[10px]">
            <span className="font-black text-accent">{row.label}</span>
            <span className={cx('font-black', row.score >= 65 ? 'text-blue-300' : row.score >= 45 ? 'text-amber-300' : 'text-muted')}>{row.score}/100</span>
            <span className={row.z >= 0 ? 'text-down' : 'text-up'}>{fmtNum(row.z, 2)}</span>
            <span className="text-slate-200">{row.expression}</span>
            <span className="text-muted">{row.risk}</span>
          </div>
        ))}
        {!rows.length && <div className="p-4 text-center text-muted">Waiting for spread scores.</div>}
      </div>
      {!!playbookRows.length && (
        <div className="mt-3 overflow-hidden rounded border border-surface-border">
          <div className="grid grid-cols-[1fr_1.35fr_1fr_1.2fr] border-b border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] font-black uppercase text-muted">
            <span>Signal Combination</span><span>Market Interpretation</span><span>Clean Expression</span><span>Risk Check</span>
          </div>
          {playbookRows.map(row => (
            <div key={row.signalCombination} className="grid grid-cols-[1fr_1.35fr_1fr_1.2fr] border-b border-surface-border/60 px-2 py-2 font-mono text-[10px]">
              <span className="text-slate-100">{row.signalCombination}</span>
              <span className="text-muted">{row.interpretation}</span>
              <span className="text-accent">{row.expression}</span>
              <span className="text-muted">{row.risk}</span>
            </div>
          ))}
        </div>
      )}
      {!!productRows.length && (
        <div className="mt-3 overflow-hidden rounded border border-surface-border">
          <div className="grid grid-cols-[86px_1fr_1fr_1.2fr] border-b border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] font-black uppercase text-muted">
            <span>Spread</span><span>Formula / Tag</span><span>Expression</span><span>Nuance</span>
          </div>
          {productRows.map(row => (
            <div key={row.spread} className="grid grid-cols-[86px_1fr_1fr_1.2fr] border-b border-surface-border/60 px-2 py-2 font-mono text-[10px]">
              <span className="font-black text-accent">{row.spread}</span>
              <span className="text-muted">{row.formula || row.tag}</span>
              <span className="text-slate-200">{row.buy} / {row.sell}</span>
              <span className="text-muted">{row.nuance}</span>
            </div>
          ))}
        </div>
      )}
      {!!riskRows.length && (
        <div className="mt-3 grid gap-2 p-3">
          {riskRows.map(row => (
            <div key={row.risk} className="rounded border border-surface-border bg-surface-card p-2">
              <div className="font-mono text-[10px] font-black text-slate-100">{row.risk}</div>
              <div className="mt-1 text-[11px] leading-relaxed text-muted">{row.control}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CeriousTradeAnalyticsWindow() {
  const { data, error } = useCeriousEndpoint<CeriousTradeAnalyticsState>('/api/cerious/trade-analytics', 10000)
  const [imported, setImported] = useState<CeriousTradeAnalyticsState | null>(() => loadImportedTradeAnalytics())
  const [importStatus, setImportStatus] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)
  const active = imported ?? (data ? { ...data, source: 'live' as const } : null)
  const metrics = active?.metrics
  const curve = active?.curve ?? []
  const maxEquity = Math.max(...curve.map(point => point.equity), metrics?.accountSize ?? 1)
  const minEquity = Math.min(...curve.map(point => point.equity), metrics?.accountSize ?? 0)
  const span = maxEquity - minEquity || 1
  const equityLine = curve.map((point, index) => {
    const x = curve.length <= 1 ? 0 : (index / (curve.length - 1)) * 100
    const y = 80 - ((point.equity - minEquity) / span) * 70
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const maxDrawdown = Math.max(...curve.map(point => point.maxDrawdown), metrics?.drawdown ?? 0, 1)
  const drawdownLine = curve.map((point, index) => {
    const x = curve.length <= 1 ? 0 : (index / (curve.length - 1)) * 100
    const y = 12 + (point.drawdown / maxDrawdown) * 66
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const riskLevel = active?.riskLevel ?? 'Waiting'
  const miniBars = metrics
    ? [
        { label: 'Win rate', pct: clamp(metrics.winRate * 100, 0, 100), value: fmtPct(metrics.winRate) },
        { label: 'Return/risk', pct: clamp(Math.abs(metrics.sharpe) * 25, 0, 100), value: fmtNum(metrics.sharpe, 2) },
        { label: 'Account return', pct: clamp(metrics.returnPct * 1000, 0, 100), value: fmtPct(metrics.returnPct) },
        { label: 'Drawdown', pct: clamp(100 - (metrics.drawdown / (metrics.accountSize || TRADE_ANALYTICS_ACCOUNT_SIZE)) * 5000, 0, 100), value: fmtMoney(metrics.drawdown) },
      ]
    : []
  const productTotals = active?.productTotals ?? []
  const report = active?.report ?? (metrics ? buildTradeAnalyticsReport(metrics, active?.records ?? []) : [])

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const text = await file.text()
      const next = analyzeTradeAnalyticsCsv(text, file.name)
      window.localStorage.setItem(TRADE_ANALYTICS_IMPORT_KEY, JSON.stringify(next))
      setImported(next)
      setImportStatus(next.status)
    } catch (err) {
      setImportStatus(err instanceof Error ? err.message : 'Import failed')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const clearImport = () => {
    window.localStorage.removeItem(TRADE_ANALYTICS_IMPORT_KEY)
    setImported(null)
    setImportStatus('Imported fills cleared; live fill journal is active.')
  }

  return (
    <div className="h-full overflow-y-auto bg-surface p-3 text-xs">
      <div className="mb-3 grid gap-2 border border-surface-border bg-surface-card p-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={cx('rounded border px-2 py-1 font-mono text-[10px] font-black uppercase', riskLevel === 'Controlled' ? 'border-blue-500/35 bg-blue-500/15 text-blue-300' : riskLevel === 'High' ? 'border-red-500/35 bg-red-500/15 text-red-300' : 'border-amber-500/35 bg-amber-500/15 text-amber-300')}>{riskLevel} Risk</span>
          <span className="font-mono text-[10px] text-muted">
            {imported ? `Imported file: ${imported.filename ?? 'fills.csv'}` : 'Live fill journal'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="btn-accent cursor-pointer px-3 py-2 text-[11px]">
            Import Fills
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt"
              className="hidden"
              onChange={event => handleImportFile(event.currentTarget.files?.[0])}
            />
          </label>
          <button className="btn-neutral px-3 py-2 text-[11px]" onClick={clearImport} disabled={!imported}>Use Live Journal</button>
          <span className={cx('font-mono text-[10px]', importStatus || error ? 'text-amber-300' : 'text-muted')}>{importStatus || error || active?.status || 'Analyzer ready.'}</span>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {[
          ['Rows', fmtInt(metrics?.rows)],
          ['Account', fmtMoney(metrics?.accountSize)],
          ['Total P&L', fmtMoney(metrics?.total)],
          ['Return', fmtPct(metrics?.returnPct)],
          ['Win Rate', fmtPct(metrics?.winRate)],
          ['Max Drawdown', `${fmtMoney(metrics?.drawdown)} (${fmtPct(metrics?.drawdownPct)})`],
          ['Sharpe', fmtNum(metrics?.sharpe, 2)],
          ['Sortino', fmtNum(metrics?.sortino, 2)],
          ['Calmar', fmtNum(metrics?.calmar, 2)],
          ['Profit Factor', fmtNum(metrics?.profitFactor, 2)],
          ['Expectancy', fmtMoney(metrics?.expectancy)],
        ].map(([label, value]) => (
          <div key={label} className="rounded border border-surface-border bg-surface-card p-2">
            <div className="text-[9px] font-bold uppercase text-muted">{label}</div>
            <div className="mt-1 font-mono text-[12px] font-black text-slate-100">{value ?? '-'}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid gap-1 rounded border border-surface-border bg-surface-card p-2">
        {miniBars.length ? miniBars.map(row => (
          <div key={row.label} className="grid grid-cols-[90px_1fr_72px] items-center gap-2 font-mono text-[10px]">
            <span className="text-muted">{row.label}</span>
            <span className="h-2 overflow-hidden rounded bg-[#03070d]">
              <span className="block h-full rounded bg-blue-400" style={{ width: `${row.pct}%` }} />
            </span>
            <span className="text-right text-slate-200">{row.value}</span>
          </div>
        )) : <div className="font-mono text-[10px] text-muted">Import fills or generate live fills to populate analytics bars.</div>}
      </div>
      <div className="mt-3 rounded border border-surface-border bg-surface-card p-2">
        <div className="mb-1 flex justify-between font-mono text-[10px] text-muted">
          <span>Account Equity Curve</span>
          <span>{fmtMoney(curve[curve.length - 1]?.equity)}</span>
        </div>
        <svg viewBox="0 0 100 86" className="h-28 w-full" preserveAspectRatio="none">
          <rect x="0" y="0" width="100" height="86" fill="rgba(8,13,20,.18)" />
          {equityLine && <polyline points={equityLine} fill="none" stroke="#4da3ff" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      <div className="mt-3 rounded border border-surface-border bg-surface-card p-2">
        <div className="mb-1 flex justify-between font-mono text-[10px] text-muted">
          <span>Intraday Drawdown</span>
          <span>{fmtMoney(metrics?.drawdown)}</span>
        </div>
        <svg viewBox="0 0 100 86" className="h-24 w-full" preserveAspectRatio="none">
          <rect x="0" y="0" width="100" height="86" fill="rgba(8,13,20,.18)" />
          {drawdownLine && <polyline points={drawdownLine} fill="none" stroke="#ffcc66" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      <div className="mt-3 grid gap-2">
        {(active?.studies ?? []).map(study => (
          <div key={study.study} className="grid grid-cols-[140px_90px_1fr] rounded border border-surface-border bg-surface-card px-2 py-1.5 font-mono text-[10px]">
            <span className="font-black text-slate-100">{study.study}</span>
            <span className={study.passed ? 'text-blue-300' : 'text-amber-300'}>{study.passed ? 'Pass' : 'Review'} {study.result}</span>
            <span className="text-muted">{study.read}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded border border-surface-border bg-surface-card">
        <div className="border-b border-surface-border px-2 py-1 font-mono text-[10px] font-black uppercase text-muted">Product Contribution</div>
        <div className="grid gap-1 p-2">
          {productTotals.length ? productTotals.map(row => (
            <div key={row.instrument} className="grid grid-cols-[90px_1fr] font-mono text-[10px]">
              <span className="font-black text-slate-100">{row.instrument}</span>
              <span className={row.pnl >= 0 ? 'text-blue-300' : 'text-down'}>{fmtMoney(row.pnl)}</span>
            </div>
          )) : <div className="font-mono text-[10px] text-muted">No product rows yet.</div>}
        </div>
      </div>
      <div className="mt-3 rounded border border-surface-border bg-surface-card">
        <div className="grid grid-cols-[130px_150px_1fr] border-b border-surface-border px-2 py-1 font-mono text-[10px] font-black uppercase text-muted">
          <span>Report</span><span>Value</span><span>Read</span>
        </div>
        {report.length ? report.map(row => (
          <div key={row.label} className="grid grid-cols-[130px_150px_1fr] border-b border-surface-border/60 px-2 py-1.5 font-mono text-[10px]">
            <span className="font-black text-slate-100">{row.label}</span>
            <span className="text-slate-200">{row.value}</span>
            <span className="text-muted">{row.read}</span>
          </div>
        )) : <div className="p-3 font-mono text-[10px] text-muted">Import fills to produce a report.</div>}
      </div>
    </div>
  )
}

function CeriousNotionalCalculatorWindow() {
  const { data, error } = useCeriousEndpoint<CeriousNotionalState>('/api/cerious/notional', 5000)
  const rows = data?.rows ?? []
  return (
    <div className="flex h-full flex-col bg-surface text-xs">
      <div className="border-b border-surface-border bg-surface-panel px-3 py-2 text-[10px] text-muted">{error || 'Display value is normalized TT-style synthetic price. Basket dollar diff is actual ratio-weighted dollar notional difference.'}</div>
      <div className="grid grid-cols-[86px_1fr_92px_96px_110px_110px] border-b border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] font-black uppercase text-muted">
        <span>Spread</span><span>Meaning</span><span>Ratio</span><span>Tick Value</span><span>Display</span><span>Basket Diff</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.map(row => (
          <div key={row.symbol} className="grid grid-cols-[86px_1fr_92px_96px_110px_110px] border-b border-surface-border/60 px-2 py-2 font-mono text-[10px]">
            <span className="font-black text-accent">{row.label}</span>
            <span className="text-muted">{row.meaning}</span>
            <span className="text-slate-200">{row.ttRatio}</span>
            <span className="text-slate-200">{fmtMoney(row.syntheticTickValue)}</span>
            <span className="text-slate-100">{fmtNum(row.displayValue, 3)}</span>
            <span className={row.basketDollarDiff >= 0 ? 'text-blue-300' : 'text-down'}>{fmtMoney(row.basketDollarDiff)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const DEFAULT_MODEL_VARIANT: ModelVariantDraft = {
  name: 'Cerious-FactorStack-Monitor',
  version: 'v0.1',
  horizon: 'Intraday / 1-week',
  owner: 'Research',
  objective: 'Combine independent market, macro, positioning, news, and liquidity signals into a bounded decision-support score with explainable attribution.',
  notes: 'Baseline factor stack: trend/relative strength, volatility, rates/credit, CFTC positioning, news pressure, and liquidity checks.',
  changeLog: 'v0.1: Initial governance registry and factor-scoring process documentation.',
  reviewCriteria: 'Promote only after data-quality checks, walk-forward validation, turnover/slippage review, adverse-regime review, and live-monitoring notes.',
}

function normalizeModelVariant(raw: Partial<ModelVariantDraft> | null | undefined): ModelVariantDraft | null {
  if (!raw || typeof raw !== 'object') return null
  return {
    ...DEFAULT_MODEL_VARIANT,
    ...raw,
    name: String(raw.name || DEFAULT_MODEL_VARIANT.name),
    version: String(raw.version || DEFAULT_MODEL_VARIANT.version),
    horizon: String(raw.horizon || DEFAULT_MODEL_VARIANT.horizon),
    owner: String(raw.owner || DEFAULT_MODEL_VARIANT.owner),
    objective: String(raw.objective || DEFAULT_MODEL_VARIANT.objective),
    notes: String(raw.notes || DEFAULT_MODEL_VARIANT.notes),
    changeLog: String(raw.changeLog || DEFAULT_MODEL_VARIANT.changeLog),
    reviewCriteria: String(raw.reviewCriteria || DEFAULT_MODEL_VARIANT.reviewCriteria),
    savedAt: raw.savedAt ? String(raw.savedAt) : undefined,
    schema: raw.schema ? String(raw.schema) : 'cerious.model.variant.v1',
  }
}

function parseModelVariant(raw: string | null): ModelVariantDraft | null {
  try {
    return normalizeModelVariant(raw ? JSON.parse(raw) as Partial<ModelVariantDraft> : null)
  } catch {
    return null
  }
}

function modelVariantKey(variant: Pick<ModelVariantDraft, 'name' | 'version'>): string {
  return `${variant.name.trim().toLowerCase()}::${variant.version.trim().toLowerCase()}`
}

function modelVariantLabel(variant: ModelVariantDraft): string {
  const saved = variant.savedAt ? ` | ${new Date(variant.savedAt).toLocaleString()}` : ''
  return `${variant.name} ${variant.version}${saved}`
}

function upsertModelVariantLibrary(list: ModelVariantDraft[], next: ModelVariantDraft): ModelVariantDraft[] {
  const key = modelVariantKey(next)
  return [
    next,
    ...list.filter(item => modelVariantKey(item) !== key),
  ].sort((a, b) => (Date.parse(b.savedAt ?? '') || 0) - (Date.parse(a.savedAt ?? '') || 0))
}

function saveModelVariantLibrary(list: ModelVariantDraft[]): void {
  window.localStorage.setItem(MODEL_VARIANT_LIBRARY_KEY, JSON.stringify(list))
}

function loadModelVariantLibrary(): ModelVariantDraft[] {
  try {
    const raw = window.localStorage.getItem(MODEL_VARIANT_LIBRARY_KEY)
    const parsed = raw ? JSON.parse(raw) as Array<Partial<ModelVariantDraft>> : []
    const library = Array.isArray(parsed)
      ? parsed.map(normalizeModelVariant).filter((item): item is ModelVariantDraft => !!item)
      : []
    const current = parseModelVariant(window.localStorage.getItem(MODEL_VARIANT_KEY))
    const legacy = parseModelVariant(window.localStorage.getItem(LEGACY_CERIOUS_MODEL_VARIANT_KEY))
    let merged = library
    if (current) merged = upsertModelVariantLibrary(merged, current)
    if (legacy) merged = upsertModelVariantLibrary(merged, { ...legacy, schema: 'cerious.model.variant.v1' })
    return merged
  } catch {
    return []
  }
}

function loadModelVariantDraft(): ModelVariantDraft {
  const current = parseModelVariant(window.localStorage.getItem(MODEL_VARIANT_KEY))
  if (current) return current
  const library = loadModelVariantLibrary()
  return library[0] ?? DEFAULT_MODEL_VARIANT
}

function CeriousModelResearchGovernanceWindow() {
  const { data, error } = useCeriousEndpoint<CeriousContentState>('/api/cerious/content/modelResearchGovernance', 30000)
  const [draft, setDraft] = useState<ModelVariantDraft>(() => loadModelVariantDraft())
  const [library, setLibrary] = useState<ModelVariantDraft[]>(() => loadModelVariantLibrary())
  const [selectedVariantKey, setSelectedVariantKey] = useState(() => draft.savedAt ? modelVariantKey(draft) : '')
  const [status, setStatus] = useState(() => draft.savedAt ? `Loaded ${draft.name} ${draft.version} saved ${new Date(draft.savedAt).toLocaleString()}.` : 'No model variant saved in this browser yet.')
  const rows = data?.rows ?? CERIOUS_PANEL_DETAILS.modelResearchGovernance?.bullets.map(item => [item]) ?? []
  const sections = data?.sections ?? []
  const updateDraft = (field: keyof ModelVariantDraft, value: string) => {
    setDraft(current => ({ ...current, [field]: value }))
    setSelectedVariantKey('')
    setStatus('Draft edited. Save Variant to persist.')
  }
  const persistLibrary = (nextLibrary: ModelVariantDraft[]) => {
    saveModelVariantLibrary(nextLibrary)
    setLibrary(nextLibrary)
  }
  const loadVariant = (key: string) => {
    setSelectedVariantKey(key)
    const variant = library.find(item => modelVariantKey(item) === key)
    if (!variant) return
    window.localStorage.setItem(MODEL_VARIANT_KEY, JSON.stringify(variant))
    setDraft(variant)
    setStatus(`Loaded ${variant.name} ${variant.version}${variant.savedAt ? ` saved ${new Date(variant.savedAt).toLocaleString()}` : ''}.`)
  }
  const saveDraft = () => {
    const next = { ...draft, savedAt: new Date().toISOString(), schema: 'cerious.model.variant.v1' }
    const nextLibrary = upsertModelVariantLibrary(library, next)
    persistLibrary(nextLibrary)
    window.localStorage.setItem(MODEL_VARIANT_KEY, JSON.stringify(next))
    setDraft(next)
    setSelectedVariantKey(modelVariantKey(next))
    setStatus(`Saved ${next.name || 'model'} ${next.version || ''}.`)
  }
  const deleteVariant = () => {
    if (!selectedVariantKey) return
    const deleted = library.find(item => modelVariantKey(item) === selectedVariantKey)
    const nextLibrary = library.filter(item => modelVariantKey(item) !== selectedVariantKey)
    persistLibrary(nextLibrary)
    window.localStorage.removeItem(MODEL_VARIANT_KEY)
    if (deleted?.schema === 'cerious.model.variant.v1') window.localStorage.removeItem(LEGACY_CERIOUS_MODEL_VARIANT_KEY)
    setSelectedVariantKey('')
    if (deleted && modelVariantKey(draft) === selectedVariantKey) setDraft(DEFAULT_MODEL_VARIANT)
    setStatus(deleted ? `Deleted ${deleted.name} ${deleted.version}.` : 'Variant removed.')
  }
  const clearDraft = () => {
    window.localStorage.removeItem(MODEL_VARIANT_KEY)
    setDraft(DEFAULT_MODEL_VARIANT)
    setSelectedVariantKey('')
    setStatus('Model variant draft cleared.')
  }
  return (
    <div className="h-full overflow-y-auto bg-surface p-3 text-xs">
      <div className="mb-3 rounded border border-accent/30 bg-accent/10 p-3">
        <div className="text-xs font-black uppercase tracking-wide text-slate-100">Model Research & Governance</div>
        <div className="mt-1 font-mono text-[10px] text-accent">{data?.service ?? 'knowledge.governance'}</div>
        {error && <div className="mt-2 font-mono text-[10px] text-amber-300">{error}</div>}
      </div>
      <div className="grid gap-2">
        {sections.map(section => (
          <div key={section.title} className="rounded border border-surface-border bg-surface-card p-3">
            <div className="mb-1 font-bold text-slate-100">{section.title}</div>
            <p className="text-[11px] leading-relaxed text-muted">{section.body}</p>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded border border-surface-border bg-surface-card">
        <div className="grid grid-cols-[150px_1.4fr_1fr] border-b border-surface-border px-2 py-1 font-mono text-[10px] font-black uppercase text-muted">
          <span>Stage</span><span>Process Rule</span><span>Evidence Captured</span>
        </div>
        {rows.map((row, index) => (
          <div key={`${row[0]}-${index.toString()}`} className="grid grid-cols-[150px_1.4fr_1fr] border-b border-surface-border/60 px-2 py-2 font-mono text-[10px]">
            <span className="font-black text-slate-100">{row[0]}</span>
            <span className="text-muted">{row[1] ?? ''}</span>
            <span className="text-muted">{row[2] ?? ''}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2">
        {[
          ['name', 'Model Name'],
          ['version', 'Version'],
          ['horizon', 'Horizon'],
          ['owner', 'Owner / Reviewer'],
        ].map(([field, label]) => (
          <label key={field} className="grid gap-1 rounded border border-surface-border bg-surface-card p-2">
            <span className="font-mono text-[9px] font-black uppercase text-muted">{label}</span>
            <input
              className="input-field py-1 text-[11px]"
              value={String(draft[field as keyof ModelVariantDraft] ?? '')}
              onChange={event => updateDraft(field as keyof ModelVariantDraft, event.currentTarget.value)}
            />
          </label>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {[
          ['objective', 'Research Objective'],
          ['notes', 'Variant Notes'],
          ['changeLog', 'Change Log'],
          ['reviewCriteria', 'Review Criteria'],
        ].map(([field, label]) => (
          <label key={field} className="grid gap-1 rounded border border-surface-border bg-surface-card p-2">
            <span className="font-mono text-[9px] font-black uppercase text-muted">{label}</span>
            <textarea
              className="input-field min-h-[88px] resize-y py-2 text-[11px] leading-relaxed"
              value={String(draft[field as keyof ModelVariantDraft] ?? '')}
              onChange={event => updateDraft(field as keyof ModelVariantDraft, event.currentTarget.value)}
            />
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          className="input-field h-8 min-w-[260px] py-1 text-[10px] font-bold"
          value={selectedVariantKey}
          onChange={event => loadVariant(event.currentTarget.value)}
        >
          <option value="">Load Variant...</option>
          {library.map(variant => (
            <option key={modelVariantKey(variant)} value={modelVariantKey(variant)}>
              {modelVariantLabel(variant)}
            </option>
          ))}
        </select>
        <button className="btn-accent px-3 py-2 text-[11px]" onClick={saveDraft}>Save Variant</button>
        <button className="btn-neutral px-3 py-2 text-[11px]" onClick={deleteVariant} disabled={!selectedVariantKey}>Delete Variant</button>
        <button className="btn-neutral px-3 py-2 text-[11px]" onClick={clearDraft}>Clear Draft</button>
        <span className="rounded border border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] text-slate-300">{library.length} saved</span>
        <span className="font-mono text-[10px] text-muted">{status}</span>
      </div>
      <p className="mt-3 rounded border border-surface-border bg-surface-card p-2 font-mono text-[10px] leading-relaxed text-muted">
        Naming convention: CERIOUS-[SignalFamily]-[Horizon]-[Variant]-vMajor.Minor. Material methodology, feature, weight, threshold, data-source, or execution-policy changes require a new version.
      </p>
    </div>
  )
}

function CeriousContentWindow({ kind }: { kind: WorkspaceWindowKind }) {
  const { data, error } = useCeriousEndpoint<CeriousContentState>(`/api/cerious/content/${kind}`, 30000)
  const details = CERIOUS_PANEL_DETAILS[kind]
  return (
    <div className="h-full overflow-y-auto bg-surface p-3">
      <div className="mb-3 rounded border border-accent/30 bg-accent/10 p-3">
        <div className="text-xs font-black uppercase tracking-wide text-slate-100">{WINDOW_LABELS[kind]}</div>
        <div className="mt-1 font-mono text-[10px] text-accent">{data?.service ?? details?.service ?? 'terminal.workspace'}</div>
      </div>
      {error && <div className="mb-3 rounded border border-down/30 bg-down/10 p-2 font-mono text-[10px] text-down">{error}</div>}
      <div className="grid gap-2">
        {(data?.sections ?? []).map(section => (
          <div key={section.title} className="rounded border border-surface-border bg-surface-card p-3">
            <div className="mb-1 font-bold text-slate-100">{section.title}</div>
            <p className="text-[11px] leading-relaxed text-muted">{section.body}</p>
          </div>
        ))}
        {(data?.rows ?? []).map((row, index) => (
          <div key={`${kind}-${index.toString()}`} className="grid gap-1 rounded border border-surface-border bg-surface-card p-2 font-mono text-[10px] text-muted">
            <div className="font-black text-slate-100">{row[0]}</div>
            {row.slice(1).map((cell, cellIndex) => <div key={`${index.toString()}-${cellIndex.toString()}`}>{cell}</div>)}
          </div>
        ))}
        {!data?.sections?.length && !data?.rows?.length && (
          <p className="text-[11px] leading-relaxed text-slate-300">{details?.body ?? 'Window registered; service content pending.'}</p>
        )}
      </div>
    </div>
  )
}

function CeriousPositionsOrdersWindow() {
  const { data, error, refresh } = useCeriousPositionsOrders()
  const options = useProductOptions()
  const simOrders = useStore(s => s.simOrders)
  const simPositions = useStore(s => s.simPositions)
  const fillsByMarket = useStore(s => s.fills)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<'instrument' | 'qty' | 'openPnl' | 'updated'>('instrument')
  const [actionStatus, setActionStatus] = useState('')
  const query = filter.trim().toLowerCase()

  const productByKey = useMemo(() => productLookup(options), [options])

  const livePositionRows = useMemo(
    () => simPositions
      .filter(position => position.status === 'open')
      .map(position => simPositionToCeriousPositionRow(position, productByKey.get(position.marketKey))),
    [productByKey, simPositions],
  )

  const liveOrderRows = useMemo(
    () => simOrders
      .filter(order => order.status === 'working' || order.status === 'partially_filled')
      .map(order => simOrderToCeriousOrderRow(order, productByKey.get(order.marketKey))),
    [productByKey, simOrders],
  )

  const liveOrderIds = useMemo(() => new Set(simOrders.map(order => order.id)), [simOrders])

  const liveFillCount = useMemo(
    () => Object.values(fillsByMarket).reduce(
      (total, fills) => total + fills.filter(fill => isAccountFillTick(fill as unknown as Record<string, unknown>)).length,
      0,
    ),
    [fillsByMarket],
  )

  const liveUpdatedMs = useMemo(() => {
    let latest = 0
    for (const order of simOrders) latest = Math.max(latest, Number(order.updatedAt) || 0)
    for (const position of simPositions) latest = Math.max(latest, Number(position.closedAt ?? position.openedAt) || 0)
    for (const fills of Object.values(fillsByMarket)) {
      for (const fill of fills) latest = Math.max(latest, Number(fill.timestamp) || 0)
    }
    return latest
  }, [fillsByMarket, simOrders, simPositions])

  const allPositionRows = useMemo(() => {
    const rows = new Map<string, CeriousPositionRow>()
    for (const position of data?.positions ?? []) {
      const safePosition = normalizeCeriousPositionRow(position as Partial<CeriousPositionRow> & Record<string, unknown>)
      rows.set(`backend-${safePosition.instrumentId}-${safePosition.account ?? ''}-${safePosition.label ?? ''}`, safePosition)
    }
    for (const position of livePositionRows) {
      const safePosition = normalizeCeriousPositionRow(position as Partial<CeriousPositionRow> & Record<string, unknown>)
      rows.set(`sim-${safePosition.instrumentId}-${safePosition.account ?? ''}-${safePosition.label ?? ''}`, safePosition)
    }
    return [...rows.values()]
  }, [data?.positions, livePositionRows])

  const allOrderRows = useMemo(() => {
    const rows = new Map<string, CeriousOrderRow>()
    for (const order of data?.orders ?? []) {
      const safeOrder = normalizeCeriousOrderRow(order as Partial<CeriousOrderRow> & Record<string, unknown>)
      rows.set(safeOrder.id, safeOrder)
    }
    for (const order of liveOrderRows) {
      const safeOrder = normalizeCeriousOrderRow(order as Partial<CeriousOrderRow> & Record<string, unknown>)
      rows.set(safeOrder.id, safeOrder)
    }
    return [...rows.values()]
  }, [data?.orders, liveOrderRows])

  const rowMatches = (row: Record<string, unknown>) => {
    if (!query) return true
    return Object.values(row).some(value => String(value ?? '').toLowerCase().includes(query))
  }

  const positions = useMemo(() => {
    const rows = allPositionRows.filter(row => rowMatches(row as unknown as Record<string, unknown>))
    return rows.slice().sort((a, b) => {
      if (sort === 'qty') return Math.abs(b.qty || 0) - Math.abs(a.qty || 0)
      if (sort === 'openPnl') return (b.openPnl || 0) - (a.openPnl || 0)
      if (sort === 'updated') return Date.parse(b.lastFillAt || '') - Date.parse(a.lastFillAt || '')
      return String(a.instrumentId || '').localeCompare(String(b.instrumentId || ''))
    })
  }, [allPositionRows, query, sort])

  const orders = useMemo(() => {
    const rows = allOrderRows.filter(row => rowMatches(row as unknown as Record<string, unknown>))
    return rows.slice().sort((a, b) => {
      if (sort === 'qty') return Math.abs(b.qty || 0) - Math.abs(a.qty || 0)
      if (sort === 'updated') return Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || '')
      return String(a.instrumentId || '').localeCompare(String(b.instrumentId || ''))
    })
  }, [allOrderRows, query, sort])

  const cancelOrder = async (orderId: string) => {
    if (!orderId || orderId === '-') return
    if (liveOrderIds.has(orderId)) {
      try {
        await cancelSharedOrder(orderId)
        setActionStatus(`Cancelled order ${orderId}`)
      } catch (err) {
        setActionStatus(`Cancel failed ${orderId}: ${err instanceof Error ? err.message : 'gateway unavailable'}`)
      }
      return
    }
    setActionStatus(`Cancel requested for ${orderId}`)
    try {
      const response = await ceriousFetch(`/api/cerious/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await refresh()
      setActionStatus(`Cancel routed for ${orderId}`)
    } catch (err) {
      setActionStatus(`Cancel failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  const cancelAll = async () => {
    setActionStatus('Cancel-all requested')
    try {
      const response = await ceriousFetch('/api/cerious/orders/cancel-all', { method: 'POST' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (payload.state) {
        useStore.getState().setSimTradingState({
          simOrders: payload.state.simOrders,
          simPositions: payload.state.simPositions,
          fills: payload.state.fills,
          simMessages: payload.state.simMessages,
        })
      }
      await refresh()
      const backendCount = Number(payload.count ?? 0)
      setActionStatus(`Cancel-all routed for ${backendCount || orders.length} working order(s)`)
    } catch (err) {
      setActionStatus(`Cancel-all failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  const summary = useMemo(() => {
    const openPnl = allPositionRows.reduce((total, position) => total + Number(position.openPnl || 0), 0)
    const liveRealizedPnl = livePositionRows.reduce((total, position) => total + Number(position.realizedPnl || 0), 0)
    const closedPnl = Number(data?.summary?.closedPnl || 0) + liveRealizedPnl
    return {
      positionCount: allPositionRows.length,
      workingOrderCount: allOrderRows.filter(order => /working|partial|open|held|queued|staged/i.test(order.status) && !/cancel|filled|reject/i.test(order.status)).length,
      fillCount: Math.max(Number(data?.summary?.fillCount || 0), liveFillCount),
      openPnl,
      closedPnl,
      totalPnl: openPnl + closedPnl,
    }
  }, [allOrderRows, allPositionRows, data?.summary, liveFillCount, livePositionRows])

  const updatedMs = Math.max(Date.parse(data?.fetchedAt || '') || 0, liveUpdatedMs)
  const updated = updatedMs ? new Date(updatedMs).toLocaleTimeString() : '-'

  return (
    <div className="flex h-full flex-col bg-surface text-xs">
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-border bg-surface-panel px-2 py-1">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted" size={13} />
          <input
            className="input-field h-8 w-full pl-7 pr-7 text-[11px]"
            value={filter}
            onChange={event => setFilter(event.target.value)}
            placeholder="Product, side, status"
          />
          {filter && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-slate-100"
              onClick={() => setFilter('')}
              title="Clear filter"
            >
              <X size={13} />
            </button>
          )}
        </div>
        <select className="input-field h-8 w-32 py-1 text-[10px]" value={sort} onChange={event => setSort(event.target.value as typeof sort)}>
          <option value="instrument">Instrument</option>
          <option value="qty">Qty</option>
          <option value="openPnl">Open P&amp;L</option>
          <option value="updated">Updated</option>
        </select>
        <button className="btn-neutral h-8 px-2 text-[10px]" onClick={() => refresh()}>Refresh</button>
        <button className="btn-danger h-8 px-2 text-[10px]" onClick={cancelAll} disabled={!orders.length}>CXL ALL</button>
      </div>

      <div className="grid grid-cols-4 gap-2 border-b border-surface-border bg-[#07101b] p-2 font-mono">
        <div className="rounded border border-surface-border bg-surface-card p-2">
          <div className="text-[9px] font-bold uppercase text-muted">Open P&amp;L</div>
          <div className={cx('mt-1 text-[13px] font-black', (summary?.openPnl ?? 0) >= 0 ? 'text-up' : 'text-down')}>{fmtMoney(summary?.openPnl ?? 0)}</div>
        </div>
        <div className="rounded border border-surface-border bg-surface-card p-2">
          <div className="text-[9px] font-bold uppercase text-muted">Closed P&amp;L</div>
          <div className={cx('mt-1 text-[13px] font-black', (summary?.closedPnl ?? 0) >= 0 ? 'text-up' : 'text-down')}>{fmtMoney(summary?.closedPnl ?? 0)}</div>
        </div>
        <div className="rounded border border-surface-border bg-surface-card p-2">
          <div className="text-[9px] font-bold uppercase text-muted">Positions</div>
          <div className="mt-1 text-[13px] font-black text-slate-100">{positions.length} / {summary?.positionCount ?? 0}</div>
        </div>
        <div className="rounded border border-surface-border bg-surface-card p-2">
          <div className="text-[9px] font-bold uppercase text-muted">Working Orders</div>
          <div className="mt-1 text-[13px] font-black text-accent">{orders.length} / {summary?.workingOrderCount ?? 0}</div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <div className="min-h-0 overflow-hidden border-b border-surface-border">
          <div className="grid grid-cols-[1.2fr_74px_90px_90px_100px] border-b border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] font-black uppercase text-muted">
            <span>Product</span><span className="text-right">Contracts</span><span className="text-right">Avg</span><span className="text-right">Mark</span><span className="text-right">Open P&amp;L</span>
          </div>
          <div className="h-[calc(100%-25px)] overflow-y-auto">
            {positions.map(position => {
              const qty = Number(position.qty) || 0
              const pnl = Number(position.openPnl) || 0
              return (
                <div key={`${position.instrumentId}-${position.account ?? ''}-${position.label ?? ''}`} className="grid grid-cols-[1.2fr_74px_90px_90px_100px] items-center border-b border-surface-border/60 px-2 py-1.5 font-mono text-[10px]">
                  <div className="min-w-0">
                    <div className="truncate font-black text-slate-100">{position.instrumentId}</div>
                    <div className="truncate text-[9px] text-muted">{position.label ?? position.account ?? '-'}</div>
                  </div>
                  <span
                    className={cx('justify-self-end rounded border px-2 py-0.5 font-black', qty === 0 && 'border-surface-border text-muted')}
                    style={qty > 0
                      ? { borderColor: 'rgba(0, 140, 255, .7)', backgroundColor: 'rgba(0, 140, 255, .24)', color: '#66e8ff' }
                      : qty < 0
                        ? { borderColor: 'rgba(255, 23, 68, .7)', backgroundColor: 'rgba(255, 23, 68, .24)', color: '#ff8fa3' }
                        : undefined}
                  >
                    {qty > 0 ? '+' : ''}{qty.toFixed(Number.isInteger(qty) ? 0 : 2)}
                  </span>
                  <span className="text-right text-slate-200">{fmtNum(position.avgPrice, 2)}</span>
                  <span className={cx('text-right', position.markLive ? 'text-accent' : 'text-muted')}>{fmtNum(position.markPrice, 2)}</span>
                  <span className={cx('text-right font-black', pnl >= 0 ? 'text-up' : 'text-down')}>{fmtMoney(pnl)}</span>
                </div>
              )
            })}
            {!positions.length && (
              <div className="p-4 text-center text-muted">No open positions.</div>
            )}
          </div>
        </div>

        <div className="min-h-0 overflow-hidden">
          <div className="grid grid-cols-[1.1fr_90px_58px_72px_80px_92px_88px] border-b border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] font-black uppercase text-muted">
            <span>Order</span><span>Product</span><span className="text-right">Side</span><span className="text-right">Contracts</span><span className="text-right">Price</span><span>Status</span><span className="text-right">Action</span>
          </div>
          <div className="h-[calc(100%-25px)] overflow-y-auto">
            {orders.map(order => {
              const isBuy = /^buy/i.test(order.side)
              const tag = order.algoName || order.orderType || order.source || 'Manual'
              return (
                <div key={`${order.id}-${order.instrumentId}`} className="grid grid-cols-[1.1fr_90px_58px_72px_80px_92px_88px] items-center border-b border-surface-border/60 px-2 py-1.5 font-mono text-[10px]">
                  <div className="min-w-0">
                    <div className="truncate font-black text-slate-100">{order.id}</div>
                    <div className="truncate text-[9px] text-muted">{tag}</div>
                  </div>
                  <span className="truncate text-accent">{order.instrumentId}</span>
                  <span
                    className="justify-self-end rounded border px-1.5 py-0.5 font-black"
                    style={isBuy
                      ? { borderColor: 'rgba(0, 140, 255, .7)', backgroundColor: 'rgba(0, 140, 255, .24)', color: '#66e8ff' }
                      : { borderColor: 'rgba(255, 23, 68, .7)', backgroundColor: 'rgba(255, 23, 68, .24)', color: '#ff8fa3' }}
                  >
                    {order.side || '-'}
                  </span>
                  <span className="text-right text-slate-200">{fmtNum(order.qty, 0)}</span>
                  <span className="text-right text-slate-200">{fmtNum(order.price, 2)}</span>
                  <span className={cx('truncate', order.held ? 'text-amber-300' : 'text-muted')}>{order.held ? `${order.status} / Held` : order.status}</span>
                  <button className="btn-danger justify-self-end px-2 py-1 text-[10px]" onClick={() => cancelOrder(order.id)}>CXL</button>
                </div>
              )
            })}
            {!orders.length && (
              <div className="p-4 text-center text-muted">No open orders.</div>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-surface-border bg-surface-panel px-2 py-1 font-mono text-[9px] text-muted">
        <span>{positions.length} open position row(s), {orders.length} open order ticket(s). Qty/contracts stay separate from order count.</span>
        <span className={cx(error ? 'text-down' : actionStatus ? 'text-accent' : 'text-muted')}>{error || actionStatus || `Updated ${updated}`}</span>
      </div>
    </div>
  )
}

function CeriousIncomingWindow({ kind }: { kind: WorkspaceWindowKind }) {
  const details = CERIOUS_PANEL_DETAILS[kind] ?? {
    service: 'terminal.workspace',
    body: 'Incoming Cerious window is registered in the launcher and ready for deeper service wiring.',
    bullets: ['Local source payload preserved', 'React window registered', 'Service boundary pending'],
  }
  return (
    <div className="h-full overflow-y-auto bg-surface p-3">
      <div className="mb-3 rounded border border-accent/30 bg-accent/10 p-3">
        <div className="text-xs font-black uppercase tracking-wide text-slate-100">{WINDOW_LABELS[kind]}</div>
        <div className="mt-1 font-mono text-[10px] text-accent">{details.service}</div>
      </div>
      <p className="text-[11px] leading-relaxed text-slate-300">{details.body}</p>
      <div className="mt-3 grid gap-2">
        {details.bullets.map(item => (
          <div key={item} className="rounded border border-surface-border bg-surface-card px-3 py-2 font-mono text-[10px] text-muted">
            {item}
          </div>
        ))}
      </div>
    </div>
  )
}

function renderWindowBody(
  item: WorkspaceWindow,
  props: {
    marketRows: MarketRowConfig[]
    setMarketRows: React.Dispatch<React.SetStateAction<MarketRowConfig[]>>
    selectedProvider: ProviderKey
    selectedSymbol: string
    operatorName: string
    selectProduct: (provider: ProviderKey, symbol: string) => void
    selectWindowProduct: (id: string, provider: ProviderKey, symbol: string) => void
    alerts: AlertRule[]
    setAlerts: React.Dispatch<React.SetStateAction<AlertRule[]>>
    cloneChart: () => void
    cloneRunway: () => void
    updateWindowChartSettings: (id: string, settings: CeriousChartSettings) => void
    updateWindowDepthLadderSettings: (id: string, settings: DepthLadderSettings) => void
    saveDepthLadderDefaultForWindow: (id: string, settings: DepthLadderSettings) => void
  },
) {
  const provider = normalizeProviderKey(item.provider ?? props.selectedProvider)
  const symbol = item.symbol ?? props.selectedSymbol
  const selectForWindow = (nextProvider: ProviderKey, nextSymbol: string) => {
    props.selectWindowProduct(item.id, nextProvider, nextSymbol)
    props.selectProduct(nextProvider, nextSymbol)
  }

  if (isRemovedWindowKind(item.kind)) return null
  if (item.kind === 'marketData') return <MarketDataWindow rows={props.marketRows} setRows={props.setMarketRows} />
  if (item.kind === 'depthLadder') return (
    <NormalDepthLadderWindow
      provider={provider}
      symbol={symbol}
      onSelect={selectForWindow}
      operatorName={props.operatorName}
      settings={item.depthLadderSettings}
      onSettingsChange={settings => props.updateWindowDepthLadderSettings(item.id, settings)}
      onSaveDefault={settings => props.saveDepthLadderDefaultForWindow(item.id, settings)}
    />
  )
  if (item.kind === 'depthTrader') return <CeriousDepthTraderWindow symbol={symbol} onSelect={selectForWindow} operatorName={props.operatorName} />
  if (item.kind === 'depthTraderEsNq') return <CeriousDepthTraderWindow symbol="ES_NQ" onSelect={selectForWindow} operatorName={props.operatorName} />
  if (item.kind === 'depthTraderYmEs') return <CeriousDepthTraderWindow symbol="YM_ES" onSelect={selectForWindow} operatorName={props.operatorName} />
  if (item.kind === 'depthTraderRtyEs') return <CeriousDepthTraderWindow symbol="RTY_ES" onSelect={selectForWindow} operatorName={props.operatorName} />
  if (item.kind === 'mdTraderEs') return <CeriousDepthTraderWindow symbol="ES" onSelect={selectForWindow} operatorName={props.operatorName} />
  if (item.kind === 'positionsOrders') return <CeriousPositionsOrdersWindow />
  if (item.kind === 'order') return <OrderBookWindow operatorName={props.operatorName} />
  if (item.kind === 'fills') return <FillsWindow operatorName={props.operatorName} />
  if (item.kind === 'alerts') return <AlertsWindow alerts={props.alerts} setAlerts={props.setAlerts} />
  if (item.kind === 'algoBuilder') return <AlgoBuilderWindow provider={provider} symbol={symbol} operatorName={props.operatorName} onSelect={selectForWindow} />
  if (item.kind === 'algoManager') return <AlgoManagerWindow />
  if (item.kind === 'charts') return <CeriousSingleChartWindow provider={provider} symbol={symbol} onSelect={selectForWindow} settings={item.chartSettings} onSettingsChange={settings => props.updateWindowChartSettings(item.id, settings)} />
  if (item.kind === 'liquidityMap') return <LiquidityMapWindow />
  if (item.kind === 'spreadConfigurations') return <CeriousSpreadConfigurationsWindow />
  if (item.kind === 'relativeSpreadCharts') return <CeriousRelativeSpreadChartsWindow />
  if (item.kind === 'dailySummary') return <CeriousDailySummaryWindow />
  if (item.kind === 'goose') return <CeriousGooseWindow />
  if (item.kind === 'liveSpreadSignals') return <CeriousLiveSpreadSignalsWindow />
  if (item.kind === 'relativeSpreadVisuals') return <CeriousRelativeSpreadVisualsWindow />
  if (item.kind === 'streamingNews') return <CeriousStreamingNewsWindow />
  if (item.kind === 'tradeAnalytics') return <CeriousTradeAnalyticsWindow />
  if (item.kind === 'auditTrail') return <CeriousAuditTrailWindow />
  if (item.kind === 'notionalCalculator') return <CeriousNotionalCalculatorWindow />
  if (item.kind === 'macroRegimeSummary') return <CeriousMacroRegimeWindow />
  if (item.kind === 'crossSpreadOpportunityMap') return <CeriousOpportunityMapWindow />
  if (
    item.kind === 'liveApiArchitecture'
    || item.kind === 'atrZScoreEngine'
    || item.kind === 'executionRules'
    || item.kind === 'orderLayeringTechniques'
    || item.kind === 'moneyManagement'
    || item.kind === 'riskChecklist'
    || item.kind === 'sourceNotes'
  ) return <CeriousContentWindow kind={item.kind} />
  if (item.kind === 'modelResearchGovernance') return <CeriousModelResearchGovernanceWindow />
  if (item.kind === 'fixMonitor') return <FixMonitor />
  if (CERIOUS_PANEL_DETAILS[item.kind]) return <CeriousIncomingWindow kind={item.kind} />
  return <ServiceMapWindow />
}

export function WorkspaceDesktop() {
  useMarketBootstrap()
  useCeriousTradingStateHydrator()
  const serviceReadiness = useCeriousServiceReadiness()
  const initialWorkspace = useMemo(() => {
    const workspace = loadActiveWorkspace()
    if (workspace) applyWorkspaceAlgoSnapshot(workspace)
    return workspace
  }, [])

  const [windows, setWindows] = useState<WorkspaceWindow[]>(() => {
    return initialWorkspace?.windows ?? defaultWindows('cme')
  })
  const [viewportSize, setViewportSize] = useState(() => ({
    width: typeof window === 'undefined' ? 1440 : window.innerWidth,
    height: typeof window === 'undefined' ? 900 : window.innerHeight,
  }))
  const [workspacePan, setWorkspacePan] = useState({ x: 0, y: 0 })
  const mainRef = useRef<HTMLElement | null>(null)
  const workspacePanRef = useRef(workspacePan)
  const edgePointerRef = useRef<{ x: number; y: number } | null>(null)
  const panFrameRef = useRef<number | null>(null)
  const [marketRows, setMarketRows] = useState<MarketRowConfig[]>(() => {
    return initialWorkspace?.rows ?? []
  })
  const [operatorName, setOperatorName] = useState(initialWorkspace?.operator ?? DEFAULT_OPERATOR)
  const [workspaceName, setWorkspaceName] = useState(initialWorkspace?.name ?? 'Cerious CME Desk')
  const [saved, setSaved] = useState<SavedWorkspace[]>(() => {
    const list = loadSavedWorkspaces()
    if (!initialWorkspace) return list
    const exists = list.some(item => workspaceKey(item.operator, item.name) === workspaceKey(initialWorkspace.operator, initialWorkspace.name))
    return exists ? list : upsertSavedWorkspace(list, initialWorkspace)
  })
  const [selectedProvider, setSelectedProvider] = useState<ProviderKey>(normalizeProviderKey(initialWorkspace?.selectedProvider))
  const [selectedSymbol, setSelectedSymbol] = useState(initialWorkspace?.selectedSymbol ?? 'ES')
  const [saveStatus, setSaveStatus] = useState('')
  const [systemMenuOpen, setSystemMenuOpen] = useState(false)
  const [widgetToAdd, setWidgetToAdd] = useState<WorkspaceWindowKind>('marketData')
  const [alerts, setAlerts] = useState<AlertRule[]>(() => initialWorkspace?.alerts ?? [])
  const setProvider = useStore(s => s.setMarketProvider)
  const simulationEnabled = useStore(s => s.simulationEnabled)
  const setSimulationEnabled = useStore(s => s.setSimulationEnabled)
  const simOrdersForSystemActions = useStore(s => s.simOrders)
  const workingOrderCountForSystemActions = simOrdersForSystemActions.filter(order => (
    order.remaining > 0
    && (order.status === 'working' || order.status === 'partially_filled')
  )).length

  const resetServerTradingSession = async () => {
    const orderWarning = workingOrderCountForSystemActions
      ? ` You currently have ${workingOrderCountForSystemActions} working order${workingOrderCountForSystemActions === 1 ? '' : 's'} visible in the workspace.`
      : ' No working orders are visible in the workspace.'
    const resetMessage = simulationEnabled
      ? `Reset the SIM trading workspace?${orderWarning} This clears simulated working orders, simulated fills, simulated positions, and simulated P&L. A backup of the fill journal will be kept.`
      : `Reset the server trading runtime?${orderWarning} This clears runtime order state and requires backend confirmation. The fill journal remains server-owned.`
    const accepted = window.confirm(resetMessage)
    if (!accepted) return
    setSaveStatus('Reset requested')
    try {
      const response = await ceriousFetch('/api/cerious/session/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: simulationEnabled ? 'toolbar simulation reset' : 'toolbar reset',
          confirm: 'RESET_TRADING_SESSION',
          scope: simulationEnabled ? 'simulation' : 'runtime',
          clearFills: simulationEnabled,
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload.ok) throw new Error(String(payload.detail || payload.message || `HTTP ${response.status}`))
      if (payload.state) {
        useStore.getState().setSimTradingState({
          simOrders: payload.state.simOrders,
          simPositions: payload.state.simPositions,
          fills: payload.state.fills,
          simMessages: payload.state.simMessages,
        })
      }
      setSaveStatus(payload.fillsCleared ? 'SIM workspace reset; fills cleared' : 'Runtime reset')
    } catch (err) {
      setSaveStatus(`Reset failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  const lockWorkspace = () => {
    setSystemMenuOpen(false)
    setSaveStatus('Workspace locked')
    window.dispatchEvent(new CustomEvent('cerious-auth-lock', {
      detail: { reason: 'Workspace locked. Orders and services remain active.' },
    }))
  }

  const logoutWorkspace = async () => {
    setSystemMenuOpen(false)
    try {
      await ceriousFetch('/api/auth/logout', { method: 'POST' })
    } catch {
      // Local logout is client-owned; backend logout is best-effort until server session revocation exists.
    }
    setSaveStatus('Logged out')
    window.dispatchEvent(new CustomEvent('cerious-auth-lock', {
      detail: { reason: 'Logged out. Log in to relaunch the workspace.' },
    }))
  }

  const shutdownSystem = async () => {
    setSystemMenuOpen(false)
    const orderWarning = workingOrderCountForSystemActions
      ? ` You currently have ${workingOrderCountForSystemActions} working order${workingOrderCountForSystemActions === 1 ? '' : 's'}.`
      : ' No working orders are visible in the workspace.'
    const accepted = window.confirm(`Shutdown Cerious services?${orderWarning} Shutdown does not cancel working orders. Use CXL ALL or KILL ALL separately if you want to cancel orders first.`)
    if (!accepted) return
    setSaveStatus('Shutdown requested')
    try {
      const response = await ceriousFetch('/api/system/shutdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'toolbar shutdown', confirm: 'SHUTDOWN_CERIOUS' }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload.ok) throw new Error(String(payload.detail || payload.message || `HTTP ${response.status}`))
      window.dispatchEvent(new CustomEvent('cerious-auth-lock', {
        detail: { reason: 'Cerious shutdown requested. Open http://127.0.0.1:8000/ when ready.' },
      }))
    } catch (err) {
      setSaveStatus(`Shutdown failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  useEffect(() => {
    let cancelled = false
    const restoreRecoveredWorkspace = async () => {
      const [recovered, serverSaved] = await Promise.all([
        fetchRecoveredWorkspaces(),
        fetchServerSavedWorkspaces(),
      ])
      const availableWorkspaces = [...serverSaved, ...recovered]
      if (cancelled || !availableWorkspaces.length) return
      const latestRecovered = Array.from(availableWorkspaces.reduce((map, item) => {
        const key = workspaceKey(item.operator, item.name)
        const existing = map.get(key)
        if (!existing || item.updatedAt > existing.updatedAt) map.set(key, item)
        return map
      }, new Map<string, SavedWorkspace>()).values())
      const recoveredTedSDefault = recovered
        .filter(item => workspaceKey(item.operator, item.name) === workspaceKey(DEFAULT_OPERATOR, 'Ted S'))
        .find(item => item.recoveredFrom === TED_S_DEFAULT_RECOVERY_FILE)
      const latestTedSByDate = latestRecovered
        .filter(item => workspaceKey(item.operator, item.name) === workspaceKey(DEFAULT_OPERATOR, 'Ted S'))
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      const latestTedS = latestTedSByDate ?? recoveredTedSDefault

      setSaved(current => {
        const base = latestTedS
          ? current.filter(item => workspaceKey(item.operator, item.name) !== workspaceKey(DEFAULT_OPERATOR, 'Ted'))
          : current
        const merged = latestRecovered.reduce((list, item) => upsertSavedWorkspace(list, item), base)
        window.localStorage.setItem(WORKSPACE_NAMES_KEY, JSON.stringify(merged))
        return merged
      })

      if (!latestTedS) return
      const activeKey = workspaceKey(operatorName.trim() || DEFAULT_OPERATOR, workspaceName.trim() || '')
      const activeUpdatedAt = Number(initialWorkspace?.updatedAt || 0)
      const shouldActivateTedS =
        activeKey === workspaceKey(DEFAULT_OPERATOR, 'Ted')
        || activeKey === workspaceKey(DEFAULT_OPERATOR, 'Cerious CME Desk')
        || latestTedS.updatedAt > activeUpdatedAt
      if (!shouldActivateTedS) return

      const activated = { ...latestTedS, updatedAt: Date.now() }
      setOperatorName(activated.operator)
      setWorkspaceName(activated.name)
      setWindows(activated.windows)
      setMarketRows(activated.rows)
      setAlerts(activated.alerts ?? [])
      applyWorkspaceAlgoSnapshot(activated)
      const nextProvider = normalizeProviderKey(activated.selectedProvider)
      setProvider(nextProvider)
      setSelectedProvider(nextProvider)
      if (activated.selectedSymbol) setSelectedSymbol(activated.selectedSymbol)
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(activated))
      window.localStorage.setItem(DEFAULT_WORKSPACE_KEY, JSON.stringify(activated))
      setSaveStatus(`Recovered ${activated.name}`)
    }
    restoreRecoveredWorkspace()
    return () => {
      cancelled = true
    }
  // Run once on launch to restore browser-profile workspace snapshots recovered from Chrome storage.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    window.localStorage.setItem(WORKSPACE_NAMES_KEY, JSON.stringify(saved))
  }, [saved])

  useEffect(() => {
    const payload: SavedWorkspace = {
      name: workspaceName.trim() || 'Untitled Workspace',
      operator: operatorName.trim() || DEFAULT_OPERATOR,
      windows,
      rows: marketRows,
      alerts,
      algoLibrary: loadAlgoLibrary(),
      algoManager: loadAlgoManagerWorkspaceState(),
      selectedProvider,
      selectedSymbol,
      updatedAt: Date.now(),
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }, [alerts, marketRows, operatorName, selectedProvider, selectedSymbol, windows, workspaceName])

  useEffect(() => {
    if (window.localStorage.getItem(DEFAULT_WORKSPACE_KEY)) return
    const initial: SavedWorkspace = {
      name: workspaceName.trim() || 'Cerious CME Desk',
      operator: operatorName.trim() || DEFAULT_OPERATOR,
      windows,
      rows: marketRows,
      alerts,
      algoLibrary: loadAlgoLibrary(),
      algoManager: loadAlgoManagerWorkspaceState(),
      selectedProvider,
      selectedSymbol,
      updatedAt: Date.now(),
    }
    const merged = upsertSavedWorkspace(saved, initial)
    setSaved(merged)
    persistWorkspaceSnapshot(initial, merged, true, 'initial default workspace')
  // Run only once to seed a missing default from the current desktop state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!saveStatus) return
    const id = window.setTimeout(() => setSaveStatus(''), 1800)
    return () => window.clearTimeout(id)
  }, [saveStatus])

  const maxZ = useMemo(() => Math.max(1, ...windows.map(item => item.z)), [windows])
  const workspaceBounds = useMemo(() => {
    const width = windows.reduce((max, item) => Math.max(max, item.x + item.w + 96), viewportSize.width)
    const height = windows.reduce((max, item) => Math.max(max, item.y + (item.collapsed ? 34 : item.h) + 96), viewportSize.height)
    return { width, height }
  }, [viewportSize.height, viewportSize.width, windows])
  const viewportSizeRef = useRef(viewportSize)
  const workspaceBoundsRef = useRef(workspaceBounds)
  const activeWorkspaceKey = workspaceKey(operatorName.trim() || DEFAULT_OPERATOR, workspaceName.trim() || 'Untitled Workspace')

  useEffect(() => {
    const onResize = () => setViewportSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    viewportSizeRef.current = viewportSize
  }, [viewportSize])

  useEffect(() => {
    workspaceBoundsRef.current = workspaceBounds
  }, [workspaceBounds])

  useEffect(() => {
    workspacePanRef.current = workspacePan
  }, [workspacePan])

  const getWorkspaceViewportRect = () => {
    const rect = mainRef.current?.getBoundingClientRect()
    if (!rect) return null
    const top = rect.top + WORKSPACE_HEADER_HEIGHT
    const bottom = rect.bottom - WORKSPACE_FOOTER_HEIGHT
    const height = Math.max(1, bottom - top)
    return {
      left: rect.left,
      right: rect.right,
      top,
      bottom,
      width: rect.width,
      height,
    }
  }

  const clampWorkspacePan = (x: number, y: number) => {
    const bounds = workspaceBoundsRef.current
    const viewport = viewportSizeRef.current
    const rect = getWorkspaceViewportRect()
    const viewWidth = rect?.width ?? viewport.width
    const viewHeight = rect?.height ?? viewport.height
    const maxX = Math.max(0, bounds.width - viewWidth)
    const maxY = Math.max(0, bounds.height - viewHeight)
    return { x: clamp(x, 0, maxX), y: clamp(y, 0, maxY) }
  }

  useEffect(() => {
    setWorkspacePan(current => {
      const next = clampWorkspacePan(current.x, current.y)
      return next.x === current.x && next.y === current.y ? current : next
    })
  // Keep the visible desktop inside the virtual canvas as windows or viewport size change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportSize.height, viewportSize.width, workspaceBounds.height, workspaceBounds.width])

  useEffect(() => {
    return () => {
      if (panFrameRef.current !== null) window.cancelAnimationFrame(panFrameRef.current)
    }
  }, [])

  const panWorkspaceBy = (dx: number, dy: number) => {
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return { x: 0, y: 0 }
    let applied = { x: 0, y: 0 }
    setWorkspacePan(current => {
      const next = clampWorkspacePan(current.x + dx, current.y + dy)
      workspacePanRef.current = next
      applied = { x: next.x - current.x, y: next.y - current.y }
      return next.x === current.x && next.y === current.y ? current : next
    })
    return applied
  }

  const stopWorkspaceEdgePan = () => {
    edgePointerRef.current = null
    if (panFrameRef.current !== null) {
      window.cancelAnimationFrame(panFrameRef.current)
      panFrameRef.current = null
    }
  }

  const stepWorkspaceEdgePan = () => {
    const pointer = edgePointerRef.current
    const main = mainRef.current
    if (!pointer || !main) {
      panFrameRef.current = null
      return
    }

    const rect = main.getBoundingClientRect()
    const viewportRect = getWorkspaceViewportRect() ?? rect
    const edge = WORKSPACE_EDGE_PAN_ZONE
    const maxSpeed = 72
    const minSpeed = 6
    let dx = 0
    let dy = 0
    const speedFromDepth = (depth: number) => {
      const t = clamp(depth / edge, 0, 1)
      return minSpeed + (t * t * maxSpeed)
    }
    const rightDepth = pointer.x >= viewportRect.right
      ? edge
      : Math.max(0, pointer.x - (viewportRect.right - edge))
    const leftDepth = pointer.x <= viewportRect.left
      ? edge
      : Math.max(0, (viewportRect.left + edge) - pointer.x)
    const bottomDepth = pointer.y >= viewportRect.bottom
      ? edge
      : Math.max(0, pointer.y - (viewportRect.bottom - edge))
    const topDepth = pointer.y <= viewportRect.top
      ? edge
      : Math.max(0, (viewportRect.top + edge) - pointer.y)

    if (rightDepth > 0) {
      dx = speedFromDepth(rightDepth)
    } else if (leftDepth > 0) {
      dx = -speedFromDepth(leftDepth)
    }

    if (bottomDepth > 0) {
      dy = speedFromDepth(bottomDepth)
    } else if (topDepth > 0) {
      dy = -speedFromDepth(topDepth)
    }

    if (dx === 0 && dy === 0) {
      stopWorkspaceEdgePan()
      return
    }

    panWorkspaceBy(dx, dy)
    panFrameRef.current = window.requestAnimationFrame(stepWorkspaceEdgePan)
  }

  const startWorkspaceEdgePan = () => {
    if (panFrameRef.current === null) {
      panFrameRef.current = window.requestAnimationFrame(stepWorkspaceEdgePan)
    }
  }

  const handleWorkspacePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.buttons !== 0) return
    const rect = getWorkspaceViewportRect()
    if (!rect) {
      stopWorkspaceEdgePan()
      return
    }
    const inHoverEdge =
      event.clientX <= rect.left + WORKSPACE_HOVER_PAN_ZONE
      || event.clientX >= rect.right - WORKSPACE_HOVER_PAN_ZONE
      || event.clientY <= rect.top + WORKSPACE_HOVER_PAN_ZONE
      || event.clientY >= rect.bottom - WORKSPACE_HOVER_PAN_ZONE
    if (!inHoverEdge) {
      stopWorkspaceEdgePan()
      return
    }
    edgePointerRef.current = { x: event.clientX, y: event.clientY }
    startWorkspaceEdgePan()
  }

  const handleWindowDragPointerMove = (event: PointerEvent) => {
    const rect = getWorkspaceViewportRect()
    const edge = WORKSPACE_EDGE_PAN_ZONE
    if (
      rect
      && event.clientX > rect.left + edge
      && event.clientX < rect.right - edge
      && event.clientY > rect.top + edge
      && event.clientY < rect.bottom - edge
    ) {
      stopWorkspaceEdgePan()
      return
    }
    edgePointerRef.current = { x: event.clientX, y: event.clientY }
    startWorkspaceEdgePan()
  }

  const handleWorkspaceWheel = (event: ReactWheelEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    const overWindow = Boolean(target.closest('[data-window-frame="true"]'))
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY)
    if (!event.altKey && !event.shiftKey && (!horizontal || overWindow)) return
    event.preventDefault()
    const dx = event.shiftKey && !horizontal ? event.deltaY : event.deltaX
    const dy = event.altKey ? event.deltaY : 0
    panWorkspaceBy(dx, dy)
  }

  const bringForward = (id: string) => {
    setWindows(current => current.map(item => item.id === id ? { ...item, z: maxZ + 1 } : item))
  }

  const moveWindow = (id: string, x: number, y: number) => {
    setWindows(current => current.map(item => item.id === id ? { ...item, x, y } : item))
  }

  const resizeWindow = (id: string, patch: Partial<Pick<WorkspaceWindow, 'x' | 'y' | 'w' | 'h'>>) => {
    setWindows(current => current.map(item => item.id === id ? { ...item, ...patch } : item))
  }

  const toggleCollapse = (id: string) => {
    setWindows(current => current.map(item => item.id === id ? { ...item, collapsed: !item.collapsed } : item))
  }

  const closeWindow = (id: string) => {
    setWindows(current => current.filter(item => item.id !== id))
  }

  const cloneWindow = (id: string) => {
    setWindows(current => {
      const source = current.find(item => item.id === id)
      if (!source) return current
      const cloneCount = current.filter(item => item.kind === source.kind).length + 1
      const clone: WorkspaceWindow = {
        ...source,
        id: `${source.kind}-clone-${Date.now()}`,
        title: `${WINDOW_LABELS[source.kind]} ${cloneCount}`,
        x: Math.max(8, source.x + 34),
        y: Math.max(48, source.y + 34),
        z: Math.max(1, ...current.map(item => item.z)) + 1,
        collapsed: false,
        chartSettings: source.chartSettings ? { ...source.chartSettings, studies: source.chartSettings.studies.map(study => ({ ...study })) } : undefined,
        depthLadderSettings: source.depthLadderSettings ? normalizeDepthLadderSettings(source.depthLadderSettings) : undefined,
      }
      return [...current, clone]
    })
  }

  const addWindow = (
    kind: WorkspaceWindowKind,
    template?: WorkspaceTemplate,
    providerOverride: ProviderKey = selectedProvider,
    symbolOverride: string = selectedSymbol,
  ) => {
    const seed = defaultWindows(template ?? 'cme').find(item => item.kind === kind)
    const id = `${kind}-${Date.now()}`
    const count = windows.filter(item => item.kind === kind).length
    const nextSymbol = defaultSymbolForWindowKind(kind, symbolOverride)
    const pan = workspacePanRef.current
    setWindows(current => [
      ...current,
      {
        ...(seed ?? win(kind, 80, 80, 520, 360, maxZ + 1, template)),
        id,
        title: count > 0 ? `${WINDOW_LABELS[kind]} ${count + 1}` : WINDOW_LABELS[kind],
        x: pan.x + 60 + count * 34,
        y: pan.y + 70 + count * 34,
        z: maxZ + 1,
        collapsed: false,
        provider: providerOverride,
        symbol: nextSymbol,
        depthLadderSettings: kind === 'depthLadder' ? loadDepthLadderDefaultSettings() : undefined,
      },
    ])
  }

  const saveWorkspace = async () => {
    const next: SavedWorkspace = {
      name: workspaceName.trim() || 'Untitled Workspace',
      operator: operatorName.trim() || DEFAULT_OPERATOR,
      windows,
      rows: marketRows,
      alerts,
      algoLibrary: loadAlgoLibrary(),
      algoManager: loadAlgoManagerWorkspaceState(),
      selectedProvider,
      selectedSymbol,
      updatedAt: Date.now(),
    }
    const merged = upsertSavedWorkspace(saved, next)
    setSaved(merged)
    persistWorkspaceSnapshot(next, merged, true, 'manual save default')
    setOperatorName(next.operator)
    setWorkspaceName(next.name)
    setSaveStatus('Saved local')
    const serverSaved = await saveWorkspaceServerSnapshot(next, 'manual save default')
    setSaveStatus(serverSaved ? 'Saved local + server' : 'Saved local; server pending')
  }

  const loadWorkspace = (operator: string, name: string) => {
    const found = saved.find(item => workspaceKey(item.operator, item.name) === workspaceKey(operator, name))
    if (!found) return
    const normalized = normalizeWorkspace(found) ?? found
    setOperatorName(normalized.operator)
    setWorkspaceName(normalized.name)
    setWindows(normalized.windows)
    setMarketRows(normalized.rows)
    setAlerts(normalized.alerts ?? [])
    applyWorkspaceAlgoSnapshot(normalized)
    if (normalized.selectedProvider) {
      const nextProvider = normalizeProviderKey(normalized.selectedProvider)
      setProvider(nextProvider)
      setSelectedProvider(nextProvider)
    }
    if (normalized.selectedSymbol) setSelectedSymbol(normalized.selectedSymbol)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...normalized, updatedAt: Date.now() }))
    setSaveStatus(`Loaded ${normalized.name}`)
  }

  const handleLoadWorkspace = (value: string) => {
    if (!value) return
    const parsed = saved.find(item => workspaceKey(item.operator, item.name) === value)
    if (parsed) loadWorkspace(parsed.operator, parsed.name)
  }

  const selectProduct = (provider: ProviderKey, symbol: string) => {
    const nextProvider = normalizeProviderKey(provider)
    setProvider(nextProvider)
    setSelectedProvider(nextProvider)
    setSelectedSymbol(symbol)
  }

  const selectWindowProduct = (id: string, provider: ProviderKey, symbol: string) => {
    const nextProvider = normalizeProviderKey(provider)
    setWindows(current => current.map(item => item.id === id ? { ...item, provider: nextProvider, symbol } : item))
  }

  const updateWindowChartSettings = (id: string, chartSettings: CeriousChartSettings) => {
    setWindows(current => current.map(item => {
      if (item.id !== id) return item
      if (JSON.stringify(item.chartSettings) === JSON.stringify(chartSettings)) return item
      return { ...item, chartSettings }
    }))
  }

  const updateWindowDepthLadderSettings = (id: string, depthLadderSettings: DepthLadderSettings) => {
    const normalized = normalizeDepthLadderSettings(depthLadderSettings)
    setWindows(current => {
      const target = current.find(item => item.id === id)
      if (!target || JSON.stringify(target.depthLadderSettings) === JSON.stringify(normalized)) return current
      return current.map(item => item.id === id ? { ...item, depthLadderSettings: normalized } : item)
    })
  }

  const saveDepthLadderDefaultForWindow = (id: string, depthLadderSettings: DepthLadderSettings) => {
    const normalized = saveDepthLadderDefaultSettings(depthLadderSettings)
    setWindows(current => current.map(item => item.kind === 'depthLadder' && item.id === id ? { ...item, depthLadderSettings: normalized } : item))
    setSaveStatus('DOM default saved')
  }

  const cloneChart = () => undefined
  const cloneRunway = () => undefined
  const serviceTone = !serviceReadiness.gatewayOk
    ? 'border-down/50 bg-down/10 text-red-200'
    : serviceReadiness.connected && serviceReadiness.priceReady
      ? 'border-[#22c55e]/50 bg-[#07120a] text-[#74ff8d]'
      : serviceReadiness.connected
        ? 'border-[#ffe800]/50 bg-[#1a1705] text-[#ffe800]'
        : 'border-surface-border bg-surface-card text-muted'
  const serviceDot = !serviceReadiness.gatewayOk
    ? 'bg-down'
    : serviceReadiness.connected && serviceReadiness.priceReady
      ? 'bg-[#22c55e]'
      : serviceReadiness.connected
        ? 'bg-[#ffe800]'
        : 'bg-muted'
  const mdStatusLabel = serviceReadiness.marketData?.connected
    ? serviceReadiness.priceReady ? 'MD Live' : 'MD Waiting'
    : 'MD Connecting'
  const execStatusLabel = serviceReadiness.executionReady ? 'SIM OK' : 'SIM Connecting'

  return (
    <div className="h-screen overflow-hidden bg-surface text-slate-100">
      <header className="absolute left-0 right-0 top-0 z-[5000] flex h-12 items-center justify-between border-b border-surface-border bg-surface-panel px-3">
        <div className="flex items-center gap-2">
          <img src={ceriousLogo} alt="Cerious Systems" className="h-8 w-8 rounded-sm border border-surface-border bg-surface object-cover" />
          <input
            value={workspaceName}
            onChange={event => setWorkspaceName(event.target.value)}
            className="w-48 rounded-sm border border-surface-border bg-surface-card px-2 py-1 text-xs font-bold text-slate-100 outline-none focus:border-accent"
            title="Workspace name"
          />
          <button className="btn-accent flex items-center gap-1 px-2 py-1 text-[11px]" onClick={saveWorkspace}>
            <Save size={13} /> Save
          </button>
          <select className="input-field w-56 py-1 text-[11px]" value={saved.some(item => workspaceKey(item.operator, item.name) === activeWorkspaceKey) ? activeWorkspaceKey : ''} onChange={event => handleLoadWorkspace(event.target.value)}>
            <option value="">Load workspace...</option>
            {saved.map(item => <option key={workspaceKey(item.operator, item.name)} value={workspaceKey(item.operator, item.name)}>{item.name}</option>)}
          </select>
          <span className={cx('w-16 font-mono text-[10px]', saveStatus ? 'text-accent' : 'text-muted')}>{saveStatus || `${saved.length} saved`}</span>
          <span
            className={cx('ml-2 flex items-center gap-1 rounded-sm border px-2 py-1 font-mono text-[10px] font-black uppercase', serviceTone)}
            title={`${serviceReadiness.detail}. Provider ${serviceReadiness.marketData?.provider ?? 'unknown'} ${serviceReadiness.marketData?.dataset ?? ''} ${serviceReadiness.marketData?.schema ?? ''}. Books: ${serviceReadiness.marketData?.bookSymbols?.join(', ') || 'waiting'}.`}
          >
            <span className={cx('h-2 w-2 rounded-full', serviceDot)} />
            <span>{mdStatusLabel}</span>
            <span className="text-slate-500">/</span>
            <span>{execStatusLabel}</span>
          </span>
          <button
            className={cx(
              'ml-2 rounded-sm border px-2 py-1 text-[11px] font-black uppercase',
              simulationEnabled ? 'border-up bg-up/15 text-up' : 'border-surface-border bg-surface-card text-muted hover:text-slate-100',
            )}
            onClick={() => setSimulationEnabled(!simulationEnabled)}
            title="When enabled, orders route to local Sim Exchange matching and live order sends are disabled."
          >
            Sim Exchange {simulationEnabled ? 'On' : 'Off'}
          </button>
          <button
            className="rounded-sm border border-surface-border bg-surface-card px-2 py-1 text-[11px] font-black uppercase text-muted hover:border-accent/50 hover:text-accent"
            onClick={resetServerTradingSession}
            title={simulationEnabled ? 'Reset SIM orders, fills, positions, and P&L after confirmation' : 'Reset server runtime after explicit confirmation. Fill/P&L journal remains backend-owned.'}
          >
            Reset Session
          </button>
          <div className="ml-2 flex items-center gap-1 rounded-sm border border-surface-border bg-surface-card p-0.5">
            <select
              className="bg-transparent px-2 py-1 text-[11px] font-bold uppercase text-slate-200 outline-none"
              value={widgetToAdd}
              onChange={event => setWidgetToAdd(event.target.value as WorkspaceWindowKind)}
              title="Add widget"
            >
              {WIDGET_MENU.map(group => (
                <optgroup key={group.group} label={group.group}>
                  {group.kinds.map(kind => <option key={kind} value={kind}>{WINDOW_LABELS[kind]}</option>)}
                </optgroup>
              ))}
            </select>
            <button className="btn-accent flex items-center gap-1 px-2 py-1 text-[11px]" onClick={() => addWindow(widgetToAdd)}>
              <Plus size={13} /> Add
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              className="flex items-center gap-1 rounded-sm border border-surface-border bg-surface-card px-2 py-1 text-[11px] font-bold uppercase text-slate-200 hover:border-accent/50 hover:text-accent"
              onClick={() => setSystemMenuOpen(open => !open)}
              title="Lock, logout, or shutdown Cerious"
            >
              <Power size={13} /> System
            </button>
            {systemMenuOpen && (
              <div className="absolute right-0 top-[calc(100%+6px)] z-[7000] w-56 border border-surface-border bg-surface-panel p-1 shadow-[0_14px_34px_rgba(0,0,0,0.42)]">
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] font-bold uppercase text-slate-200 hover:bg-surface-hover"
                  onClick={lockWorkspace}
                >
                  <Lock size={13} /> Lock Workspace
                </button>
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] font-bold uppercase text-slate-200 hover:bg-surface-hover"
                  onClick={logoutWorkspace}
                >
                  <LogOut size={13} /> Logout
                </button>
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] font-bold uppercase text-down hover:bg-down/15 hover:text-red-200"
                  onClick={shutdownSystem}
                >
                  <Power size={13} /> Shutdown
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main
        ref={mainRef}
        className="absolute inset-0 overflow-hidden"
        onPointerMove={handleWorkspacePointerMove}
        onPointerLeave={stopWorkspaceEdgePan}
        onWheel={handleWorkspaceWheel}
        style={{
          background: '#0d1014',
        }}
      >
        <div
          className="absolute left-0 top-0"
          style={{
            width: workspaceBounds.width,
            height: workspaceBounds.height,
            transform: `translate3d(${-workspacePan.x}px, ${-workspacePan.y}px, 0)`,
            transformOrigin: '0 0',
          }}
        >
          <div className="absolute inset-0 opacity-[0.16]" style={{ backgroundImage: 'linear-gradient(#3b414a 1px, transparent 1px), linear-gradient(90deg, #3b414a 1px, transparent 1px)', backgroundSize: '32px 32px' }} />
          {windows.map(item => (
              <WorkspaceWindowFrame
                key={item.id}
                item={item}
                active={item.z === maxZ}
                onActivate={() => bringForward(item.id)}
                onMove={moveWindow}
                onResize={resizeWindow}
                onToggleCollapse={() => toggleCollapse(item.id)}
                onClone={() => cloneWindow(item.id)}
                onClose={() => closeWindow(item.id)}
                getWorkspacePan={() => workspacePanRef.current}
                onDragPointerMove={handleWindowDragPointerMove}
                onDragPointerEnd={stopWorkspaceEdgePan}
              >
                {renderWindowBody(item, {
                  marketRows,
                  setMarketRows,
                  selectedProvider,
                  selectedSymbol,
                  operatorName: operatorName.trim() || DEFAULT_OPERATOR,
                  selectProduct,
                  selectWindowProduct,
                  alerts,
                  setAlerts,
                  cloneChart,
                  cloneRunway,
                  updateWindowChartSettings,
                  updateWindowDepthLadderSettings,
                  saveDepthLadderDefaultForWindow,
                })}
              </WorkspaceWindowFrame>
          ))}
        </div>
      </main>

      <footer className="absolute bottom-0 left-0 right-0 z-[5000] flex h-7 items-center justify-between border-t border-surface-border bg-surface-panel px-3 text-[10px] text-muted">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-accent"><Database size={12} /> abstraction platform</span>
          {PROVIDERS.map(provider => (
            <span key={provider.key} style={{ color: PROVIDER_COLORS[provider.key] }}>{provider.service}</span>
          ))}
        </div>
        <div />
      </footer>
    </div>
  )
}
