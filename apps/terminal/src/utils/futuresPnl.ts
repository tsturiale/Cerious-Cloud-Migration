export type FuturesContractSpec = {
  tickSize: number
  multiplier: number
  tickValue: number
}

export const FUTURES_CONTRACT_SPECS: Record<string, FuturesContractSpec> = {
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

export function isRawFuturesPriceValue(price: number): boolean {
  return Number.isFinite(price) && (price < 0 || price > 1)
}

export function isKnownFuturesProduct(marketKey: string): boolean {
  return Boolean(FUTURES_CONTRACT_SPECS[String(marketKey || '').trim().toUpperCase()])
}

export function futuresContractSpecFor(marketKey: string, price?: number): FuturesContractSpec {
  const spec = FUTURES_CONTRACT_SPECS[String(marketKey || '').trim().toUpperCase()]
  if (spec) return spec
  const rawPrices = typeof price === 'number' && isRawFuturesPriceValue(price)
  const tickSize = rawPrices ? 0.01 : 1
  const multiplier = rawPrices ? 1 : 0.01
  return { tickSize, multiplier, tickValue: tickSize * multiplier }
}

export function resolveFuturesMultiplier(marketKey: string, explicitMultiplier: unknown, price?: number): number {
  const rawMultiplier = Number(explicitMultiplier)
  if (Number.isFinite(rawMultiplier) && rawMultiplier > 0) return rawMultiplier
  return futuresContractSpecFor(marketKey, price).multiplier
}

export function calculateOpenFuturesPnl(entryPrice: number, currentPrice: number, signedContracts: number, multiplier: number): number {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice) || !Number.isFinite(signedContracts) || !Number.isFinite(multiplier)) return 0
  return (currentPrice - entryPrice) * multiplier * signedContracts
}

export function calculateFuturesMarketValue(currentPrice: number, signedContracts: number, multiplier: number): number {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(signedContracts) || !Number.isFinite(multiplier)) return 0
  return Math.abs(currentPrice * signedContracts * multiplier)
}
