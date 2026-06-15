/**
 * JournalNotes — date-stamped daily trading notes.
 * Today's note: editable textarea, saves on blur + Save button.
 * Past 7 days: read-only cards, newest first.
 * Collapsed by default.
 */
import { useState, useEffect, useRef } from 'react'
import type { JournalNote } from '../types'

interface Props {
  notes: JournalNote[]
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)  // "YYYY-MM-DD"
}

async function saveNote(date: string, text: string) {
  await fetch('/api/journal-notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, text }),
  })
}

export function JournalNotes({ notes }: Props) {
  const [open, setOpen]   = useState(false)
  const [text, setText]   = useState('')
  const [saved, setSaved] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const today     = todayStr()
  const todayNote = notes.find(n => n.date === today)
  const pastNotes = notes.filter(n => n.date !== today).slice(0, 7)

  // Sync textarea with fetched today note
  useEffect(() => {
    if (todayNote) setText(todayNote.text)
  }, [todayNote?.text])

  const handleSave = async () => {
    await saveNote(today, text)
    setSaved(true)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => setSaved(false), 2000)
  }

  const handleBlur = () => {
    if (text !== (todayNote?.text ?? '')) handleSave()
  }

  return (
    <div className="border border-surface-border rounded bg-surface">
      {/* Header / toggle */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-surface-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-2xs font-bold text-muted uppercase tracking-widest">Journal Notes</span>
          {todayNote?.text && (
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" title="Today's note saved" />
          )}
        </div>
        <span className={`text-muted text-xs transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {open && (
        <div className="px-3 pb-3 flex flex-col gap-2 border-t border-surface-border">
          {/* Today */}
          <div className="flex items-center justify-between pt-2">
            <span className="text-2xs font-mono text-accent">{today} — Today</span>
            <button
              onClick={handleSave}
              className="px-2 py-0.5 rounded text-2xs font-bold border border-accent/40 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
            >
              {saved ? '✓ Saved' : 'Save'}
            </button>
          </div>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            onBlur={handleBlur}
            placeholder="Daily trade notes — discipline, setups, lessons learned…"
            rows={4}
            className="w-full bg-[#080d19] border border-surface-border rounded px-2 py-1.5 text-xs font-mono text-slate-300 resize-none focus:outline-none focus:border-accent/50 placeholder:text-muted"
          />

          {/* Past 7 days */}
          {pastNotes.length > 0 && (
            <div className="flex flex-col gap-1.5 mt-1">
              <span className="text-2xs text-muted font-mono uppercase tracking-widest">Previous Notes</span>
              {pastNotes.map(n => (
                <div key={n.date} className="flex flex-col gap-0.5 px-2 py-1.5 rounded border border-surface-border bg-surface-panel">
                  <span className="text-2xs font-mono text-muted">{n.date}</span>
                  <p className="text-xs font-mono text-slate-400 whitespace-pre-wrap">{n.text}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
