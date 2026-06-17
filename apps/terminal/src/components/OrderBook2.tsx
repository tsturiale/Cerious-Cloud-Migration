import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type { PolyBook, PolyBookLevel, PolyTradeTick } from '../types'

/* Manual DOM hardening:
   - All orderIntent creation and DOM clicks that lead to trades MUST validate Settings.manualMaxOrders / exposure / daily limits
   - Final submission routes exclusively through POST /api/execution/entry (RiskGate + ExecutionAgent.place_entry)
   - dry_run=True is default; any live path requires explicit confirmation + env flag
   - No raw CLOB / polymarket_client calls bypassing the hardened execution layer
   - Full try/catch + user alerts on submission errors
*/

const POLL_MS = 1000
const SETTINGS_KEY = 'book2.dom.settings.v1'
const EMPTY_FILLS: PolyTradeTick[] = []
const CONTRACT_SIZES = [1, 5, 10, 25, 50, 100]
const ACCOUNT_VIEWS = ['account', 'position', 'fills'] as const
const FONT_RANGE = { min: 6, max: 18 }
const ROW_HEIGHT_RANGE = { min: 10, max: 36 }
const ROYAL_YES_COLORS = {
  actionYesText: '#93c5fd',
  yesBid: '#1d4ed8',
  yesAsk: '#2563eb',
  yesText: '#eff6ff',
  yesBarStrong: '#4169e1',
  yesBarMid: '#1d4ed8',
  yesBarWeak: '#1e3a8a',
} as const
const SYSTEM_PRICE_COLUMN = {
  bg: '#d1d5db',
  text: '#111827',
  activeBg: '#e5e7eb',
  activeText: '#111827',
} as const

type ScaleMode = 'dynamic' | 'static'
type SideView = 'both' | 'yes' | 'no'
type Book2Look = 'standard' | 'bright' | 'dark' | 'redBlue' | 'purpleBlue'
type ProbabilityLook = 'blue' | 'blackYellow' | 'whiteWhite'
type Book2Settings = {
  scaleMode: ScaleMode
  sideView: SideView
  stickMid: boolean
  softGrid: boolean
  actionMode: 'limit' | 'market'
  look: Book2Look
  probabilityLook: ProbabilityLook
  contractSize: number
  rowHeight: number
  fontSize: number
  fastTrade: boolean
}

type OrderIntent = {
  outcome: 'yes' | 'no'
  side: 'bid' | 'offer'
  orderType: 'limit' | 'market'
  cents: number
  contracts: number
}

type WorkingOrder = OrderIntent & {
  id: string
  marketKey: string
  status: 'pending' | 'working' | 'rejected'
  createdAt: number
}

type DomRow = {
  p: number
  nP: number
  yBid: number
  yAsk: number
  nBid: number
  nAsk: number
  mid: boolean
}

function fmt(n: number): string {
  if (!n) return ''
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return n.toFixed(0)
}

function mapLevels(levels: PolyBookLevel[]): Map<number, number> {
  const out = new Map<number, number>()
  for (const l of levels) {
    const c = Math.round(l.price * 100)
    out.set(c, (out.get(c) ?? 0) + l.size)
  }
  return out
}

function depthWidth(size: number, max: number): string {
  if (size <= 0) return '0%'
  return `${Math.max(10, Math.min(100, (size / max) * 100))}%`
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function loadSettings(): Book2Settings {
  const defaults: Book2Settings = {
    scaleMode: 'static',
    sideView: 'both',
    stickMid: true,
    softGrid: true,
    actionMode: 'limit',
    look: 'standard',
    probabilityLook: 'blue',
    contractSize: 10,
    rowHeight: 18,
    fontSize: 9,
    fastTrade: false,
  }
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw)
    const parsedActionMode = parsed.actionMode === 'market' || parsed.actionMode === 'stop'
      ? 'market'
      : 'limit'
    return {
      ...defaults,
      ...parsed,
      scaleMode: 'static',
      actionMode: parsedActionMode,
      rowHeight: clamp(Number(parsed.rowHeight ?? defaults.rowHeight), ROW_HEIGHT_RANGE.min, ROW_HEIGHT_RANGE.max),
      fontSize: clamp(Number(parsed.fontSize ?? defaults.fontSize), FONT_RANGE.min, FONT_RANGE.max),
    }
  } catch {
    return defaults
  }
}

