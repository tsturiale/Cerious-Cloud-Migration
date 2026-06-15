export type MarketDepthLevel = {
  price: number
  size?: number
}

export type PriceIncrementSource = 'book' | 'product-definition' | 'depth-levels' | 'missing'

export type DepthDisplayContract = {
  ready: boolean
  priceIncrement?: number
  priceIncrementSource: PriceIncrementSource
  message?: string
}

// UI code may format and group prices, but product rules must come from the
// price service contract: product definitions, book metadata, or the book itself.
export function finiteMarketPrice(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function positiveNumber(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function decimalsForIncrement(increment: number | undefined): number | undefined {
  if (!increment || !Number.isFinite(increment) || increment <= 0) return undefined
  const fixed = increment.toFixed(10).replace(/0+$/, '')
  const dot = fixed.indexOf('.')
  return dot === -1 ? 0 : Math.min(8, fixed.length - dot - 1)
}

export function formatMarketPrice(price: number, priceIncrement?: number): string {
  if (!Number.isFinite(price)) return '-'
  const incrementDecimals = decimalsForIncrement(priceIncrement)
  if (incrementDecimals !== undefined) return price.toFixed(Math.max(0, incrementDecimals))
  if (Math.abs(price) >= 100) return price.toFixed(2)
  return price.toFixed(3)
}

export function roundToPriceIncrement(price: number, priceIncrement: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(priceIncrement) || priceIncrement <= 0) return price
  return Math.round(price / priceIncrement) * priceIncrement
}

function inferPriceIncrementFromLevels(levels: MarketDepthLevel[] | undefined): number | undefined {
  const prices = (levels ?? [])
    .map(level => finiteMarketPrice(level.price))
    .filter((price): price is number => price !== undefined)
    .sort((a, b) => a - b)
  const diffs: number[] = []
  for (let index = 1; index < prices.length; index += 1) {
    const diff = Math.abs(prices[index] - prices[index - 1])
    if (diff > 1e-9) diffs.push(diff)
  }
  return diffs.sort((a, b) => a - b)[0]
}

export function resolvePriceIncrement({
  publishedTickSize,
  productTickSize,
  bids,
  asks,
}: {
  publishedTickSize?: unknown
  productTickSize?: unknown
  bids?: MarketDepthLevel[]
  asks?: MarketDepthLevel[]
}): number | undefined {
  return positiveNumber(publishedTickSize)
    ?? positiveNumber(productTickSize)
    ?? inferPriceIncrementFromLevels([...(bids ?? []), ...(asks ?? [])])
}

export function resolveDepthDisplayContract({
  publishedTickSize,
  productTickSize,
  bids,
  asks,
}: {
  publishedTickSize?: unknown
  productTickSize?: unknown
  bids?: MarketDepthLevel[]
  asks?: MarketDepthLevel[]
}): DepthDisplayContract {
  const bookIncrement = positiveNumber(publishedTickSize)
  if (bookIncrement) {
    return { ready: true, priceIncrement: bookIncrement, priceIncrementSource: 'book' }
  }
  const productIncrement = positiveNumber(productTickSize)
  if (productIncrement) {
    return { ready: true, priceIncrement: productIncrement, priceIncrementSource: 'product-definition' }
  }
  const depthIncrement = inferPriceIncrementFromLevels([...(bids ?? []), ...(asks ?? [])])
  if (depthIncrement) {
    return { ready: true, priceIncrement: depthIncrement, priceIncrementSource: 'depth-levels' }
  }
  return {
    ready: false,
    priceIncrementSource: 'missing',
    message: 'Waiting for product definition from price service.',
  }
}

export function depthMultiplierOptionsForTickSize(tickSize: unknown): number[] {
  const tick = Number(tickSize)
  if (Number.isFinite(tick) && Math.abs(tick - 0.1) < 1e-9) return [1, 2, 5, 10]
  return [1, 2, 4, 8, 16]
}
