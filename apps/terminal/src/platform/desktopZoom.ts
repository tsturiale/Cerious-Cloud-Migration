import { isCeriousDesktopRuntime } from './transport'

const DESKTOP_ZOOM_KEY = 'cerious.desktop.zoom.v1'
const MIN_ZOOM = 0.5
const MAX_ZOOM = 2
const ZOOM_STEP = 0.1

let currentZoom = 1

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100))
}

function storedZoom(): number {
  const raw = window.localStorage.getItem(DESKTOP_ZOOM_KEY)
  return clampZoom(raw ? Number(raw) : 1)
}

function applyZoom(value: number) {
  currentZoom = clampZoom(value)
  window.localStorage.setItem(DESKTOP_ZOOM_KEY, String(currentZoom))
  document.documentElement.style.setProperty('zoom', String(currentZoom))
  document.documentElement.dataset.ceriousDesktopZoom = String(currentZoom)
  window.dispatchEvent(new Event('resize'))
  window.setTimeout(() => window.dispatchEvent(new Event('resize')), 80)
}

function changeZoom(direction: number) {
  applyZoom(currentZoom + direction * ZOOM_STEP)
}

export function installCeriousDesktopZoom(): void {
  const marker = '__ceriousDesktopZoomInstalled'
  const target = window as typeof window & { [marker]?: boolean }
  if (target[marker] || !isCeriousDesktopRuntime()) return
  target[marker] = true

  applyZoom(storedZoom())

  window.addEventListener(
    'wheel',
    event => {
      if (!event.ctrlKey) return
      event.preventDefault()
      event.stopPropagation()
      changeZoom(event.deltaY < 0 ? 1 : -1)
    },
    { capture: true, passive: false },
  )

  window.addEventListener(
    'keydown',
    event => {
      if (!event.ctrlKey && !event.metaKey) return
      if (event.key === '0') {
        event.preventDefault()
        applyZoom(1)
      } else if (event.key === '+' || event.key === '=' || event.key === 'Add') {
        event.preventDefault()
        changeZoom(1)
      } else if (event.key === '-' || event.key === '_' || event.key === 'Subtract') {
        event.preventDefault()
        changeZoom(-1)
      }
    },
    { capture: true },
  )
}
