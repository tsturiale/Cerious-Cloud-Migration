import type { Bar } from '../types'

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === 'string') {
    const parsedDate = Date.parse(value)
    if (Number.isFinite(parsedDate)) return parsedDate
  }
  const parsed = finiteNumber(value)
  if (parsed === null) return null
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed
}

export function parseBarsPayload(payload: unknown): Bar[] {
  const objectPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as { bars?: unknown }
    : null
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(objectPayload?.bars)
      ? objectPayload.bars
      : []

  return source
    .map(row => {
      const item = row as Partial<Bar> & { price?: unknown; ts?: unknown; time?: unknown }
      const close = finiteNumber(item.close ?? item.price)
      if (close === null) return null
      const timestamp = normalizeTimestamp(item.timestamp ?? item.ts ?? item.time)
      if (timestamp === null) return null
      const open = finiteNumber(item.open) ?? close
      const high = finiteNumber(item.high) ?? Math.max(open, close)
      const low = finiteNumber(item.low) ?? Math.min(open, close)
      const volume = finiteNumber(item.volume) ?? 0
      return { timestamp, open, high, low, close, volume }
    })
    .filter((bar): bar is Bar => Boolean(bar))
    .sort((a, b) => a.timestamp - b.timestamp)
}

export async function fetchBars(asset: string, interval: string | number, limit: number, timeoutMs = 20_000): Promise<Bar[]> {
  const controller = new AbortController()
  let timedOut = false
  const timeout = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    const response = await fetch(
      `/api/bars/${encodeURIComponent(asset)}?interval=${encodeURIComponent(String(interval))}&limit=${limit}`,
      { signal: controller.signal, cache: 'no-store' },
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return parseBarsPayload(await response.json())
  } catch (err) {
    const isAbort = err instanceof DOMException && err.name === 'AbortError'
    if (timedOut || isAbort) {
      throw new Error(`Chart bars request timed out after ${Math.round(timeoutMs / 1000)}s`)
    }
    throw err
  } finally {
    window.clearTimeout(timeout)
  }
}
