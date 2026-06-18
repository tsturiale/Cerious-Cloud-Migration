import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Circle,
  Filter,
  Pause,
  Play,
  RotateCcw,
  Search,
  Send,
  Trash2,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type FixJournalEntry = {
  id: string
  timestamp: number
  timestampIso: string
  direction: 'sent' | 'received' | 'system'
  msgType: string
  msgTypeLabel: string
  clOrdId: string
  orderId: string
  symbol: string
  side: string
  qty: string
  price: string
  ordStatus: string
  ordStatusLabel: string
  execType: string
  raw: string
  valid: boolean
  error: string | null
  seqNum: number
}

type FixStatus = {
  state: string
  senderCompId: string
  targetCompId: string
  targetHost: string
  targetPort: number
  sendSeqNum: number
  recvSeqNum: number
  heartbeatInterval: number
  sentCount: number
  recvCount: number
  errorCount: number
  journalSize: number
  startedAt: number | null
  uptimeSeconds: number
  dryRun: boolean
  fixVersion: string
}

type DirectionFilter = 'all' | 'sent' | 'received'

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MSG_TYPE_CHIPS = [
  { value: 'D', label: 'NewOrder', color: '#3b82f6' },
  { value: '8', label: 'ExecRpt', color: '#10b981' },
  { value: 'F', label: 'Cancel', color: '#f59e0b' },
  { value: 'G', label: 'Replace', color: '#8b5cf6' },
  { value: '9', label: 'CxlRej', color: '#ef4444' },
  { value: '3', label: 'Reject', color: '#ef4444' },
  { value: 'j', label: 'BizRej', color: '#ef4444' },
  { value: 'A', label: 'Logon', color: '#6b7280' },
  { value: '5', label: 'Logout', color: '#6b7280' },
  { value: '0', label: 'HB', color: '#374151' },
]

const STATE_COLORS: Record<string, string> = {
  ACTIVE: '#10b981',
  SIMULATED: '#3b82f6',
  LOGON_SENT: '#f59e0b',
  LOGOUT_SENT: '#f59e0b',
  DISCONNECTED: '#ef4444',
}

const SIDE_COLORS: Record<string, string> = {
  BUY: '#10b981',
  SELL: '#ef4444',
}

const STATUS_COLORS: Record<string, string> = {
  New: '#3b82f6',
  PendingNew: '#3b82f6',
  PartiallyFilled: '#f59e0b',
  Filled: '#10b981',
  Cancelled: '#6b7280',
  Rejected: '#ef4444',
  Replaced: '#8b5cf6',
  PendingCancel: '#f59e0b',
  PendingReplace: '#f59e0b',
  DoneForDay: '#6b7280',
}

const POLL_INTERVAL = 2000
const WS_EVENT_TYPES = new Set(['fix_message', 'fix_status', 'fix_error'])

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatTimestamp(iso: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
    '.' + String(d.getMilliseconds()).padStart(3, '0')
}

