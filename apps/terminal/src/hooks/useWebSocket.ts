import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { ceriousWsBase } from '../platform/transport'
import type { Asset, ExecutionPosition, ExecutionRisk, WsMsg } from '../types'

const CONFIGURED_WS_BASE = (import.meta.env.VITE_CERIOUS_WS_BASE as string | undefined)?.trim()
const WS_BASE = CONFIGURED_WS_BASE || ceriousWsBase()
const WORKSPACE_SESSION_TOKEN_KEY = 'cerious.workspace.sessionToken.v1'

export function useWebSocket(asset: Asset) {
  const wsRef = useRef<WebSocket | null>(null)
  const retryRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const marketProvider = useStore(s => s.marketProvider)
  const { pushBar, setBands, setBook, pushTick, setZscore,
          pushSignal, setPositions, setMetrics, setCopyStatus,
          setMarkets, loadSnapshot, setSettlements,
          setPolyBook, pushPolyTick, pushPolyFill,
          setExecutionPositions, setExecutionRisk, setSimTradingState } = useStore.getState()

  useEffect(() => {
    let alive = true
    let endpointIndex = 0
    const endpoints = [WS_BASE]

    function connect() {
      if (!alive) return
      const base = endpoints[endpointIndex] ?? WS_BASE
      const params = new URLSearchParams({ provider: marketProvider })
      const token = window.localStorage.getItem(WORKSPACE_SESSION_TOKEN_KEY) || ''
      if (token) params.set('token', token)
      const ws = new WebSocket(`${base}/${asset}?${params.toString()}`)
      wsRef.current = ws

      ws.onopen = () => {
        endpointIndex = 0
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)

          if (msg.type === 'snapshot') {
            loadSnapshot(msg.asset as Asset, msg)
            // Snapshot also carries recent settlements
            if (Array.isArray(msg.settlements) && msg.settlements.length > 0) {
              setSettlements(msg.settlements)
            }
            return
          }

          const m = msg as WsMsg
          switch (m.type) {
            case 'bar':         pushBar(m.asset, m.data); break
            case 'bands':       setBands(m.asset, m.data); break
            case 'book':        setBook(m.asset, m.data); break
            case 'tick':        pushTick(m.asset, m.data); break
            case 'zscore':      setZscore(m.asset, m.value, m.regime); break
            case 'signal':      pushSignal(m.data); break
            case 'position':    setPositions(m.data); break
            case 'metrics':     setMetrics(m.data); break
            case 'copy_status':  setCopyStatus(m.data); break
            case 'markets':      setMarkets(m.data); break
            case 'settlements':  setSettlements(m.data); break
            case 'poly_book':    setPolyBook(m.market_key, m.data); break
            case 'poly_tick':
              pushPolyTick(m.market_key, m.data)
              break
            case 'fill':
              pushPolyFill(m.market_key, m.data)
              break
            case 'order_snapshot':
              setSimTradingState(m.data)
              break
            case 'execution_event':
              if (Array.isArray(m.data?.positions)) {
                if (m.data.risk) {
                  setExecutionRisk(m.data.risk as ExecutionRisk)
                }
                const updated = m.data.positions as ExecutionPosition[]
                setExecutionPositions(updated)
              }
              break
          }
        } catch {}
      }

      ws.onclose = () => {
        endpointIndex = (endpointIndex + 1) % endpoints.length
        if (alive) {
          retryRef.current = setTimeout(connect, 2000)
        }
      }

      ws.onerror = () => ws.close()
    }

    connect()

    return () => {
      alive = false
      clearTimeout(retryRef.current)
      wsRef.current?.close()
    }
  }, [asset, marketProvider])

  useEffect(() => {
    let alive = true

    const pollMetrics = async () => {
      try {
        const r = await fetch('/api/metrics')
        if (!r.ok || !alive) return
        const data = await r.json()
        if (!alive) return
        setMetrics(data)
      } catch {
        // Keep WS as primary source; polling is a silent fallback.
      }
    }

    pollMetrics()
    const t = setInterval(pollMetrics, 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [setMetrics])
}
