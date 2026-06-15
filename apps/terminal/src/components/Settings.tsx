/**
 * Settings — Platform preferences, theme, risk, display, alerts, and data config.
 *
 * All settings persist to localStorage.
 * Theme changes write `data-theme` to <html> — CSS vars in index.css respond instantly.
 * Trading mode is stored here and read by OrderPanel / PaperTrade via loadSettings().
 */

import { useState, useEffect, useRef } from 'react'

// ── Theme registry ─────────────────────────────────────────────────────────────

export const THEMES = {
  'dark-navy': {
    name:    'Crimson Console',
    desc:    'Dark console with red edges and cyan contrast (default)',
    swatches: ['#080a0e', '#431f25', '#3aedff', '#ff4757'],
  },
  'deep-purple': {
    name:    'Deep Purple',
    desc:    'Velvet purple glass with high-contrast lavender highlights',
    swatches: ['#0d0717', '#2a1740', '#c4b5fd', '#22d3ee'],
  },
  'dark-midnight': {
    name:    'Dark Midnight',
    desc:    'Near-black navy with cool steel accents',
    swatches: ['#05070c', '#1b2537', '#7dd3fc', '#94a3b8'],
  },
  'gunmetal': {
    name:    'Gunmetal',
    desc:    'Cold steel gray, high contrast',
    swatches: ['#0b0c0d', '#262a2d', '#5eead4', '#00d4a4'],
  },
  'abyss': {
    name:    'Abyss',
    desc:    'Pure black with violet accent',
    swatches: ['#050507', '#14151d', '#a78bfa', '#00d4a4'],
  },
  'terminal': {
    name:    'Terminal',
    desc:    'Classic green-on-black CRT',
    swatches: ['#030b04', '#0c2011', '#00e66e', '#00d4a4'],
  },
} as const

export type ThemeKey = keyof typeof THEMES

export function applyTheme(key: ThemeKey) {
  document.documentElement.dataset.theme = key === 'dark-navy' ? '' : key
}

// ── Settings shape & persistence ──────────────────────────────────────────────

export interface AppSettings {
  // Platform
  tradingMode:        'paper' | 'live'
  confirmBeforeTrade: boolean
  paperBankroll:      number      // USD

  // Theme
  theme: ThemeKey

  // Risk — General
  maxPositionSize:    number      // USD
  maxDailyLoss:       number      // USD
  killSwitchDd:       number      // % drawdown
  maxOpenPositions:   number      // legacy field kept for backward compat

  // Risk — Manual trading
  manualMaxOrders:    number      // max concurrent manual positions
  manualMaxYesDollar: number      // max total YES dollar exposure
  manualMaxNoDollar:  number      // max total NO dollar exposure
  manualDailyTrades:  number      // max manual trades per day
  manualDailyLoss:    number      // max manual daily loss USD

  // Risk — Algo systems
  algoMaxOrders:    number
  algoMaxYesDollar: number
  algoMaxNoDollar:  number
  algoDailyTrades:  number
  algoDailyLoss:    number

  // Order defaults
  defaultTradeSize:   number      // USD
  defaultSlippage:    number      // %

  // Display
  autoRotateInterval: number      // seconds
  showSignalOverlay:  boolean
  compactMode:        boolean
  probHistoryPts:     number

  // Alerts
  soundOnSignal:      boolean
  flashOnFill:        boolean
  signalFilter:       'all' | 'strong'

  // Data
  maxTapeHistory:     number
  autoBackfill:       boolean
  clobAutoReconnect:  boolean
  clobStaleThreshold: number      // seconds
  clobReconnectCd:    number      // seconds
}

export const SETTING_DEFAULTS: AppSettings = {
  tradingMode:        'paper',
  confirmBeforeTrade: true,
  paperBankroll:      1000,
  theme:              'dark-navy',
  maxPositionSize:    500,
  maxDailyLoss:       100,
  killSwitchDd:       5,
  maxOpenPositions:   7,

  manualMaxOrders:    7,
  manualMaxYesDollar: 500,
  manualMaxNoDollar:  500,
  manualDailyTrades:  20,
  manualDailyLoss:    100,

  algoMaxOrders:    3,
  algoMaxYesDollar: 300,
  algoMaxNoDollar:  300,
  algoDailyTrades:  10,
  algoDailyLoss:    50,
  defaultTradeSize:   10,
  defaultSlippage:    0.5,
  autoRotateInterval: 15,
  showSignalOverlay:  true,
  compactMode:        false,
  probHistoryPts:     500,
  soundOnSignal:      false,
  flashOnFill:        true,
  signalFilter:       'all',
  maxTapeHistory:     2000,
  autoBackfill:       true,
  clobAutoReconnect:  true,
  clobStaleThreshold: 20,
  clobReconnectCd:    45,
}

