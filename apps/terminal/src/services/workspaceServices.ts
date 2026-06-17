import type { Asset, MarketProvider } from '../types'

export type WorkspaceWindowKind =
  | 'marketData'
  | 'depthLadder'
  | 'order'
  | 'fills'
  | 'alerts'
  | 'charts'
  | 'liquidityMap'
  | 'algoBuilder'
  | 'algoManager'
  | 'serviceMap'
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

export type WorkspaceTemplate = 'cme'

export type ProviderKey = Exclude<MarketProvider, 'coingecko'>

export interface ProviderDescriptor {
  key: ProviderKey
  label: string
  protocol: string
  productModel: 'futures' | 'binary' | 'spot' | 'perp' | 'forecast'
  service: string
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
    dependsOn: ['wiki corpus', 'model metadata', 'research notes'],
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
    role: 'Owns held algos, synthetic order state, trigger evaluation, and release into the order service.',
    dependsOn: ['price service', 'study engine', 'risk gate', 'sim exchange'],
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
    role: 'Evaluates price, fill, position, study, and risk thresholds without coupling the workspace to a specific venue.',
    dependsOn: ['price service', 'study engine', 'workspace state'],
  },
]

export const PRODUCT_ASSETS: Asset[] = ['ES', 'NQ', 'YM', 'RTY', 'CL', 'GC', 'ZM', 'ZS', 'ES_NQ', 'YM_ES', 'RTY_ES']

export function providerLabel(key: ProviderKey): string {
  return PROVIDERS.find(provider => provider.key === key)?.label ?? key
}

export function providerForTemplate(_template: WorkspaceTemplate): ProviderKey {
  return 'cme'
}
