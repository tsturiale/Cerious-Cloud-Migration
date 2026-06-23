function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

export function isCeriousDesktopRuntime(): boolean {
  return false
}

export function ceriousHttpBase(): string {
  const configured = (import.meta.env.VITE_CERIOUS_HTTP_BASE as string | undefined)?.trim()
  if (configured) return trimTrailingSlash(configured)
  return ''
}

export function ceriousWsBase(): string {
  const configured = (import.meta.env.VITE_CERIOUS_WS_BASE as string | undefined)?.trim()
  if (configured) return trimTrailingSlash(configured)

  const httpBase = ceriousHttpBase()
  if (httpBase) return `${httpBase.replace(/^http/i, 'ws')}/ws`

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${window.location.host}/ws`
}

export function resolveCeriousHttp(input: RequestInfo | URL): RequestInfo | URL {
  const base = ceriousHttpBase()
  if (!base) return input
  if (typeof input === 'string') {
    return input.startsWith('/api') ? `${base}${input}` : input
  }
  if (input instanceof URL) {
    return input.pathname.startsWith('/api') && input.origin === window.location.origin
      ? new URL(`${base}${input.pathname}${input.search}${input.hash}`)
      : input
  }
  return input
}

export function resolveCeriousWs(url: string | URL): string | URL {
  const raw = typeof url === 'string' ? url : url.toString()
  if (raw.startsWith('/ws')) {
    const suffix = raw.slice('/ws'.length)
    return `${ceriousWsBase()}${suffix}`
  }
  return url
}

export function installCeriousTransport(): void {
  const marker = '__ceriousTransportInstalled'
  const target = window as typeof window & { [marker]?: boolean }
  if (target[marker]) return
  target[marker] = true

  const nativeFetch = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => nativeFetch(resolveCeriousHttp(input), init)

  const NativeWebSocket = window.WebSocket
  const WrappedWebSocket = function CeriousWebSocket(url: string | URL, protocols?: string | string[]) {
    const resolved = resolveCeriousWs(url)
    return protocols === undefined
      ? new NativeWebSocket(resolved)
      : new NativeWebSocket(resolved, protocols)
  } as unknown as typeof WebSocket

  WrappedWebSocket.prototype = NativeWebSocket.prototype
  Object.defineProperties(WrappedWebSocket, {
    CONNECTING: { value: NativeWebSocket.CONNECTING },
    OPEN: { value: NativeWebSocket.OPEN },
    CLOSING: { value: NativeWebSocket.CLOSING },
    CLOSED: { value: NativeWebSocket.CLOSED },
  })
  window.WebSocket = WrappedWebSocket
}