const LS_KEY = 'pt_settings_v1'

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return { ...SETTING_DEFAULTS, ...JSON.parse(raw) }
  } catch {}
  return { ...SETTING_DEFAULTS }
}

function saveSettings(s: AppSettings) {
  localStorage.setItem(LS_KEY, JSON.stringify(s))
}

// ── Nav sections ──────────────────────────────────────────────────────────────

type Section = 'platform' | 'theme' | 'risk' | 'trading' | 'display' | 'alerts' | 'data' | 'connections'

const NAV: { id: Section; icon: string; label: string }[] = [
  { id: 'platform',    icon: '⚡', label: 'Platform'    },
  { id: 'theme',       icon: '◈',  label: 'Theme'       },
  { id: 'risk',        icon: '⬡',  label: 'Risk'        },
  { id: 'trading',     icon: '◫',  label: 'Trading'     },
  { id: 'display',     icon: '⊞',  label: 'Display'     },
  { id: 'alerts',      icon: '◉',  label: 'Alerts'      },
  { id: 'data',        icon: '⊕',  label: 'Data'        },
  { id: 'connections', icon: '⇌',  label: 'Connections' },
]

// ── Reusable atoms ────────────────────────────────────────────────────────────

function Toggle({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => !disabled && onChange(!value)}
      disabled={disabled}
      className={`relative inline-flex items-center h-5 w-9 rounded-full transition-colors shrink-0 ${
        value ? 'bg-accent/70' : 'bg-surface-border'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span className={`absolute w-3.5 h-3.5 rounded-full bg-white shadow-md transition-transform ${
        value ? 'translate-x-[18px]' : 'translate-x-1'
      }`} />
    </button>
  )
}

function Row({
  label, desc, children, danger,
}: {
  label: string; desc?: string; children: React.ReactNode; danger?: boolean
}) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-surface-border/30 gap-6 group">
      <div className="min-w-0 flex-1">
        <div className={`text-xs font-medium ${danger ? 'text-down' : 'text-slate-300'}`}>{label}</div>
        {desc && <div className="text-2xs text-muted/60 mt-0.5 leading-relaxed">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function NumInput({
  value, onChange, min, max, step, unit, width = 'w-20',
}: {
  value: number; onChange: (v: number) => void
  min?: number; max?: number; step?: number; unit?: string; width?: string
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={e => onChange(Number(e.target.value))}
        className={`${width} bg-surface border border-surface-border/70 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-accent/60 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none text-right`}
      />
      {unit && <span className="text-2xs text-muted">{unit}</span>}
    </div>
  )
}

function Segmented<T extends string>({
  options, value, onChange,
}: {
  options: { id: T; label: string; color?: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex rounded overflow-hidden border border-surface-border/60">
      {options.map((o, i) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`px-3 py-1 text-xs font-semibold transition-colors ${
            i > 0 ? 'border-l border-surface-border/60' : ''
          } ${
            value === o.id
              ? o.color
                ? `${o.color} text-white`
                : 'bg-accent/20 text-accent'
              : 'bg-surface-panel text-muted hover:text-slate-300 hover:bg-surface-hover'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function SectionHeader({ icon, title, desc }: { icon: string; title: string; desc?: string }) {
  return (
    <div className="mb-6 pb-4 border-b border-surface-border/40">
      <div className="flex items-center gap-2.5 mb-1">
        <span className="text-accent text-sm font-mono">{icon}</span>
        <h2 className="text-xs font-bold text-slate-200 uppercase tracking-widest">{title}</h2>
      </div>
      {desc && <p className="text-xs text-muted/60 pl-7">{desc}</p>}
    </div>
  )
}

// ── Section panels ────────────────────────────────────────────────────────────

function PlatformSection({ s, set }: { s: AppSettings; set: (p: Partial<AppSettings>) => void }) {
  const isLive = s.tradingMode === 'live'
  return (
    <div>
      <SectionHeader icon="⚡" title="Platform" desc="Core trading mode and session configuration" />

      {/* Big mode switcher */}
      <div className="mb-6">
        <div className="text-2xs text-muted uppercase tracking-wider mb-3">Trading Mode</div>
        <div className="grid grid-cols-2 gap-3">
          {/* Paper card */}
          <button
            onClick={() => set({ tradingMode: 'paper' })}
            className={`flex flex-col items-start gap-2 p-4 rounded-lg border transition-all text-left ${
              !isLive
                ? 'border-accent/50 bg-accent/10 ring-1 ring-accent/30'
                : 'border-surface-border/60 bg-surface-card hover:bg-surface-hover hover:border-surface-border'
            }`}
          >
            <div className="flex items-center justify-between w-full">
              <span className="text-sm font-bold text-slate-200">Paper Trade</span>
              <span className={`w-3 h-3 rounded-full border-2 ${!isLive ? 'bg-accent border-accent' : 'border-surface-border bg-transparent'}`} />
            </div>
            <span className="text-2xs text-muted/70 leading-relaxed">
              Simulate trades risk-free. Uses paper bankroll, no real money at risk. Full backtest and signal automation enabled.
            </span>
            <span className="text-2xs font-mono bg-surface-border/40 text-slate-400 px-2 py-0.5 rounded">RECOMMENDED</span>
          </button>

          {/* Live card */}
          <button
            onClick={() => set({ tradingMode: 'live' })}
            className={`flex flex-col items-start gap-2 p-4 rounded-lg border transition-all text-left ${
              isLive
                ? 'border-down/50 bg-down/10 ring-1 ring-down/30'
                : 'border-surface-border/60 bg-surface-card hover:bg-surface-hover hover:border-surface-border'
            }`}
          >
            <div className="flex items-center justify-between w-full">
              <span className={`text-sm font-bold ${isLive ? 'text-down' : 'text-slate-200'}`}>Live Trading</span>
              <span className={`w-3 h-3 rounded-full border-2 ${isLive ? 'bg-down border-down' : 'border-surface-border bg-transparent'}`} />
            </div>
            <span className="text-2xs text-muted/70 leading-relaxed">
              Real order execution on Polymarket CLOB. Requires API keys. Real money at risk.
            </span>
            <span className="text-2xs font-mono bg-down/10 text-down px-2 py-0.5 rounded border border-down/20">⚠ REAL FUNDS</span>
          </button>
        </div>

        {isLive && (
          <div className="mt-3 px-3 py-2.5 rounded bg-down/10 border border-down/30 text-2xs text-down/90 leading-relaxed">
            Live mode is active. All orders placed via the Order panel will be submitted to the Polymarket CLOB. Ensure your API keys are configured and risk limits are set correctly.
          </div>
        )}
      </div>

      <Row label="Confirm before each trade" desc="Show a confirmation dialog before submitting any order">
        <Toggle value={s.confirmBeforeTrade} onChange={v => set({ confirmBeforeTrade: v })} />
      </Row>
      <Row label="Paper bankroll" desc="Starting balance for paper trading sessions">
        <NumInput value={s.paperBankroll} onChange={v => set({ paperBankroll: v })} min={100} step={100} unit="USD" width="w-24" />
      </Row>
    </div>
  )
}

function ThemeSection({ s, set }: { s: AppSettings; set: (p: Partial<AppSettings>) => void }) {
  return (
    <div>
      <SectionHeader icon="◈" title="Theme" desc="Visual style applied instantly — no reload required" />

      <div className="grid grid-cols-2 gap-3">
        {(Object.entries(THEMES) as [ThemeKey, typeof THEMES[ThemeKey]][]).map(([key, t]) => {
          const active = s.theme === key
          return (
            <button
              key={key}
              onClick={() => {
                set({ theme: key })
                applyTheme(key)
              }}
              className={`flex flex-col gap-3 p-4 rounded-lg border text-left transition-all ${
                active
                  ? 'border-accent/50 ring-1 ring-accent/30 bg-accent/5'
                  : 'border-surface-border/60 bg-surface-card hover:bg-surface-hover hover:border-surface-border'
              }`}
            >
              {/* Color swatches */}
              <div className="flex gap-1.5 items-center">
                {t.swatches.map((c, i) => (
                  <span
                    key={i}
                    className={`rounded ${i === 0 ? 'w-8 h-5' : 'w-4 h-5'}`}
                    style={{ backgroundColor: c, border: '1px solid rgba(255,255,255,0.06)' }}
                  />
                ))}
                {active && (
                  <span className="ml-auto text-accent text-xs">✓</span>
                )}
              </div>
              <div>
                <div className="text-xs font-bold text-slate-200">{t.name}</div>
                <div className="text-2xs text-muted/60 mt-0.5">{t.desc}</div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function RiskSubHeader({ label, color }: { label: string; color: string }) {
  return (
    <div className="flex items-center gap-2 pt-5 pb-2 border-b border-surface-border/40">
      <span className="text-[10px] font-black uppercase tracking-widest" style={{ color }}>{label}</span>
    </div>
  )
}

function RiskSection({ s, set }: { s: AppSettings; set: (p: Partial<AppSettings>) => void }) {
  return (
    <div>
      <SectionHeader icon="⬡" title="Risk Management" desc="Hard limits enforced before any order is submitted" />

      {/* ── General ─────────────────────────────────────────────── */}
      <RiskSubHeader label="General" color="var(--accent)" />
      <Row label="Max single position size" desc="Single trade size cap. Orders above this are rejected.">
        <NumInput value={s.maxPositionSize} onChange={v => set({ maxPositionSize: v })} min={1} step={10} unit="USD" />
      </Row>
      <Row
        label="Kill-switch drawdown"
        desc="If portfolio drawdown exceeds this %, all trading is suspended until manually reset."
        danger
      >
        <NumInput value={s.killSwitchDd} onChange={v => set({ killSwitchDd: v })} min={1} max={50} step={0.5} unit="%" />
      </Row>

      {/* ── Manual Trading ──────────────────────────────────────── */}
      <RiskSubHeader label="Manual Trading" color="#00d4a4" />
      <Row label="Max concurrent orders" desc="Maximum number of open manual positions at once.">
        <NumInput value={s.manualMaxOrders} onChange={v => set({ manualMaxOrders: v, maxOpenPositions: v })} min={1} max={50} />
      </Row>
      <Row label="Max YES exposure" desc="Maximum total dollar value of open YES (UP) positions.">
        <NumInput value={s.manualMaxYesDollar} onChange={v => set({ manualMaxYesDollar: v })} min={0} step={50} unit="USD" width="w-24" />
      </Row>
      <Row label="Max NO exposure" desc="Maximum total dollar value of open NO (DOWN) positions.">
        <NumInput value={s.manualMaxNoDollar} onChange={v => set({ manualMaxNoDollar: v })} min={0} step={50} unit="USD" width="w-24" />
      </Row>
      <Row label="Daily trade limit" desc="Maximum manual order submissions per calendar day.">
        <NumInput value={s.manualDailyTrades} onChange={v => set({ manualDailyTrades: v })} min={1} max={200} />
      </Row>
      <Row label="Daily loss limit" desc="Cumulative manual loss cap per day. Halts trading when hit." danger>
        <NumInput value={s.manualDailyLoss} onChange={v => set({ manualDailyLoss: v })} min={1} step={10} unit="USD" />
      </Row>

      {/* ── Algo Systems ────────────────────────────────────────── */}
      <RiskSubHeader label="Algo Systems" color="#f59e0b" />
      <Row label="Max concurrent orders" desc="Maximum algo positions open simultaneously.">
        <NumInput value={s.algoMaxOrders} onChange={v => set({ algoMaxOrders: v })} min={1} max={20} />
      </Row>
      <Row label="Max YES exposure" desc="Maximum total dollar value of algo YES positions.">
        <NumInput value={s.algoMaxYesDollar} onChange={v => set({ algoMaxYesDollar: v })} min={0} step={50} unit="USD" width="w-24" />
      </Row>
      <Row label="Max NO exposure" desc="Maximum total dollar value of algo NO positions.">
        <NumInput value={s.algoMaxNoDollar} onChange={v => set({ algoMaxNoDollar: v })} min={0} step={50} unit="USD" width="w-24" />
      </Row>
      <Row label="Daily trade limit" desc="Maximum algo order submissions per calendar day.">
        <NumInput value={s.algoDailyTrades} onChange={v => set({ algoDailyTrades: v })} min={1} max={100} />
      </Row>
      <Row label="Daily loss limit" desc="Cumulative algo loss cap per day. Halts all algo trading when hit." danger>
        <NumInput value={s.algoDailyLoss} onChange={v => set({ algoDailyLoss: v })} min={1} step={10} unit="USD" />
      </Row>
    </div>
  )
}

function TradingSection({ s, set }: { s: AppSettings; set: (p: Partial<AppSettings>) => void }) {
  return (
    <div>
      <SectionHeader icon="◫" title="Order Defaults" desc="Pre-filled values when placing orders" />

      <Row label="Default trade size" desc="Pre-filled USD amount in the order and paper trade panels.">
        <NumInput value={s.defaultTradeSize} onChange={v => set({ defaultTradeSize: v })} min={1} step={5} unit="USD" />
      </Row>
      <Row label="Default slippage tolerance" desc="Maximum acceptable price slip before order is cancelled.">
        <NumInput value={s.defaultSlippage} onChange={v => set({ defaultSlippage: v })} min={0} max={5} step={0.1} unit="%" />
      </Row>
      <Row label="Signal filter" desc="Show all signals or only high-confidence ones in the Signals panel.">
        <Segmented
          options={[
            { id: 'all',    label: 'All'    },
            { id: 'strong', label: 'Strong' },
          ]}
          value={s.signalFilter}
          onChange={v => set({ signalFilter: v })}
        />
      </Row>
    </div>
  )
}

function DisplaySection({ s, set }: { s: AppSettings; set: (p: Partial<AppSettings>) => void }) {
  return (
    <div>
      <SectionHeader icon="⊞" title="Display" desc="Chart behaviour and layout preferences" />

      <Row label="Auto-rotate interval" desc="Seconds between automatic asset switches when Rotate is ON.">
        <NumInput value={s.autoRotateInterval} onChange={v => set({ autoRotateInterval: v })} min={5} max={120} step={5} unit="s" />
      </Row>
      <Row label="Prob-chart history points" desc="How many probability data points are rendered in the bottom chart.">
        <NumInput value={s.probHistoryPts} onChange={v => set({ probHistoryPts: v })} min={50} max={4320} step={50} unit="pts" width="w-24" />
      </Row>
      <Row label="Signal overlay on chart" desc="Render signal arrows and regime zones directly on the OHLCV chart.">
        <Toggle value={s.showSignalOverlay} onChange={v => set({ showSignalOverlay: v })} />
      </Row>
      <Row label="Compact mode" desc="Reduce padding and font sizes for smaller screens or more data density.">
        <Toggle value={s.compactMode} onChange={v => set({ compactMode: v })} />
      </Row>
    </div>
  )
}

function AlertsSection({ s, set }: { s: AppSettings; set: (p: Partial<AppSettings>) => void }) {
  return (
    <div>
      <SectionHeader icon="◉" title="Alerts" desc="Notification preferences for signals and fills" />

      <Row label="Sound on new signal" desc="Play an audio ping when a new model signal fires.">
        <Toggle value={s.soundOnSignal} onChange={v => set({ soundOnSignal: v })} />
      </Row>
      <Row label="Flash on fill" desc="Flash the position row green/red when a paper or live order is filled.">
        <Toggle value={s.flashOnFill} onChange={v => set({ flashOnFill: v })} />
      </Row>
    </div>
  )
}

function DataSection({ s, set }: { s: AppSettings; set: (p: Partial<AppSettings>) => void }) {
  return (
    <div>
      <SectionHeader icon="⊕" title="Data" desc="History retention and feed configuration" />

      <Row label="Max tape history" desc="Maximum number of YES/NO trade ticks retained in the Time & Sales tape.">
        <NumInput value={s.maxTapeHistory} onChange={v => set({ maxTapeHistory: v })} min={100} max={10000} step={100} unit="ticks" width="w-24" />
      </Row>
      <Row label="Auto-backfill on connect" desc="Fetch historical probability data for all markets immediately on WebSocket connect.">
        <Toggle value={s.autoBackfill} onChange={v => set({ autoBackfill: v })} />
      </Row>
      <Row label="Auto-reconnect stale CLOB" desc="Automatically trigger CLOB reconnect when book feed is stale.">
        <Toggle value={s.clobAutoReconnect} onChange={v => set({ clobAutoReconnect: v })} />
      </Row>
      <Row label="Stale threshold" desc="Mark feed stale and allow auto-reconnect after this age.">
        <NumInput value={s.clobStaleThreshold} onChange={v => set({ clobStaleThreshold: v })} min={5} max={120} step={1} unit="sec" />
      </Row>
      <Row label="Reconnect cooldown" desc="Minimum seconds between automatic reconnect attempts.">
        <NumInput value={s.clobReconnectCd} onChange={v => set({ clobReconnectCd: v })} min={10} max={300} step={5} unit="sec" />
      </Row>

      <div className="mt-6 pt-4 border-t border-surface-border/30">
        <div className="text-2xs text-muted/50 font-mono uppercase tracking-wider mb-3">System Info</div>
        <div className="grid grid-cols-2 gap-y-2 text-2xs font-mono">
          <span className="text-muted">Version</span>
          <span className="text-slate-400">1.0.0-dev</span>
          <span className="text-muted">Storage</span>
          <span className="text-slate-400">localStorage</span>
          <span className="text-muted">Theme engine</span>
          <span className="text-slate-400">CSS var channels</span>
        </div>
      </div>

      {/* Danger zone */}
      <div className="mt-6 pt-4 border-t border-down/20">
        <div className="text-2xs text-down/60 font-mono uppercase tracking-wider mb-3">Danger Zone</div>
        <button
          onClick={() => {
            if (window.confirm('Reset all settings to defaults? This cannot be undone.')) {
              localStorage.removeItem(LS_KEY)
              window.location.reload()
            }
          }}
          className="px-3 py-1.5 rounded text-2xs font-semibold border border-down/30 text-down bg-down/5 hover:bg-down/15 transition-colors"
        >
          Reset all settings to defaults
        </button>
      </div>
    </div>
  )
}

// ── QuantConnect connection state (persisted separately) ──────────────────────

const QC_LS_KEY = 'pt_qc_creds_v1'

interface QCCredentials {
  userId:   string
  apiToken: string
}

interface QCStatus {
  state:    'disconnected' | 'connecting' | 'connected' | 'error'
  message:  string
  userId?:  string
  projects?: number
  nodes?:   { backtestNodes: number; liveNodes: number }
}

function loadQCCreds(): QCCredentials {
  try {
    const raw = localStorage.getItem(QC_LS_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return { userId: '', apiToken: '' }
}

function saveQCCreds(c: QCCredentials) {
  localStorage.setItem(QC_LS_KEY, JSON.stringify(c))
}

function clearQCCreds() {
  localStorage.removeItem(QC_LS_KEY)
}

// ── Connections section ───────────────────────────────────────────────────────

function ConnectionsSection() {
  const [creds, setCreds]       = useState<QCCredentials>(loadQCCreds)
  const [status, setStatus]     = useState<QCStatus>({ state: 'disconnected', message: 'Not connected' })
  const [showToken, setShowToken] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const [kalshiKey, setKalshiKey]     = useState(() => localStorage.getItem('kalshi_api_key') ?? '')
  const [ibkrKey, setIbkrKey]         = useState(() => localStorage.getItem('ibkr_api_key') ?? '')
  const [ibkrAccount, setIbkrAccount] = useState(() => localStorage.getItem('ibkr_account_id') ?? '')

  const saveKalshi = () => {
    localStorage.setItem('kalshi_api_key', kalshiKey)
  }
  const saveIbkr = () => {
    localStorage.setItem('ibkr_api_key', ibkrKey)
    localStorage.setItem('ibkr_account_id', ibkrAccount)
  }

  // If saved creds exist, restore connected state label (don't auto-test on mount)
  useEffect(() => {
    if (creds.userId && creds.apiToken) {
      setStatus({ state: 'disconnected', message: 'Credentials loaded — click Connect to verify' })
    }
  }, [])

  async function handleConnect() {
    if (!creds.userId.trim() || !creds.apiToken.trim()) {
      setStatus({ state: 'error', message: 'User ID and API Token are required' })
      return
    }
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setStatus({ state: 'connecting', message: 'Authenticating…' })

    try {
      // 1. Authenticate
      const authRes = await fetch('/api/qc/authenticate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ user_id: creds.userId, api_token: creds.apiToken }),
        signal:  abortRef.current.signal,
      })
      const auth = await authRes.json()

      if (!auth.success) {
        setStatus({ state: 'error', message: auth.errors?.[0] ?? 'Authentication failed' })
        return
      }

      setStatus({ state: 'connecting', message: 'Fetching projects…' })

      // 2. Projects
      const projRes = await fetch('/api/qc/projects', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ user_id: creds.userId, api_token: creds.apiToken }),
        signal:  abortRef.current.signal,
      })
      const proj = await projRes.json()

      // 3. Nodes
      const nodesRes = await fetch('/api/qc/nodes', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ user_id: creds.userId, api_token: creds.apiToken }),
        signal:  abortRef.current.signal,
      })
      const nodes = await nodesRes.json()

      const backtestNodes = nodes.nodes?.backtest?.length ?? 0
      const liveNodes     = nodes.nodes?.live?.length     ?? 0

      saveQCCreds(creds)
      setStatus({
        state:    'connected',
        message:  'Connected',
        userId:   String(auth.userId ?? creds.userId),
        projects: Array.isArray(proj.projects) ? proj.projects.length : 0,
        nodes:    { backtestNodes, liveNodes },
      })
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      setStatus({ state: 'error', message: e?.message ?? 'Network error' })
    }
  }

  function handleDisconnect() {
    abortRef.current?.abort()
    clearQCCreds()
    setCreds({ userId: '', apiToken: '' })
    setStatus({ state: 'disconnected', message: 'Disconnected' })
  }

  const isConnected   = status.state === 'connected'
  const isConnecting  = status.state === 'connecting'

  const statusColor = {
    disconnected: 'text-muted',
    connecting:   'text-warn',
    connected:    'text-up',
    error:        'text-down',
  }[status.state]

  const statusDot = {
    disconnected: 'bg-muted',
    connecting:   'bg-warn animate-pulse',
    connected:    'bg-up',
    error:        'bg-down',
  }[status.state]

  return (
    <div>
      <SectionHeader icon="⇌" title="Connections" desc="External platform integrations and API keys" />

      {/* ── QuantConnect card ─────────────────────────────────────────────── */}
      <div className={`rounded-lg border transition-all mb-4 ${
        isConnected
          ? 'border-up/30 bg-up/5'
          : status.state === 'error'
            ? 'border-down/30 bg-down/5'
            : 'border-surface-border/60 bg-surface-card'
      }`}>

        {/* Card header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-border/30">
          <div className="flex items-center gap-3">
            {/* QC logo placeholder */}
            <div className="w-7 h-7 rounded bg-surface-border/50 flex items-center justify-center text-xs font-bold text-slate-300 font-mono">
              QC
            </div>
            <div>
              <div className="text-xs font-bold text-slate-200">QuantConnect</div>
              <div className="text-2xs text-muted/60">Algorithmic trading platform</div>
            </div>
          </div>
          {/* Status badge */}
          <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-2xs font-mono font-semibold ${statusColor}`}>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot}`} />
            {status.state === 'connecting' ? 'CONNECTING…' : status.state.toUpperCase()}
          </div>
        </div>

        {/* Form / info body */}
        <div className="px-4 py-4 space-y-3">
          {/* Connected info panel */}
          {isConnected && (
            <div className="grid grid-cols-3 gap-3 p-3 rounded bg-surface/60 border border-surface-border/30 mb-2">
              <div className="text-center">
                <div className="text-base font-bold text-up font-mono">{status.userId}</div>
                <div className="text-2xs text-muted/60 mt-0.5">User ID</div>
              </div>
              <div className="text-center border-x border-surface-border/30">
                <div className="text-base font-bold text-slate-200 font-mono">{status.projects ?? '—'}</div>
                <div className="text-2xs text-muted/60 mt-0.5">Projects</div>
              </div>
              <div className="text-center">
                <div className="text-base font-bold text-slate-200 font-mono">
                  {status.nodes ? `${status.nodes.backtestNodes}B / ${status.nodes.liveNodes}L` : '—'}
                </div>
                <div className="text-2xs text-muted/60 mt-0.5">Nodes (B/L)</div>
              </div>
            </div>
          )}

          {/* Error message */}
          {status.state === 'error' && (
            <div className="text-2xs text-down/90 bg-down/10 border border-down/20 rounded px-3 py-2">
              {status.message}
            </div>
          )}

          {/* Credentials form — always shown unless connected */}
          {!isConnected && (
            <>
              <div>
                <label className="block text-2xs text-muted/70 mb-1 uppercase tracking-wider">User ID</label>
                <input
                  type="text"
                  value={creds.userId}
                  onChange={e => setCreds(p => ({ ...p, userId: e.target.value }))}
                  placeholder="e.g. 12345"
                  className="w-full bg-surface border border-surface-border/70 rounded px-3 py-2 text-xs font-mono text-slate-200 placeholder:text-muted/40 focus:outline-none focus:border-accent/60"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-2xs text-muted/70 uppercase tracking-wider">API Token</label>
                  <button
                    onClick={() => setShowToken(v => !v)}
                    className="text-2xs text-muted hover:text-slate-300 font-mono"
                  >
                    {showToken ? 'hide' : 'show'}
                  </button>
                </div>
                <input
                  type={showToken ? 'text' : 'password'}
                  value={creds.apiToken}
                  onChange={e => setCreds(p => ({ ...p, apiToken: e.target.value }))}
                  placeholder="Paste your API token"
                  className="w-full bg-surface border border-surface-border/70 rounded px-3 py-2 text-xs font-mono text-slate-200 placeholder:text-muted/40 focus:outline-none focus:border-accent/60"
                />
              </div>
              <div className="text-2xs text-muted/50 leading-relaxed">
                Find your credentials at{' '}
                <span className="text-accent/70 font-mono">quantconnect.com → Account → API Token</span>
                . Credentials are stored locally in your browser only.
              </div>
            </>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            {!isConnected ? (
              <button
                onClick={handleConnect}
                disabled={isConnecting}
                className="flex-1 py-2 rounded text-xs font-bold bg-accent/20 border border-accent/40 text-accent hover:bg-accent/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isConnecting ? 'Connecting…' : 'Connect'}
              </button>
            ) : (
              <>
                <button
                  onClick={handleConnect}
                  className="flex-1 py-2 rounded text-xs font-bold bg-surface-border/40 border border-surface-border/60 text-slate-300 hover:bg-surface-hover transition-colors"
                >
                  Re-test
                </button>
                <button
                  onClick={handleDisconnect}
                  className="flex-1 py-2 rounded text-xs font-bold bg-down/10 border border-down/30 text-down hover:bg-down/20 transition-colors"
                >
                  Disconnect
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Kalshi ──────────────────────────────────────────────── */}
      <div className="mt-6">
        <h3 className="text-xs font-semibold text-slate-300 mb-3 flex items-center gap-2">
          <span className="text-accent">◈</span> Kalshi
        </h3>
        <div className="space-y-3">
          <div>
            <label className="block text-2xs text-muted mb-1 uppercase tracking-wider">API Key</label>
            <div className="flex gap-2">
              <input
                type="password"
                value={kalshiKey}
                onChange={e => setKalshiKey(e.target.value)}
                placeholder="Kalshi API key..."
                className="flex-1 bg-surface border border-surface-border rounded px-2 py-1 text-xs font-mono text-slate-200 placeholder-muted focus:outline-none focus:border-accent/60"
              />
              <button
                onClick={saveKalshi}
                className="px-3 py-1 rounded text-xs font-semibold bg-accent/20 text-accent border border-accent/40 hover:bg-accent/30 transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── IBKR ForecastTrader ─────────────────────────────────── */}
      <div className="mt-6">
        <h3 className="text-xs font-semibold text-slate-300 mb-3 flex items-center gap-2">
          <span className="text-accent">◈</span> IBKR ForecastTrader
        </h3>
        <div className="space-y-3">
          <div>
            <label className="block text-2xs text-muted mb-1 uppercase tracking-wider">API Key</label>
            <input
              type="password"
              value={ibkrKey}
              onChange={e => setIbkrKey(e.target.value)}
              placeholder="IBKR API key..."
              className="w-full bg-surface border border-surface-border rounded px-2 py-1 text-xs font-mono text-slate-200 placeholder-muted focus:outline-none focus:border-accent/60"
            />
          </div>
          <div>
            <label className="block text-2xs text-muted mb-1 uppercase tracking-wider">Account ID</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={ibkrAccount}
                onChange={e => setIbkrAccount(e.target.value)}
                placeholder="U1234567"
                className="flex-1 bg-surface border border-surface-border rounded px-2 py-1 text-xs font-mono text-slate-200 placeholder-muted focus:outline-none focus:border-accent/60"
              />
              <button
                onClick={saveIbkr}
                className="px-3 py-1 rounded text-xs font-semibold bg-accent/20 text-accent border border-accent/40 hover:bg-accent/30 transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

export function Settings() {
  const [s, setS] = useState<AppSettings>(loadSettings)
  const [section, setSection] = useState<Section>('platform')
  const [saved, setSaved] = useState(false)

  // Auto-save on every change + sync risk limits to backend
  useEffect(() => {
    saveSettings(s)
    // Push risk limits to backend (silently ignore if server is not running)
    fetch('/api/settings/risk', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manual_max_concurrent:    s.manualMaxOrders,
        manual_max_yes_dollar:    s.manualMaxYesDollar,
        manual_max_no_dollar:     s.manualMaxNoDollar,
        manual_daily_trade_limit: s.manualDailyTrades,
        manual_daily_loss_limit:  s.manualDailyLoss,
        algo_max_concurrent:      s.algoMaxOrders,
        algo_max_yes_dollar:      s.algoMaxYesDollar,
        algo_max_no_dollar:       s.algoMaxNoDollar,
        algo_daily_trade_limit:   s.algoDailyTrades,
        algo_daily_loss_limit:    s.algoDailyLoss,
      }),
    }).catch(() => {})
    setSaved(true)
    const t = setTimeout(() => setSaved(false), 1200)
    return () => clearTimeout(t)
  }, [s])

  const set = (partial: Partial<AppSettings>) => setS(prev => ({ ...prev, ...partial }))

  const isLive = s.tradingMode === 'live'

  return (
    <div className="flex h-full min-h-0 bg-surface font-sans">

      {/* ── Left nav ─────────────────────────────────────────────────────────── */}
      <nav className="w-48 shrink-0 flex flex-col border-r border-surface-border bg-surface-panel">
        {/* Header */}
        <div className="px-4 pt-5 pb-4 border-b border-surface-border/60">
          <div className="text-2xs font-bold text-accent uppercase tracking-widest">Settings</div>
          <div className={`mt-1.5 text-2xs font-mono transition-opacity ${saved ? 'opacity-100' : 'opacity-0'}`}
               style={{ color: 'var(--up)' }}>
            ✓ Saved
          </div>
        </div>

        {/* Mode badge */}
        <div className="px-4 py-3 border-b border-surface-border/40">
          <div className="text-2xs text-muted/50 uppercase tracking-wider mb-1.5">Trading Mode</div>
          <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-2xs font-bold font-mono ${
            isLive
              ? 'bg-down/15 text-down border border-down/30'
              : 'bg-accent/10 text-accent border border-accent/25'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-down' : 'bg-accent'} ${isLive ? 'animate-pulse' : ''}`} />
            {isLive ? 'LIVE' : 'PAPER'}
          </div>
        </div>

        {/* Nav items */}
        <div className="flex-1 overflow-y-auto py-2">
          {NAV.map(n => (
            <button
              key={n.id}
              onClick={() => setSection(n.id)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                section === n.id
                  ? 'bg-accent/10 text-accent border-r-2 border-accent'
                  : 'text-muted hover:text-slate-300 hover:bg-surface-hover border-r-2 border-transparent'
              }`}
            >
              <span className="text-sm leading-none w-4 text-center shrink-0">{n.icon}</span>
              <span className="text-xs font-semibold">{n.label}</span>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-surface-border/40 text-2xs text-muted/40 font-mono">
          All changes auto-saved
        </div>
      </nav>

      {/* ── Content ──────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-8 py-8">
          {section === 'platform'    && <PlatformSection    s={s} set={set} />}
          {section === 'theme'       && <ThemeSection       s={s} set={set} />}
          {section === 'risk'        && <RiskSection        s={s} set={set} />}
          {section === 'trading'     && <TradingSection     s={s} set={set} />}
          {section === 'display'     && <DisplaySection     s={s} set={set} />}
          {section === 'alerts'      && <AlertsSection      s={s} set={set} />}
          {section === 'data'        && <DataSection        s={s} set={set} />}
          {section === 'connections' && <ConnectionsSection />}
        </div>
      </div>

    </div>
  )
}
