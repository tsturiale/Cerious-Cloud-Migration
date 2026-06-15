import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction, type WheelEvent as ReactWheelEvent } from 'react'
import {
  Activity,
  AlertTriangle,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Check,
  Copy,
  Database,
  Download,
  Folder,
  FolderOpen,
  Plus,
  Save,
  Search,
  Server,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import { useStore } from '../store'
import type { Asset, Bar, MarketInfo, PolyBook, PolyTradeTick, ProbPoint, SimOrder, SimPosition, WsMsg } from '../types'
import { GreeksEducationPanel } from './GreeksEducationPanel'
import { OrderBook2 } from './OrderBook2'
import { PolyPriceChart } from './PolyPriceChart'
import { PtbOpportunityVisual, PtbRunwayChart, type PtbRunwayProduct } from './PtbOpportunityVisual'
import { PredictionChart, type ChartDataPoint } from './PredictionChart'
import { Chart } from './Chart'
import { MultiChart } from './MultiChart'
import { PositionMonitor } from './PositionMonitor'
import { TimeAndSales } from './TimeAndSales'
import { fetchBars } from '../utils/bars'
import ceriousLogo from '../assets/branding/cerious-logo.png'
import {
  GREEK_ENGINES,
  PRODUCT_ASSETS,
  PROVIDERS,
  SERVICE_BLUEPRINT,
  providerLabel,
  type ProviderKey,
  type WorkspaceTemplate,
  type WorkspaceWindowKind,
} from '../services/workspaceServices'

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
  chartSettings?: AcmeChartSettings
  depthLadderSettings?: DepthLadderSettings
}

type ResizeDirection = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

type MarketRowConfig = {
  id: string
  provider: ProviderKey
  symbol: string
}

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

type StudyKey = 'price' | 'ptb' | 'probability' | 'truth' | 'greeks' | 'tape'
type AlertSound = 'system-chime' | 'system-bell' | 'system-alarm'
type AlgoTemplate = 'mean-reversion-v2' | 'theo-quoter' | 'scale-in' | 'ptb-trigger'
type AlgoStatus = 'draft' | 'held' | 'quoting' | 'paused'
type TheoModel = 'truth' | 'market-mid' | 'ptb-edge'
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
  outcome: 'yes' | 'no'
  side: 'bid' | 'offer' | 'both'
  orderType: 'limit' | 'market'
  theoModel: TheoModel
  quoteWidth: number
  edgeThreshold: number
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
  acmeTemplateId?: string
  acmeVersion?: string
  acmeRaw?: Record<string, unknown>
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
  period: number
  standardDeviations: number
  pegSellSideToPlus2: boolean
  pegBuySideToMinus2: boolean
}

