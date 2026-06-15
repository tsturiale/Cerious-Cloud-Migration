/**
 * Performance — institutional trade performance dashboard.
 * Tab shell: fetches all data once every 10 s, distributes via props.
 * Tab "dashboard" → PerformanceDashboard + JournalNotes
 * Tab "calendar"  → PerformanceCalendar
 */
import { useState, useEffect } from 'react'
import type { Trade, DailyMetrics, JournalNote, DailyPerf } from '../types'
import { PerformanceDashboard } from './PerformanceDashboard'
import { PerformanceCalendar } from './PerformanceCalendar'

type PerfTab = 'dashboard' | 'calendar'

export function Performance() {
  const [tab, setTab]         = useState<PerfTab>('dashboard')
  const [trades, setTrades]   = useState<Trade[]>([])
  const [metrics, setMetrics] = useState<DailyMetrics | null>(null)
  const [daily, setDaily]     = useState<DailyPerf[]>([])
  const [notes, setNotes]     = useState<JournalNote[]>([])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const [tj, tm, td, tn] = await Promise.all([
          fetch('/api/journal?limit=500').then(r => r.json()),
          fetch('/api/metrics').then(r => r.json()),
          fetch('/api/daily-performance').then(r => r.json()),
          fetch('/api/journal-notes').then(r => r.json()),
        ])
        if (cancelled) return
        setTrades(tj.trades ?? [])
        setMetrics(tm)
        setDaily(td.daily ?? [])
        setNotes(tn.notes ?? [])
      } catch { /* silently ignore — stale data stays displayed */ }
    }
    load()
    const id = setInterval(load, 10_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const TAB_CLASSES = (t: PerfTab) =>
    `px-3 py-1 rounded text-xs font-semibold transition-colors ${
      tab === t
        ? 'bg-accent/20 text-accent border border-accent/40'
        : 'text-muted hover:text-slate-300 hover:bg-surface-hover'
    }`

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-surface-border bg-surface-panel shrink-0">
        <span className="text-xs font-bold text-accent tracking-widest uppercase mr-2">Performance</span>
        <button className={TAB_CLASSES('dashboard')} onClick={() => setTab('dashboard')}>Dashboard</button>
        <button className={TAB_CLASSES('calendar')}  onClick={() => setTab('calendar')}>Calendar</button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'dashboard' && (
          <PerformanceDashboard trades={trades} metrics={metrics} daily={daily} notes={notes} />
        )}
        {tab === 'calendar' && (
          <PerformanceCalendar daily={daily} trades={trades} notes={notes} />
        )}
      </div>
    </div>
  )
}
