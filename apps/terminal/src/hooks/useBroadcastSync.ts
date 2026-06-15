/**
 * useBroadcastSync — syncs user UI selections across all open terminal windows.
 *
 * Primary window (no ?panel= param): broadcasts activeAsset, activeMarketKey,
 *   and marketProvider whenever they change in the Zustand store.
 *
 * Secondary windows (?panel=X): listens on the same channel and updates their
 *   local store so all windows track the same active market without a shared WS.
 */
import { useEffect } from 'react'
import { useStore } from '../store'

const CHANNEL = 'qst-ui-sync'

type SyncMsg =
  | { type: 'asset';    value: string }
  | { type: 'market';   value: string | null }
  | { type: 'provider'; value: string }

/** Returns true when this window is a panel popout (has ?panel= in URL). */
export function isPanelWindow(): boolean {
  return new URLSearchParams(window.location.search).has('panel')
}

/** Returns the panel type from the URL, or null if not a panel window. */
export function getPanelType(): string | null {
  return new URLSearchParams(window.location.search).get('panel')
}

/**
 * Mount in App.tsx.
 * Primary: subscribes to store, broadcasts changes to other windows.
 * Secondary: listens for broadcasts and applies them to the local store.
 */
export function useBroadcastSync() {
  const isSecondary = isPanelWindow()

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const ch = new BroadcastChannel(CHANNEL)

    if (isSecondary) {
      // ── Secondary: receive and apply ──────────────────────────────────────
      ch.onmessage = (e: MessageEvent<SyncMsg>) => {
        const { setActiveAsset, setActiveMarketKey, setMarketProvider } = useStore.getState()
        const msg = e.data
        if (msg.type === 'asset')    setActiveAsset(msg.value as any)
        if (msg.type === 'market')   setActiveMarketKey(msg.value)
        if (msg.type === 'provider') setMarketProvider(msg.value as any)
      }
    } else {
      // ── Primary: subscribe to store and broadcast changes ─────────────────
      let prev = {
        asset:    useStore.getState().activeAsset,
        market:   useStore.getState().activeMarketKey,
        provider: useStore.getState().marketProvider,
      }

      const unsub = useStore.subscribe((state) => {
        if (state.activeAsset !== prev.asset) {
          prev.asset = state.activeAsset
          ch.postMessage({ type: 'asset', value: state.activeAsset } satisfies SyncMsg)
        }
        if (state.activeMarketKey !== prev.market) {
          prev.market = state.activeMarketKey
          ch.postMessage({ type: 'market', value: state.activeMarketKey } satisfies SyncMsg)
        }
        if (state.marketProvider !== prev.provider) {
          prev.provider = state.marketProvider
          ch.postMessage({ type: 'provider', value: state.marketProvider } satisfies SyncMsg)
        }
      })

      return () => {
        unsub()
        ch.close()
      }
    }

    return () => ch.close()
  }, [isSecondary])
}