type AlgoLayerPlan = {
  ticksOffMidpoint: number
  buyTicksOffMidpoint: number
  sellTicksOffMidpoint: number
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
  field: 'last' | 'fill' | 'probability' | 'edge' | 'gamma' | 'theta'
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

type SavedWorkspace = {
  name: string
  operator: string
  windows: WorkspaceWindow[]
  rows: MarketRowConfig[]
  selectedProvider?: ProviderKey
  selectedSymbol?: string
  updatedAt: number
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
const ALGO_LIBRARY_KEY = 'cerious.algo.library.v1'
const DEPTH_LADDER_LAYOUT_KEY = 'cerious.depth-ladder.layout.v1'
const ALGO_LIBRARY_EVENT = 'cerious-algo-library'
const DEFAULT_OPERATOR = 'Operator 1'
const MAX_WORKSPACE_BACKUPS = 12
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
const STUDIES: Array<{ key: StudyKey; label: string }> = [
  { key: 'price', label: 'Price' },
  { key: 'ptb', label: 'PTB' },
  { key: 'probability', label: 'Market Prob' },
  { key: 'truth', label: 'Truth Prob' },
  { key: 'greeks', label: 'Greeks' },
  { key: 'tape', label: 'Tape' },
]

const WINDOW_LABELS: Record<WorkspaceWindowKind, string> = {
  marketData: 'Market Data',
  ladder: 'Legacy Ladder',
  depthLadder: 'Depth Ladder',
  order: 'Order Book',
  fills: 'Fills',
  alerts: 'Alert Manager',
  greeks: 'Greeks Engine',
  cryptoTerminal: 'Removed Terminal',
  eventTerminal: 'Removed Terminal',
  sportsTerminal: 'Removed Terminal',
  tradingViewChart: 'TradingView Chart',
  tradingViewMultiChart: 'TradingView Multi-Chart',
  singlePanelChart: 'Single Panel Chart',
  charts: 'Charts',
  acmeTwoPanelChart: 'ACME Plotly Two-Panel',
  acmeThreePanelChart: 'ACME Plotly Three-Panel',
  predictionChart: 'Prediction Chart',
  ptbChart: 'PTB Analytic Chart',
  ptbOpportunity: 'PTB Opportunity Map',
  ptbRunway: 'PTB Runway',
  liquidityMap: 'Liquidity Map',
  algoBuilder: 'Algo Builder',
  algoManager: 'Algo Manager',
  theoQuoter: 'Theo Quoter',
  knowledge: 'Knowledge Service',
  serviceMap: 'Service Mesh',
  productLibrary: 'Product Library',
  depthTrader: 'Depth Trader',
  depthTraderEsNq: 'Depth Trader - ES / NQ',
  depthTraderYmEs: 'Depth Trader - YM / ES',
  depthTraderRtyEs: 'Depth Trader - RTY / ES',
  mdTraderEs: 'MD Trader - ES',
  goose: 'GOOSE',
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
  spreadEsNq: 'ES / NQ',
  spreadYmEs: 'YM / ES',
  spreadRtyEs: 'RTY / ES',
}

const WIDGET_MENU: Array<{ group: string; kinds: WorkspaceWindowKind[] }> = [
  { group: 'Acme Core', kinds: ['marketData', 'depthLadder', 'positionsOrders', 'fills', 'auditTrail'] },
  { group: 'Acme Spreads', kinds: ['spreadConfigurations', 'relativeSpreadCharts', 'relativeSpreadVisuals', 'liveSpreadSignals'] },
  { group: 'Acme Intelligence', kinds: ['goose', 'macroRegimeSummary', 'streamingNews', 'tradeAnalytics', 'atrZScoreEngine', 'crossSpreadOpportunityMap'] },
  { group: 'Acme Risk & Research', kinds: ['notionalCalculator', 'executionRules', 'orderLayeringTechniques', 'moneyManagement', 'riskChecklist', 'sourceNotes', 'modelResearchGovernance'] },
  { group: 'Trading', kinds: ['order', 'alerts', 'liquidityMap'] },
  { group: 'Algos', kinds: ['algoBuilder', 'algoManager'] },
  { group: 'Charts', kinds: ['charts'] },
  { group: 'PTB Analytics', kinds: ['predictionChart', 'ptbOpportunity', 'ptbRunway', 'ptbChart', 'greeks', 'knowledge'] },
  { group: 'System', kinds: ['liveApiArchitecture', 'serviceMap'] },
]

const REMOVED_WINDOW_KINDS = new Set<WorkspaceWindowKind>([
  'ladder',
  'theoQuoter',
  'cryptoTerminal',
  'eventTerminal',
  'sportsTerminal',
  'tradingViewChart',
  'tradingViewMultiChart',
  'singlePanelChart',
  'acmeTwoPanelChart',
  'acmeThreePanelChart',
  'productLibrary',
  'spreadEsNq',
  'spreadYmEs',
  'spreadRtyEs',
])

const PROVIDER_COLORS: Record<ProviderKey, string> = {
  cme: '#00d4a4',
  polymarket: '#00d4a4',
  kalshi: '#7dd3fc',
  coinbase: '#f59e0b',
  hyperliquid: '#a78bfa',
  forecasttrader: '#f472b6',
}

function normalizeProviderKey(provider: ProviderKey | undefined): ProviderKey {
  if (provider && PROVIDERS.some(item => item.key === provider)) return provider
  return 'cme'
}

function venueColor(provider: ProviderKey | 'execution' | 'sim'): string {
  if (provider === 'execution') return '#f6c343'
  if (provider === 'sim') return '#74ff8d'
  return PROVIDER_COLORS[provider]
}

function defaultWindows(template: WorkspaceTemplate = 'cme'): WorkspaceWindow[] {
  if (template === 'event') {
    return [
      win('marketData', 16, 58, 520, 290, 1),
      win('eventTerminal', 548, 58, 650, 530, 2, 'event'),
      win('ladder', 1210, 58, 610, 650, 3),
      win('order', 16, 360, 360, 430, 4),
      win('fills', 388, 600, 420, 260, 5),
      win('greeks', 820, 600, 520, 290, 6),
      win('alerts', 1352, 720, 460, 220, 7),
      win('serviceMap', 16, 802, 760, 190, 8),
    ]
  }
  if (template === 'sports') {
    return [
      win('marketData', 16, 58, 520, 310, 1),
      win('relativeSpreadCharts', 548, 58, 650, 520, 2, 'sports'),
      win('depthLadder', 1210, 58, 610, 650, 3),
      win('order', 16, 382, 360, 420, 4),
      win('alerts', 388, 590, 430, 290, 5),
      win('knowledge', 830, 590, 500, 300, 6),
      win('serviceMap', 16, 812, 760, 180, 7),
    ]
  }
  return [
    win('marketData', 16, 58, 560, 315, 1),
    win('charts', 588, 58, 620, 430, 2),
    win('depthLadder', 1220, 58, 600, 655, 3),
    win('order', 16, 386, 370, 430, 4),
    win('fills', 398, 500, 390, 310, 5),
    win('alerts', 800, 500, 400, 310, 6),
    win('greeks', 398, 822, 560, 300, 7),
    win('ptbRunway', 1220, 724, 600, 395, 9),
    win('ptbOpportunity', 800, 822, 410, 420, 10),
    win('liquidityMap', 16, 830, 370, 290, 11),
    win('serviceMap', 398, 1134, 520, 260, 12),
    win('algoManager', 930, 1134, 430, 300, 13),
    win('spreadConfigurations', 1372, 1134, 448, 300, 14),
    win('ptbChart', 588, 500, 620, 310, 15),
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
  if (kind === 'depthTraderEsNq' || kind === 'spreadEsNq') return 'ES_NQ'
  if (kind === 'depthTraderYmEs' || kind === 'spreadYmEs') return 'YM_ES'
  if (kind === 'depthTraderRtyEs' || kind === 'spreadRtyEs') return 'RTY_ES'
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

function fmtMoney(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '-'
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(n >= 100 ? 0 : 2)}`
}

function fmtNum(n: number | undefined, digits = 2): string {
  if (n === undefined || Number.isNaN(n)) return '-'
  return n.toFixed(digits)
}

function fmtPct(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '-'
  return `${(n * 100).toFixed(1)}%`
}

function fmtProb(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '-'
  return `${n.toFixed(1)}c`
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

function normalizeWorkspace(raw: Partial<SavedWorkspace> | null | undefined): SavedWorkspace | null {
  if (!raw || !Array.isArray(raw.windows)) return null
  const windows = ensureFuturesDepthLadderWindow(ensureLegacyChartWindows(raw.windows.filter(item => !REMOVED_WINDOW_KINDS.has(item.kind)))).map(item => ({
    ...item,
    provider: normalizeProviderKey(item.provider),
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
    selectedProvider: normalizeProviderKey(raw.selectedProvider),
    selectedSymbol: raw.selectedSymbol,
    updatedAt: Number(raw.updatedAt || Date.now()),
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

async function fetchRecoveredWorkspaces(): Promise<SavedWorkspace[]> {
  try {
    const response = await fetch('/api/workspaces/recovered', { cache: 'no-store' })
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

function fmtChartTime(ts: number): string {
  const date = new Date(ts)
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`
}

function buildWorkspacePredictionData(
  option: ProductOption | undefined,
  market: MarketInfo | undefined,
  history: ProbPoint[],
  ticks: PolyTradeTick[],
): ChartDataPoint[] {
  const points = new Map<number, { yesPrice: number; volume: number }>()
  history.forEach(point => {
    if (Number.isFinite(point.ts) && Number.isFinite(point.up_pct)) points.set(point.ts, { yesPrice: clamp(point.up_pct, 0, 100), volume: 1 })
  })
  ticks.forEach(tick => {
    if (Number.isFinite(tick.timestamp) && Number.isFinite(tick.price)) {
      const existing = points.get(tick.timestamp)
      points.set(tick.timestamp, {
        yesPrice: clamp(tick.side === 'yes' ? tick.price : 100 - tick.price, 0, 100),
        volume: (existing?.volume ?? 0) + Math.max(0.25, tick.size),
      })
    }
  })
  const fallback = option?.yes ?? market?.up_pct ?? 50
  if (points.size === 0) {
    const now = Date.now()
    points.set(now - 60_000, { yesPrice: clamp(fallback, 0, 100), volume: 1 })
    points.set(now, { yesPrice: clamp(fallback, 0, 100), volume: 1 })
  }
  return Array.from(points.entries())
    .sort(([a], [b]) => a - b)
    .slice(-120)
    .map(([ts, point]) => ({ time: fmtChartTime(ts), yesPrice: point.yesPrice, volume: point.volume }))
}

function algoTemplateLabel(template: AlgoTemplate): string {
  if (template === 'mean-reversion-v2') return 'Mean Reversion v2'
  if (template === 'theo-quoter') return 'Theo Quoter'
  if (template === 'scale-in') return 'Scale In'
  return 'PTB Trigger'
}

function theoModelLabel(model: TheoModel): string {
  if (model === 'truth') return 'Truth Engine'
  if (model === 'market-mid') return 'Market Mid'
  return 'PTB Edge'
}

function defaultAcmeMeanReversionFields(symbol: string) {
  return {
    templateId: 'mean-reversion-v2',
    version: '2.0',
    instruments: [symbol],
    signalRules: [
      { id: 'regression-bands-ready', field: 'linearRegression27Bands', operator: '=', value: true, action: 'pegEntryBands', enabled: true },
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
      source: '27-period-linear-regression',
      period: 27,
      standardDeviations: 2,
      pegSellSideToPlus2: true,
      pegBuySideToMinus2: true,
    } as AlgoEntryPeg,
    layerPlan: {
      ticksOffMidpoint: 0,
      buyTicksOffMidpoint: 0,
      sellTicksOffMidpoint: 0,
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
      priceReference: '27-lr-regression-bands',
      doNotCrossInside: true,
      doNotCrossSelf: true,
      liveOrderEntryEnabled: false,
    } as AlgoOrderPolicy,
  }
}

function defaultAlgo(option: ProductOption | undefined, operator: string): AlgoDefinition {
  const symbol = option?.marketKey ?? option?.symbol ?? 'ES_NQ'
  const acmeDefaults = defaultAcmeMeanReversionFields(symbol)
  return {
    id: `algo-${Date.now()}`,
    name: `${symbol} Mean Reversion`,
    template: 'mean-reversion-v2',
    ...acmeDefaults,
    provider: option?.provider ?? 'cme',
    symbol,
    marketKey: option?.marketKey,
    outcome: 'yes',
    side: 'both',
    orderType: 'limit',
    theoModel: 'ptb-edge',
    quoteWidth: 2,
    edgeThreshold: acmeDefaults.entryPeg.standardDeviations,
    clipSize: acmeDefaults.risk.maxPosition,
    maxPosition: acmeDefaults.risk.maxPosition,
    operator,
    status: 'held',
    updatedAt: Date.now(),
  }
}

function asTemplate(value: unknown): AlgoTemplate {
  const template = String(value ?? '')
  return template === 'mean-reversion-v2' || template === 'theo-quoter' || template === 'scale-in' || template === 'ptb-trigger'
    ? template
    : 'mean-reversion-v2'
}

function asSignalRules(value: unknown): AlgoSignalRule[] {
  if (!Array.isArray(value)) return defaultAcmeMeanReversionFields('ES_NQ').signalRules
  return value.map((rule, index) => {
    const row = rule && typeof rule === 'object' ? rule as Record<string, unknown> : {}
    const rawValue = row.value
    return {
      id: String(row.id ?? `rule-${index + 1}`),
      field: String(row.field ?? ''),
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

function normalizeAcmeFields(item: Partial<AlgoDefinition> | Record<string, unknown>, symbol: string) {
  const defaults = defaultAcmeMeanReversionFields(symbol)
  return {
    templateId: String(item.templateId ?? item.acmeTemplateId ?? defaults.templateId),
    version: String(item.version ?? item.acmeVersion ?? defaults.version),
    instruments: Array.isArray(item.instruments) ? item.instruments.map(String) : [symbol],
    signalRules: asSignalRules(item.signalRules),
    risk: mergeObject(defaults.risk, item.risk),
    midpointPeg: mergeObject(defaults.midpointPeg, item.midpointPeg),
    entryPeg: mergeObject(defaults.entryPeg, item.entryPeg),
    layerPlan: mergeObject(defaults.layerPlan, item.layerPlan),
    syntheticOrderManager: mergeObject(defaults.syntheticOrderManager, item.syntheticOrderManager),
    exitPolicy: mergeObject(defaults.exitPolicy, item.exitPolicy),
    orderPolicy: mergeObject(defaults.orderPolicy, item.orderPolicy),
    notes: String(item.notes ?? ''),
  }
}

function loadAlgoLibrary(): AlgoDefinition[] {
  try {
    const raw = window.localStorage.getItem(ALGO_LIBRARY_KEY)
    const parsed = raw ? JSON.parse(raw) as Partial<AlgoDefinition>[] : []
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(item => item.id && item.name)
      .map(item => ({
        ...item,
        template: asTemplate(item.template ?? item.templateId),
        provider: normalizeProviderKey(item.provider),
        symbol: item.symbol ?? 'ES_NQ',
        marketKey: item.marketKey ?? item.symbol ?? 'ES_NQ',
        outcome: item.outcome ?? 'yes',
        side: item.side ?? 'both',
        orderType: item.orderType ?? 'limit',
        theoModel: item.theoModel ?? 'truth',
        quoteWidth: Number(item.quoteWidth ?? 2),
        edgeThreshold: Number(item.edgeThreshold ?? 1),
        clipSize: Number(item.clipSize ?? 5),
        maxPosition: Number(item.maxPosition ?? 25),
        operator: item.operator ?? DEFAULT_OPERATOR,
        status: item.status ?? 'held',
        updatedAt: Number(item.updatedAt ?? Date.now()),
        ...normalizeAcmeFields(item, String(item.marketKey ?? item.symbol ?? 'ES_NQ')),
      } as AlgoDefinition))
  } catch {
    return []
  }
}

function acmeDefinitionToAlgo(item: Record<string, unknown>): AlgoDefinition | null {
  const id = String(item.id ?? '')
  const name = String(item.name ?? id)
  if (!id || !name) return null
  const instruments = Array.isArray(item.instruments) ? item.instruments.map(String) : []
  const risk = item.risk && typeof item.risk === 'object' ? item.risk as Record<string, unknown> : {}
  const layerPlan = item.layerPlan && typeof item.layerPlan === 'object' ? item.layerPlan as Record<string, unknown> : {}
  const templateId = String(item.templateId ?? 'ptb-trigger')
  const symbol = instruments[0] ?? 'ES_NQ'
  const acmeFields = normalizeAcmeFields(item, symbol)
  const statusRaw = String(item.status ?? 'held')
  const status = statusRaw === 'draft' || statusRaw === 'paused' || statusRaw === 'quoting' || statusRaw === 'held' ? statusRaw : 'held'
  return {
    id,
    name,
    template: asTemplate(templateId),
    ...acmeFields,
    provider: 'cme',
    symbol,
    marketKey: symbol,
    outcome: 'yes',
    side: layerPlan.workSellSide === false ? 'bid' : layerPlan.workBuySide === false ? 'offer' : 'both',
    orderType: 'limit',
    theoModel: 'ptb-edge',
    quoteWidth: Number(layerPlan.layerSpacingTicks ?? 2),
    edgeThreshold: Number((item.entryPeg as Record<string, unknown> | undefined)?.standardDeviations ?? 1.5),
    clipSize: Number(layerPlan.layerCount ?? 1),
    maxPosition: Number(risk.maxPosition ?? 1),
    operator: 'Acme Trader',
    status,
    updatedAt: Date.parse(String(item.updatedAt ?? item.createdAt ?? '')) || Date.now(),
    acmeTemplateId: templateId,
    acmeVersion: String(item.version ?? ''),
    acmeRaw: item,
  }
}

function publishAlgoLibrary(next: AlgoDefinition[]) {
  window.localStorage.setItem(ALGO_LIBRARY_KEY, JSON.stringify(next))
  window.dispatchEvent(new CustomEvent(ALGO_LIBRARY_EVENT, { detail: next }))
}

function useAlgoLibrary() {
  const [algos, setAlgos] = useState<AlgoDefinition[]>(loadAlgoLibrary)

  useEffect(() => {
    let cancelled = false
    const loadAcmeDefinitions = async () => {
      try {
        const response = await fetch('/api/algo-manager/state')
        if (!response.ok) return
        const payload = await response.json()
        const definitions = Array.isArray(payload.definitions) ? payload.definitions : []
        const mapped = definitions
          .map((definition: Record<string, unknown>) => acmeDefinitionToAlgo(definition))
          .filter(Boolean) as AlgoDefinition[]
        if (cancelled || !mapped.length) return
        setAlgos(current => {
          const merged = [
            ...mapped,
            ...current.filter(item => !mapped.some(remote => remote.id === item.id)),
          ].sort((a, b) => b.updatedAt - a.updatedAt)
          publishAlgoLibrary(merged)
          return merged
        })
      } catch {
        // Local staged algos remain usable if the service is down.
      }
    }
    loadAcmeDefinitions()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const sync = () => setAlgos(loadAlgoLibrary())
    window.addEventListener(ALGO_LIBRARY_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(ALGO_LIBRARY_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const commit = (updater: (current: AlgoDefinition[]) => AlgoDefinition[]) => {
    setAlgos(current => {
      const next = updater(current).sort((a, b) => b.updatedAt - a.updatedAt)
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

function computeTheoQuote(option: ProductOption | undefined, model: TheoModel, quoteWidth: number) {
  const market = option?.priceToBeat ?? option?.spot ?? option?.yes ?? 50
  const rawPrice = market < 0 || market > 100 || option?.timeframe === '20sec' || option?.timeframe === 'synthetic'
  const truth = option?.truthYes ?? market
  const minPrice = rawPrice ? -Number.MAX_SAFE_INTEGER : 0
  const maxPrice = rawPrice ? Number.MAX_SAFE_INTEGER : 100
  const edgeFair = option?.truthYes != null && !rawPrice ? clamp((option.truthYes * 0.7) + (market * 0.3), minPrice, maxPrice) : market
  const fair = model === 'truth' ? truth : model === 'ptb-edge' ? edgeFair : market
  const half = quoteWidth / 2
  return {
    fair,
    bid: clamp(fair - half, minPrice, maxPrice),
    ask: clamp(fair + half, minPrice, maxPrice),
    edge: truth - market,
    market,
    truth,
  }
}

type AcmeSpreadStat = {
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
  lr27Mean?: number
  lr27Upper2?: number
  lr27Lower2?: number
  lr27Sigma?: number
  lr27Slope?: number
  lr27Interval?: string
  lr27Period?: number
  lr27Bars?: number
  lr27UpdatedAt?: number
  lr27IsForming?: boolean
  lr27Source?: string
  theoreticalBid: number
  theoreticalAsk: number
  signal: string
  volume?: number
  live: boolean
  bars: Bar[]
}

type AcmeMacroFactorRow = {
  key: string
  value: number
  weight: number
  contribution: number
}

type AcmeMacroState = {
  service: string
  fetchedAt?: string
  label: string
  strength: number
  algo: string
  score: number
  factors: Record<string, number>
  factorRows: AcmeMacroFactorRow[]
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

type AcmeIntelligence = {
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
    spreads: AcmeSpreadStat[]
    strongest?: AcmeSpreadStat
  }
  macroRegime?: AcmeMacroState
  liveSpreadSignals?: Array<Pick<AcmeSpreadStat, 'key' | 'label' | 'spread' | 'lastTraded' | 'mean' | 'longTermMean' | 'lookbackMean' | 'lookbackDays' | 'priorSettle' | 'moveFromMean' | 'movePctOfAtr' | 'z' | 'atr' | 'atr3' | 'atr20' | 'atr30' | 'blendedAtr' | 'halfAtr' | 'vwapBasis' | 'dayZ' | 'signalThreshold' | 'bias' | 'orderFlowScore' | 'updateCadence' | 'rvInterval' | 'rvBars' | 'rvUpdatedAt' | 'publishedAt' | 'publishReason' | 'lr27Mean' | 'lr27Upper2' | 'lr27Lower2' | 'lr27Sigma' | 'lr27Slope' | 'lr27Interval' | 'lr27Period' | 'lr27Bars' | 'lr27UpdatedAt' | 'lr27IsForming' | 'lr27Source' | 'signal' | 'theoreticalBid' | 'theoreticalAsk' | 'volume' | 'live'>>
}

type AcmeChartMode = 'candles' | 'line'
type AcmeChartTimeframe = '1m' | '5m' | '30m' | '1h' | '1d'
type AcmeChartDisplayPreset = 'clean' | 'grid' | 'calendar' | 'outline'
type AcmeChartStudyType = 'regression-channel' | 'atr' | 'volume-at-price'

type AcmeChartStudy = {
  id: string
  type: AcmeChartStudyType
  lookback: number
  upperDeviation?: number
  lowerDeviation?: number
  atrMultiplier?: number
  bins?: number
}

type AcmeChartSettings = {
  mode: AcmeChartMode
  timeframe: AcmeChartTimeframe
  displayPreset: AcmeChartDisplayPreset
  compressBlankSessions: boolean
  showGrid: boolean
  solidCandles: boolean
  studies: AcmeChartStudy[]
  studyType: AcmeChartStudyType
  studyLookback: number
  upperDeviation: number
  lowerDeviation: number
  atrMultiplier: number
  volumePriceBins: number
}

type AcmePositionRow = {
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

type AcmeOrderRow = {
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

type AcmePositionsOrdersState = {
  service: string
  fetchedAt: string
  fillsJournalUpdatedAt?: string
  runtimeUpdatedAt?: string
  positions: AcmePositionRow[]
  orders: AcmeOrderRow[]
  summary: {
    positionCount: number
    workingOrderCount: number
    fillCount: number
    openPnl: number
    closedPnl: number
    totalPnl: number
  }
}

type AcmeNewsItem = {
  id: string
  source: string
  title: string
  link?: string
  pubDate?: string
  description?: string
  urgency?: 'high' | 'normal'
  bias?: 'risk-on' | 'risk-off' | 'mixed'
}

type AcmeNewsState = {
  service: string
  provider: string
  status: string
  fetchedAt: string
  items: AcmeNewsItem[]
  warnings?: string[]
  publicSourcesExpected?: number
  publicSourcesLive?: number
}

type AcmeAuditEntry = {
  id: string
  timestamp: string
  sequence?: string | number
  severity: 'info' | 'warn' | 'error'
  channel: string
  type: string
  source?: string
  summary: string
}

type AcmeAuditState = {
  service: string
  fetchedAt: string
  entries: AcmeAuditEntry[]
}

type AcmeOpportunityState = {
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
}

type AcmeTradeAnalyticsState = {
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
  }
  studies: Array<{ study: string; passed: boolean; result: string; read: string }>
  curve: Array<{ index: number; equity: number; drawdown: number; maxDrawdown: number }>
  productTotals: Array<{ instrument: string; pnl: number }>
}

type AcmeNotionalState = {
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

type AcmeContentState = {
  kind: string
  service: string
  fetchedAt: string
  sections?: Array<{ title: string; body: string }>
  rows?: string[][]
}

function useAcmeEndpoint<T>(path: string, intervalMs = 10000) {
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

function useAcmeIntelligence(intervalMs = 60000): AcmeIntelligence | null {
  const [data, setData] = useState<AcmeIntelligence | null>(null)

  useEffect(() => {
    let cancelled = false
    const pull = async () => {
      try {
        const response = await fetch('/api/acme/intelligence', { cache: 'no-store' })
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

type AcmeLr27State = {
  symbol: string
  label?: string
  interval: string
  period: number
  bars: number
  updatedAt: number
  isForming?: boolean
  mean: number
  upper2: number
  lower2: number
  sigma: number
  slope: number
  lastTraded?: number
  live?: boolean
  source?: string
}

async function fetchFreshLr27(symbol: string): Promise<AcmeLr27State> {
  const response = await fetch(`/api/acme/lr27/${encodeURIComponent(symbol)}?fresh=true&nonce=${Date.now()}`, { cache: 'no-store' })
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const payload = await response.json() as { detail?: string }
      if (payload.detail) detail = payload.detail
    } catch {
      // Use HTTP fallback.
    }
    throw new Error(`LR27 refresh failed for ${symbol}: ${detail}`)
  }
  return await response.json() as AcmeLr27State
}

async function publishAlgoGuardAuditEvent(algo: AlgoDefinition, marketKey: string, reason: string): Promise<void> {
  try {
    await fetch('/api/algo-manager/guard-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        algoId: algo.id,
        algoName: algo.name,
        symbol: marketKey,
        reason,
      }),
    })
  } catch {
    // Local pause still protects the order path if audit publishing is down.
  }
}

function useAcmePositionsOrders() {
  const [data, setData] = useState<AcmePositionsOrdersState | null>(null)
  const [error, setError] = useState('')

  const pull = async () => {
    try {
      const response = await fetch('/api/acme/positions-orders', { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setData(await response.json())
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

function useAcmeBars(symbol: string, timeframe: AcmeChartTimeframe) {
  const [bars, setBars] = useState<Bar[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    let timeoutId = 0

    const pull = async () => {
      const key = symbol || 'ES_NQ'
      let nextDelay = 15_000
      try {
        const nextBars = await fetchBars(key, timeframe, 1200, 60_000)
        if (!cancelled) {
          if (nextBars.length) {
            setBars(nextBars)
            setError('')
          } else {
            nextDelay = 7_500
            setError('')
          }
        }
      } catch (err) {
        nextDelay = 7_500
        const message = err instanceof Error ? err.message : 'Chart bars unavailable'
        const transient = /timed out|abort/i.test(message)
        if (!cancelled) setError(transient ? '' : message)
      } finally {
        if (!cancelled) timeoutId = window.setTimeout(pull, nextDelay)
      }
    }
    pull()
    return () => {
      cancelled = true
      if (timeoutId) window.clearTimeout(timeoutId)
    }
  }, [symbol, timeframe])

  return { bars, error }
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

function useProductOptions(): ProductOption[] {
  const markets = useStore(s => s.markets)

  return useMemo(() => {
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
        const assetRank = CME_PRODUCT_ASSETS.indexOf(a.asset ?? 'EVENT') - CME_PRODUCT_ASSETS.indexOf(b.asset ?? 'EVENT')
        if (assetRank !== 0) return assetRank
        return a.symbol.localeCompare(b.symbol)
      })
  }, [markets])
}

function mappedLiquidityProducts(options: ProductOption[], cryptoPrices: ReturnType<typeof useStore.getState>['cryptoPrices']): ProductOption[] {
  void cryptoPrices
  return [...options].sort((a, b) => {
    const providerRank = PROVIDERS.findIndex(provider => provider.key === a.provider) - PROVIDERS.findIndex(provider => provider.key === b.provider)
    if (providerRank !== 0) return providerRank
    const assetRank = CME_PRODUCT_ASSETS.indexOf(a.asset ?? 'EVENT') - CME_PRODUCT_ASSETS.indexOf(b.asset ?? 'EVENT')
    if (assetRank !== 0) return assetRank
    return a.symbol.localeCompare(b.symbol)
  })
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
        {PROVIDERS.map(item => (
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
    const minWidth = 260
    const minHeight = 180
    event.currentTarget.setPointerCapture(event.pointerId)

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      const patch: Partial<Pick<WorkspaceWindow, 'x' | 'y' | 'w' | 'h'>> = {}

      if (direction.includes('e')) {
        patch.w = clamp(startWidth + dx, minWidth, 2400)
      }
      if (direction.includes('s')) {
        patch.h = clamp(startHeight + dy, minHeight, 1800)
      }
      if (direction.includes('w')) {
        const maxDx = startWidth - minWidth
        const nextDx = clamp(dx, 8 - startLeft, maxDx)
        patch.x = startLeft + nextDx
        patch.w = startWidth - nextDx
      }
      if (direction.includes('n')) {
        const maxDy = startHeight - minHeight
        const nextDy = clamp(dy, 48 - startTop, maxDy)
        patch.y = startTop + nextDy
        patch.h = startHeight - nextDy
      }

      onResize(item.id, patch)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
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
  const frameBorderColor = active ? '#3b82f6' : '#334155'
  const frameShadow = active
    ? '0 0 0 1px rgba(147, 197, 253, .35), 0 18px 42px rgba(0, 0, 0, .62)'
    : '0 0 0 1px rgba(148, 163, 184, .22), 0 14px 34px rgba(0, 0, 0, .56)'

  return (
    <section
      data-window-frame="true"
      className={cx(
        'absolute overflow-hidden rounded border-2 backdrop-blur',
      )}
      style={{
        left: item.x,
        top: item.y,
        width: item.w,
        height: item.collapsed ? 34 : item.h,
        zIndex: item.z,
        borderColor: frameBorderColor,
        boxShadow: frameShadow,
        background: 'linear-gradient(180deg, rgba(17,22,31,0.96), rgba(6,8,13,0.98))',
      }}
      onPointerDown={onActivate}
    >
      <div
        className="flex h-[34px] cursor-move select-none items-center justify-between border-b bg-surface-panel/95 px-2"
        style={{ borderColor: frameBorderColor }}
        onPointerDown={startDrag}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className={cx('h-2 w-2 rounded-full', active ? 'bg-accent' : 'bg-muted/50')} />
          <span className="truncate text-[11px] font-bold uppercase tracking-wide text-white">{displayTitle}</span>
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

function fmtPercent(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '-'
  return `${n.toFixed(1)}%`
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
  return {
    market_key: cmeBook.symbol,
    question: `${cmeBook.symbol} CME depth`,
    up_token_id: cmeBook.symbol,
    bids: (cmeBook.bids ?? []).map(level => ({ price: level.price, size: level.size })),
    asks: (cmeBook.asks ?? []).map(level => ({ price: level.price, size: level.size })),
    best_bid: cmeBook.bestBid ?? cmeBook.bids?.[0]?.price ?? null,
    best_ask: cmeBook.bestAsk ?? cmeBook.asks?.[0]?.price ?? null,
    mid: cmeBook.mid ?? 0,
    spread_pct: cmeBook.spread ?? null,
    up_pct: cmeBook.ltp ?? cmeBook.mid ?? 0,
    down_pct: cmeBook.ltp ?? cmeBook.mid ?? 0,
    ltp: cmeBook.ltp,
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
    const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

    const acceptBook = (target: string, book: CmeBook) => {
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
            if (payload) acceptBook(target, payload)
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

      const ws = new WebSocket(`${wsBase}/${encodeURIComponent(target)}?provider=cme`)
      ws.onmessage = event => {
        try {
          const payload = JSON.parse(event.data)
          if (payload.type === 'snapshot') {
            const cmeBooks = payload.cme_books as Record<string, CmeBook> | undefined
            const cmeTrades = payload.cme_trades as Record<string, CmeTradeTick[]> | undefined
            if (cmeBooks?.[target]) acceptBook(target, cmeBooks[target])
            for (const trade of cmeTrades?.[target] ?? []) acceptTrade(target, trade)
            return
          }
          if (payload.type === 'cme_book' && payload.symbol === target) acceptBook(target, payload.data as CmeBook)
          if (payload.type === 'cme_trade' && payload.symbol === target) acceptTrade(target, payload.data as CmeTradeTick)
          if (payload.type === 'markets') store().setMarkets(payload.data, true)
        } catch {
          // Ignore malformed feed messages and keep the stream alive.
        }
      }
      ws.onerror = () => ws.close()
      sockets.push(ws)
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

function playAlertSound(sound: AlertSound = 'system-chime') {
  try {
    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) return
    const ctx = new AudioContextCtor()
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
  } catch {
    // Browser autoplay policies can block audio until the user has interacted.
  }
}

async function notifyDesktop(title: string, body: string) {
  if (!('Notification' in window)) return
  const permission = Notification.permission === 'default'
    ? await Notification.requestPermission()
    : Notification.permission
  if (permission === 'granted') {
    new Notification(title, { body, tag: 'qst-fill-alert' })
  }
}

async function sendSmsAlert(phone: string | undefined, message: string) {
  if (!phone?.trim()) return
  try {
    await fetch('/api/alerts/sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: phone.trim(), message }),
    })
  } catch {
    // SMS transport status is surfaced by the backend once configured.
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
  const mappedOptions = options.filter(option => option.asset && CME_PRODUCT_ASSETS.includes(option.asset))

  const visibleForProvider = (provider: ProviderKey) => mappedOptions
    .filter(option => option.provider === provider)
    .filter(option => {
      const q = query.trim().toLowerCase()
      if (!q) return true
      return `${option.label} ${option.symbol} ${option.subtitle}`.toLowerCase().includes(q)
    })
    .sort((a, b) => {
      const ai = CME_PRODUCT_ASSETS.indexOf(a.asset ?? 'EVENT')
      const bi = CME_PRODUCT_ASSETS.indexOf(b.asset ?? 'EVENT')
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
    const option = options.find(item => item.provider === row.provider && item.symbol === row.symbol)
    if (option?.provider !== 'cme') return []
    return [String(option.marketKey ?? option.asset ?? option.symbol).toUpperCase()]
  }), [options, rows])
  useCmeMarketDataSubscriptions(cmeRowSymbols)

  const rowData = rows.map(row => {
    const option = options.find(item => item.provider === row.provider && item.symbol === row.symbol)
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
    const status = timestamp ? (Date.now() - timestamp < 30_000 ? 'OPEN' : 'STALE') : option?.live ? 'OPEN' : 'WAIT'
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

function finiteDepthPrice(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function futuresTickForSymbol(symbol: string, fallbackPrice: number): number {
  const upper = symbol.toUpperCase()
  if (upper.includes('YM')) return 1
  if (upper.includes('CL')) return 0.01
  if (upper.includes('GC')) return 0.1
  if (upper.includes('ZM')) return 0.1
  if (upper.includes('ZS')) return 0.25
  if (upper.includes('RTY')) return 0.1
  if (upper.includes('ES') || upper.includes('NQ')) return 0.25
  if (Math.abs(fallbackPrice) >= 1000) return 0.25
  if (Math.abs(fallbackPrice) >= 100) return 0.1
  return 0.01
}

function inferBookTick(book: { bids?: Array<{ price: number }>; asks?: Array<{ price: number }>; tickSize?: number } | undefined, symbol: string, fallbackPrice: number): number {
  const publishedTick = Number(book?.tickSize)
  if (Number.isFinite(publishedTick) && publishedTick > 0) return publishedTick

  const sideDiffs = (levels: Array<{ price: number }>) => {
    const prices = levels
      .map(level => finiteDepthPrice(level.price))
      .filter((price): price is number => price !== undefined)
      .sort((a, b) => a - b)
    const diffs: number[] = []
    for (let index = 1; index < prices.length; index += 1) {
      const diff = Math.abs(prices[index] - prices[index - 1])
      if (diff > 1e-9) diffs.push(diff)
    }
    return diffs
  }
  const diffs = [...sideDiffs(book?.bids ?? []), ...sideDiffs(book?.asks ?? [])]

  const inferred = diffs
    .filter(diff => diff <= Math.max(10, Math.abs(fallbackPrice) * 0.025))
    .sort((a, b) => a - b)[0]

  return inferred && Number.isFinite(inferred) ? inferred : futuresTickForSymbol(symbol, fallbackPrice)
}

function depthMultiplierOptionsForTick(tickSize: unknown): number[] {
  const tick = Number(tickSize)
  if (Number.isFinite(tick) && Math.abs(tick - 0.1) < 1e-9) return [1, 2, 5, 10]
  return [1, 2, 4, 8, 16]
}

function roundToTick(price: number, tick: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(tick) || tick <= 0) return price
  return Math.round(price / tick) * tick
}

function normalizeDepthBookPrice(price: unknown, reference: number | undefined): number | undefined {
  const value = finiteDepthPrice(price)
  if (value === undefined) return undefined
  if (reference === undefined || !Number.isFinite(reference) || reference === 0) return value
  const absReference = Math.abs(reference)
  const absValue = Math.abs(value)
  if (absReference > 100 && absValue > 0 && absValue < 100 && absValue < absReference * 0.2) return value * 100
  if (absReference < 100 && absValue > 1000) return value / 100
  return value
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

function fmtLadderPrice(price: number): string {
  if (!Number.isFinite(price)) return '-'
  if (Math.abs(price) >= 1000) return price.toFixed(2)
  if (Math.abs(price) >= 100) return price.toFixed(2)
  return price.toFixed(3)
}

function aggregateDepthLevels(
  levels: Array<{ price: number; size: number }> | undefined,
  rowStep: number,
): Map<string, number> {
  const next = new Map<string, number>()
  if (!Number.isFinite(rowStep) || rowStep <= 0) return next
  for (const level of levels ?? []) {
    const price = finiteDepthPrice(level.price)
    const size = Number(level.size)
    if (price === undefined || !Number.isFinite(size) || size <= 0) continue
    const key = fmtLadderPrice(roundToTick(price, rowStep))
    next.set(key, (next.get(key) ?? 0) + size)
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
    const endpoints = [
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://127.0.0.1:8000/ws`,
    ]
    const target = String(asset).toUpperCase()

    const acceptBook = (nextBook: CmeBook, source: 'ws' | 'snapshot' | 'rest') => {
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
          if (payload) acceptBook(payload, 'rest')
        })
        .catch(() => undefined)
    }

    const ingestSnapshot = (snapshot: Record<string, unknown>) => {
      const store = useStore.getState()
      store.loadSnapshot(target as Asset, snapshot)
      const cmeBooks = snapshot.cme_books as Record<string, CmeBook> | undefined
      const cmeTrades = snapshot.cme_trades as Record<string, CmeTradeTick[]> | undefined
      if (cmeBooks?.[target]) acceptBook(cmeBooks[target], 'snapshot')
      for (const trade of cmeTrades?.[target] ?? []) acceptTrade(trade, 'snapshot')
    }

    const ingestMessage = (msg: WsMsg | { type: 'cme_book'; symbol: string; data: CmeBook } | { type: 'cme_trade'; symbol: string; data: CmeTradeTick }) => {
      const store = useStore.getState()
      if (msg.type === 'book' && msg.asset === target) store.setBook(msg.asset, msg.data)
      if (msg.type === 'tick' && msg.asset === target) store.pushTick(msg.asset, msg.data)
      if (msg.type === 'cme_book' && msg.symbol === target) acceptBook(msg.data, 'ws')
      if (msg.type === 'cme_trade' && msg.symbol === target) acceptTrade(msg.data, 'ws')
      if (msg.type === 'markets') store.setMarkets(msg.data, true)
    }

    const connect = () => {
      if (!alive) return
      const base = endpoints[endpointIndex] ?? endpoints[0]
      setState(current => ({ ...current, status: current.lastEventAt ? 'retrying' : 'connecting' }))
      ws = new WebSocket(`${base}/${encodeURIComponent(target)}?provider=${encodeURIComponent(marketProvider)}`)

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

    connect()
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
  const streamAsset = useMemo(() => {
    const raw = option?.marketKey ?? option?.asset ?? activeSymbol
    const key = String(raw || '').trim().toUpperCase()
    return key || undefined
  }, [activeSymbol, option?.asset, option?.marketKey])
  const depthStream = useDepthMarketStream(streamAsset, activeProvider)
  const simulationEnabled = useStore(s => s.simulationEnabled)
  const placeSimOrder = useStore(s => s.placeSimOrder)
  const cancelSimOrder = useStore(s => s.cancelSimOrder)
  const simOrders = useStore(s => s.simOrders)
  const simMessages = useStore(s => s.simMessages)
  const book = depthStream.book ?? undefined
  const ticks = depthStream.trades
  const latestDepthTick = ticks?.at(-1)
  const latestDepthTradePrice = normalizeDepthBookPrice(latestDepthTick?.price, finiteDepthPrice(option?.spot) ?? finiteDepthPrice(option?.priceToBeat))
  const latestDepthLtp = normalizeDepthBookPrice(book?.ltp, finiteDepthPrice(option?.spot) ?? finiteDepthPrice(option?.priceToBeat))
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
    bg: '#008cff',
    bgSoft: 'rgba(0, 140, 255, .25)',
    bgHover: 'rgba(0, 166, 255, .38)',
    bar: 'rgba(0, 140, 255, .5)',
    text: '#eff6ff',
    strong: '#66e8ff',
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
  const laneGrey = '#4b5563'
  const laneGreyInside = '#64748b'
  const laneText = '#f8fafc'
  const depthMultiplierTick = useMemo(() => {
    const publishedTick = Number(book?.tickSize ?? option?.tickSize)
    if (Number.isFinite(publishedTick) && publishedTick > 0) return publishedTick
    const referencePrice = latestDepthLastPrice ?? finiteDepthPrice(option?.spot) ?? finiteDepthPrice(option?.priceToBeat) ?? 0
    return futuresTickForSymbol(String(option?.asset ?? marketKey ?? symbol), referencePrice)
  }, [book?.tickSize, latestDepthLastPrice, marketKey, option?.asset, option?.priceToBeat, option?.spot, option?.tickSize, symbol])
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
    const optionPrice = finiteDepthPrice(option?.spot) ?? finiteDepthPrice(option?.priceToBeat)
    const latestTick = ticks?.at(-1)
    const tickLast = normalizeDepthBookPrice(latestTick?.price, optionPrice)
    const bookLast = normalizeDepthBookPrice(book?.ltp, optionPrice)
    const tickTs = Number(latestTick?.timestamp ?? 0)
    const bookTs = Number(book?.tsMs ?? 0)
    const preferBookLast = bookLast !== undefined && bookTs >= tickTs
    const lastTrade = preferBookLast ? bookLast : tickLast ?? bookLast
    const normalizedBids = (book?.bids ?? [])
      .map(level => ({ price: normalizeDepthBookPrice(level.price, optionPrice), size: Number(level.size) }))
      .filter((level): level is { price: number; size: number } => level.price !== undefined && Number.isFinite(level.size))
    const normalizedAsks = (book?.asks ?? [])
      .map(level => ({ price: normalizeDepthBookPrice(level.price, optionPrice), size: Number(level.size) }))
      .filter((level): level is { price: number; size: number } => level.price !== undefined && Number.isFinite(level.size))
    const bestBid = normalizeDepthBookPrice(book?.bestBid, optionPrice) ?? normalizedBids[0]?.price
    const bestAsk = normalizeDepthBookPrice(book?.bestAsk, optionPrice) ?? normalizedAsks[0]?.price
    const bookMid = normalizeDepthBookPrice(book?.mid, optionPrice)
    const bookCenter = bookMid ?? (bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : undefined)
    const fallbackLast = lastTrade ?? bookCenter ?? optionPrice ?? 0
    const tick = inferBookTick(book, option?.asset ?? symbol, fallbackLast)
    const rowStep = Math.max(tick, tick * priceMultiplier)
    const bid = bestBid ?? (bestAsk !== undefined ? bestAsk - tick : fallbackLast - tick)
    const ask = bestAsk ?? (bestBid !== undefined ? bestBid + tick : fallbackLast + tick)
    const mid = bookMid ?? (Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : fallbackLast)
    const priceKey = (price: number) => fmtLadderPrice(roundToTick(price, rowStep))
    const bidMap = aggregateDepthLevels(normalizedBids, rowStep)
    const askMap = aggregateDepthLevels(normalizedAsks, rowStep)
    const lastTradeKey = lastTrade !== undefined ? priceKey(lastTrade) : undefined
    const lastTradeSize = Number(preferBookLast ? book?.ltpSize ?? latestTick?.size ?? 0 : latestTick?.size ?? book?.ltpSize ?? 0)
    return { fallbackLast, bid, ask, mid, tick, rowStep, bidMap, askMap, bidKey: priceKey(bid), askKey: priceKey(ask), lastTradeKey, lastTradeSize }
  }, [book, option?.asset, option?.priceToBeat, option?.spot, option?.yes, priceMultiplier, symbol, ticks])

  const simDepthOrders = useMemo(() => {
    if (!marketKey || !Number.isFinite(ladderModel.rowStep) || ladderModel.rowStep <= 0) return []
    return simOrders
      .filter(order => order.marketKey === marketKey && (order.status === 'working' || order.status === 'partially_filled') && order.remaining > 0)
      .map(order => ({
        id: order.id,
        side: order.side === 'bid' ? 'BID' as const : 'ASK' as const,
        priceKey: fmtLadderPrice(roundToTick(order.price, ladderModel.rowStep)),
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
  }, [ladderModel.rowStep, marketKey, simOrders])

  const displayActiveOrders = useMemo(() => {
    const simIds = new Set(simOrders.map(order => order.id))
    return activeOrders.filter(order => !simulationEnabled || !simIds.has(order.id))
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
      const key = fmtLadderPrice(roundToTick(price, rowStep))
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
        bidSize: ladderModel.bidMap.get(key) ?? 0,
        askSize: ladderModel.askMap.get(key) ?? 0,
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
  const activeForSide = (side: DepthOrderSide) => (
    displayActiveOrders.some(order => order.side === side && (order.status === 'pending' || order.status === 'working'))
    || simDepthOrders.some(order => order.side === side)
  )
  const latestFill = useMemo(() => activeOrders.filter(order => order.status === 'filled').sort((a, b) => (b.filledAt ?? 0) - (a.filledAt ?? 0))[0], [activeOrders])
  const localDepthPosition = useMemo(() => {
    const filled = activeOrders.filter(order => order.status === 'filled')
    const net = filled.reduce((sum, order) => sum + (order.side === 'BID' ? order.size : -order.size), 0)
    const notional = filled.reduce((sum, order) => sum + (order.fillPrice ?? Number(order.priceKey)) * order.size, 0)
    const size = filled.reduce((sum, order) => sum + order.size, 0)
    return {
      net,
      avg: size > 0 ? notional / size : undefined,
    }
  }, [activeOrders])

  const getSimFillPrice = (side: DepthOrderSide, orderType: 'limit' | 'market', limitPrice: number): number | null => {
    const bestBid = Number(ladderModel.bid)
    const bestAsk = Number(ladderModel.ask)
    if (orderType === 'market') {
      const fillPrice = side === 'BID' ? bestAsk : bestBid
      return Number.isFinite(fillPrice) ? fillPrice : null
    }
    if (side === 'BID' && Number.isFinite(bestAsk) && limitPrice >= bestAsk) return bestAsk
    if (side === 'ASK' && Number.isFinite(bestBid) && limitPrice <= bestBid) return bestBid
    return null
  }

  const applyDepthOrderState = (order: LocalDepthOrder): LocalDepthOrder => {
    if (simulationEnabled) {
      const fillPrice = getSimFillPrice(order.side, order.orderType, Number(order.priceKey))
      return fillPrice === null ? { ...order, status: 'working' } : { ...order, status: 'filled', fillPrice, filledAt: Date.now() }
    }
    if (!simulationEnabled) return { ...order, status: fastTrade ? 'working' : 'pending' }
    const fillPrice = getSimFillPrice(order.side, order.orderType, Number(order.priceKey))
    if (fillPrice !== null) {
      return { ...order, status: 'filled', fillPrice, filledAt: Date.now() }
    }
    return { ...order, status: 'working' }
  }

  useEffect(() => {
    if (!simulationEnabled) return
    setActiveOrders(current => current.map(order => {
      if (order.status !== 'working') return order
      const fillPrice = getSimFillPrice(order.side, order.orderType, Number(order.priceKey))
      return fillPrice === null ? order : { ...order, status: 'filled', fillPrice, filledAt: Date.now() }
    }))
  }, [ladderModel.ask, ladderModel.bid, simulationEnabled])

  const submitDepthOrder = async (side: DepthOrderSide, priceKey: string) => {
    if (!marketKey) return
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
    setActiveOrders(current => [order, ...current].slice(0, 80))
    if (simulationEnabled) {
      placeSimOrder({
        id,
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
    if (fastTrade && !simulationEnabled) {
      try {
        await fetch('/api/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product: marketKey,
            side,
            price: Number(priceKey),
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
      void fetch('/api/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product: marketKey,
          side: order.side,
          price: Number(order.priceKey),
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
    simDepthOrders
      .filter(order => order.side === side && order.priceKey === priceKey)
      .forEach(order => cancelSimOrder(order.id))
  }

  const moveOrder = (targetPriceKey: string) => {
    if (!draggingOrder || !marketKey) return
    if (targetPriceKey === draggingOrder.priceKey) {
      setDraggingOrder(null)
      setDragTargetPriceKey(null)
      return
    }
    setActiveOrders(current => current.map(order => (
      order.id === draggingOrder.id ? applyDepthOrderState({ ...order, priceKey: targetPriceKey, status: 'pending', fillPrice: undefined, filledAt: undefined }) : order
    )))
    if (simulationEnabled) {
      cancelSimOrder(draggingOrder.id)
      placeSimOrder({
        id: draggingOrder.id,
        marketKey: marketKey ?? '',
        outcome: 'yes',
        side: draggingOrder.side === 'BID' ? 'bid' : 'offer',
        orderType: 'limit',
        price: Number(targetPriceKey),
        size: draggingOrder.size,
        operator: operatorName,
        source: draggingOrder.source ?? 'manual',
        strategy: draggingOrder.strategy ?? 'depth-ladder',
        legId: draggingOrder.legId ?? `depth-${marketKey}-${targetPriceKey}-${draggingOrder.side}`,
        orderTag: draggingOrder.orderTag,
        algoRole: draggingOrder.algoRole,
        algoId: draggingOrder.algoId,
        algoName: draggingOrder.algoName,
        parentOrderId: draggingOrder.parentOrderId,
        layer: draggingOrder.layer,
        trigger: draggingOrder.trigger,
        coverTicksFromFill: draggingOrder.coverTicksFromFill,
        coverTickSize: draggingOrder.coverTickSize,
        tickSize: draggingOrder.tickSize ?? book?.tickSize ?? option?.tickSize,
        tickValue: draggingOrder.tickValue ?? book?.tickValue ?? option?.tickValue,
        multiplier: draggingOrder.multiplier ?? book?.multiplier ?? option?.multiplier,
      })
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
    simDepthOrders
      .filter(order => !side || order.side === side)
      .forEach(order => cancelSimOrder(order.id))
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
    const workingOrder = orders.find(order => order.status === 'working')
    const pendingOrder = orders.find(order => order.status === 'pending')
    const filledOrder = orders.find(order => order.status === 'filled')
    const draggableOrder = workingOrder ?? pendingOrder ?? filledOrder ?? orders[0] ?? sharedOrders[0]
    const totalSize = orders.reduce((sum, order) => sum + order.size, 0) + sharedOrders.reduce((sum, order) => sum + order.size, 0)
    const status = sharedOrders.length || workingOrder ? 'working' : pendingOrder ? 'pending' : filledOrder ? 'filled' : 'rejected'
    const sideColor = side === 'BID' ? buyColor.bg : sellColor.bg
    const primaryTag = sharedOrders[0]?.orderTag
    const colors = status === 'pending'
      ? { bg: '#ffe800', fg: '#151200', label: `${totalSize}`, border: sideColor }
      : status === 'filled'
        ? { bg: '#22c55e', fg: '#001407', label: `${totalSize}`, border: '#bbf7d0' }
        : status === 'rejected'
          ? { bg: '#7f1d1d', fg: '#fff0f2', label: density === 'small' ? 'R' : 'REJ', border: sellColor.bg }
          : { bg: sideColor, fg: side === 'BID' ? '#001014' : '#fff0f2', label: `${totalSize}`, border: side === 'BID' ? buyColor.border : sellColor.border }
    return (
      <button
        className={cx(
          'relative flex h-[78%] min-w-0 flex-1 cursor-pointer select-none items-center justify-center border px-1 font-black shadow',
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
        title={`${primaryTag ? `${primaryTag} ` : ''}${status.toUpperCase()} ${totalSize}x across ${orders.length + sharedOrders.length} order(s) ${side === 'BID' ? 'BUY' : 'SELL'} @ ${priceKey}. Right-click drag to modify price.`}
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
        {orders.length + sharedOrders.length > 1 && (
          <span
            className="absolute -top-px left-1/2 z-30 -translate-x-1/2 border px-0.5 text-[7px] leading-[9px]"
            style={{ backgroundColor: '#d1d5db', borderColor: sideColor, color: sideColor }}
          >
            x{orders.length + sharedOrders.length}
          </span>
        )}
        <span className="mr-0.5 text-[8px]">{primaryTag?.includes('ALGO') ? 'A' : side === 'BID' ? 'B' : 'S'}</span>
        <span>{colors.label}</span>
      </button>
    )
  }

  const renderOrderStack = (priceKey: string) => {
    const hasOrders = displayActiveOrders.some(item => item.priceKey === priceKey) || simDepthOrders.some(item => item.priceKey === priceKey)
    return (
      <div
        className="flex h-full items-center gap-px px-1"
        style={{ backgroundColor: laneGrey, color: laneText }}
        title={hasOrders ? `My orders @ ${priceKey}` : 'My orders'}
      >
        {hasOrders ? (
          <>
            {renderOrderFlag(priceKey, 'BID')}
            {renderOrderFlag(priceKey, 'ASK')}
          </>
        ) : null}
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
            backgroundColor: '#030509',
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
          backgroundColor: '#030509',
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
      askSize: number
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
      const visibleSize = (Number(level.bidSize) || 0) + (Number(level.myBidSize) || 0)
      const hasDepth = visibleSize > 0
      const cellBg = hasDepth ? (level.myBidSize ? '#006fff' : '#004aa8') : '#030509'
      return (
        <button
          key={column}
          className="relative h-full cursor-pointer overflow-hidden border-r px-1 text-right font-semibold hover:brightness-125"
          style={mdGridStyle(column, { borderColor: gridLine, color: hasDepth ? '#f8fbff' : buyColor.text, backgroundColor: cellBg })}
          onMouseEnter={event => { event.currentTarget.style.backgroundColor = hasDepth ? '#008cff' : '#07111f' }}
          onMouseLeave={event => { event.currentTarget.style.backgroundColor = cellBg }}
          onClick={() => submitDepthOrder('BID', level.key)}
          title={`${actionMode.toUpperCase()} BID @ ${level.key}`}
        >
          <span className="relative z-10 inline-flex items-center justify-end gap-1">
            {level.myBidSize > 0 && <span className="rounded-sm bg-[#00d8ff] px-0.5 text-[8px] font-black text-[#001014]">ME</span>}
            {visibleSize ? fmtCompact(visibleSize) : ''}
          </span>
        </button>
      )
    }
    const visibleSize = (Number(level.askSize) || 0) + (Number(level.myAskSize) || 0)
    const hasDepth = visibleSize > 0
    const cellBg = hasDepth ? (level.myAskSize ? '#d10f2f' : '#9f1028') : '#030509'
    return (
      <button
          key={column}
          className="relative h-full cursor-pointer overflow-hidden px-1 text-left font-semibold hover:brightness-125"
        style={mdGridStyle(column, { color: hasDepth ? '#fff7f8' : sellColor.text, backgroundColor: cellBg })}
        onMouseEnter={event => { event.currentTarget.style.backgroundColor = hasDepth ? '#ff1744' : '#1a070a' }}
        onMouseLeave={event => { event.currentTarget.style.backgroundColor = cellBg }}
        onClick={() => submitDepthOrder('ASK', level.key)}
        title={`${actionMode.toUpperCase()} ASK @ ${level.key}`}
      >
        <span className="relative z-10 inline-flex items-center gap-1">
          {visibleSize ? fmtCompact(visibleSize) : ''}
          {level.myAskSize > 0 && <span className="rounded-sm bg-[#ff3045] px-0.5 text-[8px] font-black text-white">ME</span>}
        </span>
      </button>
    )
  }

  const bidAskLabel = Number.isFinite(ladderModel.bid) && Number.isFinite(ladderModel.ask)
    ? `B ${fmtLadderPrice(ladderModel.bid)} / A ${fmtLadderPrice(ladderModel.ask)}`
    : simulationEnabled ? 'Sim active' : ''
  const lastTradeLabel = latestDepthLastPrice !== undefined
    ? `Last ${fmtLadderPrice(latestDepthLastPrice)} x${fmtCompact(latestDepthLastSize)}`
    : ''
  const controlButtonClass = 'h-8 border px-2 text-[11px] font-black uppercase leading-none'

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#05070b] font-mono">
      <div className="border-b p-2" style={{ backgroundColor: '#08101d', borderColor: rowLine }}>
        <ProductSelector provider={activeProvider} symbol={activeSymbol} onSelect={onSelect} />
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b px-2 py-1.5" style={{ borderColor: rowLine, backgroundColor: '#070a10' }}>
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
        <div className="flex flex-wrap items-center justify-center gap-1.5">
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
          <label
            className="flex h-8 items-center border bg-[#121212] text-[11px] font-black uppercase leading-none text-[#ffe800]"
            style={{ borderColor: rowLine }}
            title="Price multiplier: row step = exchange tick x multiplier. Higher values consolidate rows."
          >
            <span className="flex h-full items-center border-r px-2" style={{ borderColor: rowLine }}>X</span>
            <select
              value={priceMultiplier}
              onChange={event => setPriceMultiplier(Number(event.target.value) || 1)}
              className="h-full bg-[#121212] px-1 text-[11px] font-black text-[#ffe800] outline-none"
            >
              {priceMultiplierOptions.map(multiplier => <option key={multiplier} value={multiplier}>{multiplier}</option>)}
            </select>
          </label>
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
          <span className={cx(controlButtonClass, 'inline-flex items-center bg-[#121212] text-[#00d8ff]')} style={{ borderColor: rowLine }}>W {activeWorkingCount}</span>
          <span className={cx(controlButtonClass, 'inline-flex items-center bg-[#121212] text-[#22c55e]')} style={{ borderColor: rowLine }}>F {filledCount}</span>
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
          {defaultStatus && <span className={cx(controlButtonClass, 'inline-flex items-center bg-[#06111d] text-[#00d8ff]')} style={{ borderColor: '#00d8ff' }}>{defaultStatus}</span>}
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
          {levels.map(level => (
            <div
              key={level.key}
              data-depth-ladder-row="true"
              className={cx('grid select-none border-b', draggingOrder ? 'outline outline-1 outline-[#ffe800]/10' : false)}
              style={{
                gridTemplateColumns: ladderGridTemplate,
                borderColor: dragTargetPriceKey === level.key ? '#ffe800' : level.inside ? 'rgba(250, 204, 21, .38)' : mdRowLine,
                backgroundColor: dragTargetPriceKey === level.key ? 'rgba(255, 232, 0, .18)' : level.inside ? 'rgba(250, 204, 21, .09)' : '#05070b',
                height: densitySpec.rowHeight,
                lineHeight: `${densitySpec.rowHeight}px`,
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
      <div className="shrink-0 border-t p-1" style={{ borderColor: rowLine, backgroundColor: '#05070b' }}>
        <div className="mb-1 flex items-center gap-1">
          <div className="grid flex-1 grid-cols-[1fr_150px] gap-px text-[8px] uppercase">
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine }}>
              <div className="text-[#8b929e]">Intent</div>
              <div className="truncate font-bold text-white">{simulationEnabled ? `${defaultSize}x sim ${actionMode}` : fastTrade ? `${defaultSize}x fast ${actionMode}` : `${defaultSize}x staged ${actionMode}`}</div>
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
              <div className={cx('text-[#dbeafe]', localDepthPosition.net < 0 && 'text-white')}>{localDepthPosition.net > 0 ? 'Long' : localDepthPosition.net < 0 ? 'Short' : 'Flat'}</div>
              <div className="truncate text-[10px]">
                {localDepthPosition.net === 0
                  ? '0'
                  : `${Math.abs(localDepthPosition.net)} @ ${localDepthPosition.avg !== undefined ? fmtLadderPrice(localDepthPosition.avg) : '-'}`}
              </div>
            </div>
          </div>
          <input
            type="number"
            min={1}
            value={defaultSize}
            onChange={event => setDefaultSize(Math.max(1, Number(event.target.value) || 1))}
            className="h-8 w-16 border bg-[#121212] px-1 text-right text-[10px] font-bold text-slate-100 outline-none"
            style={{ borderColor: gridLine }}
            title="Custom quantity"
          />
        </div>
        {(displayActiveOrders.length > 0 || simDepthOrders.length > 0) && (
          <div className="grid grid-cols-4 gap-px text-[8px] uppercase">
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine }}>
              <div className="text-[#8b929e]">Bids</div>
              <div className="font-bold" style={{ color: buyColor.strong }}>{displayActiveOrders.filter(order => order.side === 'BID').length + simDepthOrders.filter(order => order.side === 'BID').length}</div>
            </div>
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine }}>
              <div className="text-[#8b929e]">Asks</div>
              <div className="font-bold" style={{ color: sellColor.strong }}>{displayActiveOrders.filter(order => order.side === 'ASK').length + simDepthOrders.filter(order => order.side === 'ASK').length}</div>
            </div>
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine }}>
              <div className="text-[#8b929e]">Working</div>
              <div className="font-bold text-[#00d8ff]">{activeWorkingCount}</div>
            </div>
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine }}>
              <div className="text-[#8b929e]">{latestFill ? 'Last Fill' : 'Pending'}</div>
              <div className="truncate font-bold text-[#ffe800]">{latestFill ? `${latestFill.side} ${latestFill.size} @ ${fmtLadderPrice(latestFill.fillPrice ?? Number(latestFill.priceKey))}` : activeOrders.filter(order => order.status === 'pending').length}</div>
            </div>
          </div>
        )}
        {simulationEnabled && simMessages[0] && (
          <div className="mt-1 truncate border px-1 py-0.5 text-[8px] font-bold uppercase text-[#74ff8d]" style={{ borderColor: '#1f5f2f', backgroundColor: '#07120a' }}>
            {simMessages[0]}
          </div>
        )}
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

const EXECUTION_CONTRACT_SPECS: Record<string, { tickSize: number; multiplier: number; tickValue: number }> = {
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

function executionRawPrice(price: number, marketKey: string, raw?: Record<string, unknown>): boolean {
  return Boolean(EXECUTION_CONTRACT_SPECS[marketKey.toUpperCase()])
    || (typeof raw?.multiplier === 'number' && raw.multiplier > 1)
    || (Number.isFinite(price) && (price < 0 || price > 100))
}

function executionMultiplier(marketKey: string, raw: Record<string, unknown> | undefined, price: number): number {
  const rawMultiplier = Number(raw?.multiplier)
  if (Number.isFinite(rawMultiplier) && rawMultiplier > 0) return rawMultiplier
  if (EXECUTION_CONTRACT_SPECS[marketKey.toUpperCase()]) return EXECUTION_CONTRACT_SPECS[marketKey.toUpperCase()].multiplier
  return executionRawPrice(price, marketKey, raw) ? 1 : 0.01
}

function executionPriceLabel(price: number, marketKey: string, raw?: Record<string, unknown>): string {
  if (!Number.isFinite(price)) return '-'
  if (executionRawPrice(price, marketKey, raw)) return price.toFixed(Math.abs(price) >= 100 ? 2 : 3)
  return `${price.toFixed(1)}c`
}

function executionNotional(price: number, size: number, marketKey: string, raw?: Record<string, unknown>): number {
  return Math.abs(price * size * executionMultiplier(marketKey, raw, price))
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

function simOrderToAcmeOrderRow(order: SimOrder, option: ProductOption | undefined): AcmeOrderRow {
  const side = executionOrderSideLabel(order)
  const tag = simOrderTag(order.source, order.algoRole, order.orderTag)
  return {
    id: order.id,
    instrumentId: option?.label ?? order.marketKey,
    label: option?.subtitle ?? order.marketKey,
    side,
    qty: order.remaining > 0 ? order.remaining : order.size,
    price: order.price,
    status: order.status,
    held: false,
    source: order.source,
    orderClass: tag,
    orderType: order.orderType,
    algoName: order.algoName ?? (order.source === 'algo' ? order.strategy : undefined),
    algoLegRole: order.algoRole ? (order.algoRole === 'cover' ? 'ALGO COVER' : 'ALGO ENTRY') : undefined,
    updatedAt: new Date(order.updatedAt).toISOString(),
  }
}

function simPositionToAcmePositionRow(position: SimPosition, option: ProductOption | undefined): AcmePositionRow {
  return {
    instrumentId: option?.label ?? position.marketKey,
    label: `${position.source === 'algo' ? (position.algoName ?? position.strategy) : 'Manual'}${position.algoRole ? ` / ${position.algoRole}` : ''}`,
    qty: position.size,
    avgPrice: position.avgPrice,
    markPrice: position.markPrice,
    markLive: true,
    multiplier: position.multiplier,
    openPnl: position.openPnl,
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
      const exchange = String(raw.exchange ?? providerLabel(option?.provider ?? 'cme'))
      const source = inferSource(raw, typeof raw.model === 'string' ? raw.model : undefined)
      const venue: ProviderKey | 'sim' = exchange === 'Sim Exchange' ? 'sim' : option?.provider ?? 'cme'
      const orderId = String(raw.order_id ?? raw.orderId ?? raw.trade_id ?? raw.tradeId ?? `${option?.provider ?? 'cme'}-${marketKey}-${fill.timestamp}-${index}`)
      const product = option?.label ?? market?.key ?? fill.marketKey ?? marketKey
      const priceLabel = executionPriceLabel(fill.price, marketKey, raw)
      const notional = executionNotional(fill.price, fill.size, marketKey, raw)
      const sideLabel = executionSideLabel(fill, marketKey, raw)
      const syntheticLegs = normalizeSyntheticFillLegs(raw)
      return {
        id: `fill-${marketKey}-${fill.timestamp}-${fill.price}-${fill.size}-${index}`,
        row_type: 'fill' as const,
        timestamp: fill.timestamp,
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
        size: fill.size.toFixed(0),
        status: 'FILLED',
        pnl: typeof raw.realizedPnl === 'number' ? raw.realizedPnl : 0,
        notional,
        order_details: `${simOrderTag(source, String(raw.algoRole ?? ''), String(raw.orderTag ?? ''))} ${exchange} ${product} ${sideLabel} ${fill.size.toFixed(0)} @ ${priceLabel}`,
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
    const priceLabel = executionPriceLabel(order.price, order.marketKey, order as unknown as Record<string, unknown>)
    const notional = executionNotional(order.price, order.size, order.marketKey, order as unknown as Record<string, unknown>)
    const sideLabel = executionOrderSideLabel(order)
    return {
      id: `sim-order-${order.id}`,
      row_type: 'order' as const,
      timestamp: order.updatedAt,
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
      size: `${order.filledSize.toFixed(0)} / ${order.size.toFixed(0)}`,
      status: order.status,
      pnl: position?.totalPnl ?? 0,
      notional,
      order_details: `${tag}${layerDetail} ${sideLabel} ${order.orderType.toUpperCase()} ${order.status} ${order.filledSize.toFixed(0)}/${order.size.toFixed(0)} @ ${priceLabel}${triggerDetail}${parentDetail}`,
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
  const cancelSimOrder = useStore(s => s.cancelSimOrder)
  const cancelSimOrders = useStore(s => s.cancelSimOrders)
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
      cancelSimOrder(row.order_id)
      setCancelStatus(`Cancelled ${row.order_tag} ${row.order_id}`)
      return
    }
    setCancelStatus(`Cancelling ${row.order_id}...`)
    try {
      const response = await fetch(`/api/acme/orders/${encodeURIComponent(row.order_id)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      setCancelStatus(response.ok ? `Cancel accepted for ${row.order_id}` : `Cancel rejected for ${row.order_id}`)
    } catch {
      setCancelStatus(`Cancel failed for ${row.order_id}`)
    }
  }

  const cancelAllOrders = async () => {
    setCancelStatus(simulationEnabled ? 'Cancelling Sim Exchange orders...' : 'Cancelling all venues...')
    cancelSimOrders()
    if (simulationEnabled) {
      setCancelStatus('Sim Exchange cancelled local working orders')
      return
    }
    const endpoints = [
      '/api/execution/cancel-all',
      '/api/orders/cancel-all',
      '/api/poly/cancel-all',
      '/api/poly/orders/cancel-all',
    ]
    const results = await Promise.allSettled(endpoints.map(endpoint => fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'all', account: 'parent', operator: operatorName, timestamp: Date.now() }),
    })))
    const ok = results.filter(result => result.status === 'fulfilled' && result.value.ok).length
    setCancelStatus(ok > 0 ? `Cancel all accepted by ${ok} service${ok === 1 ? '' : 's'} + Sim Exchange` : 'Sim Exchange cancelled local orders; no live adapter acknowledged yet')
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
            <span className="text-right">Size</span>
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
  if (size > 0) return `LONG ${Math.abs(size).toFixed(Number.isInteger(size) ? 0 : 2)}`
  if (size < 0) return `SHORT ${Math.abs(size).toFixed(Number.isInteger(size) ? 0 : 2)}`
  return 'FLAT'
}

function monitorPriceLabel(price: number, marketKey: string, raw?: Record<string, unknown>): string {
  if (!Number.isFinite(price)) return '-'
  return executionPriceLabel(price, marketKey, raw)
}

function simPositionToMonitorRow(position: SimPosition, option: ProductOption | undefined): PositionMonitorRow {
  const multiplier = executionMultiplier(position.marketKey, position as unknown as Record<string, unknown>, position.avgPrice)
  return {
    id: `sim-position-${position.id}`,
    provider: 'sim',
    exchange: 'Sim Exchange',
    product: option?.label ?? position.marketKey,
    symbol: option?.asset ?? option?.symbol ?? position.marketKey,
    marketKey: position.marketKey,
    position: position.status === 'closed' ? 0 : position.size,
    avgPrice: position.avgPrice,
    marketPrice: position.markPrice,
    marketValue: Math.abs(position.markPrice * position.size * multiplier),
    openPnl: position.openPnl,
    closedPnl: position.realizedPnl,
    dayPnl: position.totalPnl,
    status: position.status,
    source: position.source,
    strategy: position.algoName ?? position.strategy,
    updatedAt: position.closedAt ?? position.openedAt,
    details: `${simOrderTag(position.source, position.algoRole, position.orderTag)} ${position.status.toUpperCase()} ${positionSideLabel(position.size)} @ ${monitorPriceLabel(position.avgPrice, position.marketKey, position as unknown as Record<string, unknown>)}`,
  }
}

function executionPositionToMonitorRow(
  position: ReturnType<typeof useStore.getState>['executionPositions'][number],
  option: ProductOption | undefined,
): PositionMonitorRow {
  const marketKey = option?.marketKey ?? position.asset
  const signedSize = signedExecutionPositionSize(position.direction, Number(position.size) || 0)
  const multiplier = executionMultiplier(marketKey, position as unknown as Record<string, unknown>, Number(position.entry_price) || 0)
  const openPnl = Number(position.unrealized_pnl ?? 0)
  return {
    id: `execution-position-${position.position_id}`,
    provider: option?.provider ?? 'execution',
    exchange: providerLabel(option?.provider ?? 'cme'),
    product: option?.label ?? position.asset,
    symbol: option?.asset ?? option?.symbol ?? position.asset,
    marketKey,
    position: /closed|filled|cancel/i.test(position.status) ? 0 : signedSize,
    avgPrice: Number(position.entry_price) || 0,
    marketPrice: Number(position.current_price) || Number(position.entry_price) || 0,
    marketValue: Math.abs((Number(position.current_price) || Number(position.entry_price) || 0) * signedSize * multiplier),
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
            <span className="text-right">Size</span>
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
        <span>{visibleFillRows.length} visible fills, {visiblePositionRows.length} visible position rows</span>
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
      name: current.name || `${selectedOption?.asset ?? symbol} Theo Quoter`,
      operator: operatorName,
    }))
  }, [operatorName, provider, selectedOption?.marketKey, symbol])

  const quote = computeTheoQuote(selectedOption, draft.theoModel, draft.quoteWidth)
  const saveDraft = (status: AlgoStatus) => {
    const saveSymbol = selectedOption?.marketKey ?? symbol
    const acmeFields = normalizeAcmeFields({
      ...draft,
      instruments: draft.instruments?.length ? draft.instruments : [saveSymbol],
    }, saveSymbol)
    upsertAlgo({
      ...draft,
      ...acmeFields,
      id: draft.id || `algo-${Date.now()}`,
      provider,
      symbol: saveSymbol,
      marketKey: selectedOption?.marketKey ?? saveSymbol,
      operator: operatorName,
      status,
      updatedAt: Date.now(),
    })
    setDraft(defaultAlgo(selectedOption, operatorName))
  }
  const acmeDraft = normalizeAcmeFields(draft, draft.marketKey ?? draft.symbol)
  const signalRules = draft.signalRules ?? acmeDraft.signalRules
  const risk = draft.risk ?? acmeDraft.risk
  const entryPeg = draft.entryPeg ?? acmeDraft.entryPeg
  const layerPlan = draft.layerPlan ?? acmeDraft.layerPlan
  const syntheticOrderManager = draft.syntheticOrderManager ?? acmeDraft.syntheticOrderManager
  const exitPolicy = draft.exitPolicy ?? acmeDraft.exitPolicy
  const orderPolicy = draft.orderPolicy ?? acmeDraft.orderPolicy
  const setTemplate = (template: AlgoTemplate) => {
    setDraft(current => {
      const symbolKey = selectedOption?.marketKey ?? current.symbol
      const acmeFields = template === 'mean-reversion-v2' ? normalizeAcmeFields(current, symbolKey) : {}
      return { ...current, ...acmeFields, template, templateId: template }
    })
  }
  const updateRule = (index: number, patch: Partial<AlgoSignalRule>) => {
    setDraft(current => {
      const rules = [...(current.signalRules ?? acmeDraft.signalRules)]
      rules[index] = { ...rules[index], ...patch }
      return { ...current, signalRules: rules }
    })
  }
  const updateRisk = (patch: Partial<AlgoRisk>) => setDraft(current => ({ ...current, risk: { ...(current.risk ?? acmeDraft.risk), ...patch } }))
  const updateEntryPeg = (patch: Partial<AlgoEntryPeg>) => setDraft(current => ({ ...current, entryPeg: { ...(current.entryPeg ?? acmeDraft.entryPeg), ...patch } }))
  const updateLayerPlan = (patch: Partial<AlgoLayerPlan>) => setDraft(current => ({ ...current, layerPlan: { ...(current.layerPlan ?? acmeDraft.layerPlan), ...patch } }))
  const updateSyntheticManager = (patch: Partial<AlgoSyntheticOrderManager>) => setDraft(current => ({ ...current, syntheticOrderManager: { ...(current.syntheticOrderManager ?? acmeDraft.syntheticOrderManager), ...patch } }))
  const updateExitPolicy = (patch: Partial<AlgoExitPolicy>) => setDraft(current => ({ ...current, exitPolicy: { ...(current.exitPolicy ?? acmeDraft.exitPolicy), ...patch } }))
  const updateOrderPolicy = (patch: Partial<AlgoOrderPolicy>) => setDraft(current => ({ ...current, orderPolicy: { ...(current.orderPolicy ?? acmeDraft.orderPolicy), ...patch } }))

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
                <option value="theo-quoter">Theo Quoter</option>
                <option value="scale-in">Scale In</option>
                <option value="ptb-trigger">PTB Trigger</option>
              </select>
            </label>
            <label className="text-[10px] uppercase text-muted">
              Theo Model
              <select className="input-field mt-1 w-full py-1 text-[11px]" value={draft.theoModel} onChange={event => setDraft(current => ({ ...current, theoModel: event.target.value as TheoModel }))}>
                <option value="truth">Truth Engine</option>
                <option value="market-mid">Market Mid</option>
                <option value="ptb-edge">PTB Edge</option>
              </select>
            </label>
            <label className="text-[10px] uppercase text-muted">
              Outcome
              <select className="input-field mt-1 w-full py-1 text-[11px]" value={draft.outcome} onChange={event => setDraft(current => ({ ...current, outcome: event.target.value as 'yes' | 'no' }))}>
                <option value="yes">YES</option>
                <option value="no">NO</option>
              </select>
            </label>
            <label className="text-[10px] uppercase text-muted">
              Quote Side
              <select className="input-field mt-1 w-full py-1 text-[11px]" value={draft.side} onChange={event => setDraft(current => ({ ...current, side: event.target.value as AlgoDefinition['side'] }))}>
                <option value="both">Both</option>
                <option value="bid">Bid</option>
                <option value="offer">Offer</option>
              </select>
            </label>
            {[
              ['Quote Width', 'quoteWidth', 0.5],
              ['Edge Trigger', 'edgeThreshold', 0.5],
              ['Clip Size', 'clipSize', 1],
              ['Max Position', 'maxPosition', 1],
            ].map(([label, key, step]) => (
              <label key={String(key)} className="text-[10px] uppercase text-muted">
                {label}
                <input
                  type="number"
                  step={Number(step)}
                  className="input-field mt-1 w-full py-1 text-[11px]"
                  value={Number(draft[key as keyof AlgoDefinition])}
                  onChange={event => setDraft(current => ({ ...current, [key]: Number(event.target.value) }))}
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
                  Period
                  <input type="number" className="input-field mt-1 w-full py-1 text-[11px]" value={entryPeg.period} onChange={event => updateEntryPeg({ period: Number(event.target.value) || 1 })} />
                </label>
                <label className="text-[10px] uppercase text-muted">
                  Std Dev
                  <input type="number" step={0.25} className="input-field mt-1 w-full py-1 text-[11px]" value={entryPeg.standardDeviations} onChange={event => updateEntryPeg({ standardDeviations: Number(event.target.value) || 0 })} />
                </label>
                <label className="col-span-2 text-[10px] uppercase text-muted">
                  Source
                  <input className="input-field mt-1 w-full py-1 text-[11px]" value={entryPeg.source} onChange={event => updateEntryPeg({ source: event.target.value })} />
                </label>
                <label className="flex items-center gap-2 text-[10px] uppercase text-muted"><input type="checkbox" checked={entryPeg.pegBuySideToMinus2} onChange={event => updateEntryPeg({ pegBuySideToMinus2: event.target.checked })} /> Buy to -band</label>
                <label className="flex items-center gap-2 text-[10px] uppercase text-muted"><input type="checkbox" checked={entryPeg.pegSellSideToPlus2} onChange={event => updateEntryPeg({ pegSellSideToPlus2: event.target.checked })} /> Sell to +band</label>
              </div>
            </div>
            <div className="rounded border border-surface-border bg-surface-card p-2">
              <div className="mb-2 font-mono text-[10px] font-black uppercase text-accent">Layer Plan</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[10px] uppercase text-muted">
                  Layers
                  <input type="number" className="input-field mt-1 w-full py-1 text-[11px]" value={layerPlan.layerCount} onChange={event => updateLayerPlan({ layerCount: Number(event.target.value) || 1 })} />
                </label>
                <label className="text-[10px] uppercase text-muted">
                  Spacing Ticks
                  <input type="number" className="input-field mt-1 w-full py-1 text-[11px]" value={layerPlan.layerSpacingTicks} onChange={event => updateLayerPlan({ layerSpacingTicks: Number(event.target.value) || 0 })} />
                </label>
                <label className="text-[10px] uppercase text-muted">
                  Buy Offset
                  <input type="number" className="input-field mt-1 w-full py-1 text-[11px]" value={layerPlan.buyTicksOffMidpoint} onChange={event => updateLayerPlan({ buyTicksOffMidpoint: Number(event.target.value) || 0 })} />
                </label>
                <label className="text-[10px] uppercase text-muted">
                  Sell Offset
                  <input type="number" className="input-field mt-1 w-full py-1 text-[11px]" value={layerPlan.sellTicksOffMidpoint} onChange={event => updateLayerPlan({ sellTicksOffMidpoint: Number(event.target.value) || 0 })} />
                </label>
                <label className="flex items-center gap-2 text-[10px] uppercase text-muted"><input type="checkbox" checked={layerPlan.workBuySide} onChange={event => updateLayerPlan({ workBuySide: event.target.checked })} /> Work bid</label>
                <label className="flex items-center gap-2 text-[10px] uppercase text-muted"><input type="checkbox" checked={layerPlan.workSellSide} onChange={event => updateLayerPlan({ workSellSide: event.target.checked })} /> Work ask</label>
              </div>
            </div>
            <div className="rounded border border-surface-border bg-surface-card p-2">
              <div className="mb-2 font-mono text-[10px] font-black uppercase text-accent">Risk / Synthetic Manager</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[10px] uppercase text-muted">
                  Max Pos
                  <input type="number" className="input-field mt-1 w-full py-1 text-[11px]" value={risk.maxPosition} onChange={event => { const value = Number(event.target.value) || 1; updateRisk({ maxPosition: value }); setDraft(current => ({ ...current, maxPosition: value, clipSize: value })) }} />
                </label>
                <label className="text-[10px] uppercase text-muted">
                  Max Loss ATR
                  <input type="number" className="input-field mt-1 w-full py-1 text-[11px]" value={risk.maxLossAtr} onChange={event => updateRisk({ maxLossAtr: Number(event.target.value) || 0 })} />
                </label>
                <label className="col-span-2 text-[10px] uppercase text-muted">
                  Entry Technique
                  <input className="input-field mt-1 w-full py-1 text-[11px]" value={syntheticOrderManager.entryTechnique} onChange={event => updateSyntheticManager({ entryTechnique: event.target.value })} />
                </label>
                <label className="flex items-center gap-2 text-[10px] uppercase text-muted"><input type="checkbox" checked={syntheticOrderManager.holdUntilTriggered} onChange={event => updateSyntheticManager({ holdUntilTriggered: event.target.checked })} /> Hold until trigger</label>
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
            <button className="btn-accent py-2 text-[11px] font-bold" onClick={() => saveDraft('quoting')}>Stage Quoting</button>
          </div>
        </div>
        <div className="rounded border border-surface-border bg-surface-card p-2 font-mono">
          <div className="text-[10px] font-black uppercase text-accent">Theo Quote</div>
          <div className="mt-2 grid grid-cols-2 gap-y-1 text-[10px]">
            <span className="text-muted">Fair</span><span className="text-right font-black text-slate-100">{quote.fair.toFixed(1)}c</span>
            <span className="text-muted">Bid</span><span className="text-right font-black text-blue-300">{quote.bid.toFixed(1)}c</span>
            <span className="text-muted">Ask</span><span className="text-right font-black text-red-300">{quote.ask.toFixed(1)}c</span>
            <span className="text-muted">Edge</span><span className={cx('text-right font-black', quote.edge >= 0 ? 'text-up' : 'text-down')}>{quote.edge >= 0 ? '+' : ''}{quote.edge.toFixed(1)}c</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded bg-surface">
            <div className="h-full bg-accent" style={{ width: `${clamp(Math.abs(quote.edge) * 8, 2, 100)}%` }} />
          </div>
          <div className="mt-2 text-[9px] leading-relaxed text-muted">
            Held algos stay in Manager until status is changed. Quoting algos are represented as synthetic order intent until the algo engine service is connected.
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

type RegressionBandValues = {
  mean?: number
  upper?: number
  lower?: number
  sigma?: number
  slope?: number
  label: string
}

const LR_DEPLOY_MAX_AGE_MS = 90 * 60 * 1000

function finiteOptional(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function regressionBandsForPeg(stat: AcmeSpreadStat | undefined, period: number, deviations: number): RegressionBandValues | null {
  const lookback = Math.max(2, Math.floor(Number(period) || 27))
  const std = Math.max(0, Number(deviations) || 2)
  if (lookback === 27 && Math.abs(std - 2) < 0.0001) {
    const mean = finiteOptional(stat?.lr27Mean)
    const upper = finiteOptional(stat?.lr27Upper2)
    const lower = finiteOptional(stat?.lr27Lower2)
    if (mean !== undefined || upper !== undefined || lower !== undefined) {
      const interval = stat?.lr27Interval || '30m'
      return {
        mean,
        upper,
        lower,
        sigma: finiteOptional(stat?.lr27Sigma),
        slope: finiteOptional(stat?.lr27Slope),
        label: `LR27 ${interval} +/-2`,
      }
    }
    return null
  }

  if (stat?.bars?.length) {
    const channel = acmeRegressionChannel(stat.bars, {
      id: `algo-peg-lr-${lookback}-${std}`,
      type: 'regression-channel',
      lookback,
      upperDeviation: std,
      lowerDeviation: std,
    })
    const latest = channel?.endpoints[channel.endpoints.length - 1]
    if (latest) {
      return {
        mean: latest.mean,
        upper: latest.upper,
        lower: latest.lower,
        sigma: latest.sigma,
        slope: latest.slope,
        label: `LR${lookback} +/-${std}`,
      }
    }
  }

  return null
}

function algoRequiresRegressionPeg(algo: AlgoDefinition): boolean {
  const symbol = algo.marketKey ?? algo.symbol
  const acmeFields = normalizeAcmeFields(algo, symbol)
  const entryPeg = algo.entryPeg ?? acmeFields.entryPeg
  return Boolean(entryPeg.pegBuySideToMinus2 || entryPeg.pegSellSideToPlus2)
}

function validateAlgoStudyFreshness(algo: AlgoDefinition, stat: AcmeSpreadStat | undefined): string | null {
  if (!algoRequiresRegressionPeg(algo)) return null
  const symbol = algo.marketKey ?? algo.symbol
  if (!stat) return `${algo.name}: send price not published for ${symbol}; missing spread study`
  const mean = finiteOptional(stat.lr27Mean)
  const upper = finiteOptional(stat.lr27Upper2)
  const lower = finiteOptional(stat.lr27Lower2)
  const bars = Number(stat.lr27Bars ?? 0)
  const updatedAt = Number(stat.lr27UpdatedAt ?? 0)
  if (mean === undefined || upper === undefined || lower === undefined) {
    return `${algo.name}: send price not published for ${symbol}; LR27 +/-2 values are missing`
  }
  if (!Number.isFinite(bars) || bars < 27) {
    return `${algo.name}: send price not published for ${symbol}; LR27 has ${Number.isFinite(bars) ? bars : 0} bar(s), needs 27`
  }
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
    return `${algo.name}: send price not published for ${symbol}; LR27 timestamp is missing`
  }
  const ageMs = Date.now() - updatedAt
  if (ageMs > LR_DEPLOY_MAX_AGE_MS) {
    const updated = new Date(updatedAt).toLocaleTimeString()
    return `${algo.name}: send price not published for ${symbol}; LR27 is stale, last completed 30m bar ${updated}`
  }
  return null
}

function statWithFreshLr27(marketKey: string, lr: AcmeLr27State, fallback?: AcmeSpreadStat): AcmeSpreadStat {
  const last = finiteOptional(lr.lastTraded) ?? fallback?.lastTraded ?? fallback?.spread ?? 0
  return {
    key: marketKey,
    label: fallback?.label ?? lr.label ?? marketKey,
    spread: last,
    lastTraded: last,
    mean: fallback?.mean ?? last,
    longTermMean: fallback?.longTermMean ?? fallback?.mean ?? last,
    lookbackMean: fallback?.lookbackMean ?? fallback?.mean ?? last,
    priorLookbackMean: fallback?.priorLookbackMean ?? fallback?.mean ?? last,
    lookbackDays: fallback?.lookbackDays,
    priorSettle: fallback?.priorSettle,
    moveFromMean: fallback?.moveFromMean ?? 0,
    movePctOfAtr: fallback?.movePctOfAtr ?? 0,
    atr: fallback?.atr ?? 0,
    atr3: fallback?.atr3,
    atr20: fallback?.atr20,
    atr30: fallback?.atr30,
    blendedAtr: fallback?.blendedAtr,
    halfAtr: fallback?.halfAtr,
    vwapBasis: fallback?.vwapBasis,
    dayZ: fallback?.dayZ,
    z: fallback?.z ?? 0,
    rawZ: fallback?.rawZ,
    signalThreshold: fallback?.signalThreshold,
    bias: fallback?.bias ?? 'neutral',
    orderFlowScore: fallback?.orderFlowScore,
    updateCadence: 'focused LR27 refresh before algo deployment',
    rvInterval: fallback?.rvInterval,
    rvBars: fallback?.rvBars,
    rvUpdatedAt: fallback?.rvUpdatedAt,
    publishedAt: fallback?.publishedAt,
    publishReason: fallback?.publishReason,
    lr27Mean: lr.mean,
    lr27Upper2: lr.upper2,
    lr27Lower2: lr.lower2,
    lr27Sigma: lr.sigma,
    lr27Slope: lr.slope,
    lr27Interval: lr.interval,
    lr27Period: lr.period,
    lr27Bars: lr.bars,
    lr27UpdatedAt: lr.updatedAt,
    lr27IsForming: lr.isForming,
    lr27Source: lr.source ?? 'focused-lr27',
    theoreticalBid: fallback?.theoreticalBid ?? lr.lower2,
    theoreticalAsk: fallback?.theoreticalAsk ?? lr.upper2,
    signal: fallback?.signal ?? 'LR27 refreshed',
    volume: fallback?.volume,
    live: Boolean(lr.live ?? fallback?.live),
    bars: fallback?.bars ?? [],
  }
}

function buildAlgoDeploymentOrders(algo: AlgoDefinition, option: ProductOption | undefined, spreadStat?: AcmeSpreadStat): AlgoDeploymentOrder[] {
  const symbol = algo.marketKey ?? algo.symbol
  const acmeFields = normalizeAcmeFields(algo, symbol)
  const layerPlan = algo.layerPlan ?? acmeFields.layerPlan
  const risk = algo.risk ?? acmeFields.risk
  const entryPeg = algo.entryPeg ?? acmeFields.entryPeg
  const exitPolicy = algo.exitPolicy ?? acmeFields.exitPolicy
  const quote = computeTheoQuote(option, algo.theoModel, algo.quoteWidth)
  const tick = futuresTickForSymbol(symbol, quote.market)
  if (validateAlgoStudyFreshness(algo, spreadStat)) return []
  const pegBands = regressionBandsForPeg(spreadStat, entryPeg.period, entryPeg.standardDeviations)
  const layers = clamp(Math.floor(Number(layerPlan.layerCount) || 1), 1, Math.max(1, Number(layerPlan.maxLayers) || 10))
  const spacingTicks = Number(layerPlan.layerSpacingTicks) || 0
  const size = Math.max(1, Number(algo.clipSize || risk.maxPosition) || 1)
  const sides: Array<'bid' | 'offer'> = []
  if ((algo.side === 'both' || algo.side === 'bid') && layerPlan.workBuySide !== false) sides.push('bid')
  if ((algo.side === 'both' || algo.side === 'offer') && layerPlan.workSellSide !== false) sides.push('offer')
  const base = quote.fair
  const buyBase = entryPeg.pegBuySideToMinus2 && pegBands?.lower !== undefined ? pegBands.lower : base
  const sellBase = entryPeg.pegSellSideToPlus2 && pegBands?.upper !== undefined ? pegBands.upper : base
  const orders: AlgoDeploymentOrder[] = []
  for (let layer = 0; layer < layers; layer += 1) {
    const buyOffset = (Number(layerPlan.buyTicksOffMidpoint ?? layerPlan.ticksOffMidpoint) || 0) + (layer * spacingTicks)
    const sellOffset = (Number(layerPlan.sellTicksOffMidpoint ?? layerPlan.ticksOffMidpoint) || 0) + (layer * spacingTicks)
    if (sides.includes('bid')) {
      orders.push({
        side: 'bid',
        price: roundToTick(buyBase - (buyOffset * tick), tick),
        size,
        layer: layer + 1,
        trigger: entryPeg.pegBuySideToMinus2 ? `${pegBands?.label ?? `LR${entryPeg.period}`} lower` : 'midpoint',
        coverTicksFromFill: Number(exitPolicy.coverTicksFromFill) || 0,
        coverTickSize: tick,
      })
    }
    if (sides.includes('offer')) {
      orders.push({
        side: 'offer',
        price: roundToTick(sellBase + (sellOffset * tick), tick),
        size,
        layer: layer + 1,
        trigger: entryPeg.pegSellSideToPlus2 ? `${pegBands?.label ?? `LR${entryPeg.period}`} upper` : 'midpoint',
        coverTicksFromFill: Number(exitPolicy.coverTicksFromFill) || 0,
        coverTickSize: tick,
      })
    }
  }
  return orders
}

function AlgoManagerWindow() {
  const { algos, updateAlgo, removeAlgo } = useAlgoLibrary()
  const options = useProductOptions()
  const intelligence = useAcmeIntelligence()
  const placeSimOrder = useStore(s => s.placeSimOrder)
  const cancelSimOrders = useStore(s => s.cancelSimOrders)
  const simOrders = useStore(s => s.simOrders)
  const [statusFilter, setStatusFilter] = useState<AlgoStatus | 'all'>('all')
  const [algoToLoad, setAlgoToLoad] = useState('')
  const [stagedAlgoIds, setStagedAlgoIds] = useState<string[]>([])
  const [selectedDeployIds, setSelectedDeployIds] = useState<string[]>([])
  const [deployStatus, setDeployStatus] = useState('')
  const [deploying, setDeploying] = useState(false)
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
    const map = new Map<string, AcmeSpreadStat>()
    ;(intelligence?.spreadPack?.spreads ?? []).forEach(stat => {
      map.set(stat.key, stat)
    })
    return map
  }, [intelligence?.spreadPack?.spreads])
  const counts = algos.reduce<Record<AlgoStatus, number>>((acc, algo) => {
    acc[algo.status] += 1
    return acc
  }, { draft: 0, held: 0, quoting: 0, paused: 0 })
  const loadAlgo = () => {
    if (!algoToLoad) return
    setStagedAlgoIds(current => current.includes(algoToLoad) ? current : [...current, algoToLoad])
    setSelectedDeployIds(current => current.includes(algoToLoad) ? current : [...current, algoToLoad])
    setAlgoToLoad('')
  }
  const toggleDeploySelection = (id: string) => {
    setSelectedDeployIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
  }
  const pauseAndAuditSendPriceBlockers = async (blockers: Array<{ algo: AlgoDefinition; marketKey: string; reason: string }>) => {
    if (!blockers.length) return
    const blockedIds = new Set(blockers.map(item => item.algo.id))
    blockers.forEach(({ algo }) => updateAlgo(algo.id, { status: 'paused' }))
    setStagedAlgoIds(current => current.filter(id => !blockedIds.has(id)))
    setSelectedDeployIds(current => current.filter(id => !blockedIds.has(id)))
    await Promise.all(blockers.map(({ algo, marketKey, reason }) => publishAlgoGuardAuditEvent(algo, marketKey, reason)))
  }
  const deployAlgoDefinitions = async (selected: AlgoDefinition[]) => {
    if (!selected.length) {
      setDeployStatus('Select algo rows to deploy')
      return 0
    }
    setDeploying(true)
    let orderCount = 0
    try {
      setDeployStatus('Refreshing LR27 studies before deployment...')
      const freshSpreadStatsByKey = new Map(spreadStatsByKey)
      const requiredMarkets = Array.from(new Set(selected
        .filter(algoRequiresRegressionPeg)
        .map(algo => {
          const option = options.find(item => item.provider === algo.provider && item.symbol === algo.symbol)
            ?? options.find(item => item.marketKey === algo.marketKey)
          return algo.marketKey ?? option?.marketKey ?? algo.symbol
        })))
      for (const marketKey of requiredMarkets) {
        try {
          const lr = await fetchFreshLr27(marketKey)
          freshSpreadStatsByKey.set(marketKey, statWithFreshLr27(marketKey, lr, freshSpreadStatsByKey.get(marketKey)))
        } catch (err) {
          freshSpreadStatsByKey.delete(marketKey)
          freshSpreadStatsByKey.set(marketKey, {
            key: marketKey,
            label: marketKey,
            spread: 0,
            lastTraded: 0,
            mean: 0,
            longTermMean: 0,
            lookbackMean: 0,
            z: 0,
            atr: 0,
            lr27Mean: undefined,
            lr27Upper2: undefined,
            lr27Lower2: undefined,
            lr27Bars: 0,
            lr27UpdatedAt: 0,
            lr27Source: err instanceof Error ? err.message : 'fresh LR27 refresh failed',
            theoreticalBid: 0,
            theoreticalAsk: 0,
            signal: 'send price not published',
            live: false,
            bars: [],
          })
        }
      }
      const blockers: Array<{ algo: AlgoDefinition; marketKey: string; reason: string }> = []
      selected.forEach(algo => {
        const option = options.find(item => item.provider === algo.provider && item.symbol === algo.symbol)
          ?? options.find(item => item.marketKey === algo.marketKey)
        const marketKey = algo.marketKey ?? option?.marketKey ?? algo.symbol
        const blocker = validateAlgoStudyFreshness(algo, freshSpreadStatsByKey.get(marketKey))
        if (blocker) blockers.push({ algo, marketKey, reason: blocker })
      })
      if (blockers.length) {
        await pauseAndAuditSendPriceBlockers(blockers)
        const messages = blockers.map(item => item.reason)
        setDeployStatus(`DEPLOY BLOCKED: ${messages.slice(0, 2).join(' | ')}${messages.length > 2 ? ` (+${messages.length - 2} more)` : ''}`)
        return 0
      }

      selected.forEach(algo => {
        const option = options.find(item => item.provider === algo.provider && item.symbol === algo.symbol)
          ?? options.find(item => item.marketKey === algo.marketKey)
        const marketKey = algo.marketKey ?? option?.marketKey ?? algo.symbol
        const deploymentOrders = buildAlgoDeploymentOrders(algo, option, freshSpreadStatsByKey.get(marketKey))
        if (!deploymentOrders.length) return
        deploymentOrders.forEach(order => {
          placeSimOrder({
            id: `algo-${algo.id}-${order.side}-${order.layer}-${Date.now()}-${orderCount}`,
            marketKey,
            outcome: algo.outcome,
            side: order.side,
            orderType: algo.orderType,
            price: order.price,
            size: order.size,
            operator: algo.operator,
            source: 'algo',
            strategy: algo.name,
            legId: `${algo.id}-${order.side}-L${order.layer}`,
            orderTag: 'ALGO ENTRY',
            algoRole: 'entry',
            algoId: algo.id,
            algoName: algo.name,
            layer: order.layer,
            trigger: order.trigger,
            coverTicksFromFill: order.coverTicksFromFill,
            coverTickSize: order.coverTickSize,
            tickSize: option?.tickSize,
            tickValue: option?.tickValue,
            multiplier: option?.multiplier,
          })
          orderCount += 1
        })
        updateAlgo(algo.id, { status: 'quoting' })
      })
      setDeployStatus(orderCount ? `Deployed ${orderCount} algo order${orderCount === 1 ? '' : 's'} from fresh LR27 studies` : 'No deployable orders were generated')
      return orderCount
    } catch (err) {
      const blockers = selected
        .filter(algoRequiresRegressionPeg)
        .map(algo => ({
          algo,
          marketKey: algo.marketKey ?? algo.symbol,
          reason: `${algo.name}: send price not published for ${algo.marketKey ?? algo.symbol}; ${err instanceof Error ? err.message : 'fresh study refresh failed'}`,
        }))
      await pauseAndAuditSendPriceBlockers(blockers)
      setDeployStatus(`DEPLOY BLOCKED: ${blockers[0]?.reason ?? (err instanceof Error ? err.message : 'fresh study refresh failed')}`)
      return 0
    } finally {
      setDeploying(false)
    }
  }
  const deploySelected = () => {
    const selected = stagedAlgos.filter(algo => selectedDeployIds.includes(algo.id))
    void deployAlgoDefinitions(selected)
  }
  const killAllAlgos = () => {
    const pausedCount = algos.filter(algo => algo.status !== 'draft').length
    cancelSimOrders({ source: 'algo' })
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
          <button className="btn-accent px-3 py-1 text-[11px] font-black" onClick={deploySelected} disabled={deploying}>{deploying ? 'Checking...' : 'Deploy Selected'}</button>
          <button className="btn-neutral px-2 py-1 text-[11px]" onClick={() => { setStagedAlgoIds([]); setSelectedDeployIds([]) }}>Clear</button>
        </div>
        <div className="mt-2 grid grid-cols-[26px_1fr_80px_66px_58px_58px_76px_70px_70px] border border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] font-bold uppercase text-muted">
          <span />
          <span>Deploy Queue</span>
          <span>Product</span>
          <span>Side</span>
          <span className="text-right">Layers</span>
          <span className="text-right">Rules</span>
          <span className="text-right">First Bid</span>
          <span className="text-right">First Ask</span>
          <span className="text-right">Clip</span>
        </div>
        <div className="max-h-40 overflow-y-auto border-x border-b border-surface-border">
          {stagedAlgos.map(algo => {
            const option = options.find(item => item.provider === algo.provider && item.symbol === algo.symbol)
              ?? options.find(item => item.marketKey === algo.marketKey)
            const marketKey = algo.marketKey ?? option?.marketKey ?? algo.symbol
            const deploymentOrders = buildAlgoDeploymentOrders(algo, option, spreadStatsByKey.get(marketKey))
            const firstBid = deploymentOrders.find(order => order.side === 'bid')
            const firstAsk = deploymentOrders.find(order => order.side === 'offer')
            const activeRules = (algo.signalRules ?? []).filter(rule => rule.enabled).length
            const layerCount = algo.layerPlan?.layerCount ?? deploymentOrders.reduce((max, order) => Math.max(max, order.layer), 0)
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
        <span>Algo</span><span>Product</span><span>Template</span><span>Status</span><span className="text-right">Clip</span><span className="text-right">Max Pos</span><span className="text-right">Controls</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.map(algo => (
          <div key={algo.id} className="grid grid-cols-[1.2fr_82px_82px_70px_74px_76px_108px] items-center gap-1 border-b border-surface-border/50 px-2 py-1.5 font-mono text-[10px]">
            <div className="min-w-0">
              <div className="truncate font-black text-slate-100">{algo.name}</div>
              <div className="truncate text-[9px] text-muted">{theoModelLabel(algo.theoModel)} / {algo.operator}</div>
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

export function TheoQuoterWindow({
  provider,
  symbol,
  onSelect,
}: {
  provider: ProviderKey
  symbol: string
  onSelect: (provider: ProviderKey, symbol: string) => void
}) {
  const options = useProductOptions()
  const { algos } = useAlgoLibrary()
  const [model, setModel] = useState<TheoModel>('truth')
  const [width, setWidth] = useState(2)
  const selectedOption = options.find(option => option.provider === provider && option.symbol === symbol)
  const quote = computeTheoQuote(selectedOption, model, width)
  const productAlgos = algos.filter(algo => algo.provider === provider && algo.symbol === symbol)

  return (
    <div className="flex h-full flex-col bg-surface text-xs">
      <div className="grid grid-cols-[1fr_120px_80px] gap-2 border-b border-surface-border bg-surface-panel p-2">
        <ProductSelector provider={provider} symbol={symbol} onSelect={onSelect} compact />
        <select className="input-field py-1 text-[11px]" value={model} onChange={event => setModel(event.target.value as TheoModel)}>
          <option value="truth">Truth Engine</option>
          <option value="market-mid">Market Mid</option>
          <option value="ptb-edge">PTB Edge</option>
        </select>
        <input className="input-field py-1 text-[11px]" type="number" step={0.5} value={width} onChange={event => setWidth(Number(event.target.value) || 0)} title="Quote width in cents" />
      </div>
      <div className="grid grid-cols-4 gap-2 border-b border-surface-border p-3 font-mono">
        <div className="rounded border border-surface-border bg-surface-card p-2"><div className="text-[9px] uppercase text-muted">Market</div><div className="text-lg font-black text-slate-100">{quote.market.toFixed(1)}c</div></div>
        <div className="rounded border border-surface-border bg-surface-card p-2"><div className="text-[9px] uppercase text-muted">Theo</div><div className="text-lg font-black text-accent">{quote.fair.toFixed(1)}c</div></div>
        <div className="rounded border border-blue-500/30 bg-blue-500/10 p-2"><div className="text-[9px] uppercase text-blue-200">Bid</div><div className="text-lg font-black text-blue-200">{quote.bid.toFixed(1)}c</div></div>
        <div className="rounded border border-red-500/30 bg-red-500/10 p-2"><div className="text-[9px] uppercase text-red-200">Ask</div><div className="text-lg font-black text-red-200">{quote.ask.toFixed(1)}c</div></div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="mb-2 flex items-center justify-between font-mono text-[10px]">
          <span className="font-bold uppercase text-muted">Product algos</span>
          <span className={cx('font-black', quote.edge >= 0 ? 'text-up' : 'text-down')}>edge {quote.edge >= 0 ? '+' : ''}{quote.edge.toFixed(1)}c</span>
        </div>
        {productAlgos.map(algo => (
          <div key={algo.id} className="mb-1 grid grid-cols-[1fr_70px_70px_64px] rounded border border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px]">
            <span className="truncate font-bold text-slate-100">{algo.name}</span>
            <span className="text-muted">{algoTemplateLabel(algo.template)}</span>
            <span className={algo.status === 'quoting' ? 'text-up' : 'text-warn'}>{algo.status}</span>
            <span className="text-right text-accent">{algo.clipSize}x</span>
          </div>
        ))}
        {productAlgos.length === 0 && <div className="rounded border border-surface-border bg-surface-card p-4 text-center text-muted">No algo uses this product yet.</div>}
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
        ? option.provider === 'coinbase' || option.provider === 'hyperliquid'
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
            <span className="text-right text-slate-200">{row.option.provider === 'cme' ? (Number.isFinite(row.last) ? fmtLadderPrice(Number(row.last)) : '-') : row.option.provider === 'coinbase' || row.option.provider === 'hyperliquid' ? fmtMoney(row.last) : fmtCents(row.last)}</span>
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

  const defaultOption = options.find(option => option.provider === 'cme' && option.symbol === 'ES') ?? options[0]

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

  const firedFillKeys = useRef<Record<string, string>>({})

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
    const fillMessage = lastFill
      ? `${providerLabel(option?.provider ?? 'cme')} ${option?.label ?? option?.symbol ?? 'product'} ${executionSideLabel(lastFill, option?.marketKey ?? option?.symbol ?? lastFill.marketKey, lastFill as PolyTradeTick & Record<string, unknown>)} fill ${lastFill.size.toFixed(0)} @ ${option?.provider === 'cme' ? fmtLadderPrice(lastFill.price) : `${lastFill.price.toFixed(1)}c`}`
      : 'No fills yet'
    const fillKey = lastFill
      ? `${option?.marketKey ?? option?.symbol ?? 'product'}-${lastFill.timestamp}-${lastFill.price}-${lastFill.size}-${lastFill.side}-${(lastFill as PolyTradeTick & Record<string, unknown>).orderId ?? (lastFill as PolyTradeTick & Record<string, unknown>).order_id ?? ''}`
      : undefined
    if (alert.field === 'last') return { option, actual: last, message: `Last traded ${option?.provider === 'cme' ? fmtLadderPrice(Number(last)) : moneyProduct ? fmtMoney(last) : fmtCents(last)}`, moneyProduct }
    if (alert.field === 'fill') return { option, actual: lastFill?.timestamp, message: fillMessage, moneyProduct: false, fillKey }
    if (alert.field === 'probability') return { option, actual: market?.up_pct ?? option?.yes, message: `YES probability ${fmtPercent(market?.up_pct ?? option?.yes)}`, moneyProduct: false }
    if (alert.field === 'edge') {
      const actual = market ? (market.truth_up_pct ?? 0) - market.up_pct : undefined
      return { option, actual, message: `Edge ${actual !== undefined ? fmtCents(actual) : '-'}`, moneyProduct: false }
    }
    if (alert.field === 'gamma') return { option, actual: market?.gamma, message: `Gamma ${market?.gamma?.toFixed(4) ?? '-'}`, moneyProduct: false }
    return { option, actual: market?.theta, message: `Theta ${market?.theta?.toFixed(4) ?? '-'}`, moneyProduct: false }
  }

  useEffect(() => {
    alerts.forEach(alert => {
      if (!alert.enabled || alert.field !== 'fill') return
      const read = readAlert(alert)
      if (!read.fillKey) return
      if (firedFillKeys.current[alert.id] === read.fillKey) return
      firedFillKeys.current[alert.id] = read.fillKey
      const title = `Fill alert: ${read.option?.label ?? alert.productSymbol ?? 'product'}`
      const message = read.message
      const delivery = alert.delivery ?? {}
      if (delivery.audio) playAlertSound(delivery.sound ?? 'system-chime')
      if (delivery.desktop) void notifyDesktop(title, message)
      if (delivery.sms) void sendSmsAlert(delivery.phone, message)
    })
  }, [alerts, fills])

  return (
    <div className="flex h-full flex-col bg-surface text-xs">
      <div className="flex items-center justify-between border-b border-surface-border bg-surface-panel px-3 py-2">
        <div className="text-[10px] text-muted">Rules evaluate against the abstraction layer.</div>
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
                  <option value="probability">probability</option>
                  <option value="edge">edge</option>
                  <option value="gamma">gamma</option>
                  <option value="theta">theta</option>
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
              {alert.field === 'fill' && (
                <div className="mt-1 grid grid-cols-[78px_96px_92px_1fr] gap-1 text-[10px]">
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
                </div>
              )}
              <div className="mt-1 flex items-center justify-between text-[10px] font-mono">
                <span className={hit ? 'font-bold text-warn' : 'text-muted'}>{hit ? 'TRIGGERED' : 'watching'}</span>
                <span className="truncate text-slate-300">{read.message} {alert.field !== 'fill' ? `${alert.op} ${formatThreshold(alert, moneyProduct)}` : ''}</span>
              </div>
            </div>
          )
        })}
        {alerts.length === 0 && <div className="p-4 text-center text-muted">No alerts configured.</div>}
      </div>
    </div>
  )
}

function GreeksWindow() {
  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="grid grid-cols-3 gap-1 border-b border-surface-border bg-surface-card p-2">
        {GREEK_ENGINES.map(engine => (
          <div key={engine.key} className="rounded border border-surface-border bg-surface-panel px-2 py-1">
            <div className="text-[10px] font-bold uppercase text-accent">{engine.label}</div>
            <div className="text-[9px] font-mono text-muted">{engine.service}</div>
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <GreeksEducationPanel />
      </div>
    </div>
  )
}

function KnowledgeWindow() {
  return (
    <div className="h-full overflow-y-auto bg-surface p-3 text-xs text-slate-300">
      <div className="mb-3 flex items-center gap-2">
        <BookOpen size={16} className="text-accent" />
        <div className="text-[10px] text-muted">Service boundary for education, definitions, and playbooks.</div>
      </div>
      {[
        ['Microstructure', 'Z-score, OFI, VPIN, Keltner stretch, DIDI trend state, and trapped trader diagnostics.'],
        ['Truth Engine', 'Merton jump-diffusion, Student-t tails, micro-drift, and Bayesian edge detection.'],
        ['Greeks', 'Delta, Gamma, Theta, Vega, Vanna, and Charm as independent engines with publishable outputs.'],
        ['Execution', 'RiskGate, order router, journal, fills, and alert state can become separately deployable services.'],
      ].map(([title, body]) => (
        <div key={title} className="mb-2 rounded border border-surface-border bg-surface-card p-3">
          <div className="mb-1 font-bold text-slate-100">{title}</div>
          <p className="text-[11px] leading-relaxed text-muted">{body}</p>
        </div>
      ))}
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

const ACME_SPREAD_PRODUCTS = [
  { symbol: 'ES_NQ', label: 'ES / NQ', legs: 'ES - 0.2666667 x NQ', service: 'price.synthetic-spread' },
  { symbol: 'YM_ES', label: 'YM / ES', legs: 'YM - 6.6666667 x ES', service: 'price.synthetic-spread' },
  { symbol: 'RTY_ES', label: 'RTY / ES', legs: 'RTY - 0.4265 x ES', service: 'price.synthetic-spread' },
]

const ACME_PANEL_DETAILS: Partial<Record<WorkspaceWindowKind, { service: string; body: string; bullets: string[] }>> = {
  goose: {
    service: 'advisor.goose',
    body: 'Macro advisor window from Polyman. This is parked as its own boundary so the advisor feed can run independently of the trading canvas.',
    bullets: ['Macro context', 'Operator notes', 'Signal commentary'],
  },
  streamingNews: {
    service: 'news.stream',
    body: 'Streaming News window from Acme, reserved for the real-time news ingestion feed.',
    bullets: ['Timestamped feed', 'Source attribution', 'Spread impact tags'],
  },
  liveApiArchitecture: {
    service: 'terminal.gateway',
    body: 'Live API Architecture view for watching the service split as CME ingress, pricing, algos, orders, fills, alerts, and sim exchange move apart.',
    bullets: ['CME ingress only', 'Gateway fanout', 'Microservice readiness'],
  },
  tradeAnalytics: {
    service: 'analytics.trade',
    body: 'Trade Analytics workspace from Acme, fed by fills, orders, spread marks, and operator tags.',
    bullets: ['P&L attribution', 'Operator/source split', 'Export-ready rows'],
  },
  positionsOrders: {
    service: 'order.service',
    body: 'Positions & Orders window. This keeps the old workflow visible while routing the new build toward a dedicated order service.',
    bullets: ['Open orders', 'Positions', 'Cancel/replace path'],
  },
  auditTrail: {
    service: 'audit.journal',
    body: 'Audit Trail from Polyman, intended to capture every operator action, algo state change, order event, and fill.',
    bullets: ['Operator activity', 'Algo events', 'Gateway responses'],
  },
  spreadConfigurations: {
    service: 'product-library',
    body: 'Spread Configurations window for Acme synthetic products and leg definitions.',
    bullets: ACME_SPREAD_PRODUCTS.map(product => `${product.symbol}: ${product.legs}`),
  },
  relativeSpreadVisuals: {
    service: 'visuals.relative-spread',
    body: 'Relative Spread Visuals from Acme, reserved for cross-spread visual diagnostics.',
    bullets: ['Spread value', 'Leg pressure', 'Dislocation state'],
  },
  notionalCalculator: {
    service: 'risk.notional',
    body: 'Notional Calculator from Polyman, kept as an operator utility and future risk-service client.',
    bullets: ['Leg ratio sizing', 'Dollar notional', 'Spread exposure'],
  },
  macroRegimeSummary: {
    service: 'macro.regime',
    body: 'Macro Regime Summary from Acme, ready for the macro advisor and market-state feed.',
    bullets: ['Regime state', 'Volatility context', 'Session profile'],
  },
  liveSpreadSignals: {
    service: 'signal.spread',
    body: 'Live Spread Signals window, fed by synthetic marks, z-score, ATR, and trigger criteria.',
    bullets: ['ES/NQ', 'YM/ES', 'RTY/ES'],
  },
  atrZScoreEngine: {
    service: 'signal.atr-zscore',
    body: 'ATR and Z-Score Engine from Acme, preserved as a signal service target.',
    bullets: ['Rolling z-score', 'ATR bands', 'Trigger thresholds'],
  },
  executionRules: {
    service: 'risk.execution-rules',
    body: 'Execution Rules window, preserving the Acme operating checklist around held orders and releases.',
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
    body: 'Cross-Spread Opportunity Map from Acme, intended to compare all synthetic spread products.',
    bullets: ['Relative z-score', 'Best opportunity', 'Correlation check'],
  },
  riskChecklist: {
    service: 'risk.checklist',
    body: 'Risk Checklist window from Polyman, preserved for operator workflow and pre-release checks.',
    bullets: ['Data live', 'Risk armed', 'Algo state checked'],
  },
  sourceNotes: {
    service: 'knowledge.notes',
    body: 'Source Notes from Acme, kept for model assumptions, data-source comments, and operator notes.',
    bullets: ['Model notes', 'Data notes', 'Change notes'],
  },
  modelResearchGovernance: {
    service: 'knowledge.governance',
    body: 'Model Research & Governance window from Acme, reserved for model versioning and review state.',
    bullets: ['Version registry', 'Research status', 'Approval state'],
  },
}

export function AcmeProductLibraryWindow({ onSelect }: { onSelect: (provider: ProviderKey, symbol: string) => void }) {
  const options = useProductOptions()
  const rows = options.filter(option => PRODUCT_ASSETS.includes(option.asset ?? 'EVENT') || ACME_SPREAD_PRODUCTS.some(product => product.symbol === option.symbol))
  const ordered = [...rows].sort((a, b) => {
    const aSpread = ACME_SPREAD_PRODUCTS.some(product => product.symbol === a.symbol)
    const bSpread = ACME_SPREAD_PRODUCTS.some(product => product.symbol === b.symbol)
    if (aSpread !== bSpread) return aSpread ? -1 : 1
    return a.symbol.localeCompare(b.symbol)
  })

  return (
    <div className="h-full overflow-y-auto bg-surface p-3">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-xs font-black uppercase tracking-wide text-slate-100">Acme Product Library</div>
          <div className="mt-1 text-[10px] text-muted">Outrights plus Acme synthetic spread products.</div>
        </div>
        <span className="rounded border border-accent/30 bg-accent/10 px-2 py-1 font-mono text-[10px] font-bold text-accent">
          {ordered.length} products
        </span>
      </div>
      <div className="grid gap-2">
        {ordered.map(option => {
          const spread = ACME_SPREAD_PRODUCTS.find(product => product.symbol === option.symbol)
          return (
            <button
              key={`${option.provider}-${option.symbol}`}
              className="rounded border border-surface-border bg-surface-card p-2 text-left hover:border-accent/50 hover:bg-surface-hover"
              onClick={() => onSelect(option.provider, option.symbol)}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs font-black text-slate-100">{spread?.label ?? option.label}</span>
                <span className={cx('rounded px-1.5 py-0.5 text-[9px] font-bold uppercase', spread ? 'bg-accent/15 text-accent' : 'bg-surface text-muted')}>
                  {spread ? 'Synthetic' : 'Outright'}
                </span>
              </div>
              <div className="mt-1 text-[10px] text-muted">{spread?.legs ?? option.subtitle}</div>
              <div className="mt-2 flex justify-between font-mono text-[10px]">
                <span className="text-up">Bid {fmtProb(option.yes)}</span>
                <span className="text-down">Ask {fmtProb(option.no)}</span>
                <span className="text-muted">{option.live ? 'LIVE' : 'staged'}</span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function AcmeDepthTraderWindow({
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

type PlotlyLike = {
  react: (node: HTMLElement, traces: unknown[], layout: Record<string, unknown>, config?: Record<string, unknown>) => Promise<unknown>
  Plots?: { resize: (node: HTMLElement) => void }
  Fx?: { unhover?: (node: HTMLElement) => void }
}

type PlotlyHoverEvent = {
  points?: Array<{ curveNumber?: number }>
}

type PlotlyEventNode = HTMLElement & {
  on?: (eventName: string, handler: (event: PlotlyHoverEvent) => void) => void
  removeAllListeners?: (eventName: string) => void
}

function acmeChartStudyLabel(study: AcmeChartStudy) {
  if (study.type === 'atr') return `ATR ${study.lookback} x${(study.atrMultiplier ?? 2).toFixed(2)}`
  if (study.type === 'volume-at-price') return `Volume at Price ${study.bins ?? 28}`
  return `Linear Regression ${study.lookback} +${(study.upperDeviation ?? 2).toFixed(2)}/-${(study.lowerDeviation ?? 2).toFixed(2)}`
}

function acmeChartPalette(index: number) {
  const palettes = [
    { basis: '#ffd166', upper: '#fbbf24', lower: '#f59e0b' },
    { basis: '#ffe08a', upper: '#facc15', lower: '#d97706' },
    { basis: '#fff0b3', upper: '#eab308', lower: '#b45309' },
    { basis: '#fcd34d', upper: '#f59e0b', lower: '#92400e' },
  ]
  return palettes[Math.abs(index) % palettes.length]
}

function acmeAverage(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0
}

function acmeMedian(values: number[]) {
  const sorted = values.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
  if (!sorted.length) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function acmeClampLatestFormingBar(rows: Bar[]): Bar[] {
  if (rows.length < 8) return rows
  const latest = rows[rows.length - 1]
  const prior = rows.slice(Math.max(0, rows.length - 81), -1)
  const medianRange = acmeMedian(prior.map(row => row.high - row.low))
  const medianMove = acmeMedian(prior.slice(1).map((row, index) => Math.abs(row.close - prior[index].close)))
  const latestRange = latest.high - latest.low
  const previousClose = rows[rows.length - 2]?.close
  const latestMove = Number.isFinite(previousClose) ? Math.abs(latest.close - previousClose) : 0
  const rangeLimit = Math.max(medianRange * 2.4, medianMove * 5, 0.01)
  const closeLimit = Math.max(medianRange * 3.2, medianMove * 6, 0.01)
  if (!medianRange || (latestRange <= rangeLimit && latestMove <= closeLimit)) return rows

  const repairedClose = latestMove > closeLimit && Number.isFinite(previousClose)
    ? previousClose + Math.sign(latest.close - previousClose) * closeLimit
    : latest.close
  const repairedOpen = latestMove > closeLimit && Number.isFinite(previousClose)
    ? previousClose
    : latest.open
  const bodyHigh = Math.max(repairedOpen, repairedClose)
  const bodyLow = Math.min(repairedOpen, repairedClose)
  const pad = Math.max(medianRange * 1.35, Math.abs(repairedClose - repairedOpen) * 1.2, 0.01)
  const repaired = {
    ...latest,
    open: repairedOpen,
    close: repairedClose,
    high: Math.max(bodyHigh, Math.min(latest.high, bodyHigh + pad)),
    low: Math.min(bodyLow, Math.max(latest.low, bodyLow - pad)),
  }
  return [...rows.slice(0, -1), repaired]
}

function acmeTimeframeMs(timeframe: AcmeChartTimeframe): number {
  if (timeframe === '1m') return 60_000
  if (timeframe === '5m') return 5 * 60_000
  if (timeframe === '30m') return 30 * 60_000
  if (timeframe === '1h') return 60 * 60_000
  return 24 * 60 * 60_000
}

function acmeCompletedStudyRows(rows: Bar[], timeframe: AcmeChartTimeframe): Bar[] {
  const periodMs = acmeTimeframeMs(timeframe)
  const now = Date.now()
  return rows.filter(row => Number.isFinite(row.timestamp) && row.timestamp + periodMs <= now)
}

function acmeTimeLabel(ms: number) {
  const date = new Date(ms)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function acmeCompressedAxis(bars: Bar[]) {
  const x = bars.map((_, index) => index)
  const maxTicks = Math.max(2, Math.min(9, Math.floor(Math.max(320, bars.length * 8) / 120)))
  const step = Math.max(1, Math.floor((bars.length - 1) / Math.max(1, maxTicks - 1)))
  const tickvals: number[] = []
  const ticktext: string[] = []
  for (let index = 0; index < bars.length; index += step) {
    tickvals.push(index)
    ticktext.push(acmeTimeLabel(bars[index].timestamp))
  }
  if (bars.length && tickvals[tickvals.length - 1] !== bars.length - 1) {
    tickvals.push(bars.length - 1)
    ticktext.push(acmeTimeLabel(bars[bars.length - 1].timestamp))
  }
  return { x, tickvals, ticktext, labels: bars.map(bar => new Date(bar.timestamp).toLocaleString()) }
}

function acmeRegressionChannel(bars: Bar[], study: AcmeChartStudy) {
  if (study.type !== 'regression-channel') return null
  const lookback = Math.max(2, Math.floor(study.lookback || 27))
  const endIndex = bars.length - 1
  const startIndex = endIndex - lookback + 1
  if (startIndex < 0) return null
  const sample = bars.slice(startIndex, endIndex + 1).map(bar => Number(bar.close))
  if (!sample.every(Number.isFinite)) return null
  const n = sample.length
  const xMean = (n - 1) / 2
  const yMean = acmeAverage(sample)
  let numerator = 0
  let denominator = 0
  sample.forEach((value, index) => {
    numerator += (index - xMean) * (value - yMean)
    denominator += (index - xMean) ** 2
  })
  const slope = denominator ? numerator / denominator : 0
  const intercept = yMean - slope * xMean
  const residuals = sample.map((value, index) => value - (intercept + slope * index))
  const sigma = Math.sqrt(acmeAverage(residuals.map(value => value ** 2)) || 0)
  const endpoints = [0, n - 1].map(sampleIndex => {
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
  return { study, endpoints }
}

function acmeRegressionTraces(
  bars: Bar[],
  studies: AcmeChartStudy[],
  xValues: Array<number | Date>,
  labels: string[],
) {
  return studies.flatMap((study, index) => {
    const channel = acmeRegressionChannel(bars, study)
    if (!channel) return []
    const palette = acmeChartPalette(index)
    const x = channel.endpoints.map(point => xValues[point.index])
    const customdata = channel.endpoints.map(point => labels[point.index])
    const suffix = ` ${index + 1}`
    const upperLabel = `+${(study.upperDeviation ?? 2).toFixed(2)} Dev Band${suffix}`
    const lowerLabel = `-${(study.lowerDeviation ?? 2).toFixed(2)} Dev Band${suffix}`
    return [
      {
        x,
        y: channel.endpoints.map(point => point.mean),
        customdata,
        type: 'scatter',
        mode: 'lines',
        name: `Mean Line${suffix}`,
        line: { color: palette.basis, width: 1.55, dash: 'dash' },
        hovertemplate: '%{customdata}<br>Mean %{y:.2f}<extra></extra>',
      },
      {
        x,
        y: channel.endpoints.map(point => point.upper),
        customdata,
        type: 'scatter',
        mode: 'lines',
        name: upperLabel,
        line: { color: palette.upper, width: 1.35 },
        hovertemplate: `%{customdata}<br>${upperLabel} %{y:.2f}<extra></extra>`,
      },
      {
        x,
        y: channel.endpoints.map(point => point.lower),
        customdata,
        type: 'scatter',
        mode: 'lines',
        name: lowerLabel,
        line: { color: palette.lower, width: 1.35 },
        hovertemplate: `%{customdata}<br>${lowerLabel} %{y:.2f}<extra></extra>`,
      },
    ]
  })
}

function acmeAtrValue(bars: Bar[], period: number): number | null {
  const lookback = Math.max(2, Math.floor(period || 14))
  if (bars.length < lookback + 1) return null
  const trs: number[] = []
  for (let index = 1; index < bars.length; index += 1) {
    const current = bars[index]
    const previous = bars[index - 1]
    trs.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ))
  }
  return acmeAverage(trs.slice(-lookback))
}

function acmeAtrTraces(
  bars: Bar[],
  studies: AcmeChartStudy[],
  xValues: Array<number | Date>,
  labels: string[],
) {
  return studies.filter(study => study.type === 'atr').flatMap((study, index) => {
    const period = Math.max(2, Math.floor(study.lookback || 14))
    const multiplier = Math.max(0, study.atrMultiplier ?? 2)
    const yUpper: Array<number | null> = []
    const yLower: Array<number | null> = []
    for (let i = 0; i < bars.length; i += 1) {
      const atr = acmeAtrValue(bars.slice(0, i + 1), period)
      yUpper.push(atr === null ? null : bars[i].close + atr * multiplier)
      yLower.push(atr === null ? null : bars[i].close - atr * multiplier)
    }
    const upperColor = index % 2 ? '#38bdf8' : '#00d8ff'
    const lowerColor = index % 2 ? '#fb7185' : '#ff3045'
    return [
      {
        x: xValues,
        y: yUpper,
        customdata: labels,
        type: 'scatter',
        mode: 'lines',
        name: `ATR +${multiplier.toFixed(2)}`,
        line: { color: upperColor, width: 1, dash: 'dot' },
        hovertemplate: '%{customdata}<br>ATR Upper %{y:.2f}<extra></extra>',
      },
      {
        x: xValues,
        y: yLower,
        customdata: labels,
        type: 'scatter',
        mode: 'lines',
        name: `ATR -${multiplier.toFixed(2)}`,
        line: { color: lowerColor, width: 1, dash: 'dot' },
        hovertemplate: '%{customdata}<br>ATR Lower %{y:.2f}<extra></extra>',
      },
    ]
  })
}

function acmeVolumeAtPriceShapes(rows: Bar[], studies: AcmeChartStudy[]) {
  const study = studies.find(item => item.type === 'volume-at-price')
  if (!study || rows.length < 2) return []
  const prices = rows.flatMap(row => [row.low, row.high, row.close]).filter(Number.isFinite)
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return []
  const bins = Math.max(8, Math.min(80, Math.floor(study.bins ?? 28)))
  const step = (max - min) / bins
  const buckets = Array.from({ length: bins }, (_, index) => ({ low: min + index * step, high: min + (index + 1) * step, volume: 0 }))
  rows.forEach(row => {
    const typical = (row.high + row.low + row.close) / 3
    const index = clamp(Math.floor((typical - min) / step), 0, bins - 1)
    buckets[index].volume += Math.max(0, row.volume || 0)
  })
  const maxVolume = Math.max(1, ...buckets.map(bucket => bucket.volume))
  return buckets
    .filter(bucket => bucket.volume > 0)
    .map(bucket => {
      const width = 0.18 * (bucket.volume / maxVolume)
      return {
        type: 'rect',
        xref: 'paper',
        yref: 'y',
        x0: 1 - width,
        x1: 1,
        y0: bucket.low,
        y1: bucket.high,
        line: { width: 0 },
        fillcolor: 'rgba(0, 216, 255, .18)',
        layer: 'below',
      }
    })
}

function AcmePlotlyChart({ stat }: { stat: AcmeSpreadStat }) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    let cancelled = false
    let retryId = 0
    const render = () => {
      const plotly = (window as typeof window & { Plotly?: PlotlyLike }).Plotly
      if (!plotly) {
        retryId = window.setTimeout(render, 250)
        return
      }
      const bars = stat.bars ?? []
      const x = bars.map(bar => new Date(bar.timestamp))
      const y = bars.map(bar => bar.close)
      const mean = stat.mean
      const upper = stat.mean + 2 * stat.atr
      const lower = stat.mean - 2 * stat.atr
      const traces = [
        { x, y, type: 'scatter', mode: 'lines', name: stat.label, line: { color: '#00d8ff', width: 2 } },
        { x, y: y.map(() => mean), type: 'scatter', mode: 'lines', name: 'Mean', line: { color: '#e5f0ff', width: 1, dash: 'dot' } },
        { x, y: y.map(() => upper), type: 'scatter', mode: 'lines', name: '+2 ATR', line: { color: '#ff3045', width: 1, dash: 'dash' } },
        { x, y: y.map(() => lower), type: 'scatter', mode: 'lines', name: '-2 ATR', line: { color: '#38bdf8', width: 1, dash: 'dash' } },
      ]
      const layout = {
        paper_bgcolor: '#05070b',
        plot_bgcolor: '#05070b',
        margin: { l: 42, r: 18, t: 8, b: 28 },
        font: { color: '#e5f0ff', size: 10 },
        xaxis: { gridcolor: 'rgba(38,50,65,.42)', linecolor: '#4b5f76', tickcolor: '#4b5f76', tickfont: { color: '#a8b4c4' }, zeroline: false },
        yaxis: { gridcolor: 'rgba(38,50,65,.42)', linecolor: '#4b5f76', tickcolor: '#4b5f76', tickfont: { color: '#a8b4c4' }, zeroline: false },
        showlegend: false,
      }
      if (!cancelled) void plotly.react(node, traces, layout, { displayModeBar: false, responsive: true })
    }
    render()
    return () => {
      cancelled = true
      if (retryId) window.clearTimeout(retryId)
    }
  }, [stat])

  return <div ref={ref} className="h-full w-full" />
}

function AcmePlotlyPanelWindow({ panels }: { panels: 2 | 3 }) {
  const data = useAcmeIntelligence()
  const spreads = data?.spreadPack?.spreads ?? []
  const visible = spreads.slice(0, panels)
  return (
    <div className={cx('grid h-full gap-2 bg-surface p-2', panels === 3 ? 'grid-rows-3' : 'grid-rows-2')}>
      {visible.map(stat => (
        <div key={stat.key} className="min-h-0 rounded border border-surface-border bg-surface-card p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-mono text-[11px] font-black text-accent">{stat.label}</span>
            <span className={cx('font-mono text-[10px] font-black', stat.z >= 0 ? 'text-down' : 'text-up')}>z {stat.z.toFixed(2)}</span>
          </div>
          <div className="h-[calc(100%-22px)] min-h-0 overflow-hidden">
            <AcmePlotlyChart stat={stat} />
          </div>
        </div>
      ))}
      {!visible.length && <div className="rounded border border-surface-border bg-surface-card p-4 text-center text-muted">Waiting for Acme spread bars.</div>}
    </div>
  )
}

function AcmeProductCandleChart({
  symbol,
  timeframe,
  mode,
  compressBlankSessions,
  showGrid,
  solidCandles,
  studies,
}: {
  symbol: string
  timeframe: AcmeChartTimeframe
  mode: AcmeChartMode
  compressBlankSessions: boolean
  showGrid: boolean
  solidCandles: boolean
  studies: AcmeChartStudy[]
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const { bars, error } = useAcmeBars(symbol || 'ES_NQ', timeframe)
  const [legendOpen, setLegendOpen] = useState(false)
  const [hoverReady, setHoverReady] = useState(false)
  const legendTimerRef = useRef<number | null>(null)
  const hoverTimerRef = useRef<number | null>(null)
  const hoverTokenRef = useRef(0)

  const clearLegendTimer = () => {
    if (legendTimerRef.current !== null) {
      window.clearTimeout(legendTimerRef.current)
      legendTimerRef.current = null
    }
  }

  const showLegendAfterHold = () => {
    clearLegendTimer()
    legendTimerRef.current = window.setTimeout(() => {
      setLegendOpen(true)
      legendTimerRef.current = null
    }, 550)
  }

  const hideLegend = () => {
    clearLegendTimer()
    setLegendOpen(false)
  }

  useEffect(() => {
    const node = ref.current
    if (!node) return
    let cancelled = false
    let retryId = 0
    let detachHoverEvents: (() => void) | null = null
    let resizeObserver: ResizeObserver | null = null
    const clearHoverIntent = () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = null
      }
      hoverTokenRef.current += 1
      setHoverReady(false)
    }
    const render = () => {
      const plotly = (window as typeof window & { Plotly?: PlotlyLike }).Plotly
      if (!plotly) {
        retryId = window.setTimeout(render, 250)
        return
      }
      const rows = acmeClampLatestFormingBar(bars.filter(bar => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)))
      if (!rows.length) {
        detachHoverEvents?.()
        clearHoverIntent()
        node.innerHTML = '<div class="flex h-full items-center justify-center text-xs text-slate-500">Waiting for chart bars.</div>'
        return
      }
      const compressed = compressBlankSessions ? acmeCompressedAxis(rows) : null
      const x = compressed ? compressed.x : rows.map(bar => new Date(bar.timestamp))
      const labels = compressed ? compressed.labels : rows.map(bar => new Date(bar.timestamp).toLocaleString())
      const studyRows = acmeCompletedStudyRows(rows, timeframe)
      const compressedStudy = compressBlankSessions ? acmeCompressedAxis(studyRows) : null
      const studyX = compressedStudy ? compressedStudy.x : studyRows.map(bar => new Date(bar.timestamp))
      const studyLabels = compressedStudy ? compressedStudy.labels : studyRows.map(bar => new Date(bar.timestamp).toLocaleString())
      const baseTrace = mode === 'candles'
        ? {
            x,
            customdata: labels,
            open: rows.map(bar => bar.open),
            high: rows.map(bar => bar.high),
            low: rows.map(bar => bar.low),
            close: rows.map(bar => bar.close),
            type: 'candlestick',
            name: symbol || 'ACME Chart',
            increasing: {
              line: { color: solidCandles ? 'rgba(255,255,255,.95)' : '#00d8ff', width: solidCandles ? 0.9 : 1.3 },
              fillcolor: solidCandles ? '#006dff' : 'rgba(0,216,255,.34)',
            },
            decreasing: {
              line: { color: solidCandles ? 'rgba(255,255,255,.95)' : '#ff3045', width: solidCandles ? 0.9 : 1.3 },
              fillcolor: solidCandles ? '#ff3045' : 'rgba(255,48,69,.42)',
            },
            hoverlabel: { bgcolor: '#101a29', font: { color: '#edf4ff' } },
            hovertemplate: '%{customdata}<br>O %{open:.2f}<br>H %{high:.2f}<br>L %{low:.2f}<br>C %{close:.2f}<extra></extra>',
          }
        : {
            x,
            customdata: labels,
            y: rows.map(bar => bar.close),
            type: 'scatter',
            mode: 'lines',
            name: `${symbol || 'ACME'} Close`,
            line: { color: '#00d8ff', width: 1.8 },
            connectgaps: false,
            hovertemplate: '%{customdata}<br>Close %{y:.2f}<extra></extra>',
          }
      const regressionTraces = acmeRegressionTraces(studyRows, studies, studyX, studyLabels)
      const atrTraces = acmeAtrTraces(studyRows, studies, studyX, studyLabels)
      const volumeAtPriceShapes = acmeVolumeAtPriceShapes(rows, studies)
      const last = rows[rows.length - 1]
      const traces = [baseTrace, ...regressionTraces, ...atrTraces]
      const priceMarkerShapes = Number.isFinite(last.close)
        ? [{
            type: 'line',
            xref: 'paper',
            yref: 'y',
            x0: 0.985,
            x1: 1,
            y0: last.close,
            y1: last.close,
            line: { color: '#00d8ff', width: 1 },
          }]
        : []
      const layout = {
        autosize: true,
        paper_bgcolor: '#05070b',
        plot_bgcolor: '#05070b',
        margin: { l: 4, r: 46, t: 6, b: 24 },
        dragmode: 'pan',
        showlegend: regressionTraces.length + atrTraces.length > 0,
        legend: {
          orientation: 'h',
          x: 0.01,
          y: 0.995,
          xanchor: 'left',
          yanchor: 'top',
          font: { color: '#e5f0ff', size: 9 },
          bgcolor: 'rgba(5,7,11,.9)',
          bordercolor: 'rgba(0,216,255,.3)',
          borderwidth: 1,
        },
        hovermode: 'closest',
        hoverdistance: 8,
        spikedistance: -1,
        uirevision: `${symbol}-${timeframe}-${mode}-${compressBlankSessions ? 'nogaps' : 'time'}-${studies.map(acmeChartStudyLabel).join('|')}`,
        font: { family: 'Inter, Arial, sans-serif', color: '#e5f0ff', size: 11 },
        shapes: [...volumeAtPriceShapes, ...priceMarkerShapes],
        annotations: Number.isFinite(last.close)
          ? [{
              xref: 'paper',
              yref: 'y',
              x: 1.002,
              y: last.close,
              xanchor: 'left',
              yanchor: 'middle',
              text: last.close.toFixed(2),
              showarrow: false,
              font: { color: '#001014', size: 9 },
              bgcolor: '#00d8ff',
              bordercolor: 'rgba(0,216,255,.68)',
              borderwidth: 1,
              borderpad: 1,
            }]
          : [],
        xaxis: {
          title: { text: '' },
          type: compressed ? 'linear' : 'date',
          rangeslider: { visible: false },
          showgrid: showGrid,
          gridcolor: 'rgba(38,50,65,.55)',
          linecolor: '#4b5f76',
          tickcolor: '#4b5f76',
          tickfont: { color: '#a8b4c4', size: 9 },
          ticklen: 3,
          nticks: 7,
          showline: true,
          automargin: false,
          fixedrange: false,
          ...(compressed ? { tickmode: 'array', tickvals: compressed.tickvals, ticktext: compressed.ticktext } : {}),
        },
        yaxis: {
          title: { text: '' },
          side: 'right',
          showgrid: showGrid,
          gridcolor: 'rgba(38,50,65,.55)',
          linecolor: '#4b5f76',
          tickcolor: '#4b5f76',
          tickfont: { color: '#a8b4c4', size: 9 },
          tickformat: '.2f',
          ticklen: 3,
          nticks: 9,
          showline: true,
          zeroline: false,
          automargin: false,
          fixedrange: false,
        },
      }
      if (!cancelled) void plotly.react(node, traces, layout, {
        responsive: true,
        scrollZoom: true,
        displaylogo: false,
        modeBarButtonsToRemove: ['toImage', 'sendDataToCloud', 'lasso2d', 'select2d'],
      }).then(() => {
        if (cancelled) return
        detachHoverEvents?.()
        resizeObserver?.disconnect()
        const plotNode = node as PlotlyEventNode
        plotNode.removeAllListeners?.('plotly_hover')
        plotNode.removeAllListeners?.('plotly_unhover')
        const handleHover = (event: PlotlyHoverEvent) => {
          const point = event.points?.[0]
          if (point?.curveNumber !== 0) {
            clearHoverIntent()
            plotly.Fx?.unhover?.(node)
            return
          }
          if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current)
          const token = hoverTokenRef.current + 1
          hoverTokenRef.current = token
          setHoverReady(false)
          hoverTimerRef.current = window.setTimeout(() => {
            if (!cancelled && hoverTokenRef.current === token) setHoverReady(true)
            hoverTimerRef.current = null
          }, 850)
        }
        const handleUnhover = () => {
          clearHoverIntent()
        }
        plotNode.on?.('plotly_hover', handleHover)
        plotNode.on?.('plotly_unhover', handleUnhover)
        node.addEventListener('mouseleave', handleUnhover)
        detachHoverEvents = () => {
          plotNode.removeAllListeners?.('plotly_hover')
          plotNode.removeAllListeners?.('plotly_unhover')
          node.removeEventListener('mouseleave', handleUnhover)
        }
        const resize = () => {
          if (!cancelled) window.requestAnimationFrame(() => plotly.Plots?.resize(node))
        }
        resizeObserver = new ResizeObserver(resize)
        resizeObserver.observe(node)
        if (node.parentElement) resizeObserver.observe(node.parentElement)
        resize()
      })
    }
    render()
    return () => {
      cancelled = true
      detachHoverEvents?.()
      resizeObserver?.disconnect()
      clearHoverIntent()
      if (retryId) window.clearTimeout(retryId)
    }
  }, [bars, compressBlankSessions, mode, showGrid, solidCandles, studies, symbol, timeframe])

  useEffect(() => () => {
    clearLegendTimer()
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current)
  }, [])

  return (
    <div className="relative h-full w-full">
      <style>{`
        .acme-product-plot .legend {
          opacity: 1;
          transition: opacity 140ms ease, transform 140ms ease;
        }
        .acme-product-plot:not(.acme-legend-open) .legend {
          opacity: 0 !important;
          pointer-events: none !important;
          transform: translateY(-10px);
        }
        .acme-product-plot:not(.acme-hover-ready) .hoverlayer {
          opacity: 0 !important;
          pointer-events: none !important;
        }
      `}</style>
      <div
        className="absolute left-0 top-0 z-20 h-8 w-full"
        onPointerEnter={showLegendAfterHold}
        onPointerLeave={hideLegend}
        title="Hover and hold to show chart legend"
      />
      <div
        ref={ref}
        className={cx('acme-product-plot h-full w-full', legendOpen && 'acme-legend-open', hoverReady && 'acme-hover-ready')}
      />
      {error && <div className="pointer-events-none absolute bottom-2 left-2 rounded border border-down/30 bg-down/10 px-2 py-1 font-mono text-[10px] text-down">Chart bars retrying: {error}</div>}
    </div>
  )
}

function AcmeSingleChartWindow({
  provider,
  symbol,
  onSelect,
  settings,
  onSettingsChange,
}: {
  provider: ProviderKey
  symbol: string
  onSelect: (provider: ProviderKey, symbol: string) => void
  settings?: AcmeChartSettings
  onSettingsChange: (settings: AcmeChartSettings) => void
}) {
  const [mode, setMode] = useState<AcmeChartMode>(settings?.mode ?? 'candles')
  const [timeframe, setTimeframe] = useState<AcmeChartTimeframe>(settings?.timeframe ?? '30m')
  const [compressBlankSessions, setCompressBlankSessions] = useState(settings?.compressBlankSessions ?? true)
  const [showGrid, setShowGrid] = useState(settings?.showGrid ?? false)
  const [solidCandles, setSolidCandles] = useState(settings?.solidCandles ?? true)
  const [displayPreset, setDisplayPreset] = useState<AcmeChartDisplayPreset>(settings?.displayPreset ?? 'clean')
  const [showStudyBuilder, setShowStudyBuilder] = useState(false)
  const [studyType, setStudyType] = useState<AcmeChartStudyType>(settings?.studyType ?? 'regression-channel')
  const [studyLookback, setStudyLookback] = useState(settings?.studyLookback ?? 27)
  const [upperDeviation, setUpperDeviation] = useState(settings?.upperDeviation ?? 2)
  const [lowerDeviation, setLowerDeviation] = useState(settings?.lowerDeviation ?? 2)
  const [atrMultiplier, setAtrMultiplier] = useState(settings?.atrMultiplier ?? 2)
  const [volumePriceBins, setVolumePriceBins] = useState(settings?.volumePriceBins ?? 28)
  const [studies, setStudies] = useState<AcmeChartStudy[]>(settings?.studies ?? [
    { id: 'regch-default-27', type: 'regression-channel', lookback: 27, upperDeviation: 2, lowerDeviation: 2 },
  ])
  const selectedSymbol = symbol || 'ES_NQ'
  const studyStatus = studies.length ? studies.map(acmeChartStudyLabel).join(' | ') : 'No studies'
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
      studyLookback,
      upperDeviation,
      lowerDeviation,
      atrMultiplier,
      volumePriceBins,
    })
  }, [atrMultiplier, compressBlankSessions, displayPreset, lowerDeviation, mode, showGrid, solidCandles, studies, studyLookback, studyType, timeframe, upperDeviation, volumePriceBins])

  const addStudy = () => {
    const lookback = Math.max(2, Math.min(500, Math.floor(studyLookback || 27)))
    const upper = Number(Math.max(0, Math.min(10, upperDeviation || 0)).toFixed(2))
    const lower = Number(Math.max(0, Math.min(10, lowerDeviation || 0)).toFixed(2))
    const multiplier = Number(Math.max(0, Math.min(20, atrMultiplier || 0)).toFixed(2))
    const bins = Math.max(8, Math.min(80, Math.floor(volumePriceBins || 28)))
    const common = {
      id: `study-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      type: studyType,
      lookback,
    }
    const nextStudy: AcmeChartStudy = studyType === 'regression-channel'
      ? { ...common, type: 'regression-channel', upperDeviation: upper, lowerDeviation: lower }
      : studyType === 'atr'
        ? { ...common, type: 'atr', atrMultiplier: multiplier }
        : { ...common, type: 'volume-at-price', bins }
    setStudies(current => [
      ...current,
      nextStudy,
    ])
  }

  const applyDisplayPreset = (preset: AcmeChartDisplayPreset) => {
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
        <select className="input-field h-8 w-[112px] py-1 text-[10px] font-bold uppercase" value={mode} onChange={event => setMode(event.target.value as AcmeChartMode)} title="Chart style">
          <option value="candles">Candles</option>
          <option value="line">Line</option>
        </select>
        <select className="input-field h-8 w-[92px] py-1 font-mono text-[10px] font-bold uppercase" value={timeframe} onChange={event => setTimeframe(event.target.value as AcmeChartTimeframe)} title="Chart timeframe">
          <option value="1m">1m</option>
          <option value="5m">5m</option>
          <option value="30m">30m</option>
          <option value="1h">1h</option>
          <option value="1d">1d</option>
        </select>
        <select className="input-field h-8 w-[132px] py-1 text-[10px] font-bold uppercase" value={displayPreset} onChange={event => applyDisplayPreset(event.target.value as AcmeChartDisplayPreset)} title="Display preset">
          <option value="clean">Clean</option>
          <option value="grid">Grid</option>
          <option value="calendar">Calendar</option>
          <option value="outline">Outline</option>
        </select>
        <button
          className={cx('btn-neutral flex h-8 items-center gap-1 px-2 text-[10px] font-black uppercase', showStudyBuilder && 'border-accent/60 text-accent')}
          onClick={() => setShowStudyBuilder(current => !current)}
          title={studyStatus}
        >
          <SlidersHorizontal size={13} /> Studies {studies.length}
        </button>
      </div>
      {showStudyBuilder && (
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-border bg-[#07101b] px-2 py-1">
        <span className="font-mono text-[10px] font-black uppercase text-muted">Studies</span>
        <select className="input-field h-7 w-40 py-0 text-[10px] font-bold" value={studyType} onChange={event => setStudyType(event.target.value as AcmeChartStudyType)}>
          <option value="regression-channel">Linear Regression</option>
          <option value="atr">ATR</option>
          <option value="volume-at-price">Volume at Price</option>
        </select>
        {studyType !== 'volume-at-price' && <label className="flex items-center gap-1 font-mono text-[10px] text-muted">Lookback
          <input className="input-field h-7 w-16 px-2 py-0 text-[10px]" type="number" min={2} max={500} step={1} value={studyLookback} onChange={event => setStudyLookback(Number(event.target.value))} />
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
        <button className="btn-neutral h-7 px-2 text-[10px]" onClick={() => setStudies([])} disabled={!studies.length}>Clear</button>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {studies.map(study => (
            <button
              key={study.id}
              className="shrink-0 rounded border border-cyan-300/35 bg-cyan-400/10 px-2 py-1 font-mono text-[10px] font-bold text-cyan-100"
              onClick={() => setStudies(current => current.filter(item => item.id !== study.id))}
              title="Remove study"
            >
              {acmeChartStudyLabel(study)}
            </button>
          ))}
        </div>
      </div>
      )}
      <div className="min-h-0 flex-1 p-2">
        <div className="h-full rounded border border-surface-border bg-[#05070b] p-1">
          <AcmeProductCandleChart
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
        ACME Product Chart | {selectedSymbol} | {timeframe} REST bars | {mode === 'candles' ? 'Candlesticks' : 'Line'} | {compressBlankSessions ? 'No blank sessions' : 'Calendar time'} | {showGrid ? 'Grid' : 'No grid'} | {studyStatus}
      </div>
    </div>
  )
}

function AcmeSpreadGuideWindow({ symbol }: { symbol: string }) {
  const product = ACME_SPREAD_PRODUCTS.find(item => item.symbol === symbol)
  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="border-b border-surface-border bg-surface-panel px-3 py-2">
        <div className="font-mono text-xs font-black text-accent">{product?.label ?? symbol}</div>
        <div className="mt-1 text-[10px] text-muted">{product?.legs ?? 'Acme synthetic spread'}</div>
      </div>
      <div className="min-h-0 flex-1">
        <Chart asset={symbol as Asset} />
      </div>
    </div>
  )
}

function spreadTone(stat?: Partial<AcmeSpreadStat>) {
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

function liveSpreadLast(row: Pick<AcmeSpreadStat, 'lastTraded' | 'spread'> & { key: string }, books: Record<string, PolyBook>, ticks: Record<string, PolyTradeTick[]>) {
  const liveBook = books[row.key]
  const liveTick = ticks[row.key]?.at(-1)
  const liveBookLtp = Number.isFinite(Number(liveBook?.ltp))
    ? Number(liveBook?.ltp)
    : Number.isFinite(Number(liveBook?.up_pct))
      ? Number(liveBook?.up_pct)
      : undefined
  return liveBookLtp ?? liveTick?.price ?? row.lastTraded ?? row.spread
}

function liveSpreadLocation(row: Partial<AcmeSpreadStat>, last: number) {
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

function AcmeGooseWindow() {
  const data = useAcmeIntelligence(60000)
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
          {gooseData?.updateCadence ?? 'One-minute advisory cadence'}
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

function AcmeLiveSpreadSignalsWindow() {
  const data = useAcmeIntelligence(60000)
  const rows = data?.liveSpreadSignals ?? []
  useCmeMarketDataSubscriptions(rows.map(row => row.key))
  const polyBooks = useStore(s => s.polyBooks)
  const polyTicks = useStore(s => s.polyTicks)
  return (
    <div className="flex h-full flex-col bg-surface text-xs">
      <div className="grid grid-cols-[86px_1fr_72px_72px_72px_58px_68px_1.1fr] border-b border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] font-black uppercase text-muted">
        <span>Spread</span><span>Last vs 30D</span><span className="text-right">LR27 -2</span><span className="text-right">LR27 Mid</span><span className="text-right">LR27 +2</span><span className="text-right">Z</span><span className="text-right">Flow</span><span className="text-right">Signal</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.map(row => {
          const last = liveSpreadLast(row, polyBooks, polyTicks)
          const location = liveSpreadLocation(row, last)
          const tone = spreadTone({ z: location.dayZ })
          const baseline = location.meanValue
          const lrTitle = `${row.lr27Bars ?? 0} x ${row.lr27Interval ?? '30m'}${row.lr27IsForming ? ' including active bar' : ''}`
          return (
            <div key={row.key} className={cx('grid grid-cols-[86px_1fr_72px_72px_72px_58px_68px_1.1fr] border-b px-2 py-2 font-mono text-[10px]', tone.border, tone.bg)}>
              <span className={cx('font-black', tone.accent)}>{row.label}</span>
              <span className="text-slate-200">
                {last.toFixed(2)}
                <span className="text-muted"> vs {baseline.toFixed(2)} </span>
                <span className={tone.accent}>({fmtNum(last - baseline, 2)})</span>
                <span className="ml-1 text-muted">ATR {fmtNum(location.atrValue, 2)}</span>
              </span>
              <span className="text-right text-blue-300" title={lrTitle}>{fmtNum(finiteOptional(row.lr27Lower2), 2)}</span>
              <span className="text-right text-amber-200" title={lrTitle}>{fmtNum(finiteOptional(row.lr27Mean), 2)}</span>
              <span className="text-right text-red-300" title={lrTitle}>{fmtNum(finiteOptional(row.lr27Upper2), 2)}</span>
              <span className={cx('text-right font-black', tone.accent)}>{location.dayZ.toFixed(2)}</span>
              <span className="text-right"><span className={cx('rounded px-1.5 py-0.5 font-black', tone.bg, tone.accent)}>{Math.round(row.orderFlowScore ?? Math.abs(location.z) * 42)}</span></span>
              <span className="text-right text-muted">{location.signal}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AcmeRelativeSpreadVisualsWindow() {
  const data = useAcmeIntelligence()
  const rows = data?.spreadPack?.spreads ?? []
  useCmeMarketDataSubscriptions(rows.map(row => row.key))
  const polyBooks = useStore(s => s.polyBooks)
  const polyTicks = useStore(s => s.polyTicks)
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
          const last = liveSpreadLast(row, polyBooks, polyTicks)
          const location = liveSpreadLocation(row, last)
          const x = clamp(50 + clamp(location.z, -2, 2) * 25, 0, 100)
          const tone = spreadTone({ z: location.z })
          const baseline = location.meanValue
          const leftZone = 'linear-gradient(90deg, rgba(56,189,248,.26), rgba(56,189,248,.08), rgba(15,23,42,.45), rgba(251,113,133,.08), rgba(251,113,133,.26))'
          return (
            <div key={row.key} className={cx('rounded border p-3', tone.border, tone.bg)}>
              <div className="mb-2 flex items-center justify-between font-mono text-[11px]">
                <span className={cx('font-black', tone.accent)}>{row.label}</span>
                <span className={cx('font-black', tone.accent)}>z {location.z.toFixed(2)} | {tone.label}</span>
              </div>
              <div className="relative h-8 rounded border border-surface-border bg-[#05070b]" style={{ background: leftZone }}>
                <div className="absolute left-1/4 top-0 h-full w-px bg-blue-300/25" />
                <div className="absolute left-1/2 top-0 h-full w-px bg-muted/50" />
                <div className="absolute left-3/4 top-0 h-full w-px bg-red-300/25" />
                <div className="absolute top-1 h-6 w-1.5 rounded" style={{ left: `${x}%`, background: tone.fill, boxShadow: `0 0 12px ${tone.fill}` }} />
              </div>
              <div className="mt-1 flex justify-between font-mono text-[9px] text-muted"><span>-2 ATR cheap</span><span>30D Mean</span><span>+2 ATR rich</span></div>
              <div className="mt-2 grid grid-cols-5 gap-2 font-mono text-[10px] text-muted">
                <span>Last <b className="text-slate-200">{last.toFixed(3)}</b></span>
                <span>30D <b className="text-slate-200">{baseline.toFixed(3)}</b></span>
                <span>ATR <b className="text-slate-200">{location.atrValue.toFixed(3)}</b></span>
                <span>Vol <b className="text-slate-200">{fmtCompact(row.volume ?? 0)}</b></span>
                <span className={tone.accent}>{location.signal}</span>
              </div>
              <div className="mt-1 font-mono text-[9px] text-muted">
                Session anchor {fmtNum(location.vwapBasis, 3)} | 3/30 ATR {fmtNum(row.atr3, 3)} / {fmtNum(row.atr30 ?? row.atr20, 3)} | LR27 {fmtNum(row.lr27Mean, 2)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AcmeRelativeSpreadSvg({ stat }: { stat: AcmeSpreadStat }) {
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
  const meanValue = Number(stat.mean)
  const upper = meanValue + 2 * Number(stat.atr)
  const lower = meanValue - 2 * Number(stat.atr)
  const values = [...closes, meanValue, upper, lower].filter(Number.isFinite)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const x = (index: number) => left + (points.length <= 1 ? 0 : (index / (points.length - 1)) * plotWidth)
  const y = (value: number) => top + ((max - value) / span) * plotHeight
  const line = points.map((row, index) => `${x(index).toFixed(1)},${y(Number(row.close)).toFixed(1)}`).join(' ')
  const last = points[points.length - 1]
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
      <text x={left} y={height - 8} fill="rgba(230,241,255,.62)" fontSize={10}>{firstDate}</text>
      <text x={left + plotWidth} y={height - 8} textAnchor="end" fill="rgba(230,241,255,.62)" fontSize={10}>{lastDate}</text>
    </svg>
  )
}

function AcmeRelativeSpreadChartsWindow() {
  const data = useAcmeIntelligence(60000)
  const rows = data?.spreadPack?.spreads ?? []
  return (
    <div className="h-full overflow-y-auto bg-surface p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-[10px] text-muted">Daily synthetic closes with 30-session mean and +/-2 blended ATR bands. Forecast rails update on completed study history, like the Acme HTML visual.</div>
        <span className="rounded border border-accent/30 bg-accent/10 px-2 py-1 font-mono text-[10px] font-bold text-accent">{rows.length} spreads</span>
      </div>
      <div className="grid gap-3">
        {rows.map(stat => {
          const bars = stat.bars ?? []
          const last = bars[bars.length - 1]
          return (
            <div key={stat.key} className="rounded border border-surface-border bg-surface-card p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-mono text-[12px] font-black text-slate-100">{stat.label}</h3>
                <span className={cx('font-mono text-[10px] font-black', stat.z >= 0 ? 'text-down' : 'text-up')}>z {stat.z.toFixed(2)}</span>
              </div>
              <div className="h-44 rounded border border-surface-border bg-[#05070b]">
                <AcmeRelativeSpreadSvg stat={stat} />
              </div>
              <div className="mt-2 flex justify-between font-mono text-[10px] text-muted">
                <span>{bars.length} bars</span>
                <span>{last ? `${Number(last.close).toFixed(3)} | ${stat.signal}` : 'Waiting'}</span>
              </div>
            </div>
          )
        })}
        {!rows.length && <div className="rounded border border-surface-border bg-surface-card p-4 text-center text-muted">Loading chart data...</div>}
      </div>
    </div>
  )
}

function AcmeStreamingNewsWindow() {
  const { data, error } = useAcmeEndpoint<AcmeNewsState>('/api/acme/news', 60000)
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

function AcmeAuditTrailWindow() {
  const { data, error } = useAcmeEndpoint<AcmeAuditState>('/api/acme/audit', 5000)
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

function AcmeMacroRegimeWindow() {
  const { data, error } = useAcmeEndpoint<AcmeMacroState>('/api/acme/macro-regime', 10000)
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

function AcmeOpportunityMapWindow() {
  const { data, error } = useAcmeEndpoint<AcmeOpportunityState>('/api/acme/opportunity-map', 10000)
  const rows = data?.rows ?? []
  return (
    <div className="flex h-full flex-col bg-surface text-xs">
      <div className="border-b border-surface-border bg-surface-panel px-3 py-2 font-mono text-[10px] text-muted">{error || 'Cross-spread ranking from z-location, leadership confirmation, regime, source breadth, and liquidity.'}</div>
      <div className="grid grid-cols-[90px_66px_70px_1fr_1.2fr] border-b border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] font-black uppercase text-muted">
        <span>Spread</span><span>Score</span><span>Z</span><span>Expression</span><span>Risk Check</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
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
    </div>
  )
}

function AcmeTradeAnalyticsWindow() {
  const { data, error } = useAcmeEndpoint<AcmeTradeAnalyticsState>('/api/acme/trade-analytics', 10000)
  const metrics = data?.metrics
  const curve = data?.curve ?? []
  const maxEquity = Math.max(...curve.map(point => point.equity), metrics?.accountSize ?? 1)
  const minEquity = Math.min(...curve.map(point => point.equity), metrics?.accountSize ?? 0)
  const span = maxEquity - minEquity || 1
  const line = curve.map((point, index) => {
    const x = curve.length <= 1 ? 0 : (index / (curve.length - 1)) * 100
    const y = 80 - ((point.equity - minEquity) / span) * 70
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <div className="h-full overflow-y-auto bg-surface p-3 text-xs">
      <div className="mb-3 flex items-center justify-between">
        <span className={cx('rounded border px-2 py-1 font-mono text-[10px] font-black uppercase', data?.riskLevel === 'Controlled' ? 'border-blue-500/35 bg-blue-500/15 text-blue-300' : data?.riskLevel === 'High' ? 'border-red-500/35 bg-red-500/15 text-red-300' : 'border-amber-500/35 bg-amber-500/15 text-amber-300')}>{data?.riskLevel ?? 'Waiting'} Risk</span>
        <span className="font-mono text-[10px] text-muted">{error || data?.status || 'Analyzer ready.'}</span>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {[
          ['Rows', metrics?.rows.toFixed(0)],
          ['Total P&L', fmtMoney(metrics?.total)],
          ['Win Rate', fmtPct(metrics?.winRate)],
          ['Max Drawdown', `${fmtMoney(metrics?.drawdown)} (${fmtPct(metrics?.drawdownPct)})`],
          ['Sharpe', fmtNum(metrics?.sharpe, 2)],
          ['Sortino', fmtNum(metrics?.sortino, 2)],
          ['Calmar', fmtNum(metrics?.calmar, 2)],
          ['Expectancy', fmtMoney(metrics?.expectancy)],
        ].map(([label, value]) => (
          <div key={label} className="rounded border border-surface-border bg-surface-card p-2">
            <div className="text-[9px] font-bold uppercase text-muted">{label}</div>
            <div className="mt-1 font-mono text-[12px] font-black text-slate-100">{value ?? '-'}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded border border-surface-border bg-surface-card p-2">
        <svg viewBox="0 0 100 86" className="h-32 w-full" preserveAspectRatio="none">
          <rect x="0" y="0" width="100" height="86" fill="rgba(8,13,20,.18)" />
          {line && <polyline points={line} fill="none" stroke="#00d8ff" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      <div className="mt-3 grid gap-2">
        {(data?.studies ?? []).map(study => (
          <div key={study.study} className="grid grid-cols-[140px_90px_1fr] rounded border border-surface-border bg-surface-card px-2 py-1.5 font-mono text-[10px]">
            <span className="font-black text-slate-100">{study.study}</span>
            <span className={study.passed ? 'text-blue-300' : 'text-amber-300'}>{study.passed ? 'Pass' : 'Review'} {study.result}</span>
            <span className="text-muted">{study.read}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function AcmeNotionalCalculatorWindow() {
  const { data, error } = useAcmeEndpoint<AcmeNotionalState>('/api/acme/notional', 5000)
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

function AcmeContentWindow({ kind }: { kind: WorkspaceWindowKind }) {
  const { data, error } = useAcmeEndpoint<AcmeContentState>(`/api/acme/content/${kind}`, 30000)
  const details = ACME_PANEL_DETAILS[kind]
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

function AcmePositionsOrdersWindow() {
  const { data, error, refresh } = useAcmePositionsOrders()
  const options = useProductOptions()
  const simOrders = useStore(s => s.simOrders)
  const simPositions = useStore(s => s.simPositions)
  const fillsByMarket = useStore(s => s.fills)
  const cancelSimOrderLive = useStore(s => s.cancelSimOrder)
  const cancelSimOrdersLive = useStore(s => s.cancelSimOrders)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<'instrument' | 'qty' | 'openPnl' | 'updated'>('instrument')
  const [actionStatus, setActionStatus] = useState('')
  const query = filter.trim().toLowerCase()

  const productByKey = useMemo(() => productLookup(options), [options])

  const livePositionRows = useMemo(
    () => simPositions
      .filter(position => position.status === 'open')
      .map(position => simPositionToAcmePositionRow(position, productByKey.get(position.marketKey))),
    [productByKey, simPositions],
  )

  const liveOrderRows = useMemo(
    () => simOrders
      .filter(order => order.status === 'working' || order.status === 'partially_filled')
      .map(order => simOrderToAcmeOrderRow(order, productByKey.get(order.marketKey))),
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
    const rows = new Map<string, AcmePositionRow>()
    for (const position of data?.positions ?? []) {
      rows.set(`backend-${position.instrumentId}-${position.account ?? ''}-${position.label ?? ''}`, position)
    }
    for (const position of livePositionRows) {
      rows.set(`sim-${position.instrumentId}-${position.account ?? ''}-${position.label ?? ''}`, position)
    }
    return [...rows.values()]
  }, [data?.positions, livePositionRows])

  const allOrderRows = useMemo(() => {
    const rows = new Map<string, AcmeOrderRow>()
    for (const order of data?.orders ?? []) rows.set(order.id, order)
    for (const order of liveOrderRows) rows.set(order.id, order)
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
      cancelSimOrderLive(orderId)
      setActionStatus(`Cancelled local sim order ${orderId}`)
      return
    }
    setActionStatus(`Cancel requested for ${orderId}`)
    try {
      const response = await fetch(`/api/acme/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await refresh()
      setActionStatus(`Cancel routed for ${orderId}`)
    } catch (err) {
      setActionStatus(`Cancel failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  const cancelAll = async () => {
    const localCount = liveOrderRows.length
    setActionStatus('Cancel-all requested')
    if (localCount > 0) cancelSimOrdersLive()
    try {
      const response = await fetch('/api/acme/orders/cancel-all', { method: 'POST' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      await refresh()
      const backendCount = Number(payload.count ?? 0)
      const totalCount = localCount + backendCount
      setActionStatus(`Cancel-all routed for ${totalCount || orders.length} working order(s)`)
    } catch (err) {
      setActionStatus(localCount > 0
        ? `Cancelled ${localCount} local sim order(s); backend cancel failed: ${err instanceof Error ? err.message : 'unknown error'}`
        : `Cancel-all failed: ${err instanceof Error ? err.message : 'unknown error'}`)
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
            <span>Product</span><span className="text-right">Qty</span><span className="text-right">Avg</span><span className="text-right">Mark</span><span className="text-right">Open P&amp;L</span>
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
                  <span className="text-right text-slate-200">{position.avgPrice.toFixed(2)}</span>
                  <span className={cx('text-right', position.markLive ? 'text-accent' : 'text-muted')}>{position.markPrice.toFixed(2)}</span>
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
          <div className="grid grid-cols-[1.1fr_90px_58px_58px_80px_92px_88px] border-b border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] font-black uppercase text-muted">
            <span>Order</span><span>Product</span><span className="text-right">Side</span><span className="text-right">Qty</span><span className="text-right">Price</span><span>Status</span><span className="text-right">Action</span>
          </div>
          <div className="h-[calc(100%-25px)] overflow-y-auto">
            {orders.map(order => {
              const isBuy = /^buy/i.test(order.side)
              const tag = order.algoName || order.orderType || order.source || 'Manual'
              return (
                <div key={`${order.id}-${order.instrumentId}`} className="grid grid-cols-[1.1fr_90px_58px_58px_80px_92px_88px] items-center border-b border-surface-border/60 px-2 py-1.5 font-mono text-[10px]">
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
                  <span className="text-right text-slate-200">{Number(order.qty || 0).toFixed(0)}</span>
                  <span className="text-right text-slate-200">{Number(order.price || 0).toFixed(2)}</span>
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
        <span>{positions.length} open position(s), {orders.length} open order(s). Positions are rebuilt from fills; open orders come from the order state stream.</span>
        <span className={cx(error ? 'text-down' : actionStatus ? 'text-accent' : 'text-muted')}>{error || actionStatus || `Updated ${updated}`}</span>
      </div>
    </div>
  )
}

function AcmeIncomingWindow({ kind }: { kind: WorkspaceWindowKind }) {
  const details = ACME_PANEL_DETAILS[kind] ?? {
    service: 'terminal.workspace',
    body: 'Incoming Acme window is registered in the Cerious launcher and ready for deeper service wiring.',
    bullets: ['Polyman source preserved', 'React window registered', 'Service boundary pending'],
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

function TradingViewChartWindow({
  provider,
  symbol,
  onSelect,
}: {
  provider: ProviderKey
  symbol: string
  onSelect: (provider: ProviderKey, symbol: string) => void
}) {
  const activeAsset = useStore(s => s.activeAsset)
  const options = useProductOptions()
  const selectedOption = options.find(option => option.provider === provider && option.symbol === symbol)
  const asset = selectedOption?.asset ?? activeAsset

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-border bg-surface-panel px-2 py-1">
        <div className="min-w-[280px] flex-1">
          <ProductSelector provider={provider} symbol={symbol} onSelect={onSelect} compact />
        </div>
        <span className="rounded border border-accent/30 bg-accent/10 px-2 py-1 font-mono text-[10px] font-bold text-accent">
          {asset} OHLCV
        </span>
        <span className="text-[10px] text-muted">Original Arbitek lightweight chart</span>
      </div>
      <div className="min-h-0 flex-1">
        <Chart asset={asset} />
      </div>
    </div>
  )
}

function TradingViewMultiChartWindow({
  provider,
  symbol,
  onSelect,
}: {
  provider: ProviderKey
  symbol: string
  onSelect: (provider: ProviderKey, symbol: string) => void
}) {
  const activeAsset = useStore(s => s.activeAsset)
  const options = useProductOptions()
  const selectedOption = options.find(option => option.provider === provider && option.symbol === symbol)
  const asset = selectedOption?.asset ?? activeAsset
  const [panels, setPanels] = useState<2 | 3 | 4 | 5>(4)

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-border bg-surface-panel px-2 py-1">
        <div className="min-w-[280px] flex-1">
          <ProductSelector provider={provider} symbol={symbol} onSelect={onSelect} compact />
        </div>
        <select
          className="input-field w-24 py-1 text-[10px]"
          value={panels}
          onChange={event => setPanels(Number(event.target.value) as 2 | 3 | 4 | 5)}
          title="Chart panels"
        >
          <option value={2}>2 panels</option>
          <option value={3}>3 panels</option>
          <option value={4}>4 panels</option>
          <option value={5}>5 panels</option>
        </select>
        <span className="rounded border border-accent/30 bg-accent/10 px-2 py-1 font-mono text-[10px] font-bold text-accent">
          {asset} synchronized
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <MultiChart asset={asset} panels={panels} />
      </div>
    </div>
  )
}

function PredictionMarketChartWindow({
  provider,
  symbol,
  onSelect,
  onClone,
}: {
  provider: ProviderKey
  symbol: string
  onSelect: (provider: ProviderKey, symbol: string) => void
  onClone: () => void
}) {
  const options = useProductOptions()
  const markets = useStore(s => s.markets)
  const probHistory = useStore(s => s.probHistory)
  const polyTicks = useStore(s => s.polyTicks)
  const selectedOption = options.find(option => option.provider === provider && option.symbol === symbol)
  const market = selectedOption?.marketKey ? markets.find(item => item.key === selectedOption.marketKey) : undefined
  const history = selectedOption?.marketKey ? (probHistory[selectedOption.marketKey] ?? []) : []
  const ticks = selectedOption?.marketKey ? (polyTicks[selectedOption.marketKey] ?? []) : []
  const chartData = useMemo(
    () => buildWorkspacePredictionData(selectedOption, market, history, ticks),
    [history, market, selectedOption, ticks],
  )
  const latestYes = chartData.at(-1)?.yesPrice ?? selectedOption?.yes ?? market?.up_pct ?? 50
  const latestNo = 100 - latestYes
  const lastTick = ticks.at(-1)

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-border bg-surface-panel px-2 py-1">
        <div className="min-w-[280px] flex-1">
          <ProductSelector provider={provider} symbol={symbol} onSelect={onSelect} compact />
        </div>
        <button className="btn-accent flex items-center gap-1 px-2 py-1 text-[10px]" onClick={onClone} title="Clone this prediction chart">
          <Copy size={12} /> Clone Chart
        </button>
        <span className="rounded border border-up/30 bg-up/10 px-2 py-1 font-mono text-[10px] font-bold text-up">
          LIVE {chartData.length} pts
        </span>
      </div>
      <div className="border-b border-surface-border bg-[#08101b] px-3 py-2">
        <div className="truncate text-[11px] font-black uppercase tracking-wide text-slate-100">
          {selectedOption?.subtitle ?? selectedOption?.label ?? symbol}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px]">
          <span className="rounded border border-blue-500/30 bg-blue-500/10 px-2 py-1 text-blue-300">YES {latestYes.toFixed(1)}%</span>
          <span className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-red-300">NO {latestNo.toFixed(1)}%</span>
          <span className="text-muted">
            {lastTick ? `last tick ${fmtChartTime(lastTick.timestamp)} ${lastTick.size}x @ ${lastTick.price}c` : 'waiting for live tick'}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 p-2">
        <PredictionChart data={chartData} height="100%" />
      </div>
    </div>
  )
}

function PtbChartWindow({
  provider,
  symbol,
  onSelect,
  onClone,
}: {
  provider: ProviderKey
  symbol: string
  onSelect: (provider: ProviderKey, symbol: string) => void
  onClone: () => void
}) {
  const [studies, setStudies] = useState<Record<StudyKey, boolean>>({
    price: true,
    ptb: true,
    probability: true,
    truth: true,
    greeks: false,
    tape: false,
  })
  const activeAsset = useStore(s => s.activeAsset)
  const options = useProductOptions()
  const selectedOption = options.find(option => option.provider === provider && option.symbol === symbol)
  const [chartAssets, setChartAssets] = useState<Asset[]>([activeAsset])

  useEffect(() => {
    setChartAssets(current => current.length ? current : [activeAsset])
  }, [activeAsset])

  const addChartProduct = () => {
    if (!selectedOption?.asset) return
    setChartAssets(current => current.includes(selectedOption.asset!) ? current : [...current, selectedOption.asset!].slice(-4))
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-border bg-surface-panel px-2 py-1">
        <div className="min-w-[260px] flex-1">
          <ProductSelector provider={provider} symbol={symbol} onSelect={onSelect} compact />
        </div>
        <button
          className="btn-neutral flex items-center gap-1 px-2 py-1 text-[10px]"
          onClick={addChartProduct}
          disabled={!selectedOption?.asset}
          title="Add selected product as another chart pane"
        >
          <Plus size={12} /> Add Pane
        </button>
        <button className="btn-accent flex items-center gap-1 px-2 py-1 text-[10px]" onClick={onClone}>
          <Copy size={12} /> Clone Chart
        </button>
        <div className="flex flex-wrap gap-1">
          {chartAssets.map(asset => (
            <button
              key={asset}
              className="rounded border border-accent/30 bg-accent/10 px-2 py-1 text-[10px] font-bold text-accent"
              onClick={() => setChartAssets(current => current.length === 1 ? current : current.filter(item => item !== asset))}
              title="Remove pane"
            >
              {asset}
            </button>
          ))}
          {STUDIES.map(study => (
            <button
              key={study.key}
              className={cx(
                'rounded border px-2 py-1 text-[10px] font-bold uppercase',
                studies[study.key] ? 'border-accent/50 bg-accent/15 text-accent' : 'border-surface-border bg-surface-card text-muted',
              )}
              onClick={() => setStudies(current => ({ ...current, [study.key]: !current[study.key] }))}
            >
              {study.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto]">
        <div className={cx('min-h-0 gap-1 overflow-hidden', chartAssets.length > 1 && 'grid grid-cols-2')}>
          {studies.price && chartAssets.length === 1 ? (
            <PolyPriceChart />
          ) : (
            chartAssets.map(asset => (
              <div key={asset} className="min-h-[220px] min-w-0 border border-surface-border/50">
                <Chart asset={asset} />
              </div>
            ))
          )}
        </div>
        {studies.tape && (
          <div className="h-40 overflow-hidden border-t border-surface-border bg-surface-panel">
            <TimeAndSales popped={false} onPopout={() => undefined} onDock={() => undefined} />
          </div>
        )}
      </div>
    </div>
  )
}

function PtbRunwayWindow({
  provider,
  symbol,
  onSelect,
  onClone,
}: {
  provider: ProviderKey
  symbol: string
  onSelect: (provider: ProviderKey, symbol: string) => void
  onClone: () => void
}) {
  const options = useProductOptions()
  const selectedOption = options.find(option => option.provider === provider && option.symbol === symbol)
  const product: PtbRunwayProduct | undefined = selectedOption
    ? {
        provider: selectedOption.provider,
        symbol: selectedOption.symbol,
        label: selectedOption.label,
        subtitle: selectedOption.subtitle,
        marketKey: selectedOption.marketKey,
        asset: selectedOption.asset,
        yes: selectedOption.yes,
        no: selectedOption.no,
        truthYes: selectedOption.truthYes,
        truthNo: selectedOption.truthNo,
        spot: selectedOption.spot,
        priceToBeat: selectedOption.priceToBeat,
        expiryTs: selectedOption.expiryTs,
      }
    : undefined

  return (
    <PtbRunwayChart
      product={product}
      controls={
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-[280px] flex-1">
            <ProductSelector provider={provider} symbol={symbol} onSelect={onSelect} compact />
          </div>
          <button className="btn-accent flex items-center gap-1 px-2 py-1 text-[10px]" onClick={onClone} title="Clone this PTB runway study">
            <Copy size={12} /> Clone Study
          </button>
          <span className="rounded border border-surface-border bg-surface-card px-2 py-1 font-mono text-[10px] text-muted">
            {selectedOption?.asset ?? selectedOption?.symbol ?? 'select product'}
          </span>
        </div>
      }
    />
  )
}

export function CryptoTerminalWindow({
  provider,
  symbol,
  onSelect,
}: {
  provider: ProviderKey
  symbol: string
  onSelect: (provider: ProviderKey, symbol: string) => void
}) {
  const activeAsset = useStore(s => s.activeAsset)
  const options = useProductOptions()
  const selectedOption = options.find(option => option.provider === provider && option.symbol === symbol)
  const [chartAssets, setChartAssets] = useState<Asset[]>([activeAsset])

  const addChartProduct = () => {
    if (!selectedOption?.asset) return
    setChartAssets(current => current.includes(selectedOption.asset!) ? current : [...current, selectedOption.asset!].slice(-4))
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-border bg-surface-panel p-2">
        <div className="min-w-[280px] flex-1">
          <ProductSelector provider={provider} symbol={symbol} onSelect={onSelect} compact />
        </div>
        <button className="btn-accent flex items-center gap-1 px-2 py-1 text-[10px]" onClick={addChartProduct} disabled={!selectedOption?.asset}>
          <Plus size={12} /> Add Pane
        </button>
        <div className="flex flex-wrap gap-1">
          {chartAssets.map(asset => (
            <button
              key={asset}
              className="rounded border border-surface-border bg-surface-card px-2 py-1 text-[10px] font-bold text-slate-200"
              onClick={() => setChartAssets(current => current.length === 1 ? current : current.filter(item => item !== asset))}
              title="Remove pane"
            >
              {asset}
            </button>
          ))}
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_190px]">
        <div className={cx('min-h-0 gap-1 overflow-hidden', chartAssets.length > 1 && 'grid grid-cols-2')}>
          {chartAssets.map(asset => (
            <div key={asset} className="min-h-[220px] min-w-0 border border-surface-border/50">
              <Chart asset={asset} />
            </div>
          ))}
        </div>
        <div className="min-h-0 border-l border-surface-border"><PositionMonitor /></div>
      </div>
    </div>
  )
}

export function SportsTerminalWindow() {
  const options = useProductOptions().filter(option => option.provider === 'kalshi' || option.provider === 'forecasttrader')
  const sports = options.filter(option => /sport|game|team|nba|nfl|mlb|nhl|soccer/i.test(option.subtitle))
  const list = sports.length > 0 ? sports : options.slice(0, 12)
  return (
    <div className="h-full overflow-y-auto bg-surface p-3">
      <div className="mb-3 flex items-center gap-2">
        <Activity size={16} className="text-accent" />
        <div className="text-[10px] text-muted">Sports markets use the same event/product abstraction as Kalshi and IBKR.</div>
      </div>
      <div className="space-y-2">
        {list.map(option => (
          <div key={`${option.provider}-${option.symbol}`} className="rounded border border-surface-border bg-surface-card p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-bold text-slate-100">{option.subtitle}</span>
              <span className="font-mono text-[10px]" style={{ color: PROVIDER_COLORS[option.provider] }}>{providerLabel(option.provider)}</span>
            </div>
            <div className="mt-1 grid grid-cols-3 font-mono text-[10px]">
              <span className="text-up">YES {fmtProb(option.yes)}</span>
              <span className="text-down">NO {fmtProb(option.no)}</span>
              <span className="text-right text-muted">{fmtMoney(option.volume)}</span>
            </div>
          </div>
        ))}
        {list.length === 0 && <div className="rounded border border-surface-border bg-surface-card p-4 text-center text-muted">No sports/event products loaded yet.</div>}
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
    openPredictionChart: (provider: ProviderKey, symbol: string) => void
    updateWindowChartSettings: (id: string, settings: AcmeChartSettings) => void
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

  if (item.kind === 'productLibrary') return null
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
  if (item.kind === 'ladder') return null
  if (item.kind === 'depthTrader') return <AcmeDepthTraderWindow symbol={symbol} onSelect={selectForWindow} operatorName={props.operatorName} />
  if (item.kind === 'depthTraderEsNq') return <AcmeDepthTraderWindow symbol="ES_NQ" onSelect={selectForWindow} operatorName={props.operatorName} />
  if (item.kind === 'depthTraderYmEs') return <AcmeDepthTraderWindow symbol="YM_ES" onSelect={selectForWindow} operatorName={props.operatorName} />
  if (item.kind === 'depthTraderRtyEs') return <AcmeDepthTraderWindow symbol="RTY_ES" onSelect={selectForWindow} operatorName={props.operatorName} />
  if (item.kind === 'mdTraderEs') return <AcmeDepthTraderWindow symbol="ES" onSelect={selectForWindow} operatorName={props.operatorName} />
  if (item.kind === 'positionsOrders') return <AcmePositionsOrdersWindow />
  if (item.kind === 'order') return <OrderBookWindow operatorName={props.operatorName} />
  if (item.kind === 'fills') return <FillsWindow operatorName={props.operatorName} />
  if (item.kind === 'alerts') return <AlertsWindow alerts={props.alerts} setAlerts={props.setAlerts} />
  if (item.kind === 'algoBuilder') return <AlgoBuilderWindow provider={provider} symbol={symbol} operatorName={props.operatorName} onSelect={selectForWindow} />
  if (item.kind === 'algoManager') return <AlgoManagerWindow />
  if (item.kind === 'theoQuoter') return null
  if (item.kind === 'greeks') return <GreeksWindow />
  if (item.kind === 'cryptoTerminal') return null
  if (item.kind === 'eventTerminal') return null
  if (item.kind === 'sportsTerminal') return null
  if (item.kind === 'charts') return <AcmeSingleChartWindow provider={provider} symbol={symbol} onSelect={selectForWindow} settings={item.chartSettings} onSettingsChange={settings => props.updateWindowChartSettings(item.id, settings)} />
  if (item.kind === 'acmeTwoPanelChart') return <AcmePlotlyPanelWindow panels={2} />
  if (item.kind === 'acmeThreePanelChart') return <AcmePlotlyPanelWindow panels={3} />
  if (item.kind === 'singlePanelChart') return <TradingViewChartWindow provider={provider} symbol={symbol} onSelect={selectForWindow} />
  if (item.kind === 'tradingViewChart') return <TradingViewChartWindow provider={provider} symbol={symbol} onSelect={selectForWindow} />
  if (item.kind === 'tradingViewMultiChart') return <TradingViewMultiChartWindow provider={provider} symbol={symbol} onSelect={selectForWindow} />
  if (item.kind === 'predictionChart') return <PredictionMarketChartWindow provider={provider} symbol={symbol} onSelect={selectForWindow} onClone={() => props.openPredictionChart(provider, symbol)} />
  if (item.kind === 'ptbChart') return <PtbChartWindow provider={provider} symbol={symbol} onSelect={selectForWindow} onClone={props.cloneChart} />
  if (item.kind === 'ptbOpportunity') return <PtbOpportunityVisual />
  if (item.kind === 'ptbRunway') return <PtbRunwayWindow provider={provider} symbol={symbol} onSelect={selectForWindow} onClone={props.cloneRunway} />
  if (item.kind === 'liquidityMap') return <LiquidityMapWindow />
  if (item.kind === 'knowledge') return <KnowledgeWindow />
  if (item.kind === 'relativeSpreadCharts') return <AcmeRelativeSpreadChartsWindow />
  if (item.kind === 'goose') return <AcmeGooseWindow />
  if (item.kind === 'liveSpreadSignals') return <AcmeLiveSpreadSignalsWindow />
  if (item.kind === 'relativeSpreadVisuals') return <AcmeRelativeSpreadVisualsWindow />
  if (item.kind === 'spreadEsNq') return <AcmeSpreadGuideWindow symbol="ES_NQ" />
  if (item.kind === 'spreadYmEs') return <AcmeSpreadGuideWindow symbol="YM_ES" />
  if (item.kind === 'spreadRtyEs') return <AcmeSpreadGuideWindow symbol="RTY_ES" />
  if (item.kind === 'streamingNews') return <AcmeStreamingNewsWindow />
  if (item.kind === 'tradeAnalytics') return <AcmeTradeAnalyticsWindow />
  if (item.kind === 'auditTrail') return <AcmeAuditTrailWindow />
  if (item.kind === 'notionalCalculator') return <AcmeNotionalCalculatorWindow />
  if (item.kind === 'macroRegimeSummary') return <AcmeMacroRegimeWindow />
  if (item.kind === 'crossSpreadOpportunityMap') return <AcmeOpportunityMapWindow />
  if (
    item.kind === 'liveApiArchitecture'
    || item.kind === 'spreadConfigurations'
    || item.kind === 'atrZScoreEngine'
    || item.kind === 'executionRules'
    || item.kind === 'orderLayeringTechniques'
    || item.kind === 'moneyManagement'
    || item.kind === 'riskChecklist'
    || item.kind === 'sourceNotes'
    || item.kind === 'modelResearchGovernance'
  ) return <AcmeContentWindow kind={item.kind} />
  if (ACME_PANEL_DETAILS[item.kind]) return <AcmeIncomingWindow kind={item.kind} />
  return <ServiceMapWindow />
}

export function WorkspaceDesktop() {
  useMarketBootstrap()
  const initialWorkspace = useMemo(loadActiveWorkspace, [])

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
  const [widgetToAdd, setWidgetToAdd] = useState<WorkspaceWindowKind>('marketData')
  const [alerts, setAlerts] = useState<AlertRule[]>([])
  const setProvider = useStore(s => s.setMarketProvider)
  const simulationEnabled = useStore(s => s.simulationEnabled)
  const setSimulationEnabled = useStore(s => s.setSimulationEnabled)
  const resetTradingSession = useStore(s => s.resetTradingSession)

  useEffect(() => {
    let cancelled = false
    const restoreRecoveredWorkspace = async () => {
      const recovered = await fetchRecoveredWorkspaces()
      if (cancelled || !recovered.length) return
      const latestRecovered = Array.from(recovered.reduce((map, item) => {
        const key = workspaceKey(item.operator, item.name)
        const existing = map.get(key)
        if (!existing || item.updatedAt > existing.updatedAt) map.set(key, item)
        return map
      }, new Map<string, SavedWorkspace>()).values())
      const latestTedS = latestRecovered
        .filter(item => workspaceKey(item.operator, item.name) === workspaceKey(DEFAULT_OPERATOR, 'Ted S'))
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]

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
      const tedSKey = workspaceKey(DEFAULT_OPERATOR, 'Ted S')
      const activeUpdatedAt = Number(initialWorkspace?.updatedAt || 0)
      const shouldActivateTedS =
        activeKey !== tedSKey
        && (
          activeKey === workspaceKey(DEFAULT_OPERATOR, 'Ted')
          || activeKey === workspaceKey(DEFAULT_OPERATOR, 'Cerious CME Desk')
          || latestTedS.updatedAt > activeUpdatedAt
        )
      if (!shouldActivateTedS) return

      const activated = { ...latestTedS, updatedAt: Date.now() }
      setOperatorName(activated.operator)
      setWorkspaceName(activated.name)
      setWindows(activated.windows)
      setMarketRows(activated.rows)
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
      selectedProvider,
      selectedSymbol,
      updatedAt: Date.now(),
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }, [marketRows, operatorName, selectedProvider, selectedSymbol, windows, workspaceName])

  useEffect(() => {
    if (window.localStorage.getItem(DEFAULT_WORKSPACE_KEY)) return
    const initial: SavedWorkspace = {
      name: workspaceName.trim() || 'Cerious CME Desk',
      operator: operatorName.trim() || DEFAULT_OPERATOR,
      windows,
      rows: marketRows,
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

  const clampWorkspacePan = (x: number, y: number) => {
    const bounds = workspaceBoundsRef.current
    const viewport = viewportSizeRef.current
    const rect = mainRef.current?.getBoundingClientRect()
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
    const edge = 120
    const maxSpeed = 48
    const minSpeed = 2
    let dx = 0
    let dy = 0
    const speedFromOutside = (depth: number) => {
      const t = clamp(depth / edge, 0, 1)
      return minSpeed + (t * t * maxSpeed)
    }
    const rightDepth = pointer.x - rect.right
    const leftDepth = rect.left - pointer.x
    const bottomDepth = pointer.y - rect.bottom
    const topDepth = rect.top - pointer.y

    if (rightDepth > 0) {
      dx = speedFromOutside(rightDepth)
    } else if (leftDepth > 0) {
      dx = -speedFromOutside(leftDepth)
    }

    if (bottomDepth > 0) {
      dy = speedFromOutside(bottomDepth)
    } else if (topDepth > 0) {
      dy = -speedFromOutside(topDepth)
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
    if (event.buttons === 0) stopWorkspaceEdgePan()
  }

  const handleWindowDragPointerMove = (event: PointerEvent) => {
    const rect = mainRef.current?.getBoundingClientRect()
    if (rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
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

  const saveWorkspace = () => {
    const next: SavedWorkspace = {
      name: workspaceName.trim() || 'Untitled Workspace',
      operator: operatorName.trim() || DEFAULT_OPERATOR,
      windows,
      rows: marketRows,
      selectedProvider,
      selectedSymbol,
      updatedAt: Date.now(),
    }
    const merged = upsertSavedWorkspace(saved, next)
    setSaved(merged)
    persistWorkspaceSnapshot(next, merged, true, 'manual save default')
    setOperatorName(next.operator)
    setWorkspaceName(next.name)
    setSaveStatus('Saved default')
  }

  const loadWorkspace = (operator: string, name: string) => {
    const found = saved.find(item => workspaceKey(item.operator, item.name) === workspaceKey(operator, name))
    if (!found) return
    const normalized = normalizeWorkspace(found) ?? found
    setOperatorName(normalized.operator)
    setWorkspaceName(normalized.name)
    setWindows(normalized.windows)
    setMarketRows(normalized.rows)
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

  const updateWindowChartSettings = (id: string, chartSettings: AcmeChartSettings) => {
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

  const cloneChart = () => addWindow('ptbChart')
  const cloneRunway = () => addWindow('ptbRunway')
  const openPredictionChart = (provider: ProviderKey, symbol: string) => {
    selectProduct(provider, symbol)
    addWindow('predictionChart', undefined, provider, symbol)
  }

  return (
    <div className="h-screen overflow-hidden bg-[#05070b] text-slate-200">
      <header className="absolute left-0 right-0 top-0 z-[5000] flex h-12 items-center justify-between border-b border-surface-border bg-[#080c14]/95 px-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <img src={ceriousLogo} alt="Cerious Systems" className="h-8 w-8 rounded border border-surface-border bg-[#05101c] object-cover" />
          <input
            value={workspaceName}
            onChange={event => setWorkspaceName(event.target.value)}
            className="w-48 rounded border border-surface-border bg-surface-card px-2 py-1 text-xs font-bold text-slate-100 outline-none focus:border-accent"
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
          <button
            className={cx(
              'ml-2 rounded border px-2 py-1 text-[11px] font-black uppercase',
              simulationEnabled ? 'border-up bg-up/15 text-up' : 'border-surface-border bg-surface-card text-muted hover:text-slate-100',
            )}
            onClick={() => setSimulationEnabled(!simulationEnabled)}
            title="When enabled, orders route to local Sim Exchange matching and live order sends are disabled."
          >
            Sim Exchange {simulationEnabled ? 'On' : 'Off'}
          </button>
          <button
            className="rounded border border-surface-border bg-surface-card px-2 py-1 text-[11px] font-black uppercase text-muted hover:border-accent/50 hover:text-accent"
            onClick={() => {
              resetTradingSession()
              setSaveStatus('Session reset')
            }}
            title="Clear local orders, fills, positions, and execution rows without changing live CME market data."
          >
            Reset Session
          </button>
          <div className="ml-2 flex items-center gap-1 rounded border border-surface-border bg-surface-card p-0.5">
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
      </header>

      <main
        ref={mainRef}
        className="absolute inset-0 overflow-hidden"
        onPointerMove={handleWorkspacePointerMove}
        onPointerLeave={stopWorkspaceEdgePan}
        onWheel={handleWorkspaceWheel}
        style={{
          background:
            'linear-gradient(135deg, #05070b 0%, #090d14 55%, #07090d 100%)',
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
          <div className="absolute inset-0 opacity-[0.12]" style={{ backgroundImage: 'linear-gradient(#1f2937 1px, transparent 1px), linear-gradient(90deg, #1f2937 1px, transparent 1px)', backgroundSize: '32px 32px' }} />
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
                openPredictionChart,
                updateWindowChartSettings,
                updateWindowDepthLadderSettings,
                saveDepthLadderDefaultForWindow,
              })}
            </WorkspaceWindowFrame>
          ))}
        </div>
      </main>

      <footer className="absolute bottom-0 left-0 right-0 z-[5000] flex h-7 items-center justify-between border-t border-surface-border bg-[#080c14]/95 px-3 font-mono text-[10px] text-muted">
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
