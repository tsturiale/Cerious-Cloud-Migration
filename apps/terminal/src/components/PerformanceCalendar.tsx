/**
 * PerformanceCalendar — monthly P&L calendar with day drill-down.
 * Each cell shows net P&L, trade count badge, win-rate mini-bar, tinted background.
 * Clicking a cell opens a right-panel with that day's trades and journal note.
 */
import { useState, useMemo } from 'react'
import type { Trade, DailyPerf, JournalNote } from '../types'

interface Props {
  daily:  DailyPerf[]
  trades: Trade[]
  notes:  JournalNote[]
}

const DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function usd(n: number) {
  return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2)
}

function buildCalendar(year: number, month: number): (Date | null)[] {
  const first = new Date(year, month, 1)
  const last  = new Date(year, month + 1, 0)
  const cells: (Date | null)[] = []
  for (let i = 0; i < first.getDay(); i++) cells.push(null)
  for (let d = 1; d <= last.getDate(); d++) cells.push(new Date(year, month, d))
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

export function PerformanceCalendar({ daily, trades, notes }: Props) {
  const now = new Date()
  const [year,  setYear]    = useState(now.getFullYear())
  const [month, setMonth]   = useState(now.getMonth())
  const [selected, setSelected] = useState<string | null>(null)

  const cells = useMemo(() => buildCalendar(year, month), [year, month])

  const perfByDate = useMemo(() => {
    const m: Record<string, DailyPerf> = {}
    for (const d of daily) m[d.date] = d
    return m
  }, [daily])

  const tradesByDate = useMemo(() => {
    const m: Record<string, Trade[]> = {}
    for (const t of trades) {
      const d = new Date(t.exit_time).toISOString().slice(0, 10)
      ;(m[d] ??= []).push(t)
    }
    return m
  }, [trades])

  const noteByDate = useMemo(() => {
    const m: Record<string, string> = {}
    for (const n of notes) m[n.date] = n.text
    return m
  }, [notes])

  // Month summary
  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`
  const monthDates  = Object.keys(perfByDate).filter(d => d.startsWith(monthPrefix))
  const monthPnl    = monthDates.reduce((s, d) => s + perfByDate[d].net_pnl, 0)
  const monthTrades = monthDates.reduce((s, d) => s + perfByDate[d].trade_count, 0)
  const monthWins   = monthDates.reduce((s, d) => s + perfByDate[d].win_count, 0)
  const monthWR     = monthTrades ? (monthWins / monthTrades * 100).toFixed(1) : '—'
  const bestDay     = monthDates.length ? Math.max(...monthDates.map(d => perfByDate[d].net_pnl)) : null
  const worstDay    = monthDates.length ? Math.min(...monthDates.map(d => perfByDate[d].net_pnl)) : null

  const prevMonth = () => {
    if (month === 0) { setYear(y => y - 1); setMonth(11) } else setMonth(m => m - 1)
  }
  const nextMonth = () => {
    if (month === 11) { setYear(y => y + 1); setMonth(0) } else setMonth(m => m + 1)
  }

  const todayStr = now.toISOString().slice(0, 10)

  function cellBg(pnl: number): string {
    const MAX     = 500
    const opacity = Math.min(Math.abs(pnl) / MAX, 1) * 0.35
    if (pnl > 0) return `rgba(0,212,164,${opacity})`
    if (pnl < 0) return `rgba(255,71,87,${opacity})`
    return 'transparent'
  }

  const selectedPerf   = selected ? perfByDate[selected]   : null
  const selectedTrades = selected ? (tradesByDate[selected] ?? []).slice().sort((a, b) => a.exit_time - b.exit_time) : []
  const selectedNote   = selected ? noteByDate[selected] ?? '' : ''

  return (
    <div className="flex h-full overflow-hidden">
      {/* Calendar main */}
      <div className="flex-1 flex flex-col gap-3 p-3 overflow-y-auto">
        {/* Month nav */}
        <div className="flex items-center justify-between">
          <button onClick={prevMonth} className="px-2 py-1 rounded text-xs text-muted hover:text-slate-300 hover:bg-surface-hover border border-surface-border">← Prev</button>
          <span className="text-sm font-bold text-slate-200">{MONTHS[month]} {year}</span>
          <button onClick={nextMonth} className="px-2 py-1 rounded text-xs text-muted hover:text-slate-300 hover:bg-surface-hover border border-surface-border">Next →</button>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 gap-1">
          {DAYS.map(d => (
            <div key={d} className="text-center text-2xs font-bold text-muted uppercase py-1">{d}</div>
          ))}
        </div>

        {/* Calendar cells */}
        <div className="grid grid-cols-7 gap-1">
          {cells.map((date, i) => {
            if (!date) return <div key={i} />
            const ds   = date.toISOString().slice(0, 10)
            const perf = perfByDate[ds]
            const isToday    = ds === todayStr
            const isSelected = ds === selected
            return (
              <button
                key={ds}
                onClick={() => setSelected(ds === selected ? null : ds)}
                className={`relative flex flex-col rounded border text-left p-1.5 transition-colors min-h-[68px] ${
                  isSelected ? 'border-accent' : isToday ? 'border-accent/50' : 'border-surface-border'
                } hover:border-accent/60`}
                style={{ backgroundColor: perf ? cellBg(perf.net_pnl) : undefined }}
              >
                {/* Day number */}
                <span className={`text-2xs font-mono font-bold ${isToday ? 'text-accent' : 'text-muted'}`}>{date.getDate()}</span>
                {/* Trade count badge */}
                {perf && (
                  <span className="absolute top-1 right-1 text-2xs font-bold bg-surface-panel rounded px-0.5">{perf.trade_count}</span>
                )}
                {/* P&L */}
                {perf && (
                  <span className={`text-2xs font-mono font-bold mt-auto ${perf.net_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {perf.net_pnl >= 0 ? '+' : ''}{perf.net_pnl.toFixed(0)}
                  </span>
                )}
                {/* Win-rate mini-bar */}
                {perf && perf.trade_count > 0 && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-surface-border rounded-b">
                    <div className="h-full bg-emerald-400 rounded-b" style={{ width: `${perf.win_rate}%` }} />
                  </div>
                )}
              </button>
            )
          })}
        </div>

        {/* Month summary */}
        <div className="grid grid-cols-5 gap-2 mt-1">
          {[
            { label: 'Month P&L', value: usd(monthPnl), color: monthPnl >= 0 ? 'text-emerald-400' : 'text-red-400' },
            { label: 'Best Day',  value: bestDay  !== null ? usd(bestDay)  : '—', color: 'text-emerald-400' },
            { label: 'Worst Day', value: worstDay !== null ? usd(worstDay) : '—', color: 'text-red-400' },
            { label: 'Trades',    value: String(monthTrades), color: 'text-slate-300' },
            { label: 'Win Rate',  value: monthWR !== '—' ? `${monthWR}%` : '—', color: 'text-amber-400' },
          ].map(({ label, value, color }) => (
            <div key={label} className="flex flex-col items-center gap-0.5 px-2 py-1.5 bg-surface rounded border border-surface-border">
              <span className="text-2xs text-muted font-mono uppercase tracking-wide">{label}</span>
              <span className={`text-xs font-mono font-bold ${color}`}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Day drill-down panel */}
      {selected && (
        <div className="w-80 border-l border-surface-border bg-surface-panel flex flex-col overflow-hidden shrink-0">
          {/* Panel header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-surface-border">
            <span className="text-xs font-bold text-slate-200">{selected}</span>
            <button onClick={() => setSelected(null)} className="text-muted hover:text-slate-300 text-xs">✕</button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
            {/* Day KPIs */}
            {selectedPerf ? (
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { label: 'P&L',    value: usd(selectedPerf.net_pnl),              color: selectedPerf.net_pnl >= 0 ? 'text-emerald-400' : 'text-red-400' },
                  { label: 'Trades', value: String(selectedPerf.trade_count),        color: 'text-slate-300' },
                  { label: 'WR',     value: `${selectedPerf.win_rate.toFixed(1)}%`,  color: 'text-amber-400' },
                ].map(({ label, value, color }) => (
                  <div key={label} className="flex flex-col items-center gap-0.5 py-1.5 bg-surface rounded border border-surface-border">
                    <span className="text-2xs text-muted font-mono">{label}</span>
                    <span className={`text-xs font-mono font-bold ${color}`}>{value}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-2xs text-muted font-mono">No trades on this day</p>
            )}

            {/* Day trades */}
            {selectedTrades.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <span className="text-2xs text-muted font-mono uppercase tracking-wide">Trades</span>
                <div className="border border-surface-border rounded overflow-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-surface-border">
                        {['Time', 'Asset', 'Dir', 'P&L'].map(h => (
                          <th key={h} className="px-1.5 py-1 text-left text-2xs font-bold text-muted">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {selectedTrades.map((t, i) => (
                        <tr key={i} className="border-b border-surface-border/30 hover:bg-surface-hover">
                          <td className="px-1.5 py-0.5 text-2xs font-mono text-muted">{new Date(t.exit_time).toLocaleTimeString()}</td>
                          <td className="px-1.5 py-0.5 text-2xs font-mono font-bold text-amber-400">{t.asset}</td>
                          <td className="px-1.5 py-0.5">
                            <span className={`text-2xs font-bold ${t.direction === 'UP' ? 'text-emerald-400' : 'text-red-400'}`}>{t.direction}</span>
                          </td>
                          <td className={`px-1.5 py-0.5 text-2xs font-mono font-bold ${t.net_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{usd(t.net_pnl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Day note */}
            <div className="flex flex-col gap-1">
              <span className="text-2xs text-muted font-mono uppercase tracking-wide">Note</span>
              {selected === todayStr ? (
                <p className="text-xs font-mono text-slate-400 italic">Edit today's note in the Dashboard → Journal Notes section.</p>
              ) : selectedNote ? (
                <p className="text-xs font-mono text-slate-400 whitespace-pre-wrap bg-[#080d19] p-2 rounded border border-surface-border">{selectedNote}</p>
              ) : (
                <p className="text-2xs text-muted font-mono italic">No note for this day</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
