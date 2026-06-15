/**
 * MultiScreenLauncher — header button that opens terminal panels on additional
 * monitors.
 *
 * Technology stack:
 * - window.open() with left/top/width/height features → positions windows
 * - Multi-Screen Window Placement API (getScreenDetails) → Chrome 100+ for
 *   precise multi-monitor positioning. Falls back to screen.width math for
 *   browsers without the API.
 * - BroadcastChannel (useBroadcastSync) keeps asset/market selection in sync
 *   across all open windows automatically.
 *
 * Presets:
 *   3-Screen Trader   → chart|center + trading on screen 2, flow|markets on screen 3
 *   2-Screen Setup    → Multi-Chart on second screen
 *   Trading Desk      → Order Book + AGR on second screen
 *   Custom            → choose any single panel to pop out
 */
import { useState, useRef, useEffect } from 'react'

interface ScreenInfo {
  availLeft: number
  availTop: number
  availWidth: number
  availHeight: number
  label?: string
}

async function getScreens(): Promise<ScreenInfo[]> {
  // Try Multi-Screen Window Placement API (Chrome 100+ behind window-management permission)
  if ('getScreenDetails' in window) {
    try {
      const details = await (window as any).getScreenDetails()
      return (details.screens as any[]).map((s: any, i: number) => ({
        availLeft:   s.availLeft,
        availTop:    s.availTop,
        availWidth:  s.availWidth,
        availHeight: s.availHeight,
        label:       s.label || `Screen ${i + 1}`,
      }))
    } catch {
      // permission denied or API not stable — fall through
    }
  }

  // Fallback: assume screens are arranged left-to-right, each same size as primary
  const sw = window.screen.width
  const sh = window.screen.height
  return [
    { availLeft: 0,      availTop: 0, availWidth: sw, availHeight: sh, label: 'Screen 1 (this)' },
    { availLeft: sw,     availTop: 0, availWidth: sw, availHeight: sh, label: 'Screen 2' },
    { availLeft: sw * 2, availTop: 0, availWidth: sw, availHeight: sh, label: 'Screen 3' },
  ]
}

function openPanel(panel: string, screen: ScreenInfo, windowName?: string) {
  const base = window.location.href.split('?')[0]
  const url = `${base}?panel=${panel}`
  const features = [
    `left=${screen.availLeft}`,
    `top=${screen.availTop}`,
    `width=${screen.availWidth}`,
    `height=${screen.availHeight}`,
    'menubar=no',
    'toolbar=no',
    'location=no',
    'status=no',
    'scrollbars=no',
    'resizable=yes',
  ].join(',')
  const name = windowName ?? `qst_${panel}_${Date.now()}`
  window.open(url, name, features)
}

interface Preset {
  name: string
  description: string
  icon: string
  screens: number
  launch: (screens: ScreenInfo[]) => void
}

const PRESETS: Preset[] = [
  {
    name: '3-Screen Trader',
    description: 'Screen 1: Terminal  ·  Screen 2: Multi-Chart  ·  Screen 3: Trading Desk',
    icon: '⊟⊟⊟',
    screens: 3,
    launch: (screens) => {
      const s1 = screens[1] ?? screens[0]
      const s2 = screens[2] ?? screens[0]
      openPanel('center',  s1, 'qst_center')
      openPanel('right',   s2, 'qst_right')
    },
  },
  {
    name: '2-Screen Setup',
    description: 'Screen 1: Terminal  ·  Screen 2: Multi-Chart (4 timeframes)',
    icon: '⊟⊟',
    screens: 2,
    launch: (screens) => {
      const s1 = screens[1] ?? screens[0]
      openPanel('multichart', s1, 'qst_multichart')
    },
  },
  {
    name: 'Trading Desk',
    description: 'Screen 1: Terminal  ·  Screen 2: Order Book + Execution + AGR',
    icon: '⊟ ▤',
    screens: 2,
    launch: (screens) => {
      const s1 = screens[1] ?? screens[0]
      openPanel('trading', s1, 'qst_trading')
    },
  },
  {
    name: 'Markets Monitor',
    description: 'Screen 1: Terminal  ·  Screen 2: All Markets + Probability Chart',
    icon: '⊟ ◫',
    screens: 2,
    launch: (screens) => {
      const s1 = screens[1] ?? screens[0]
      openPanel('markets', s1, 'qst_markets')
    },
  },
]

const SINGLE_PANELS = [
  { id: 'multichart', label: 'Multi-Chart'      },
  { id: 'chart',      label: 'OHLCV Chart'      },
  { id: 'trading',    label: 'Trading Desk'      },
  { id: 'tape',       label: 'Tape / T&S'        },
  { id: 'flow',       label: 'AGR Flow'          },
  { id: 'markets',    label: 'Markets + Prob'    },
  { id: 'probchart',  label: 'Prob Chart'        },
]

