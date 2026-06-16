import { useEffect } from 'react'
import { Toaster } from 'react-hot-toast'
import { DesktopToolbar, WorkspaceDesktop, WorkspacePopoutWindow } from './components/WorkspaceDesktop'
import { PanelWindow } from './components/PanelWindow'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PortalGate } from './components/PortalGate'
import { useWebSocket } from './hooks/useWebSocket'
import { useBroadcastSync, getPanelType } from './hooks/useBroadcastSync'
import { useStore } from './store'

const ASSETS = ['ES', 'NQ', 'YM', 'RTY', 'CL', 'GC', 'ZM', 'ZS'] as const

/** Opens one WebSocket for the currently active asset. */
function AssetConnector() {
  const asset = useStore(s => s.activeAsset)
  useWebSocket(asset)
  return null
}

/** Auto-rotates the active asset every 8 s when autoRotate is enabled.
 *  Only active in the primary window (no ?panel= param). */
function MarketRotator() {
  const { autoRotate, activeAsset, setActiveAsset } = useStore()

  useEffect(() => {
    if (!autoRotate) return

    const id = setInterval(() => {
      const idx = ASSETS.indexOf(activeAsset as any)
      const nextIdx = (idx + 1) % ASSETS.length
      setActiveAsset(ASSETS[nextIdx])
    }, 8000)

    return () => clearInterval(id)
  }, [autoRotate, activeAsset, setActiveAsset])

  return null
}

/** Syncs asset/market/provider selection across all open windows. */
function BroadcastSyncProvider() {
  useBroadcastSync()
  return null
}

const toasterStyle = {
  background: '#0f1629',
  color: '#e2e8f0',
  border: '1px solid #1e2d4e',
  fontSize: '12px',
  fontFamily: 'JetBrains Mono, monospace',
}

// Detect panel type once at module level (doesn't change during app lifetime)
const PANEL = getPanelType()
const SEARCH_PARAMS = new URLSearchParams(window.location.search)
const WORKSPACE_POPOUT = SEARCH_PARAMS.get('workspace_popout')
const DESKTOP_TOOLBAR = SEARCH_PARAMS.get('desktop_toolbar') === '1'

export default function App() {
  if (WORKSPACE_POPOUT) {
    return (
      <ErrorBoundary>
        <PortalGate>
          <AssetConnector />
          <BroadcastSyncProvider />
          <WorkspacePopoutWindow windowId={WORKSPACE_POPOUT} />
        </PortalGate>
        <Toaster position="bottom-right" toastOptions={{ style: toasterStyle }} />
      </ErrorBoundary>
    )
  }

  if (DESKTOP_TOOLBAR) {
    return (
      <ErrorBoundary>
        <PortalGate>
          <BroadcastSyncProvider />
          <DesktopToolbar />
        </PortalGate>
        <Toaster position="bottom-right" toastOptions={{ style: toasterStyle }} />
      </ErrorBoundary>
    )
  }

  // Panel window — standalone, positioned on a secondary monitor
  if (PANEL) {
    return (
      <ErrorBoundary>
        <AssetConnector />
        <BroadcastSyncProvider />
        <PanelWindow panel={PANEL} />
        <Toaster position="bottom-right" toastOptions={{ style: toasterStyle }} />
      </ErrorBoundary>
    )
  }

  // Primary window — full terminal
  return (
    <ErrorBoundary>
      <PortalGate>
        <AssetConnector />
        <MarketRotator />
        <BroadcastSyncProvider />
        <WorkspaceDesktop />
      </PortalGate>
      <Toaster position="bottom-right" toastOptions={{ style: toasterStyle }} />
    </ErrorBoundary>
  )
}