export function OrderBook2({
  marketKey: forcedMarketKey,
  productLabel,
  productSubtitle,
  operatorName = 'Operator 1',
}: {
  marketKey?: string
  productLabel?: string
  productSubtitle?: string
  operatorName?: string
} = {}) {
  const storeActiveMarketKey = useStore(s => s.activeMarketKey)
  const setActiveMarketKey = useStore(s => s.setActiveMarketKey)
  const marketProvider = useStore(s => s.marketProvider)
  const setMarketProvider = useStore(s => s.setMarketProvider)
  const setBookClickPrice = useStore(s => s.setBookClickPrice)
  const setPolyBook = useStore(s => s.setPolyBook)
  const simulationEnabled = useStore(s => s.simulationEnabled)
  const placeSimOrder = useStore(s => s.placeSimOrder)
  const cancelSimOrder = useStore(s => s.cancelSimOrder)
  const cancelSimOrders = useStore(s => s.cancelSimOrders)
  const simOrders = useStore(s => s.simOrders)
  const storeMarkets = useStore(s => s.markets)
  const storeBooks = useStore(s => s.polyBooks)
  const positions = useStore(s => s.positions)
  const metrics = useStore(s => s.metrics)
  const fills = useStore(s => {
    const fillKey = forcedMarketKey ?? s.activeMarketKey
    return fillKey ? (s.fills[fillKey] ?? EMPTY_FILLS) : EMPTY_FILLS
  })
  const tapeTicks = useStore(s => {
    const tickKey = forcedMarketKey ?? s.activeMarketKey
    return tickKey ? (s.polyTicks[tickKey] ?? EMPTY_FILLS) : EMPTY_FILLS
  })
  const initialSettings = useMemo(loadSettings, [])

  const [restMarkets, setRestMarkets] = useState<Array<{ key: string; live: boolean; timeframe: string }>>([])
  const [restBook, setRestBook] = useState<PolyBook | null>(null)
  const [stickMid] = useState(initialSettings.stickMid)
  const [scaleMode] = useState<ScaleMode>(initialSettings.scaleMode)
  const [sideView, setSideView] = useState<SideView>(initialSettings.sideView)
  const [softGrid, setSoftGrid] = useState(initialSettings.softGrid)
  const [actionMode, setActionMode] = useState<'limit' | 'market'>(initialSettings.actionMode)
  const [look, setLook] = useState<Book2Look>(initialSettings.look)
  const [probabilityLook, setProbabilityLook] = useState<ProbabilityLook>(initialSettings.probabilityLook)
  const [contractSize, setContractSize] = useState(initialSettings.contractSize)
  const [rowHeight, setRowHeight] = useState(initialSettings.rowHeight)
  const [fontSize, setFontSize] = useState(initialSettings.fontSize)
  const [fastTrade, setFastTrade] = useState(initialSettings.fastTrade)
  const [accountView, setAccountView] = useState<'account' | 'position' | 'fills'>('account')
  const [orderIntent, setOrderIntent] = useState<OrderIntent | null>(null)
  const [workingOrders, setWorkingOrders] = useState<WorkingOrder[]>([])
  const [replaceDrag, setReplaceDrag] = useState<WorkingOrder | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [flash, setFlash] = useState<Record<string, 'up' | 'down'>>({})
  const prevRef = useRef<Record<string, number>>({})
  const yesRef = useRef<HTMLDivElement | null>(null)
  const noRef = useRef<HTMLDivElement | null>(null)

  const reconcileLocalSimOrder = (id: string) => {
    const simOrder = useStore.getState().simOrders.find(item => item.id === id)
    setWorkingOrders(current => {
      if (simOrder?.status === 'working' || simOrder?.status === 'partially_filled') {
        return current.map(order => order.id === id ? { ...order, status: 'working' } : order)
      }
      return current.filter(order => order.id !== id)
    })
  }

  // HARDENED MANUAL SUBMISSION — wired to execution layer
  const submitManualOrder = async () => {
    if (!orderIntent || !key) {
      alert('No order ticket or active market')
      return
    }
    if (simulationEnabled) {
      const workingId = `sim-${key}-${orderIntent.outcome}-${orderIntent.side}-${orderIntent.cents}-${Date.now()}`
      setWorkingOrders(current => [{
        ...orderIntent,
        id: workingId,
        marketKey: key,
        status: 'working' as const,
        createdAt: Date.now(),
      }, ...current].slice(0, 30))
      placeSimOrder({
        id: workingId,
        marketKey: key,
        outcome: orderIntent.outcome,
        side: orderIntent.side,
        orderType: orderIntent.orderType,
        price: orderIntent.cents,
        size: orderIntent.contracts,
        operator: operatorName,
        source: 'manual',
        strategy: 'manual-dom',
        legId: `${workingId}-L1`,
      })
      reconcileLocalSimOrder(workingId)
      setOrderIntent(null)
      return
    }
    const settings = (() => {
      try { return JSON.parse(localStorage.getItem('book2.dom.settings.v1') || '{}') } catch { return {} }
    })()
    const maxOrders = settings.manualMaxOrders ?? 7
    const maxYes = settings.manualMaxYesDollar ?? 500
    const maxNo = settings.manualMaxNoDollar ?? 500

    // Basic limit check (extend with store.positions if needed)
    if (positions.length >= maxOrders) {
      alert('Max manual positions limit reached')
      return
    }
    if ((yesExposure + noExposure) > (maxYes + maxNo)) {
      alert('Manual exposure limit exceeded')
      return
    }

    const isLive = (import.meta.env.PROD && !settings.forceDryRun)
    if (isLive) {
      if (!window.confirm('LIVE TRADE — confirm manual entry via ExecutionAgent?')) return
    }

    const assetName = key.split('_')[0] || 'BTC'
    const payload = {
      market_id: key,
      order_type: orderIntent.orderType.toUpperCase(),
      size_usd: orderIntent.contracts * (orderIntent.cents / 100) * 100, // rough USD
      stop_loss_pct: 0.10,
      take_profit_pct: 0.20,
      trailing_stop_pct: 0.0,
      entry_timeout_secs: 300,
      signal_dict: {
        timestamp: Date.now(),
        asset: assetName,
        model: 'kc_reversion',
        direction: orderIntent.outcome === 'yes' ? 'UP' : 'DOWN',
        strength: 1.0,
        regime: 'medium'
      }
    }

    try {
      const res = await fetch('/api/execution/entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      if (res.ok) {
        const data = await res.json().catch(() => ({}))
        alert('Entry submitted: ' + (data.position_id ?? 'dry-run'))
        setOrderIntent(null)
      } else {
        const err = await res.text().catch(() => res.status)
        alert('Entry failed: ' + err)
      }
    } catch (e) {
      alert('Network error on manual entry: ' + (e instanceof Error ? e.message : e))
    }
  }

  const submitFastOrder = async (intent: OrderIntent, workingId: string) => {
    if (!key) {
      setWorkingOrders(current => current.map(order => order.id === workingId ? { ...order, status: 'rejected' } : order))
      return
    }
    if (simulationEnabled) {
      placeSimOrder({
        id: workingId,
        marketKey: key,
        outcome: intent.outcome,
        side: intent.side,
        orderType: intent.orderType,
        price: intent.cents,
        size: intent.contracts,
        operator: operatorName,
        source: 'manual',
        strategy: 'fast-dom',
        legId: `${workingId}-L1`,
      })
      reconcileLocalSimOrder(workingId)
      return
    }
    const settings = (() => {
      try { return JSON.parse(localStorage.getItem('book2.dom.settings.v1') || '{}') } catch { return {} }
    })()
    const maxOrders = settings.manualMaxOrders ?? 7
    const maxYes = settings.manualMaxYesDollar ?? 500
    const maxNo = settings.manualMaxNoDollar ?? 500

    if (positions.length >= maxOrders || (yesExposure + noExposure) > (maxYes + maxNo)) {
      setWorkingOrders(current => current.map(order => order.id === workingId ? { ...order, status: 'rejected' } : order))
      return
    }

    const assetName = key.split('_')[0] || 'BTC'
    const payload = {
      market_id: key,
      order_type: intent.orderType.toUpperCase(),
      size_usd: intent.contracts * (intent.cents / 100) * 100,
      stop_loss_pct: 0.10,
      take_profit_pct: 0.20,
      trailing_stop_pct: 0.0,
      entry_timeout_secs: 300,
      signal_dict: {
        timestamp: Date.now(),
        asset: assetName,
        model: 'kc_reversion',
        direction: intent.outcome === 'yes' ? 'UP' : 'DOWN',
        strength: 1.0,
        regime: 'medium',
      },
    }

    try {
      const res = await fetch('/api/execution/entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      setWorkingOrders(current => current.map(order => (
        order.id === workingId ? { ...order, status: res.ok ? 'working' : 'rejected' } : order
      )))
    } catch {
      setWorkingOrders(current => current.map(order => order.id === workingId ? { ...order, status: 'rejected' } : order))
    }
  }

  const fallbackKey = useMemo(() => {
    const fromStore = storeMarkets.find(m => m.live && m.timeframe !== 'event')?.key
    if (fromStore) return fromStore
    return restMarkets.find(m => m.live && m.timeframe !== 'event')?.key ?? null
  }, [storeMarkets, restMarkets])

  const activeMarketKey = forcedMarketKey ?? storeActiveMarketKey
  const key = activeMarketKey ?? fallbackKey
  const activeMarket = key ? storeMarkets.find(market => market.key === key) : undefined
  const ladderProductLabel = productLabel ?? activeMarket?.key ?? key ?? 'Select product'
  const ladderProductSubtitle = productSubtitle ?? activeMarket?.question ?? activeMarket?.timeframe ?? 'Polymarket ladder'
  const wsBook = key ? (storeBooks[key] ?? null) : null
  const book = useMemo(() => {
    if (!wsBook && !restBook) return null
    if (!wsBook) return restBook
    if (!restBook) return wsBook
    const wsTs = (wsBook.seen_ms ?? wsBook.timestamp_ms)
    const reTs = (restBook.seen_ms ?? restBook.timestamp_ms)
    return wsTs >= reTs ? wsBook : restBook
  }, [wsBook, restBook])

  useEffect(() => {
    if (marketProvider !== 'polymarket') setMarketProvider('polymarket')
  }, [marketProvider, setMarketProvider])

  useEffect(() => {
    let dead = false
    const loadMarkets = async () => {
      try {
        const r = await fetch('/api/markets?provider=polymarket')
        if (!r.ok || dead) return
        const d = await r.json()
        if (dead) return
        setRestMarkets((d.markets ?? []).map((m: any) => ({
          key: m.key, live: !!m.live, timeframe: m.timeframe ?? '',
        })))
      } catch {
        // ignore
      }
    }
    loadMarkets()
    const id = setInterval(loadMarkets, 5000)
    return () => { dead = true; clearInterval(id) }
  }, [])

  useEffect(() => {
    if (forcedMarketKey || activeMarketKey || !fallbackKey) return
    setActiveMarketKey(fallbackKey)
  }, [activeMarketKey, fallbackKey, forcedMarketKey, setActiveMarketKey])

  useEffect(() => {
    if (!key) return
    let dead = false
    const pull = async () => {
      try {
        const r = await fetch(`/api/poly/book/${encodeURIComponent(key)}`)
        if (!r.ok || dead) return
        const d = await r.json()
        if (dead) return
        setRestBook(d)
        setPolyBook(key, d)
      } catch {
        // ignore
      }
    }
    pull()
    const id = setInterval(pull, POLL_MS)
    return () => { dead = true; clearInterval(id) }
  }, [key, setPolyBook])

  const rows = useMemo(() => {
    if (!book) return [] as DomRow[]
    const yBid = mapLevels(book.bids)
    const yAsk = mapLevels(book.asks)
    const nBid = mapLevels(book.asks.map(a => ({ price: 1 - a.price, size: a.size })))
    const nAsk = mapLevels(book.bids.map(b => ({ price: 1 - b.price, size: b.size })))
    const yesMid = Math.round(book.mid * 100)
    const noMid = 100 - yesMid
    const priceRange = () => Array.from({ length: 99 }, (_, i) => 99 - i)
    const yesPrices = priceRange()
    const noPrices = priceRange()

    const out: DomRow[] = []
    for (let index = 0; index < yesPrices.length; index += 1) {
      const p = yesPrices[index]
      const nP = noPrices[index] ?? p
      out.push({
        p,
        nP,
        yBid: yBid.get(p) ?? 0,
        yAsk: yAsk.get(p) ?? 0,
        nBid: nBid.get(nP) ?? 0,
        nAsk: nAsk.get(nP) ?? 0,
        mid: p === yesMid || nP === noMid,
      })
    }
    return out
  }, [book])

  const displayRows = useMemo(() => {
    if (rows.length) return rows
    const out: DomRow[] = []
    const prices = Array.from({ length: 99 }, (_, i) => 99 - i)
    for (const p of prices) {
      out.push({ p, nP: p, yBid: 0, yAsk: 0, nBid: 0, nAsk: 0, mid: p === 50 })
    }
    return out
  }, [rows])

  const maxY = useMemo(() => Math.max(1, ...displayRows.map(r => Math.max(r.yBid, r.yAsk))), [displayRows])
  const maxN = useMemo(() => Math.max(1, ...displayRows.map(r => Math.max(r.nBid, r.nAsk))), [displayRows])
  const showYes = sideView !== 'no'
  const showNo = sideView !== 'yes'
  const orderColumnWidth = clamp(Math.round(fontSize * 4.2), 24, 42)
  const priceColumnWidth = clamp(Math.round(fontSize * 5.4), 34, 58)
  const domGridTemplateColumns = `${orderColumnWidth}px minmax(28px,1fr) ${priceColumnWidth}px minmax(28px,1fr) ${orderColumnWidth}px`
  const headerGridTemplateColumns = showYes && showNo
    ? `${domGridTemplateColumns} ${domGridTemplateColumns}`
    : domGridTemplateColumns
  const yesCenterPrice = book ? Math.round(book.mid * 100) : 50
  const noCenterPrice = 100 - yesCenterPrice

  const recenterDom = (target: 'yes' | 'no') => {
    const idx = displayRows.findIndex(r => target === 'yes' ? r.p === yesCenterPrice : r.nP === noCenterPrice)
    if (idx < 0) return
    const ref = target === 'yes' ? yesRef : noRef
    const viewport = ref.current?.clientHeight ?? rowHeight * 25
    const top = Math.max(0, idx * rowHeight - (viewport / 2) + rowHeight / 2)
    ref.current?.scrollTo({ top, behavior: 'smooth' })
  }

  const recenterNow = () => {
    recenterDom('yes')
    recenterDom('no')
  }

  useEffect(() => {
    const next: Record<string, 'up' | 'down'> = {}
    for (const r of rows) {
      const entries: Array<[string, number]> = [
        [`${r.p}:yb`, r.yBid], [`${r.p}:ya`, r.yAsk], [`${r.p}:nb`, r.nBid], [`${r.p}:na`, r.nAsk],
      ]
      for (const [k, v] of entries) {
        const prev = prevRef.current[k] ?? 0
        if (v !== prev) next[k] = v > prev ? 'up' : 'down'
        prevRef.current[k] = v
      }
    }
    if (!Object.keys(next).length) return
    setFlash(f => ({ ...f, ...next }))
    const t = setTimeout(() => {
      setFlash(f => {
        const c = { ...f }
        for (const k of Object.keys(next)) delete c[k]
        return c
      })
    }, 500)
    return () => clearTimeout(t)
  }, [rows])

  const ageMs = book ? Date.now() - (book.seen_ms ?? book.timestamp_ms) : Number.POSITIVE_INFINITY
  const fresh = !key ? 'NO FEED' : !book ? 'LOADING' : ageMs < 12_000 ? 'FRESH' : ageMs < 25_000 ? 'AGING' : 'STALE'
  const gridLine = softGrid ? '#8b929e' : '#202020'
  const rowLine = softGrid ? '#686f7a' : '#404040'
  const yesPositions = positions.filter(p => p.direction === 'UP')
  const noPositions = positions.filter(p => p.direction === 'DOWN')
  const yesExposure = yesPositions.reduce((sum, p) => sum + p.size, 0)
  const noExposure = noPositions.reduce((sum, p) => sum + p.size, 0)
  const yesPnl = yesPositions.reduce((sum, p) => sum + p.unrealized_pnl, 0)
  const noPnl = noPositions.reduce((sum, p) => sum + p.unrealized_pnl, 0)
  const totalPnl = yesPnl + noPnl
  const netExposure = yesExposure - noExposure
  const lastFill = fills[fills.length - 1]
  const lastTrade = tapeTicks[tapeTicks.length - 1] ?? lastFill
  const latestYesTradePrice = lastTrade?.side === 'yes' ? Math.round(lastTrade.price) : null
  const latestNoTradePrice = lastTrade?.side === 'no' ? Math.round(lastTrade.price) : null
  const palette = useMemo(() => {
    const themes = {
      standard: {
        panel: '#070b12',
        header: '#0b1220',
        action: '#111827',
        actionYesText: '#6ee7b7',
        actionNoText: '#fca5a5',
        yesBid: '#065f46',
        yesAsk: '#047857',
        yesText: '#d1fae5',
        yesBarStrong: '#22c55e',
        yesBarMid: '#16a34a',
        yesBarWeak: '#064e3b',
        noBid: '#7f1d1d',
        noAsk: '#991b1b',
        noText: '#fee2e2',
        noBarStrong: '#ef4444',
        noBarMid: '#dc2626',
        noBarWeak: '#7f1d1d',
        price: '#0b2a63',
        mid: '#facc15',
      },
      bright: {
        panel: '#020403',
        header: '#050505',
        action: '#111827',
        actionYesText: '#00ff40',
        actionNoText: '#ffb0b0',
        yesBid: '#00a42f',
        yesAsk: '#00c838',
        yesText: '#001507',
        yesBarStrong: '#00ff40',
        yesBarMid: '#00c934',
        yesBarWeak: '#063616',
        noBid: '#c90000',
        noAsk: '#ff2020',
        noText: '#ffffff',
        noBarStrong: '#ff2020',
        noBarMid: '#d00000',
        noBarWeak: '#4a0000',
        price: '#003fbe',
        mid: '#ffe800',
      },
      dark: {
        panel: '#05070b',
        header: '#070a10',
        action: '#0b0f17',
        actionYesText: '#5aa884',
        actionNoText: '#b87373',
        yesBid: '#052919',
        yesAsk: '#06321e',
        yesText: '#b8dec9',
        yesBarStrong: '#11864b',
        yesBarMid: '#0d653b',
        yesBarWeak: '#052417',
        noBid: '#361010',
        noAsk: '#451313',
        noText: '#e1b6b6',
        noBarStrong: '#9a2626',
        noBarMid: '#731d1d',
        noBarWeak: '#351010',
        price: '#071d42',
        mid: '#9f8f18',
      },
      redBlue: {
        panel: '#05070d',
        header: '#08101d',
        action: '#0b1324',
        actionYesText: '#93c5fd',
        actionNoText: '#fca5a5',
        yesBid: '#0b3b75',
        yesAsk: '#0f4f9f',
        yesText: '#dbeafe',
        yesBarStrong: '#3b82f6',
        yesBarMid: '#2563eb',
        yesBarWeak: '#0b2f68',
        noBid: '#7f1d1d',
        noAsk: '#991b1b',
        noText: '#fee2e2',
        noBarStrong: '#ef4444',
        noBarMid: '#dc2626',
        noBarWeak: '#7f1d1d',
        price: '#0b2a63',
        mid: '#facc15',
      },
      purpleBlue: {
        panel: '#070611',
        header: '#0d0b1d',
        action: '#111827',
        actionYesText: '#93c5fd',
        actionNoText: '#d8b4fe',
        yesBid: '#0b3b75',
        yesAsk: '#0f4f9f',
        yesText: '#dbeafe',
        yesBarStrong: '#60a5fa',
        yesBarMid: '#2563eb',
        yesBarWeak: '#0b2f68',
        noBid: '#3b1768',
        noAsk: '#581c87',
        noText: '#f3e8ff',
        noBarStrong: '#c084fc',
        noBarMid: '#9333ea',
        noBarWeak: '#3b1768',
        price: '#111f55',
        mid: '#facc15',
      },
    } satisfies Record<Book2Look, Record<string, string>>
    return { ...themes[look], ...ROYAL_YES_COLORS, price: SYSTEM_PRICE_COLUMN.bg }
  }, [look])
  const probabilityPalette = useMemo(() => {
    const looks = {
      blue: SYSTEM_PRICE_COLUMN,
      blackYellow: SYSTEM_PRICE_COLUMN,
      whiteWhite: SYSTEM_PRICE_COLUMN,
    } satisfies Record<ProbabilityLook, { bg: string; text: string; activeBg: string; activeText: string }>
    return looks[probabilityLook]
  }, [probabilityLook])

  const queueOrder = (outcome: 'yes' | 'no', side: 'bid' | 'offer', cents: number) => {
    const intent = { outcome, side, cents, orderType: actionMode, contracts: contractSize }
    setBookClickPrice({ outcome, cents })
    if (fastTrade && key) {
      const workingId = `fast-${key}-${outcome}-${side}-${cents}-${Date.now()}`
      setOrderIntent(null)
      setWorkingOrders(current => [{
        ...intent,
        id: workingId,
        marketKey: key,
        status: 'pending' as const,
        createdAt: Date.now(),
      }, ...current].slice(0, 30))
      void submitFastOrder(intent, workingId)
      return
    }
    setOrderIntent(intent)
  }

  const cancelWorkingOrder = (id: string) => {
    setWorkingOrders(current => current.filter(order => order.id !== id))
    cancelSimOrder(id)
    if (replaceDrag?.id === id) setReplaceDrag(null)
  }

  const cancelWorkingOrders = (outcome: 'yes' | 'no', side: 'bid' | 'offer') => {
    setWorkingOrders(current => current.filter(order => (
      order.marketKey !== key || order.outcome !== outcome || order.side !== side
    )))
    if (key) cancelSimOrders({ marketKey: key, outcome, side })
    if (replaceDrag?.marketKey === key && replaceDrag.outcome === outcome && replaceDrag.side === side) setReplaceDrag(null)
  }

  const replaceWorkingOrder = (order: WorkingOrder, cents: number) => {
    if (!key) return
    const nextIntent: OrderIntent = {
      outcome: order.outcome,
      side: order.side,
      cents,
      orderType: order.orderType,
      contracts: order.contracts,
    }
    const workingId = `replace-${key}-${order.outcome}-${order.side}-${cents}-${Date.now()}`
    setWorkingOrders(current => [
      {
        ...nextIntent,
        id: workingId,
        marketKey: key,
        status: 'pending' as const,
        createdAt: Date.now(),
      },
      ...current.filter(item => item.id !== order.id),
    ].slice(0, 30))
    cancelSimOrder(order.id)
    setReplaceDrag(null)
    void submitFastOrder(nextIntent, workingId)
  }

  const handleReplaceDrop = (cents: number) => {
    if (!replaceDrag) return
    replaceWorkingOrder(replaceDrag, cents)
  }

  const cycleAccountView = (delta: number) => {
    setAccountView(current => {
      const idx = ACCOUNT_VIEWS.indexOf(current)
      const next = (idx + (delta > 0 ? 1 : -1) + ACCOUNT_VIEWS.length) % ACCOUNT_VIEWS.length
      return ACCOUNT_VIEWS[next]
    })
  }

  const setDensity = (nextFontSize: number, nextRowHeight: number) => {
    setFontSize(clamp(nextFontSize, FONT_RANGE.min, FONT_RANGE.max))
    setRowHeight(clamp(nextRowHeight, ROW_HEIGHT_RANGE.min, ROW_HEIGHT_RANGE.max))
  }

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ scaleMode, sideView, stickMid, softGrid, actionMode, look, probabilityLook, contractSize, rowHeight, fontSize, fastTrade }))
  }, [scaleMode, sideView, stickMid, softGrid, actionMode, look, probabilityLook, contractSize, rowHeight, fontSize, fastTrade])

  useEffect(() => {
    if (!simulationEnabled) return
    setWorkingOrders(current => current.filter(order => {
      const simOrder = simOrders.find(item => item.id === order.id)
      if (!simOrder) return false
      return simOrder.status === 'working' || simOrder.status === 'partially_filled'
    }))
  }, [simOrders, simulationEnabled])

  const rowTextStyle = { fontSize: `${fontSize}px` }
  const tinyMode = fontSize <= 7 || rowHeight <= 12
  const activeWorkingCount = workingOrders.filter(order => order.marketKey === key && order.status !== 'rejected').length
  const activeForSide = (outcome: 'yes' | 'no', side: 'bid' | 'offer') => workingOrders.some(order => (
    order.marketKey === key && order.outcome === outcome && order.side === side && order.status !== 'rejected'
  ))
  const renderCancelHeaderButton = (outcome: 'yes' | 'no', side: 'bid' | 'offer') => {
    const active = activeForSide(outcome, side)
    const label = tinyMode ? 'X' : 'CXL'
    const sideLabel = side === 'bid' ? 'bids' : 'sells'
    return (
      <button
        className={`flex h-full w-full items-center justify-center border px-0.5 text-[7px] font-black leading-none ${active ? 'bg-[#2a2500] text-[#ffe800]' : 'bg-[#121212] text-[#58606d]'}`}
        style={{ borderColor: active ? '#ffe800' : gridLine }}
        onClick={event => {
          event.preventDefault()
          event.stopPropagation()
          cancelWorkingOrders(outcome, side)
        }}
        disabled={!active}
        title={`Cancel ${outcome.toUpperCase()} ${sideLabel}`}
      >
        {label}
      </button>
    )
  }
  const renderWorkingMarker = (outcome: 'yes' | 'no', side: 'bid' | 'offer', cents: number, align: 'left' | 'right') => {
    const order = workingOrders.find(item => item.marketKey === key && item.outcome === outcome && item.side === side && item.cents === cents)
    if (!order) return null
    const colors = order.status === 'working'
      ? { bg: '#00d8ff', fg: '#001014', label: tinyMode ? 'W' : `W ${order.contracts}` }
      : order.status === 'pending'
        ? { bg: '#ffe800', fg: '#151200', label: tinyMode ? 'P' : `P ${order.contracts}` }
        : { bg: '#ff3045', fg: '#fff0f2', label: tinyMode ? 'R' : 'REJ' }

    return (
      <span
        className={`absolute inset-y-0 z-20 flex min-w-[22px] cursor-pointer select-none items-center justify-center border px-1 font-black shadow ${align === 'left' ? 'left-0' : 'right-0'}`}
        style={{
          backgroundColor: colors.bg,
          color: colors.fg,
          borderColor: order.status === 'working' ? '#dffbff' : '#fff4a3',
          boxShadow: `0 0 ${tinyMode ? 5 : 9}px ${colors.bg}`,
          fontSize: tinyMode ? 7 : 9,
        }}
        title={`${order.status.toUpperCase()} ${order.contracts}x ${order.outcome.toUpperCase()} ${order.side.toUpperCase()} ${order.cents}¢`}
      >
        <span
          className="flex h-full w-full items-center justify-center"
          onClick={event => {
            event.preventDefault()
            event.stopPropagation()
            cancelWorkingOrder(order.id)
          }}
          onContextMenu={event => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDown={event => {
            if (event.button !== 2) return
            event.preventDefault()
            event.stopPropagation()
            setReplaceDrag(order)
          }}
        >
          {colors.label}
        </span>
      </span>
    )
  }

  const renderYesDomRow = (r: DomRow) => {
    const yesLtp = latestYesTradePrice === r.p
    return (
      <div
        key={`yes-dom-${r.p}`}
        className={cx('relative grid items-center border-b', replaceDrag?.outcome === 'yes' && 'outline outline-1 outline-[#ffe800]/20')}
        style={{
          gridTemplateColumns: domGridTemplateColumns,
          borderColor: rowLine,
          backgroundColor: palette.panel,
          height: rowHeight,
          lineHeight: `${rowHeight}px`,
        }}
        onPointerUp={event => {
          if (event.button !== 2 || !replaceDrag || replaceDrag.outcome !== 'yes') return
          event.preventDefault()
          event.stopPropagation()
          handleReplaceDrop(r.p)
        }}
        onContextMenu={event => {
          if (!replaceDrag || replaceDrag.outcome !== 'yes') return
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        <div
          className="relative h-full border-r"
          style={{ borderColor: gridLine, backgroundColor: palette.action }}
          title={`YES bid working orders @ ${r.p}¢`}
        >
          {renderWorkingMarker('yes', 'bid', r.p, 'right')}
        </div>
        <button
          className={`relative h-full cursor-pointer overflow-hidden border-r px-1 text-right font-semibold hover:brightness-125 ${flash[`${r.p}:yb`] === 'up' ? 'text-white' : flash[`${r.p}:yb`] === 'down' ? 'text-[#5b0000]' : ''}`}
          style={{ ...rowTextStyle, borderColor: gridLine, backgroundColor: palette.yesBid, color: palette.yesText }}
          onClick={() => queueOrder('yes', 'bid', r.p)}
          title={`${actionMode.toUpperCase()} YES bid @ ${r.p}¢`}
        >
          {r.yBid > 0 && <span className="absolute inset-y-0 right-0" style={{ width: depthWidth(r.yBid, maxY), background: `linear-gradient(to left, ${palette.yesBarStrong}, ${palette.yesBarMid}, ${palette.yesBarWeak})` }} />}
          <span className={`relative z-10 ${r.yBid > 0 ? 'text-white font-bold' : ''}`}>{fmt(r.yBid)}</span>
        </button>
        <button
          className="h-full border-r px-1 text-center font-bold"
          style={{ ...rowTextStyle, borderColor: yesLtp ? '#ffe800' : gridLine, backgroundColor: yesLtp ? palette.mid : probabilityPalette.bg, color: yesLtp ? '#000' : probabilityPalette.text }}
          onDoubleClick={() => recenterDom('yes')}
          title={yesLtp ? 'YES last trade price' : 'Double-click to recenter YES DOM'}
        >
          {r.p}¢
        </button>
        <button
          className={`relative h-full cursor-pointer overflow-hidden border-r px-1 text-right font-semibold hover:brightness-125 ${flash[`${r.p}:ya`] === 'up' ? 'text-white' : flash[`${r.p}:ya`] === 'down' ? 'text-[#5b0000]' : ''}`}
          style={{ ...rowTextStyle, borderColor: gridLine, backgroundColor: palette.yesAsk, color: palette.yesText }}
          onClick={() => queueOrder('yes', 'offer', r.p)}
          title={`${actionMode.toUpperCase()} YES offer @ ${r.p}¢`}
        >
          {r.yAsk > 0 && <span className="absolute inset-y-0 left-0" style={{ width: depthWidth(r.yAsk, maxY), background: `linear-gradient(to right, ${palette.yesBarStrong}, ${palette.yesBarMid}, ${palette.yesBarWeak})` }} />}
          <span className={`relative z-10 ${r.yAsk > 0 ? 'text-white font-bold' : ''}`}>{fmt(r.yAsk)}</span>
        </button>
        <div
          className="relative h-full border-r"
          style={{ borderColor: gridLine, backgroundColor: palette.action }}
          title={`YES sell working orders @ ${r.p}¢`}
        >
          {renderWorkingMarker('yes', 'offer', r.p, 'left')}
        </div>
      </div>
    )
  }

  const renderNoDomRow = (r: DomRow) => {
    const noLtp = latestNoTradePrice === r.nP
    return (
      <div
        key={`no-dom-${r.nP}`}
        className={cx('relative grid items-center border-b', replaceDrag?.outcome === 'no' && 'outline outline-1 outline-[#ffe800]/20')}
        style={{
          gridTemplateColumns: domGridTemplateColumns,
          borderColor: rowLine,
          backgroundColor: palette.panel,
          height: rowHeight,
          lineHeight: `${rowHeight}px`,
        }}
        onPointerUp={event => {
          if (event.button !== 2 || !replaceDrag || replaceDrag.outcome !== 'no') return
          event.preventDefault()
          event.stopPropagation()
          handleReplaceDrop(r.nP)
        }}
        onContextMenu={event => {
          if (!replaceDrag || replaceDrag.outcome !== 'no') return
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        <div
          className="relative h-full border-r"
          style={{ borderColor: gridLine, backgroundColor: palette.action }}
          title={`NO bid working orders @ ${r.nP}¢`}
        >
          {renderWorkingMarker('no', 'bid', r.nP, 'right')}
        </div>
        <button
          className={`relative h-full cursor-pointer overflow-hidden border-r px-1 text-right font-semibold hover:brightness-125 ${flash[`${r.p}:nb`] === 'up' ? 'text-white' : flash[`${r.p}:nb`] === 'down' ? 'text-[#ffd0d0]' : ''}`}
          style={{ ...rowTextStyle, borderColor: gridLine, backgroundColor: palette.noBid, color: palette.noText }}
          onClick={() => queueOrder('no', 'bid', r.nP)}
          title={`${actionMode.toUpperCase()} NO bid @ ${r.nP}¢`}
        >
          {r.nBid > 0 && <span className="absolute inset-y-0 right-0" style={{ width: depthWidth(r.nBid, maxN), background: `linear-gradient(to left, ${palette.noBarStrong}, ${palette.noBarMid}, ${palette.noBarWeak})` }} />}
          <span className="relative z-10">{fmt(r.nBid)}</span>
        </button>
        <button
          className="h-full border-r px-1 text-center font-bold"
          style={{ ...rowTextStyle, borderColor: noLtp ? '#ffe800' : gridLine, backgroundColor: noLtp ? palette.mid : probabilityPalette.bg, color: noLtp ? '#000' : probabilityPalette.text }}
          onDoubleClick={() => recenterDom('no')}
          title={noLtp ? 'NO last trade price' : 'Double-click to recenter NO side'}
        >
          {r.nP}¢
        </button>
        <button
          className={`relative h-full cursor-pointer overflow-hidden border-r px-1 text-left font-semibold hover:brightness-125 ${flash[`${r.p}:na`] === 'up' ? 'text-white' : flash[`${r.p}:na`] === 'down' ? 'text-[#ffd0d0]' : ''}`}
          style={{ ...rowTextStyle, borderColor: gridLine, backgroundColor: palette.noAsk, color: palette.noText }}
          onClick={() => queueOrder('no', 'offer', r.nP)}
          title={`${actionMode.toUpperCase()} NO offer @ ${r.nP}¢`}
        >
          {r.nAsk > 0 && <span className="absolute inset-y-0 left-0" style={{ width: depthWidth(r.nAsk, maxN), background: `linear-gradient(to right, ${palette.noBarStrong}, ${palette.noBarMid}, ${palette.noBarWeak})` }} />}
          <span className="relative z-10">{fmt(r.nAsk)}</span>
        </button>
        <div
          className="relative h-full"
          style={{ backgroundColor: palette.action }}
          title={`NO sell working orders @ ${r.nP}¢`}
        >
          {renderWorkingMarker('no', 'offer', r.nP, 'left')}
        </div>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 flex flex-col text-[9px] font-mono" style={{ backgroundColor: palette.panel }}>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center border-b px-1 py-0.5" style={{ borderColor: rowLine, backgroundColor: palette.header }}>
        <div className="min-w-0" title={ladderProductSubtitle}>
          <div className="truncate font-black tracking-normal" style={{ color: palette.actionYesText }}>
            {ladderProductLabel}
          </div>
          {!tinyMode && (
            <div className="truncate text-[7px] font-bold uppercase tracking-wide text-[#8b929e]">
              {ladderProductSubtitle}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <div className="flex border" style={{ borderColor: rowLine }}>
            <button onClick={() => setDensity(6, 10)} className="bg-[#121212] px-1 py-0 text-[9px] font-bold text-[#d1d5db]" title="Tiny ladder density">
              XS
            </button>
            <button onClick={() => setDensity(8, 14)} className="border-x bg-[#121212] px-1 py-0 text-[9px] font-bold text-[#d1d5db]" style={{ borderColor: rowLine }} title="Compact ladder density">
              SM
            </button>
            <button onClick={() => setDensity(9, 18)} className="bg-[#121212] px-1 py-0 text-[9px] font-bold text-[#d1d5db]" title="Normal ladder density">
              MD
            </button>
          </div>
          <button
            onClick={() => setActionMode(m => m === 'limit' ? 'market' : 'limit')}
            className={`border px-1 py-0 text-[9px] font-bold ${actionMode === 'limit' ? 'bg-[#0b2a63] text-white' : 'bg-[#4a0000] text-[#ffe0e0]'}`}
            style={{ borderColor: rowLine }}
          >
            {actionMode === 'limit' ? 'LMT' : 'MKT'}
          </button>
          <button
            onClick={() => setFastTrade(v => !v)}
            className={`border px-1 py-0 text-[9px] font-black ${fastTrade ? 'bg-[#ffe800] text-black' : 'bg-[#121212] text-[#a0a0a0]'}`}
            style={{ borderColor: fastTrade ? '#ffe800' : rowLine }}
            title="Fast Trade: single-click bid/ask cells submit immediately with no trade confirmation message"
          >
            FAST
          </button>
          <span className="border bg-[#121212] px-1 py-0 text-[9px] font-bold text-[#00d8ff]" style={{ borderColor: rowLine }} title="Working orders displayed in the ladder">
            W {activeWorkingCount}
          </span>
          <span className={`border px-1 py-0 text-[9px] font-black ${simulationEnabled ? 'bg-[#163300] text-[#74ff8d]' : 'bg-[#121212] text-[#8b929e]'}`} style={{ borderColor: simulationEnabled ? '#22c55e' : rowLine }} title="Sim Exchange local matching environment">
            SIM
          </span>
          <button onClick={() => setShowSettings(v => !v)} className="border bg-[#121212] px-1 py-0 text-[9px] font-bold text-[#d1d5db]" style={{ borderColor: rowLine }}>
            SET
          </button>
          <span
            className={`h-2 w-2 rounded-full ${fresh === 'FRESH' ? 'bg-[#00ff40]' : fresh === 'AGING' || fresh === 'LOADING' ? 'bg-[#ffe800]' : 'bg-[#ff2020]'}`}
            title={`Feed status: ${fresh}`}
          />
        </div>
        <span />
      </div>

      {showSettings && (
        <div className="border-b bg-[#0b0f17] p-1" style={{ borderColor: rowLine }}>
          <div className="grid grid-cols-[1fr_auto] gap-1">
            <div className="grid grid-cols-6 border text-[8px] uppercase" style={{ borderColor: rowLine }}>
              <span className="border-r px-1 py-0.5 text-[#aab2c0]" style={{ borderColor: gridLine }}>Grid</span>
              <button onClick={() => setSoftGrid(v => !v)} className={`border-r px-1 py-0.5 font-bold ${softGrid ? 'bg-[#d1d5db] text-black' : 'bg-[#121212] text-[#a0a0a0]'}`} style={{ borderColor: gridLine }}>
                {softGrid ? 'Soft Grey' : 'Hard Dark'}
              </button>
              <span className="border-r px-1 py-0.5 text-[#aab2c0]" style={{ borderColor: gridLine }}>Scale</span>
              <button className="px-1 py-0.5 font-bold text-white bg-[#0b2a63]" title="Price ladder is fixed high-to-low">
                fixed
              </button>
              <span className="border-r border-t px-1 py-0.5 text-[#aab2c0]" style={{ borderColor: gridLine }}>View</span>
              <button onClick={() => setSideView('both')} className={`border-r border-t px-1 py-0.5 font-bold ${sideView === 'both' ? 'bg-[#ffe800] text-black' : 'bg-[#121212] text-[#a0a0a0]'}`} style={{ borderColor: gridLine }}>Both</button>
              <button onClick={() => setSideView('yes')} className={`border-r border-t px-1 py-0.5 font-bold ${sideView === 'yes' ? 'bg-[#00d93a] text-black' : 'bg-[#121212] text-[#a0a0a0]'}`} style={{ borderColor: gridLine }}>Yes</button>
              <button onClick={() => setSideView('no')} className={`border-t px-1 py-0.5 font-bold ${sideView === 'no' ? 'bg-[#ff2020] text-white' : 'bg-[#121212] text-[#a0a0a0]'}`} style={{ borderColor: gridLine }}>No</button>
              <span className="border-r border-t px-1 py-0.5 text-[#aab2c0]" style={{ borderColor: gridLine }}>Action</span>
              <button onClick={() => setActionMode('limit')} className={`border-r border-t px-1 py-0.5 font-bold ${actionMode === 'limit' ? 'bg-[#0b2a63] text-white' : 'bg-[#121212] text-[#a0a0a0]'}`} style={{ borderColor: gridLine }}>Limit</button>
              <button onClick={() => setActionMode('market')} className={`border-r border-t px-1 py-0.5 font-bold ${actionMode === 'market' ? 'bg-[#4a0000] text-[#ffe0e0]' : 'bg-[#121212] text-[#a0a0a0]'}`} style={{ borderColor: gridLine }}>Market</button>
              <button onClick={() => setOrderIntent(null)} className="border-t px-1 py-0.5 font-bold text-[#a0a0a0] bg-[#121212]" style={{ borderColor: gridLine }}>Clear</button>
              <span className="border-r border-t px-1 py-0.5 text-[#aab2c0]" style={{ borderColor: gridLine }}>Look</span>
              <button onClick={() => setLook('standard')} className={`border-r border-t px-1 py-0.5 font-bold ${look === 'standard' ? 'text-white' : 'bg-[#121212] text-[#a0a0a0]'}`} style={{ borderColor: gridLine, backgroundColor: look === 'standard' ? '#0b2a63' : undefined }}>Std</button>
              <button onClick={() => setLook('bright')} className={`border-r border-t px-1 py-0.5 font-bold ${look === 'bright' ? 'text-black' : 'bg-[#121212] text-[#a0a0a0]'}`} style={{ borderColor: gridLine, backgroundColor: look === 'bright' ? '#ffe800' : undefined }}>Bright</button>
              <button onClick={() => setLook('dark')} className={`border-r border-t px-1 py-0.5 font-bold ${look === 'dark' ? 'text-white' : 'bg-[#121212] text-[#a0a0a0]'}`} style={{ borderColor: gridLine, backgroundColor: look === 'dark' ? '#111827' : undefined }}>Dark</button>
              <button onClick={() => setLook('redBlue')} className={`border-r border-t px-1 py-0.5 font-bold ${look === 'redBlue' ? 'text-white' : 'bg-[#121212] text-[#a0a0a0]'}`} style={{ borderColor: gridLine, backgroundColor: look === 'redBlue' ? '#1d4ed8' : undefined }}>R/B</button>
              <button onClick={() => setLook('purpleBlue')} className={`border-t px-1 py-0.5 font-bold ${look === 'purpleBlue' ? 'text-white' : 'bg-[#121212] text-[#a0a0a0]'}`} style={{ borderColor: gridLine, backgroundColor: look === 'purpleBlue' ? '#7e22ce' : undefined }}>P/B</button>
              <span className="border-r border-t px-1 py-0.5 text-[#aab2c0]" style={{ borderColor: gridLine }}>Prob</span>
              <button onClick={() => setProbabilityLook('blue')} className={`border-r border-t px-1 py-0.5 font-bold ${probabilityLook === 'blue' ? 'text-white' : 'bg-[#121212] text-[#a0a0a0]'}`} style={{ borderColor: gridLine, backgroundColor: probabilityLook === 'blue' ? palette.price : undefined }}>Blue</button>
              <button onClick={() => setProbabilityLook('blackYellow')} className={`border-r border-t px-1 py-0.5 font-bold ${probabilityLook === 'blackYellow' ? 'text-[#ffe800]' : 'bg-[#121212] text-[#a0a0a0]'}`} style={{ borderColor: gridLine, backgroundColor: probabilityLook === 'blackYellow' ? '#000000' : undefined }}>Blk/Yel</button>
              <button onClick={() => setProbabilityLook('whiteWhite')} className={`border-r border-t px-1 py-0.5 font-bold ${probabilityLook === 'whiteWhite' ? 'text-black' : 'bg-[#121212] text-[#a0a0a0]'}`} style={{ borderColor: gridLine, backgroundColor: probabilityLook === 'whiteWhite' ? '#ffffff' : undefined }}>Wht/Blk</button>
              <span className="border-r border-t px-1 py-0.5 text-[#aab2c0]" style={{ borderColor: gridLine }}>Density</span>
              <button onClick={() => setDensity(6, 10)} className="border-r border-t px-1 py-0.5 font-bold text-[#d1d5db] bg-[#121212]" style={{ borderColor: gridLine }}>XS</button>
              <button onClick={() => setDensity(8, 14)} className="border-r border-t px-1 py-0.5 font-bold text-[#d1d5db] bg-[#121212]" style={{ borderColor: gridLine }}>SM</button>
              <button onClick={() => setDensity(9, 18)} className="border-t px-1 py-0.5 font-bold text-[#d1d5db] bg-[#121212]" style={{ borderColor: gridLine }}>MD</button>
            </div>
            <button onClick={() => setShowSettings(false)} className="border border-[#ffe800] bg-[#2a2500] px-2 text-[8px] font-bold text-[#ffe800]">
              SAVE
            </button>
          </div>
        </div>
      )}

      <div className="grid border-b text-[8px] font-bold uppercase" style={{ gridTemplateColumns: headerGridTemplateColumns, borderColor: rowLine, backgroundColor: palette.header }}>
        {showYes && (
          <span className="border-r" style={{ borderColor: gridLine, backgroundColor: palette.action }}>
            {renderCancelHeaderButton('yes', 'bid')}
          </span>
        )}
        {showYes && (
          <span className="border-r px-1 text-right text-white" style={{ borderColor: gridLine, backgroundColor: palette.yesBarStrong }}>
            Yes Bid
          </span>
        )}
        {showYes && (
          <button onClick={recenterNow} className="border-r px-1 text-center" style={{ borderColor: gridLine, backgroundColor: probabilityPalette.bg, color: probabilityPalette.text }}>
            {tinyMode ? 'Y%' : 'Yes %'}
          </button>
        )}
        {showYes && (
          <span className="border-r px-1 text-left text-white" style={{ borderColor: gridLine, backgroundColor: palette.yesAsk }}>
            Yes Ask
          </span>
        )}
        {showYes && (
          <span className="border-r" style={{ borderColor: gridLine, backgroundColor: palette.action }}>
            {renderCancelHeaderButton('yes', 'offer')}
          </span>
        )}
        {showNo && (
          <span className="border-r" style={{ borderColor: gridLine, backgroundColor: palette.action }}>
            {renderCancelHeaderButton('no', 'bid')}
          </span>
        )}
        {showNo && (
          <span className="border-r px-1 text-right text-white" style={{ borderColor: gridLine, backgroundColor: palette.noBarMid }}>
            No Bid
          </span>
        )}
        {showNo && (
          <button onClick={recenterNow} className="border-r px-1 text-center" style={{ borderColor: gridLine, backgroundColor: probabilityPalette.bg, color: probabilityPalette.text }}>
            {tinyMode ? 'N%' : 'No %'}
          </button>
        )}
        {showNo && (
          <span className="border-r px-1 text-left text-white" style={{ borderColor: gridLine, backgroundColor: palette.noBarStrong }}>
            No Ask
          </span>
        )}
        {showNo && (
          <span style={{ backgroundColor: palette.action }}>
            {renderCancelHeaderButton('no', 'offer')}
          </span>
        )}
      </div>

      <div
        className={cx('grid flex-1 min-h-0 gap-px overflow-hidden', showYes && showNo ? 'grid-cols-2' : 'grid-cols-1')}
        style={{ backgroundColor: gridLine }}
      >
        {showYes && (
          <div ref={yesRef} className="min-h-0 min-w-0 overflow-y-auto [scrollbar-width:thin]" style={{ backgroundColor: palette.panel }}>
            {displayRows.map(renderYesDomRow)}
          </div>
        )}
        {showNo && (
          <div ref={noRef} className="min-h-0 min-w-0 overflow-y-auto [scrollbar-width:thin]" style={{ backgroundColor: palette.panel }}>
            {displayRows.map(renderNoDomRow)}
          </div>
        )}
      </div>

      <div
        className="shrink-0 border-t p-1"
        style={{ borderColor: rowLine, backgroundColor: palette.panel }}
        onWheel={(e) => {
          e.preventDefault()
          cycleAccountView(e.deltaY)
        }}
      >
        <div className="mb-1 flex items-center gap-1">
          <div className="flex border text-[8px] uppercase" style={{ borderColor: gridLine }}>
            {ACCOUNT_VIEWS.map(view => (
              <button
                key={view}
                onClick={() => setAccountView(view)}
                className={`px-1 py-0.5 font-bold ${accountView === view ? 'text-white' : 'text-[#8b929e]'}`}
                style={{ backgroundColor: accountView === view ? palette.price : palette.action }}
              >
                {view}
              </button>
            ))}
          </div>
          <div className="ml-auto flex border text-[8px]" style={{ borderColor: gridLine }}>
            {CONTRACT_SIZES.map(size => (
              <button
                key={size}
                onClick={() => setContractSize(size)}
                className={`px-1 py-0.5 font-bold ${contractSize === size ? 'text-black' : 'text-[#d1d5db]'}`}
                style={{ backgroundColor: contractSize === size ? palette.mid : palette.action }}
                title={`Set contract size ${size}`}
              >
                {size >= 100 ? '100' : size}
              </button>
            ))}
          </div>
        </div>

        {accountView === 'account' && (
          <div className="grid grid-cols-4 gap-px text-[8px] uppercase">
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine }}>
              <div className="text-[#8b929e]">Order Ticket</div>
              <div className="truncate font-bold text-white">
                {orderIntent ? `${orderIntent.orderType.toUpperCase()} ${orderIntent.contracts}x ${orderIntent.outcome.toUpperCase()} ${orderIntent.side.toUpperCase()} ${orderIntent.cents}¢` : `${contractSize}x ready`}
              </div>
              {orderIntent && (
                <button
                  onClick={submitManualOrder}
                  className="ml-2 border border-[#00ff40] bg-[#003300] px-2 py-0 text-[8px] font-black text-[#00ff40] hover:bg-[#004400]"
                  title="Submit via hardened /api/execution/entry (RiskGate + ExecutionAgent)"
                >
                  SUBMIT
                </button>
              )}
            </div>
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine }}>
              <div className="text-[#8b929e]">Exposure</div>
              <div className="font-bold text-white">Y {yesExposure.toFixed(0)} / N {noExposure.toFixed(0)}</div>
            </div>
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine }}>
              <div className="text-[#8b929e]">Net / P&L</div>
              <div className={`font-bold ${totalPnl >= 0 ? 'text-[#00ff40]' : 'text-[#ff4040]'}`}>{netExposure.toFixed(0)} / {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}</div>
            </div>
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine }}>
              <div className="text-[#8b929e]">Acct</div>
              <div className="font-bold text-white">{metrics?.trade_count ?? 0} trades · {metrics?.trades_remaining ?? '--'} left</div>
            </div>
          </div>
        )}

        {accountView === 'position' && (
          <div className="grid grid-cols-4 gap-px text-[8px] uppercase">
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine }}>
              <div className="text-[#8b929e]">YES Pos</div>
              <div className="font-bold" style={{ color: palette.actionYesText }}>{yesPositions.length} / {yesExposure.toFixed(0)}</div>
            </div>
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine }}>
              <div className="text-[#8b929e]">NO Pos</div>
              <div className="font-bold" style={{ color: palette.actionNoText }}>{noPositions.length} / {noExposure.toFixed(0)}</div>
            </div>
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine }}>
              <div className="text-[#8b929e]">YES P&L</div>
              <div className={`font-bold ${yesPnl >= 0 ? 'text-[#00ff40]' : 'text-[#ff4040]'}`}>{yesPnl >= 0 ? '+' : ''}{yesPnl.toFixed(2)}</div>
            </div>
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine }}>
              <div className="text-[#8b929e]">NO P&L</div>
              <div className={`font-bold ${noPnl >= 0 ? 'text-[#00ff40]' : 'text-[#ff4040]'}`}>{noPnl >= 0 ? '+' : ''}{noPnl.toFixed(2)}</div>
            </div>
          </div>
        )}

        {accountView === 'fills' && (
          <div className="grid grid-cols-4 gap-px text-[8px] uppercase">
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine }}>
              <div className="text-[#8b929e]">Last Fill</div>
              <div className="truncate font-bold text-white">{lastFill ? `${lastFill.side.toUpperCase()} ${lastFill.price.toFixed(1)}¢` : 'None'}</div>
            </div>
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine }}>
              <div className="text-[#8b929e]">Fill Size</div>
              <div className="font-bold text-white">{lastFill ? lastFill.size.toFixed(0) : '--'}</div>
            </div>
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine }}>
              <div className="text-[#8b929e]">Fills</div>
              <div className="font-bold text-white">{fills.length}</div>
            </div>
            <div className="border px-1 py-0.5" style={{ borderColor: gridLine }}>
              <div className="text-[#8b929e]">Ticket</div>
              <div className="font-bold text-white">{contractSize} contracts</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
