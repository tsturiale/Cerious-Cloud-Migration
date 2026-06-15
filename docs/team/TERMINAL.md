# QuantSwarm Terminal — Developer Reference

**Path:** `C:\Users\trade\OneDrive\Desktop\QuantSwarmTerminal\terminal\`  
**Stack:** React 18 + TypeScript + Vite + Tailwind CSS  
**Last updated:** 2026-04-14

---

## What It Is

A full-screen quantitative trading workstation focused on Polymarket prediction market trading. Displays real-time prices, probability curves, order books, position tracking, and P&L analytics. Designed for a single active trader with a multi-panel resizable layout.

---

## Tech Stack

| Layer | Library |
|---|---|
| Framework | React 18 + TypeScript |
| Bundler | Vite |
| Styling | Tailwind CSS v3 |
| UI primitives | Radix UI, Lucide React icons |
| Layout resizing | `react-resizable-panels` (column splits) + custom wheel-drag (row splits) |
| Charts | `recharts` (probability, P&L), `lightweight-charts` (price candles) |
| State | Zustand (`terminal/src/store/index.ts`) |
| WebSocket | Custom hook (`terminal/src/hooks/useWebSocket.ts`) |
| Toast notifications | `react-hot-toast` |
| Tables | `@tanstack/react-table` |

---

## Running the Dev Server

```bash
cd C:/Users/trade/OneDrive/Desktop/QuantSwarmTerminal/terminal
npm install
npm run dev        # starts Vite dev server (default: http://localhost:5173)
npm run build      # production build
npm run lint       # ESLint
npm run preview    # preview production build
```

---

## Layout Architecture

The app uses a three-column split layout. Column widths are managed by `react-resizable-panels`. Row heights within the center column use flex + mouse wheel drag.

```
┌─────────────────────────────────────────────────────────────────────┐
│  LEFT PANEL (default 14%)  │  CENTER PANEL (72%)  │  RIGHT PANEL   │
│                            │                       │                │
│  MarketNav                 │  Chart                │  SignalPanel   │
│  ProviderGrid              │  ─────────────────    │  OrderBook     │
│  ConnectionHealth          │  PolyPriceChart       │  OrderPanel    │
│  CryptoPriceStrip          │  ─────────────────    │  PositionMon.  │
│                            │  ProbChart + Tape     │  RiskBar       │
└─────────────────────────────────────────────────────────────────────┘
```

**Row separators** (center panel): `bg-fuchsia-500`, `cursor-ns-resize`, mouse wheel drag
**Column separators**: `bg-cyan-400`, `cursor-col-resize`, drag via react-resizable-panels

### Row Resize State (Layout.tsx ~line 57)
```tsx
const [s2Flex, setS2Flex] = useState(2)      // PolyPriceChart flex
const [s3Flex, setS3Flex] = useState(2.66)   // ProbChart+Tape flex
// Both clamped to [0.5, 5] via wheel events
```

### Min Heights Applied (Layout.tsx ~line 200)
```tsx
style={{ flex: 6, minHeight: 150 }}           // Chart section
style={{ flex: s2Flex, minHeight: 80 }}       // PolyPriceChart
style={{ flex: s3Flex, minHeight: 100 }}      // ProbChart + TapeIndicator
```

---

## Key Components

| Component | File | Purpose |
|---|---|---|
| `Layout` | `Layout.tsx` | Root layout — panel splits, tab routing, resize state |
| `Chart` | `Chart.tsx` | Single-asset candlestick chart (lightweight-charts) |
| `MultiChart` | `MultiChart.tsx` | Multi-asset grid chart view |
| `PolyPriceChart` | `PolyPriceChart.tsx` | Polymarket YES price time series |
| `ProbChart` | `ProbChart.tsx` | Probability curve with signal overlays |
| `TapeIndicator` | (in center panel) | Live tape — recent trades |
| `MarketNav` | `MarketNav.tsx` | Left sidebar — asset/market navigation |
| `SignalPanel` | `SignalPanel.tsx` | Right panel — HMM regime signals |
| `OrderBook` | `OrderBook.tsx` | Bid/ask depth |
| `OrderPanel` | `OrderPanel.tsx` | Order entry (paper mode) |
| `PositionMonitor` | `PositionMonitor.tsx` | Open positions + P&L |
| `RiskBar` | `RiskBar.tsx` | Live drawdown / risk gauge |
| `Analytics` | `Analytics.tsx` | Historical trade analytics |
| `Performance` | `Performance.tsx` | P&L performance over time |
| `PerformanceCalendar` | `PerformanceCalendar.tsx` | Calendar heatmap of daily P&L |
| `EdgeCopyPanel` | `EdgeCopyPanel.tsx` | Edge metrics copy/export |
| `HealthTab` | `HealthTab.tsx` | System/connection health status |
| `Settings` | `Settings.tsx` | User preferences |
| `HubPage` | `HubPage.tsx` | Multi-provider hub (in progress — see ROADMAP) |
| `PaperTrade` | `PaperTrade.tsx` | Paper trading mode |
| `JournalNotes` | `JournalNotes.tsx` | Trade journal |
| `AGRFlow` | `AGRFlow.tsx` | AGR signal flow visualization |

---

## State Management (Zustand)

All global state lives in `terminal/src/store/index.ts`. Key slices:

- **active asset** — which market/symbol is selected
- **chart mode** — single vs multi-chart
- **positions** — open paper trade positions
- **P&L** — realized + unrealized
- **connection status** — WebSocket health

---

## Data Sources

| Source | Method | What it provides |
|---|---|---|
| Polymarket Gamma API | REST | Market metadata, probability snapshots |
| Polymarket CLOB API | WebSocket | Live order book, trade tape |
| The Odds API | REST (via BizOS OpenClaw) | NFL/sports odds |
| BizOS HMM signal | REST/queue (via BizOS) | Regime ID, signal, confidence |

WebSocket connection managed by `useWebSocket.ts` hook.

---

## Important Layout Notes for Devs

1. **Do not add `Panel` or `Separator` components to the center column.** The row resizing is done with flex divs + mouse wheel handlers (`onWheelDiv1`, `onWheelDiv2`). Using `react-resizable-panels` primitives inside the center column will break the wheel-drag resize.

2. **Column separators are cyan (`bg-cyan-400`)**, row separators are fuchsia (`bg-fuchsia-500`). Keep this color distinction.

3. **`minHeight` is enforced via inline style**, not Tailwind classes, because flex children ignore `min-h-*` in some browser contexts.

4. **Chart switching** is controlled by `chartMode` state in Zustand — `'single'` renders `<Chart>`, anything else renders `<MultiChart>`.

---

## Branch Conventions

Active development branch: `feature/titanium-v5-update`  
Main branch: `main`  
PR target: `main`

Commits are prefixed: `feat:`, `fix:`, `docs:`, `refactor:`
