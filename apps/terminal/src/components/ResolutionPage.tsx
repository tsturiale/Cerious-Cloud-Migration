/**
 * ResolutionPage — Polymarket resolution reference.
 * Content sourced from https://docs.polymarket.com/concepts/resolution
 */

const DOCS_URL = 'https://docs.polymarket.com/concepts/resolution'

const ACCENT   = 'text-cyan-400'
const MUTED    = 'text-slate-400'
const DIM      = 'text-slate-500'
const WARN_COL = 'text-amber-400'
const UP_COL   = 'text-emerald-400'
const DOWN_COL = 'text-red-400'

/* ── small primitives ─────────────────────────────────────────────────── */

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className={`text-xs font-bold uppercase tracking-widest ${ACCENT} mb-3 flex items-center gap-2`}>
      <span className="h-px flex-1 bg-cyan-900/60" />
      {children}
      <span className="h-px flex-1 bg-cyan-900/60" />
    </h2>
  )
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-[#0d1826] border border-[#1e3050] rounded-lg p-4 ${className}`}>
      {children}
    </div>
  )
}

function Badge({ children, color = 'cyan' }: { children: React.ReactNode; color?: 'cyan' | 'amber' | 'emerald' | 'red' | 'violet' }) {
  const cls: Record<string, string> = {
    cyan:    'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
    amber:   'bg-amber-500/15 text-amber-400 border-amber-500/30',
    emerald: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    red:     'bg-red-500/15 text-red-400 border-red-500/30',
    violet:  'bg-violet-500/15 text-violet-400 border-violet-500/30',
  }
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold border font-mono ${cls[color]}`}>
      {children}
    </span>
  )
}

function Pill({ label, value, col = '' }: { label: string; value: string; col?: string }) {
  return (
    <div className="flex items-center justify-between py-1 border-b border-[#1e3050]/60 last:border-0">
      <span className={`text-[11px] ${MUTED}`}>{label}</span>
      <span className={`text-[11px] font-mono font-semibold ${col || 'text-slate-200'}`}>{value}</span>
    </div>
  )
}

/* ── phase card ───────────────────────────────────────────────────────── */

interface Phase {
  num:   number
  title: string
  color: string
  ring:  string
  items: string[]
}

function PhaseCard({ phase }: { phase: Phase }) {
  return (
    <div className={`relative bg-[#0d1826] border ${phase.ring} rounded-lg p-4`}>
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold border ${phase.ring} ${phase.color}`}>
          {phase.num}
        </span>
        <span className={`text-[12px] font-bold ${phase.color}`}>{phase.title}</span>
      </div>
      <ul className="space-y-1">
        {phase.items.map((item, i) => (
          <li key={i} className={`text-[11px] ${MUTED} flex items-start gap-1.5`}>
            <span className={`mt-0.5 shrink-0 ${phase.color} opacity-60`}>›</span>
            <span dangerouslySetInnerHTML={{ __html: item }} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ── flow paths ───────────────────────────────────────────────────────── */

function FlowPath({ label, steps, time, color }: { label: string; steps: string[]; time: string; color: string }) {
  return (
    <div className="bg-[#0d1826] border border-[#1e3050] rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <span className={`text-[10px] font-bold uppercase tracking-wider ${color}`}>{label}</span>
        <Badge color={color === 'text-emerald-400' ? 'emerald' : color === 'text-amber-400' ? 'amber' : 'red'}>
          {time}
        </Badge>
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        {steps.map((step, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="text-[10px] font-mono bg-[#111f35] border border-[#1e3050] rounded px-1.5 py-0.5 text-slate-300">
              {step}
            </span>
            {i < steps.length - 1 && <span className="text-slate-600 text-[10px]">→</span>}
          </span>
        ))}
      </div>
    </div>
  )
}

/* ── main page ────────────────────────────────────────────────────────── */

export function ResolutionPage() {
  const phases: Phase[] = [
    {
      num:   1,
      title: 'Proposal',
      color: 'text-cyan-400',
      ring:  'border-cyan-500/30',
      items: [
        'Anyone can initiate resolution by selecting an outcome.',
        'Proposer posts a bond — <strong class="text-slate-200">typically $750 pUSD</strong>.',
        'Proposal is submitted to the UMA Optimistic Oracle.',
        'Successful uncontested proposers recover their bond <strong class="text-slate-200">plus a reward</strong>.',
      ],
    },
    {
      num:   2,
      title: 'Challenge Period',
      color: 'text-amber-400',
      ring:  'border-amber-500/30',
      items: [
        '<strong class="text-slate-200">2-hour window</strong> after proposal during which disputes can be filed.',
        'No dispute filed → market resolves immediately.',
        'Dispute filed → triggers a new proposal round or full escalation.',
      ],
    },
    {
      num:   3,
      title: 'Dispute Process',
      color: 'text-orange-400',
      ring:  'border-orange-500/30',
      items: [
        'Challenger posts a <strong class="text-slate-200">counter-bond matching the proposer (typically $750 pUSD)</strong>.',
        'If disputes persist beyond one round, a <strong class="text-slate-200">24–48 hour evidence period</strong> opens in UMA Discord.',
        'Both parties submit arguments and supporting evidence.',
      ],
    },
    {
      num:   4,
      title: 'UMA Token Holder Vote',
      color: 'text-violet-400',
      ring:  'border-violet-500/30',
      items: [
        '<strong class="text-slate-200">~48 hour voting period</strong> by UMA token holders determines the final outcome.',
        'Vote result: Proposer wins → bond back + ½ disputer\'s bond.',
        'Vote result: Disputer wins → bond back + ½ proposer\'s bond.',
        'Vote result: Too Early / Unknown → special outcome rules apply (see below).',
      ],
    },
  ]

  const contracts = [
    { version: 'v3.0 (current)', address: '0x157Ce2d672854c848c9b79C49a8Cc6cc89176a49', current: true },
    { version: 'v2.0',           address: '0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74', current: false },
    { version: 'v1.0',           address: '0xCB1822859cEF82Cd2Eb4E6276C7916e692995130', current: false },
  ]

  return (
    <div className="flex flex-col h-full bg-[#070d1a] overflow-hidden font-mono">

      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="shrink-0 px-6 py-3 border-b border-[#1e3050] bg-[#0d1826] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-cyan-400 tracking-wider uppercase">
            Polymarket Resolution
          </span>
          <span className={`text-[10px] ${DIM}`}>— Reference Guide</span>
        </div>
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 px-3 py-1 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-400 text-[10px] font-bold uppercase tracking-wider hover:bg-cyan-500/20 transition-colors"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
          Official Docs ↗
        </a>
      </div>

      {/* ── Body ───────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-7">

        {/* Overview + Quick Stats */}
        <div className="grid grid-cols-3 gap-4">

          <Card className="col-span-2">
            <h3 className="text-[11px] font-bold text-slate-200 mb-2 uppercase tracking-wider">What is Resolution?</h3>
            <p className={`text-[11px] ${MUTED} leading-relaxed`}>
              When an event's outcome becomes known, the market <strong className="text-slate-200">resolves</strong> to
              determine winners. Winning YES or NO tokens redeem for <strong className="text-emerald-400">$1 pUSD</strong> each
              via smart contract, while losing tokens become <strong className="text-red-400">worthless ($0)</strong>.
              Trading ceases immediately upon resolution.
            </p>
            <p className={`text-[11px] ${MUTED} leading-relaxed mt-2`}>
              Polymarket uses the <strong className="text-cyan-300">UMA Optimistic Oracle</strong> — a decentralised
              dispute system where anyone can propose outcomes and anyone can challenge proposals they believe are incorrect.
            </p>
            <div className={`mt-3 px-3 py-2 rounded border border-amber-500/25 bg-amber-500/5 text-[10px] ${WARN_COL} leading-relaxed`}>
              ⚠ <strong>The market rules define how it resolves</strong> — not the title. Always read the
              full resolution criteria before trading, especially edge-case provisions.
            </div>
          </Card>

          <Card>
            <h3 className="text-[11px] font-bold text-slate-200 mb-3 uppercase tracking-wider">Key Numbers</h3>
            <Pill label="Proposal bond"       value="~$750 pUSD" />
            <Pill label="Counter-bond"        value="~$750 pUSD" />
            <Pill label="Challenge window"    value="2 hours" />
            <Pill label="Evidence period"     value="24–48 hours" />
            <Pill label="UMA vote duration"   value="~48 hours" />
            <Pill label="Undisputed total"    value="~2 hours"    col={UP_COL} />
            <Pill label="Disputed total"      value="4–6 days"   col={DOWN_COL} />
          </Card>
        </div>

        {/* Pre-defined rules */}
        <div>
          <SectionTitle>Pre-Defined Resolution Rules</SectionTitle>
          <div className="grid grid-cols-3 gap-3">
            {[
              {
                title: 'Resolution Source',
                icon:  '📡',
                body:  'Each market specifies the authoritative information source. Resolution is determined by that source alone — regardless of other data.',
              },
              {
                title: 'End Date',
                icon:  '📅',
                body:  'The date and time when the market becomes eligible for resolution proposals. Markets can only be proposed after this time.',
              },
              {
                title: 'Edge Cases',
                icon:  '📐',
                body:  'Explicit guidance on handling ambiguous situations, like event cancellation, postponement, or conflicting sources.',
              },
            ].map(item => (
              <Card key={item.title}>
                <div className="text-lg mb-1">{item.icon}</div>
                <h4 className="text-[11px] font-bold text-slate-200 mb-1">{item.title}</h4>
                <p className={`text-[10px] ${MUTED} leading-relaxed`}>{item.body}</p>
              </Card>
            ))}
          </div>
          <div className={`mt-3 px-3 py-2 rounded border border-[#1e3050] bg-[#0d1826] text-[10px] ${MUTED} leading-relaxed`}>
            <span className="text-slate-300 font-semibold">Additional Context:</span> When unforeseen circumstances
            require rule clarification, context can be added. Clarifications <em>cannot</em> change the fundamental
            intent of the question and are published on-chain via the bulletin board contract.
          </div>
        </div>

        {/* Resolution flows */}
        <div>
          <SectionTitle>Resolution Paths</SectionTitle>
          <div className="space-y-2">
            <FlowPath
              label="Path A — No dispute"
              steps={['Propose', 'Wait 2h', 'Resolve']}
              time="~2 hours"
              color="text-emerald-400"
            />
            <FlowPath
              label="Path B — One dispute, second proposal accepted"
              steps={['Propose', 'Challenge', 'Re-Propose', 'Resolve']}
              time="~4 hours"
              color="text-amber-400"
            />
            <FlowPath
              label="Path C — Two disputes, UMA vote required"
              steps={['Propose', 'Challenge', 'Re-Propose', 'Re-Challenge', 'Evidence 24–48h', 'UMA Vote 48h', 'Resolve']}
              time="4–6 days"
              color="text-red-400"
            />
          </div>
        </div>

        {/* 4 Phases */}
        <div>
          <SectionTitle>Four-Phase Process</SectionTitle>
          <div className="grid grid-cols-2 gap-3">
            {phases.map(p => <PhaseCard key={p.num} phase={p} />)}
          </div>
        </div>

        {/* Bond outcomes + Special outcomes side by side */}
        <div className="grid grid-cols-2 gap-4">

          <div>
            <SectionTitle>Bond Distribution</SectionTitle>
            <div className="space-y-2">
              {[
                { scenario: 'Proposer wins vote',     proposer: '+bond + ½ disputer bond', disputer: '–bond',                  col: UP_COL   },
                { scenario: 'Disputer wins vote',     proposer: '–bond',                   disputer: '+bond + ½ proposer bond', col: DOWN_COL },
                { scenario: 'Incorrect / Too Early',  proposer: '–full bond (lost)',       disputer: '—',                      col: WARN_COL },
              ].map(r => (
                <Card key={r.scenario} className="py-2 px-3">
                  <div className={`text-[10px] font-bold ${r.col} mb-1`}>{r.scenario}</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <span className={`text-[9px] uppercase tracking-wider ${DIM}`}>Proposer</span>
                      <div className="text-[10px] font-mono text-slate-300">{r.proposer}</div>
                    </div>
                    <div>
                      <span className={`text-[9px] uppercase tracking-wider ${DIM}`}>Disputer</span>
                      <div className="text-[10px] font-mono text-slate-300">{r.disputer}</div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>

          <div>
            <SectionTitle>Special Outcomes</SectionTitle>
            <div className="space-y-2">
              <Card>
                <div className={`text-[10px] font-bold ${WARN_COL} mb-1`}>Too Early</div>
                <p className={`text-[10px] ${MUTED} leading-relaxed`}>
                  Event hasn't concluded yet. Disputer receives their bond plus half the proposer's bond.
                  Market is <strong className="text-slate-200">not resolved</strong> — a new proposal round begins.
                </p>
              </Card>
              <Card>
                <div className={`text-[10px] font-bold text-violet-400 mb-1`}>Unknown / 50-50</div>
                <p className={`text-[10px] ${MUTED} leading-relaxed`}>
                  Neither YES nor NO is applicable (rare edge case). Market resolves
                  <strong className="text-slate-200"> 50/50 — each token redeems for $0.50 pUSD</strong>.
                </p>
              </Card>
              <Card>
                <div className={`text-[10px] font-bold ${UP_COL} mb-1`}>Post-Resolution State</div>
                <p className={`text-[10px] ${MUTED} leading-relaxed`}>
                  Trading ceases immediately. Winning tokens redeem for <strong className="text-emerald-400">$1.00 pUSD</strong> via
                  contract redemption function. Losing tokens have <strong className="text-red-400">zero value</strong>.
                </p>
              </Card>
            </div>
          </div>
        </div>

        {/* Contract addresses */}
        <div>
          <SectionTitle>UmaCtfAdapter Contracts — Polygon Mainnet</SectionTitle>
          <div className="space-y-1.5">
            {contracts.map(c => (
              <div
                key={c.version}
                className={`flex items-center justify-between px-4 py-2.5 rounded-lg border ${c.current ? 'border-cyan-500/40 bg-cyan-500/5' : 'border-[#1e3050] bg-[#0d1826]'}`}
              >
                <div className="flex items-center gap-3">
                  {c.current && <Badge color="cyan">CURRENT</Badge>}
                  <span className={`text-[11px] font-semibold ${c.current ? 'text-slate-200' : MUTED}`}>
                    {c.version}
                  </span>
                </div>
                <code className={`text-[10px] font-mono ${c.current ? 'text-cyan-300' : DIM}`}>
                  {c.address}
                </code>
              </div>
            ))}
          </div>
          <p className={`mt-2 text-[10px] ${DIM}`}>
            All three versions are deployed on Polygon Mainnet. New markets use v3.0. Tokens from older markets
            can still be redeemed via their respective contract versions.
          </p>
        </div>

        {/* Footer link */}
        <div className={`pb-4 text-center text-[10px] ${DIM}`}>
          Full documentation at{' '}
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-500 hover:text-cyan-400 underline underline-offset-2"
          >
            {DOCS_URL}
          </a>
        </div>

      </div>
    </div>
  )
}