export function MultiScreenLauncher() {
  const [open, setOpen] = useState(false)
  const [screens, setScreens] = useState<ScreenInfo[]>([])
  const [hasApi, setHasApi] = useState(false)
  const [dropdownPos, setDropdownPos] = useState({ top: 0, right: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)

  // Close when clicking outside
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      // close if the click isn't on the button or dropdown
      const dropEl = document.getElementById('qst-screens-dropdown')
      if (
        btnRef.current && !btnRef.current.contains(target) &&
        dropEl && !dropEl.contains(target)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  function handleOpen() {
    if (open) { setOpen(false); return }
    // Position dropdown below the button — synchronous, no blocking
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setDropdownPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
    }
    setHasApi('getScreenDetails' in window)
    setOpen(true)
    // Detect screens in background after the dropdown is visible
    getScreens().then(setScreens).catch(() => {})
  }

  function launchPreset(preset: Preset) {
    const s = screens.length >= 2 ? screens : [
      { availLeft: 0,                    availTop: 0, availWidth: window.screen.width, availHeight: window.screen.height },
      { availLeft: window.screen.width,  availTop: 0, availWidth: window.screen.width, availHeight: window.screen.height },
      { availLeft: window.screen.width * 2, availTop: 0, availWidth: window.screen.width, availHeight: window.screen.height },
    ]
    preset.launch(s)
    setOpen(false)
  }

  function launchSingle(panel: string) {
    const s = screens.length >= 2 ? screens[1] : {
      availLeft:   window.screen.width,
      availTop:    0,
      availWidth:  window.screen.width,
      availHeight: window.screen.height,
    }
    openPanel(panel, s as ScreenInfo)
    setOpen(false)
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleOpen}
        className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-tighter transition-all border
          ${open
            ? 'bg-accent/20 text-accent border-accent/40'
            : 'bg-surface-hover text-muted border-surface-border hover:text-slate-300 hover:border-accent/30'
          }`}
        title="Open panels on additional monitors"
      >
        ⊞ Screens
      </button>

      {open && (
        <div
          id="qst-screens-dropdown"
          style={{ position: 'fixed', top: dropdownPos.top, right: dropdownPos.right, zIndex: 9999 }}
          className="w-[380px] bg-surface-panel border border-surface-border rounded-lg shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="px-3 py-2 border-b border-surface-border bg-surface flex items-center justify-between">
            <div>
              <span className="text-xs font-bold text-accent">Multi-Screen Mode</span>
              <p className="text-[10px] text-muted mt-0.5">
                {hasApi
                  ? `${screens.length} screen${screens.length !== 1 ? 's' : ''} detected via Multi-Screen API`
                  : 'Using fallback screen positioning (Chrome 100+ for precise placement)'
                }
              </p>
            </div>
            <button onClick={() => setOpen(false)} className="text-muted hover:text-slate-300 text-xs ml-2">✕</button>
          </div>

          {/* Detected screens */}
          {screens.length > 0 && (
            <div className="px-3 py-2 border-b border-surface-border">
              <p className="text-[9px] font-bold text-muted uppercase tracking-widest mb-1.5">Detected Displays</p>
              <div className="flex gap-1.5 flex-wrap">
                {screens.map((s, i) => (
                  <div key={i} className={`px-2 py-0.5 rounded text-[9px] font-mono border
                    ${i === 0 ? 'border-accent/40 text-accent bg-accent/10' : 'border-surface-border text-muted'}`}
                  >
                    {s.label ?? `Screen ${i + 1}`} {s.availWidth}×{s.availHeight}
                    {i === 0 && <span className="ml-1 opacity-60">(this)</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Layout presets */}
          <div className="px-3 py-2 border-b border-surface-border">
            <p className="text-[9px] font-bold text-muted uppercase tracking-widest mb-1.5">Layout Presets</p>
            <div className="flex flex-col gap-1">
              {PRESETS.map(preset => (
                <button
                  key={preset.name}
                  onClick={() => launchPreset(preset)}
                  className="w-full text-left px-2.5 py-2 rounded border border-surface-border bg-surface hover:bg-surface-hover hover:border-accent/30 transition-all group"
                >
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-xs font-semibold text-slate-200 group-hover:text-accent transition-colors">
                      {preset.name}
                    </span>
                    <span className="text-[9px] text-muted font-mono border border-surface-border rounded px-1">
                      {preset.screens} screens
                    </span>
                  </div>
                  <p className="text-[9px] text-muted leading-relaxed">{preset.description}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Single panel pop-out */}
          <div className="px-3 py-2">
            <p className="text-[9px] font-bold text-muted uppercase tracking-widest mb-1.5">Pop Out Single Panel</p>
            <div className="grid grid-cols-2 gap-1">
              {SINGLE_PANELS.map(p => (
                <button
                  key={p.id}
                  onClick={() => launchSingle(p.id)}
                  className="text-left px-2 py-1.5 rounded border border-surface-border bg-surface hover:bg-surface-hover hover:border-accent/30 transition-all text-[10px] text-slate-300 font-semibold hover:text-accent"
                >
                  ↗ {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Footer note */}
          <div className="px-3 pb-2">
            <p className="text-[9px] text-muted/60 leading-relaxed">
              Each panel window connects independently and stays in sync via BroadcastChannel.
              For precise monitor placement, Chrome 100+ is required.
            </p>
          </div>
        </div>
      )}
    </>
  )
}
