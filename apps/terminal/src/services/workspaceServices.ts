import type { Asset, MarketProvider } from '../types'

export type WorkspaceWindowKind =
  | 'marketData'
  | 'ladder'
  | 'depthLadder'
  | 'order'
  | 'fills'
  | 'alerts'
  | 'greeks'
  | 'cryptoTerminal'
  | 'eventTerminal'
  | 'sportsTerminal'
  | 'tradingViewChart'
  | 'tradingViewMultiChart'
  | 'singlePanelChart'
  | 'charts'
  | 'acmeTwoPanelChart'
  | 'acmeThreePanelChart'
  | 'predictionChart'
  | 'ptbChart'
  | 'ptbOpportunity'
  | 'ptbRunway'
  | 'liquidityMap'
  | 'algoBuilder'
  | 'algoManager'
  | 'theoQuoter'
  | 'knowledge'
  | 'serviceMap'
  | 'productLibrary'
  | 'depthTrader'
  | 'depthTraderEsNq'
  | 'depthTraderYmEs'
  | 'depthTraderRtyEs'
  | 'mdTraderEs'
  | 'goose'
  | 'streamingNews'
  | 'liveApiArchitecture'
  | 'tradeAnalytics'
  | 'positionsOrders'
  | 'auditTrail'
  | 'spreadConfigurations'
  | 'relativeSpreadCharts'
  | 'relativeSpreadVisuals'
  | 'notionalCalculator'
  | 'macroRegimeSummary'
  | 'liveSpreadSignals'
  | 'atrZScoreEngine'
  | 'executionRules'
  | 'orderLayeringTechniques'
  | 'moneyManagement'
  | 'crossSpreadOpportunityMap'
  | 'riskChecklist'
  | 'sourceNotes'
  | 'modelResearchGovernance'
  | 'spreadEsNq'
  | 'spreadYmEs'
  | 'spreadRtyEs'

export type WorkspaceTemplate = 'cme' | 'crypto' | 'event' | 'sports'

export type ProviderKey = Exclude<MarketProvider, 'coingecko'>

export interface ProviderDescriptor {
  key: ProviderKey
  label: string
  protocol: string
  productModel: 'futures' | 'binary' | 'spot' | 'perp' | 'forecast'
  service: string
}

export interface EngineDescriptor {
  key: string
  label: string
  service: string
  output: string
}

export const PROVIDERS: ProviderDescriptor[] = [
  {
    key: 'cme',
    label: 'CME',
    protocol: 'CME futures market data',
    productModel: 'futures',
    service: 'price.cme-ingress',
  },
]

export const GREEK_ENGINES: EngineDescriptor[] = [
  { key: 'delta', label: 'Delta / Truth Probability', service: 'greeks.delta-engine', output: 'fair probability and edge' },
  { key: 'gamma', label: 'Gamma Engine', service: 'greeks.gamma-engine', output: 'probability acceleration near PTB' },
  { key: 'theta', label: 'Theta Engine', service: 'greeks.theta-engine', output: 'time decay and boundary drift' },
  { key: 'vega', label: 'Vega Engine', service: 'greeks.vega-engine', output: 'volatility sensitivity' },
  { key: 'vanna', label: 'Vanna Engine', service: 'greeks.vanna-engine', output: 'delta sensitivity to volatility' },
  { key: 'charm', label: 'Charm Engine', service: 'greeks.charm-engine', output: 'delta bleed over time' },
]

export const SERVICE_BLUEPRINT = [
  {
    key: 'price',
    label: 'Price Service',
    role: 'Normalizes CME market data into the terminal tape and depth contracts.',
    dependsOn: ['CME adapter', 'market registry', 'websocket fanout'],
  },
  {
    key: 'knowledge',
    label: 'Knowledge Service',
    role: 'Publishes the education wiki, model definitions, playbooks, and contextual explanations into the workspace.',
    dependsOn: ['wiki corpus', 'model metadata', 'greek definitions'],
  },
  {
    key: 'greeks',
    label: 'Greek Engine Mesh',
    role: 'Runs each greek as an independently addressable engine so Delta, Gamma, Theta, Vega, Vanna, and Charm can be recomposed.',
    dependsOn: ['price service', 'truth engine', 'microstructure features'],
  },
  {
    key: 'orders',
    label: 'Order Service',
    role: 'Routes order tickets through RiskGate and the execution agent, then returns fills and position events.',
    dependsOn: ['risk gate', 'venue router', 'journal service'],
  },
  {
    key: 'algo-engine',
    label: 'Algo Engine Service',
    role: 'Owns held algos, synthetic order state, trigger evaluation, theo quote generation, and release into the order service.',
    dependsOn: ['price service', 'greek engines', 'risk gate', 'sim exchange'],
  },
  {
    key: 'sim-exchange',
    label: 'Sim Exchange Service',
    role: 'Runs the local matching engine, waits for at least two contracts of confirming tape volume, publishes simulated fills, and marks simulated P&L.',
    dependsOn: ['price service', 'local order book', 'fill publisher', 'position ledger'],
  },
  {
    key: 'alerts',
    label: 'Alert Service',
    role: 'Evaluates price, PTB, probability, and greek thresholds without coupling the workspace to a specific venue.',
    dependsOn: ['price service', 'greek engines', 'workspace state'],
  },
]

export const PRODUCT_ASSETS: Asset[] = ['ES', 'NQ', 'YM', 'RTY', 'CL', 'GC', 'ZM', 'ZS', 'ES_NQ', 'YM_ES', 'RTY_ES']

export function providerLabel(key: ProviderKey): string {
  return PROVIDERS.find(provider => provider.key === key)?.label ?? key
}

export function providerForTemplate(_template: WorkspaceTemplate): ProviderKey {
  return 'cme'
}
