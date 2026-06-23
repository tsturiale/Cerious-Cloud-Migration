import { useEffect, useRef, useState } from 'react'

export type GatewayBookSide = 'buy' | 'sell' | 'B' | 'S'
export type GatewayDeltaAction = 'A' | 'M' | 'D'

export interface GatewayBookDelta {
  type?: string
  symbol?: string
  action?: GatewayDeltaAction
  side?: GatewayBookSide
  sideCode?: GatewayBookSide
  price?: number | null
  qty?: number | null
  orders?: number | null
  timestampMs?: number
  sequence?: number
}

export interface GatewayEventPacket {
  orders?: unknown[]
  fills?: unknown[]
  deltas?: GatewayBookDelta[]
}

export interface GatewayEventFrame {
  event_packet?: GatewayEventPacket
}

export interface OrderBookLevel {
  price: number
  qty: number
  orders: number
}

export interface GatewayBookState {
  bids: Record<string, OrderBookLevel>
  asks: Record<string, OrderBookLevel>
}

const EMPTY_BOOK: GatewayBookState = { bids: {}, asks: {} }

function sideTarget(delta: GatewayBookDelta): 'bids' | 'asks' {
  const side = String(delta.sideCode ?? delta.side ?? '').toLowerCase()
  return side === 's' || side === 'sell' ? 'asks' : 'bids'
}

function finiteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function boundBook(book: Record<string, OrderBookLevel>, descending: boolean, maxLevels: number): Record<string, OrderBookLevel> {
  return Object.keys(book)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => descending ? b - a : a - b)
    .slice(0, maxLevels)
    .reduce<Record<string, OrderBookLevel>>((acc, price) => {
      const level = book[String(price)]
      if (level) acc[String(price)] = level
      return acc
    }, {})
}

export function applyGatewayEventPacket(prevBook: GatewayBookState, packet: GatewayEventPacket, maxLevels = 200): GatewayBookState {
  const nextBids = { ...prevBook.bids }
  const nextAsks = { ...prevBook.asks }
  const deltas = Array.isArray(packet.deltas) ? packet.deltas : []

  for (const delta of deltas) {
    if (!finiteNumber(delta.price)) continue
    const book = sideTarget(delta) === 'bids' ? nextBids : nextAsks
    const priceKey = String(delta.price)
    const qty = finiteNumber(delta.qty) ? delta.qty : 0
    const orders = finiteNumber(delta.orders) ? delta.orders : 0

    if (delta.action === 'D' || qty <= 0 || orders <= 0) {
      delete book[priceKey]
    } else {
      book[priceKey] = { price: delta.price, qty, orders }
    }
  }

  return {
    bids: boundBook(nextBids, true, maxLevels),
    asks: boundBook(nextAsks, false, maxLevels),
  }
}

export function useGatewayEventBook(webSocketUrl: string | null, maxLevels = 200, renderIntervalMs = 50): GatewayBookState {
  const [orderBook, setOrderBook] = useState<GatewayBookState>(EMPTY_BOOK)
  const incomingBuffer = useRef<GatewayEventPacket[]>([])

  useEffect(() => {
    if (!webSocketUrl) {
      setOrderBook(EMPTY_BOOK)
      incomingBuffer.current = []
      return undefined
    }

    const ws = new WebSocket(webSocketUrl)
    ws.onmessage = event => {
      try {
        const raw = JSON.parse(String(event.data)) as GatewayEventFrame
        if (raw.event_packet) incomingBuffer.current.push(raw.event_packet)
      } catch {
        // Drop malformed exchange frames. Rendering should never crash the terminal.
      }
    }

    const renderTicker = window.setInterval(() => {
      if (incomingBuffer.current.length === 0) return
      const packets = incomingBuffer.current.splice(0)
      setOrderBook(prev => packets.reduce((book, packet) => applyGatewayEventPacket(book, packet, maxLevels), prev))
    }, renderIntervalMs)

    return () => {
      ws.close()
      window.clearInterval(renderTicker)
    }
  }, [webSocketUrl, maxLevels, renderIntervalMs])

  return orderBook
}