function formatUptime(seconds: number): string {
  if (!seconds || seconds < 0) return '0s'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function escapeForDisplay(raw: string): string {
  return raw.replace(/\x01/g, ' | ')
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function FixMonitor() {
  const [entries, setEntries] = useState<FixJournalEntry[]>([])
  const [status, setStatus] = useState<FixStatus | null>(null)
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all')
  const [msgTypeFilter, setMsgTypeFilter] = useState<Set<string>>(new Set())
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [symbolFilter, setSymbolFilter] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [paused, setPaused] = useState(false)
  const tableEndRef = useRef<HTMLDivElement>(null)
  const tableContainerRef = useRef<HTMLDivElement>(null)

  // ---- Data fetching via REST poll + WS events ----
  const fetchJournal = useCallback(async () => {
    if (paused) return
    try {
      const res = await fetch('/api/fix/journal?limit=500')
      if (!res.ok) return
      const data = await res.json()
      setEntries(data.entries ?? [])
      setStatus(data.status ?? null)
    } catch { /* network error, will retry */ }
  }, [paused])

  // Initial load + poll
  useEffect(() => {
    fetchJournal()
    const id = setInterval(fetchJournal, POLL_INTERVAL)
    return () => clearInterval(id)
  }, [fetchJournal])

  // Listen for FIX events on existing WebSocket
  useEffect(() => {
    function handleWsMessage(event: MessageEvent) {
      try {
        const msg = JSON.parse(event.data)
        if (!WS_EVENT_TYPES.has(msg.type)) return
        if (msg.type === 'fix_message' && msg.data && !paused) {
          setEntries(prev => {
            const next = [...prev, msg.data]
            return next.length > 500 ? next.slice(-500) : next
          })
        }
        if (msg.type === 'fix_status' && msg.data) {
          setStatus(msg.data)
        }
      } catch { /* ignore parse errors from non-FIX messages */ }
    }

    // Attach to any open WebSocket (the asset connector creates one)
    const origAddEventListener = WebSocket.prototype.addEventListener
    // We'll just poll — WS integration happens naturally through the journal refetch
    void origAddEventListener
  }, [paused])

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && tableEndRef.current) {
      tableEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [entries.length, autoScroll])

  // Handle scroll position to toggle auto-scroll
  const handleScroll = useCallback(() => {
    const container = tableContainerRef.current
    if (!container) return
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40
    setAutoScroll(atBottom)
  }, [])

  // ---- Filtering ----
  const filtered = entries.filter(entry => {
    if (directionFilter !== 'all' && entry.direction !== directionFilter) return false
    if (msgTypeFilter.size > 0 && !msgTypeFilter.has(entry.msgType)) return false
    if (errorsOnly && !entry.error) return false
    if (symbolFilter && entry.symbol && !entry.symbol.toUpperCase().includes(symbolFilter.toUpperCase())) return false
    if (searchText) {
      const q = searchText.toLowerCase()
      const haystack = `${entry.raw} ${entry.msgTypeLabel} ${entry.clOrdId} ${entry.symbol} ${entry.side} ${entry.ordStatusLabel}`.toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })

  // ---- Actions ----
  const toggleMsgType = (type: string) => {
    setMsgTypeFilter(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  const clearFilters = () => {
    setDirectionFilter('all')
    setMsgTypeFilter(new Set())
    setErrorsOnly(false)
    setSearchText('')
    setSymbolFilter('')
  }

  const sendTestOrder = async () => {
    try {
      await fetch('/api/fix/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'ES', side: 'bid', price: 6000.00, qty: 1 }),
      })
      setTimeout(fetchJournal, 200)
    } catch { /* ignore */ }
  }

  const stateColor = STATE_COLORS[status?.state ?? ''] ?? '#6b7280'
  const hasActiveFilters = directionFilter !== 'all' || msgTypeFilter.size > 0 || errorsOnly || searchText || symbolFilter

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: '#080c14', color: '#c8d6e5', fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11, overflow: 'hidden', borderRadius: 4,
    }}>
      {/* ---- SESSION HEADER ---- */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px',
        background: 'linear-gradient(180deg, #0d1525 0%, #0a1020 100%)',
        borderBottom: '1px solid #1a2744', flexShrink: 0, minHeight: 36,
      }}>
        {/* Status dot */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <Circle size={8} fill={stateColor} color={stateColor} />
          <span style={{ color: stateColor, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {status?.state ?? 'LOADING'}
          </span>
        </div>

        {/* Comp IDs */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#5a7a9e', fontSize: 10 }}>
          <span style={{ color: '#8faabe' }}>{status?.senderCompId ?? '—'}</span>
          <ArrowUp size={9} style={{ opacity: 0.5 }} />
          <ArrowDown size={9} style={{ opacity: 0.5 }} />
          <span style={{ color: '#8faabe' }}>{status?.targetCompId ?? '—'}</span>
        </div>

        <div style={{ width: 1, height: 16, background: '#1a2744' }} />

        {/* Sequence numbers */}
        <div style={{ display: 'flex', gap: 8, fontSize: 10, color: '#5a7a9e' }}>
          <span>S:<span style={{ color: '#8faabe' }}>{status?.sendSeqNum ?? 0}</span></span>
          <span>R:<span style={{ color: '#8faabe' }}>{status?.recvSeqNum ?? 0}</span></span>
        </div>

        <div style={{ width: 1, height: 16, background: '#1a2744' }} />

        {/* FIX version + HB */}
        <span style={{ fontSize: 10, color: '#4a6a8e' }}>
          {status?.fixVersion ?? 'FIX.4.4'} · HB {status?.heartbeatInterval ?? 30}s
        </span>

        <div style={{ flex: 1 }} />

        {/* Uptime */}
        <span style={{ fontSize: 10, color: '#4a6a8e' }}>
          {status?.startedAt ? `↑ ${formatUptime(status.uptimeSeconds)}` : ''}
        </span>

        {/* Connection indicator */}
        {status?.state === 'ACTIVE' || status?.state === 'SIMULATED' ? (
          <Wifi size={12} color={stateColor} />
        ) : (
          <WifiOff size={12} color="#ef4444" />
        )}
      </div>

      {/* ---- FILTER BAR ---- */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px',
        background: '#0a1020', borderBottom: '1px solid #141e34', flexShrink: 0,
        flexWrap: 'wrap', minHeight: 32,
      }}>
        {/* Direction filter */}
        <div style={{ display: 'flex', gap: 2 }}>
          {(['all', 'sent', 'received'] as DirectionFilter[]).map(dir => (
            <button key={dir} onClick={() => setDirectionFilter(dir)} style={{
              padding: '2px 7px', fontSize: 9, borderRadius: 3, border: 'none', cursor: 'pointer',
              background: directionFilter === dir ? '#1e3a5f' : 'transparent',
              color: directionFilter === dir ? '#7dd3fc' : '#4a6a8e',
              fontFamily: 'inherit', textTransform: 'uppercase', letterSpacing: 0.4,
              transition: 'all 0.15s',
            }}>
              {dir === 'all' ? 'All' : dir === 'sent' ? '→ Sent' : '← Recv'}
            </button>
          ))}
        </div>

        <div style={{ width: 1, height: 14, background: '#1a2744' }} />

        {/* MsgType chips */}
        <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {MSG_TYPE_CHIPS.map(chip => {
            const active = msgTypeFilter.has(chip.value)
            return (
              <button key={chip.value} onClick={() => toggleMsgType(chip.value)} style={{
                padding: '1px 5px', fontSize: 9, borderRadius: 3, cursor: 'pointer',
                border: `1px solid ${active ? chip.color : 'transparent'}`,
                background: active ? `${chip.color}18` : 'transparent',
                color: active ? chip.color : '#3a5a7e',
                fontFamily: 'inherit', transition: 'all 0.15s',
              }}>
                {chip.label}
              </button>
            )
          })}
        </div>

        <div style={{ width: 1, height: 14, background: '#1a2744' }} />

        {/* Error toggle */}
        <button onClick={() => setErrorsOnly(!errorsOnly)} style={{
          padding: '2px 6px', fontSize: 9, borderRadius: 3, border: 'none', cursor: 'pointer',
          background: errorsOnly ? '#7f1d1d' : 'transparent',
          color: errorsOnly ? '#fca5a5' : '#4a6a8e',
          fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 3,
        }}>
          <AlertTriangle size={9} /> Errors
        </button>

        {/* Symbol filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, background: '#0d1525', borderRadius: 3, padding: '1px 5px', border: '1px solid #1a2744' }}>
          <Filter size={9} color="#3a5a7e" />
          <input
            type="text" placeholder="Symbol" value={symbolFilter}
            onChange={e => setSymbolFilter(e.target.value)}
            style={{
              background: 'transparent', border: 'none', outline: 'none', color: '#8faabe',
              fontSize: 9, fontFamily: 'inherit', width: 42,
            }}
          />
        </div>

        {/* Search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, background: '#0d1525', borderRadius: 3, padding: '1px 5px', border: '1px solid #1a2744', flex: 1, minWidth: 80 }}>
          <Search size={9} color="#3a5a7e" />
          <input
            type="text" placeholder="Search FIX..." value={searchText}
            onChange={e => setSearchText(e.target.value)}
            style={{
              background: 'transparent', border: 'none', outline: 'none', color: '#8faabe',
              fontSize: 9, fontFamily: 'inherit', width: '100%',
            }}
          />
        </div>

        {/* Clear filters */}
        {hasActiveFilters && (
          <button onClick={clearFilters} style={{
            padding: '2px 5px', fontSize: 9, borderRadius: 3, border: 'none', cursor: 'pointer',
            background: '#1e293b', color: '#94a3b8', fontFamily: 'inherit',
          }}>
            Clear
          </button>
        )}

        {/* Pause/Resume */}
        <button onClick={() => setPaused(!paused)} title={paused ? 'Resume' : 'Pause'} style={{
          padding: '2px 4px', borderRadius: 3, border: 'none', cursor: 'pointer',
          background: paused ? '#7f1d1d' : 'transparent', color: paused ? '#fca5a5' : '#4a6a8e',
        }}>
          {paused ? <Play size={10} /> : <Pause size={10} />}
        </button>

        {/* Test order button */}
        <button onClick={sendTestOrder} title="Send test NewOrderSingle (sim)" style={{
          padding: '2px 6px', fontSize: 9, borderRadius: 3, border: '1px solid #1e3a5f',
          cursor: 'pointer', background: '#0d1a2e', color: '#7dd3fc', fontFamily: 'inherit',
          display: 'flex', alignItems: 'center', gap: 3,
        }}>
          <Zap size={9} /> Test
        </button>
      </div>

      {/* ---- MESSAGE TABLE ---- */}
      <div
        ref={tableContainerRef}
        onScroll={handleScroll}
        style={{
          flex: 1, overflow: 'auto', minHeight: 0,
        }}
      >
        {/* Table header */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '22px 72px 38px 110px 80px 52px 40px 58px 62px 72px 1fr',
          gap: 0, padding: '3px 10px',
          background: '#0c1628', borderBottom: '1px solid #1a2744',
          position: 'sticky', top: 0, zIndex: 2,
          fontSize: 9, color: '#3a5a7e', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600,
        }}>
          <span></span>
          <span>Time</span>
          <span>Seq</span>
          <span>MsgType</span>
          <span>ClOrdID</span>
          <span>Symbol</span>
          <span>Side</span>
          <span>Qty</span>
          <span>Price</span>
          <span>Status</span>
          <span></span>
        </div>

        {/* Table rows */}
        {filtered.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            height: 120, color: '#2a4a6e', fontSize: 11, gap: 6,
          }}>
            <Activity size={18} />
            {entries.length === 0 ? 'No FIX messages yet — send a test order to begin' : 'No messages match current filters'}
          </div>
        ) : (
          filtered.map((entry, idx) => {
            const isExpanded = expandedRow === entry.id
            const isError = !!entry.error
            const isSystem = entry.direction === 'system'
            const rowBg = isError
              ? idx % 2 === 0 ? '#1a0a0a' : '#1f0c0c'
              : isSystem
                ? idx % 2 === 0 ? '#0a0e18' : '#0c1020'
                : idx % 2 === 0 ? '#080c14' : '#0a1020'

            return (
              <div key={entry.id}>
                <div
                  onClick={() => setExpandedRow(isExpanded ? null : entry.id)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '22px 72px 38px 110px 80px 52px 40px 58px 62px 72px 1fr',
                    gap: 0, padding: '3px 10px', cursor: 'pointer',
                    background: rowBg, borderBottom: '1px solid #0f1a2e',
                    transition: 'background 0.1s',
                    alignItems: 'center', minHeight: 22,
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = '#111d33' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = rowBg }}
                >
                  {/* Direction */}
                  <span style={{ display: 'flex', alignItems: 'center' }}>
                    {isSystem ? (
                      <Activity size={10} color="#4a6a8e" />
                    ) : entry.direction === 'sent' ? (
                      <ArrowUp size={10} color="#3b82f6" />
                    ) : (
                      <ArrowDown size={10} color="#10b981" />
                    )}
                  </span>

                  {/* Time */}
                  <span style={{ color: '#5a7a9e', fontSize: 10 }}>
                    {formatTimestamp(entry.timestampIso)}
                  </span>

                  {/* Seq */}
                  <span style={{ color: '#3a5a7e', fontSize: 10 }}>
                    {entry.seqNum || ''}
                  </span>

                  {/* MsgType */}
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{
                      padding: '0px 4px', borderRadius: 2, fontSize: 9, fontWeight: 600,
                      background: isSystem ? '#1a2744' : entry.msgType === 'D' ? '#1e3a5f' : entry.msgType === '8' ? '#064e3b' : entry.msgType === '3' || entry.msgType === '9' || entry.msgType === 'j' ? '#7f1d1d' : '#1a2744',
                      color: isSystem ? '#4a6a8e' : entry.msgType === 'D' ? '#7dd3fc' : entry.msgType === '8' ? '#6ee7b7' : entry.msgType === '3' || entry.msgType === '9' || entry.msgType === 'j' ? '#fca5a5' : '#5a7a9e',
                    }}>
                      {isSystem ? 'SYS' : entry.msgType}
                    </span>
                    <span style={{ color: '#8faabe', fontSize: 10 }}>
                      {entry.msgTypeLabel}
                    </span>
                    {isError && <AlertTriangle size={9} color="#ef4444" />}
                  </span>

                  {/* ClOrdID */}
                  <span style={{ color: '#7aa0be', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.clOrdId || '—'}
                  </span>

                  {/* Symbol */}
                  <span style={{ color: '#a0c4e0', fontWeight: 600, fontSize: 10 }}>
                    {entry.symbol || ''}
                  </span>

                  {/* Side */}
                  <span style={{
                    color: SIDE_COLORS[entry.side] ?? '#5a7a9e',
                    fontWeight: 600, fontSize: 10,
                  }}>
                    {entry.side || ''}
                  </span>

                  {/* Qty */}
                  <span style={{ color: '#8faabe', fontSize: 10, textAlign: 'right', paddingRight: 4 }}>
                    {entry.qty || ''}
                  </span>

                  {/* Price */}
                  <span style={{ color: '#c8d6e5', fontSize: 10, textAlign: 'right', paddingRight: 4 }}>
                    {entry.price ? parseFloat(entry.price).toFixed(2) : ''}
                  </span>

                  {/* OrdStatus */}
                  <span style={{
                    color: STATUS_COLORS[entry.ordStatusLabel] ?? '#5a7a9e',
                    fontSize: 10, fontWeight: entry.ordStatusLabel ? 600 : 400,
                  }}>
                    {entry.ordStatusLabel || ''}
                  </span>

                  {/* Expand indicator */}
                  <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    {isExpanded ? <ChevronDown size={10} color="#4a6a8e" /> : <ChevronRight size={10} color="#2a3a5e" />}
                  </span>
                </div>

                {/* Expanded raw FIX message */}
                {isExpanded && (
                  <div style={{
                    padding: '6px 10px 6px 32px',
                    background: '#060a12', borderBottom: '1px solid #1a2744',
                    fontSize: 10, lineHeight: 1.5,
                  }}>
                    {entry.error && (
                      <div style={{
                        padding: '3px 8px', marginBottom: 4, borderRadius: 3,
                        background: '#7f1d1d20', border: '1px solid #7f1d1d',
                        color: '#fca5a5', fontSize: 10, display: 'flex', alignItems: 'center', gap: 4,
                      }}>
                        <AlertTriangle size={10} /> {entry.error}
                      </div>
                    )}
                    <div style={{
                      padding: '4px 8px', borderRadius: 3, background: '#0a1020',
                      border: '1px solid #1a2744', color: '#6a8aae',
                      wordBreak: 'break-all', whiteSpace: 'pre-wrap',
                      fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
                    }}>
                      {escapeForDisplay(entry.raw)}
                    </div>
                    {entry.orderId && (
                      <div style={{ marginTop: 3, color: '#3a5a7e', fontSize: 9 }}>
                        OrderID: <span style={{ color: '#7aa0be' }}>{entry.orderId}</span>
                        {entry.execType && <> · ExecType: <span style={{ color: '#7aa0be' }}>{entry.execType}</span></>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
        <div ref={tableEndRef} />
      </div>

      {/* ---- STATS FOOTER ---- */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '4px 10px',
        background: 'linear-gradient(180deg, #0a1020 0%, #080c14 100%)',
        borderTop: '1px solid #1a2744', flexShrink: 0, minHeight: 24,
        fontSize: 9, color: '#3a5a7e',
      }}>
        <span>
          Sent: <span style={{ color: '#7dd3fc' }}>{status?.sentCount ?? 0}</span>
        </span>
        <span>
          Recv: <span style={{ color: '#6ee7b7' }}>{status?.recvCount ?? 0}</span>
        </span>
        <span style={{ color: (status?.errorCount ?? 0) > 0 ? '#ef4444' : '#3a5a7e' }}>
          Errors: <span style={{ fontWeight: (status?.errorCount ?? 0) > 0 ? 700 : 400 }}>{status?.errorCount ?? 0}</span>
        </span>

        <div style={{ width: 1, height: 12, background: '#1a2744' }} />

        <span>
          Journal: <span style={{ color: '#5a7a9e' }}>{filtered.length}</span>
          {hasActiveFilters && <span style={{ color: '#3a5a7e' }}> / {entries.length}</span>}
        </span>

        <div style={{ flex: 1 }} />

        {status?.dryRun && (
          <span style={{
            padding: '1px 5px', borderRadius: 2, fontSize: 8,
            background: '#f59e0b18', color: '#f59e0b', fontWeight: 600,
            border: '1px solid #f59e0b40',
          }}>
            DRY RUN
          </span>
        )}

        <span style={{ color: '#2a4a6e' }}>
          {status?.targetHost ?? ''}
        </span>

        {/* Auto-scroll indicator */}
        <span style={{ color: autoScroll ? '#10b981' : '#3a5a7e', fontSize: 8, cursor: 'pointer' }}
          onClick={() => { setAutoScroll(true); tableEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }}>
          {autoScroll ? '● LIVE' : '○ SCROLL'}
        </span>
      </div>
    </div>
  )
}
