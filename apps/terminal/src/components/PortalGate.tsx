import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import ceriousLogo from '../assets/branding/cerious-logo.png'

export type PortalSession = {
  username: string
  sessionToken: string
  expiresAt?: number
}

const CERIOUS_SESSION_KEY = 'cerious.portal.session.v1'

export function getStoredPortalSession(): PortalSession | null {
  try {
    const raw = window.localStorage.getItem(CERIOUS_SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PortalSession>
    if (!parsed.username || !parsed.sessionToken) return null
    return {
      username: String(parsed.username),
      sessionToken: String(parsed.sessionToken),
      expiresAt: Number(parsed.expiresAt || 0) || undefined,
    }
  } catch {
    return null
  }
}

function storePortalSession(session: PortalSession | null) {
  if (!session) {
    window.localStorage.removeItem(CERIOUS_SESSION_KEY)
    return
  }
  window.localStorage.setItem(CERIOUS_SESSION_KEY, JSON.stringify(session))
}

function setWorkspaceSessionToken(token: string | null) {
  if (token) window.localStorage.setItem('cerious.workspace.sessionToken.v1', token)
  else window.localStorage.removeItem('cerious.workspace.sessionToken.v1')
}

type LoginPortalProps = {
  onAuthenticated: (session: PortalSession) => void
  initialStatus?: string
}

function LoginPortal({ onAuthenticated, initialStatus = '' }: LoginPortalProps) {
  const [username, setUsername] = useState('tsturiale')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState(initialStatus)
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setStatus('Authenticating')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload.sessionToken) {
        throw new Error(String(payload.detail || 'Login failed'))
      }
      const session: PortalSession = {
        username: String(payload.username || username),
        sessionToken: String(payload.sessionToken),
        expiresAt: Number(payload.expiresAt || 0) || undefined,
      }
      storePortalSession(session)
      setWorkspaceSessionToken(session.sessionToken)
      onAuthenticated(session)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Login failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="min-h-screen bg-[#050911] text-slate-100">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_10%,rgba(47,128,237,0.22),transparent_34%),linear-gradient(180deg,#081529_0%,#050911_58%,#03060b_100%)]" />
      <section className="relative flex min-h-screen items-center justify-center px-6 py-10">
        <form
          onSubmit={submit}
          className="w-full max-w-[390px] border border-blue-500/45 bg-[#080d17]/95 p-7 shadow-[0_0_0_1px_rgba(147,197,253,0.1),0_24px_90px_rgba(0,0,0,0.55)]"
        >
          <div className="mb-6 flex items-center gap-4">
            <img src={ceriousLogo} alt="Cerious Systems" className="h-16 w-16 rounded border border-blue-400/30 object-cover" />
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.28em] text-blue-200">Cerious Systems</div>
              <h1 className="mt-1 text-xl font-semibold tracking-normal text-white">Terminal Portal</h1>
            </div>
          </div>

          <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.16em] text-slate-400" htmlFor="cerious-username">
            Username
          </label>
          <input
            id="cerious-username"
            autoComplete="username"
            value={username}
            onChange={event => setUsername(event.target.value)}
            className="mb-5 w-full border border-slate-600 bg-[#0d1422] px-3 py-3 font-mono text-sm text-white outline-none transition focus:border-blue-400"
          />

          <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.16em] text-slate-400" htmlFor="cerious-password">
            Password
          </label>
          <input
            id="cerious-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            className="mb-6 w-full border border-slate-600 bg-[#0d1422] px-3 py-3 font-mono text-sm text-white outline-none transition focus:border-blue-400"
          />

          <button
            type="submit"
            disabled={submitting}
            className="h-12 w-full border border-blue-300/40 bg-blue-600 px-4 font-mono text-sm font-bold uppercase tracking-[0.14em] text-white transition hover:bg-blue-500 disabled:cursor-wait disabled:opacity-60"
          >
            {submitting ? 'Launching' : 'Launch Workspace'}
          </button>

          <div className="mt-4 min-h-5 font-mono text-xs text-slate-400">{status}</div>
        </form>
      </section>
    </main>
  )
}

export function PortalGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<PortalSession | null>(() => getStoredPortalSession())
  const [checking, setChecking] = useState(() => Boolean(getStoredPortalSession()))
  const [portalMessage, setPortalMessage] = useState('')

  useEffect(() => {
    const existing = getStoredPortalSession()
    if (!existing) {
      setChecking(false)
      return
    }
    let cancelled = false
    const validate = async () => {
      try {
        // Try validating stored session, with retry on network errors
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await fetch(`/api/auth/session?token=${encodeURIComponent(existing.sessionToken)}`, { cache: 'no-store' })
            if (response.ok) {
              if (cancelled) return
              setWorkspaceSessionToken(existing.sessionToken)
              setSession(existing)
              return
            }
            if (response.status === 401) {
              // Token genuinely expired — try auto-login before giving up
              break
            }
            // Other error (503, etc) — backend might be starting, retry
            await new Promise(r => setTimeout(r, 2000))
            continue
          } catch {
            // Network error — backend is probably restarting, retry
            if (attempt < 2) {
              await new Promise(r => setTimeout(r, 2000))
              continue
            }
            break
          }
        }

        // Session invalid or backend unreachable — try auto-login
        // (uses portal credentials from .env so you never get locked out locally)
        if (cancelled) return
        try {
          const autoResp = await fetch('/api/auth/auto', { method: 'POST', cache: 'no-store' })
          if (autoResp.ok) {
            const payload = await autoResp.json()
            if (payload.sessionToken) {
              const autoSession: PortalSession = {
                username: String(payload.username || 'local'),
                sessionToken: String(payload.sessionToken),
                expiresAt: Number(payload.expiresAt || 0) || undefined,
              }
              if (cancelled) return
              storePortalSession(autoSession)
              setWorkspaceSessionToken(autoSession.sessionToken)
              setSession(autoSession)
              return
            }
          }
        } catch { /* auto-login not available */ }

        if (cancelled) return
        storePortalSession(null)
        setWorkspaceSessionToken(null)
        setSession(null)
      } finally {
        if (!cancelled) setChecking(false)
      }
    }
    validate()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const handleLock = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: string }>).detail
      storePortalSession(null)
      setWorkspaceSessionToken(null)
      setSession(null)
      setChecking(false)
      setPortalMessage(detail?.reason || 'Workspace locked. Log in to unlock.')
    }
    window.addEventListener('cerious-auth-lock', handleLock as EventListener)
    return () => window.removeEventListener('cerious-auth-lock', handleLock as EventListener)
  }, [])

  if (checking) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#050911] text-slate-100">
        <div className="flex items-center gap-4 font-mono text-sm text-blue-100">
          <img src={ceriousLogo} alt="Cerious Systems" className="h-14 w-14 rounded border border-blue-400/30 object-cover" />
          Preparing Cerious Terminal
        </div>
      </main>
    )
  }

  if (!session) {
    return <LoginPortal onAuthenticated={(next) => { setPortalMessage(''); setSession(next) }} initialStatus={portalMessage} />
  }

  return <>{children}</>
}
