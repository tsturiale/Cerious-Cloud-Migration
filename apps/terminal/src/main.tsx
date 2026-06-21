import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { loadSettings, applyTheme } from './components/Settings'
import { installCeriousTransport } from './platform/transport'
import { installCeriousDesktopZoom } from './platform/desktopZoom'

// Apply saved theme before first render so there's no flash of wrong theme
applyTheme(loadSettings().theme)
installCeriousTransport()
installCeriousDesktopZoom()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
// reload trigger

