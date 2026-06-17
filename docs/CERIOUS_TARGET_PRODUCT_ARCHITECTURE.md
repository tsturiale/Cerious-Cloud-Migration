# Cerious Systems Target Product Architecture

Cerious has one product surface with two containers:

- Cloud / web canvas: the default authenticated terminal that runs in the browser.
- Desktop client: a later native container that runs the same terminal application with native windowing and local hardware access.

The cloud client and desktop client must share the same backend contracts, session state, market data, order state, risk rules, algo definitions, studies, fills, positions, alerts, and workspace persistence. The UI is not the source of trading truth.

## Non-Negotiable Rules

- The UI renders and commands; services own state.
- Price display comes from product definitions and market-data subscriptions, not widget-specific pricing code.
- Simulation is its own exchange. It uses the same order lifecycle and position/PnL model as future live venues.
- Algo Manager does not create private UI-only orders. It sends deploy commands to the algo/order service.
- If a send-price dependency is unavailable, the algo pauses and publishes an audit event. It must not guess.
- Depth ladders, order books, fills, positions, alerts, and algos all subscribe to the same authoritative session/order stream.
- Browser popouts are not a production desktop model.

## Local Cloud Workflow

This is the current supported workflow while the backend remains local:

1. User opens Cerious.
2. Portal login authenticates locally through `/api/auth/login`.
3. Terminal loads the saved server workspace, with local cache as a fast fallback.
4. The web canvas is the primary workspace.
5. The browser client has full functionality and does not depend on desktop popout behavior.
6. A Download Desktop Client button is visible but belongs to the future desktop workflow.

## Service Boundaries

### Terminal Gateway

The gateway is the single client-facing API boundary. It serves REST and WebSocket contracts to the React terminal.

Primary responsibilities:

- Authentication and session validation.
- Workspace snapshot load/save.
- Market-data stream fanout.
- Order/fill/position state fanout.
- Study/algo/audit state fanout.
- Desktop package download.

### Price Service

Owns market-data ingress and normalization.

Current production target:

- CME through Databento live MBP-1 and historical REST.
- T4 can be added as another CME-compatible adapter.

Future adapters:

- Kalshi.
- Polymarket.
- Coinbase.

The price service publishes normalized books, trades, top of book, last trade, and product definition metadata. Widgets do not invent exchange rules.

### Studies Service

Owns technical and relative-value calculations:

- LR27 30-minute regression.
- ATR.
- Volume at price.
- Relative value visuals.
- Spread signals.
- Goose/macro regime.

It consumes historical backfill plus live rolling bars and publishes timestamped study snapshots with freshness metadata.

### Algo Engine

Owns:

- Algo definitions.
- Saved algo workflows.
- Peg rules.
- Trigger evaluation.
- Deploy/hold/pause/kill lifecycle.
- Sanity checks.

Deploying an algo creates order intents against the order service. Working orders are tagged `ALGO ENTRY` or `ALGO COVER`.

### Order Service

Owns the canonical order book for the user's session:

- Manual orders.
- Algo orders.
- Cancel/replace.
- Kill all.
- Order status.
- Filled/cancelled removal from working views.

It publishes state to every widget that needs it.

### Sim Exchange

Simulation is modeled as an exchange adapter:

- Accepts order commands from the order service.
- Matches against the normalized market data stream.
- Publishes fills.
- Updates positions and live open PnL.

This lets the live exchange path and sim exchange path share the same UI and risk abstractions.

## WebSocket Contract Direction

The terminal WebSocket should publish these event classes:

- `market.snapshot`
- `market.book`
- `market.trade`
- `study.snapshot`
- `algo.snapshot`
- `algo.event`
- `order.snapshot`
- `order.event`
- `fill.event`
- `position.snapshot`
- `risk.snapshot`
- `audit.event`
- `workspace.snapshot`

On reconnect, the client receives a snapshot first, then live deltas. This is what prevents reloads, missing algo orders, stale PnL, and window-to-window disagreement.

## Desktop Client Direction

The desktop client is not the current Chrome-app-window workflow.

Future desktop behavior:

1. User downloads a signed Win64 installer from the web portal.
2. Installer creates a branded desktop launcher.
3. Launcher opens a native desktop container.
4. The desktop container authenticates and starts or connects to required services.
5. A native toolbar controls workspace load/save, service status, windows, alerts, and emergency controls.
6. The desktop app opens all saved desktop windows from the desktop workspace snapshot.
7. Desktop workspace state is saved both server-side and locally.

The desktop client must use the same backend contracts as the web client.

## Implementation Phases

1. Stabilize cloud/web workflow as the default product path.
2. Remove the old Chrome floating-window workflow from active launch paths.
3. Create authoritative order/sim service REST contracts.
4. Add order/fill/position snapshots to the gateway stream.
5. Move manual and algo order placement to service APIs.
6. Update depth ladder, order book, fills, and positions to render service-published state.
7. Keep desktop download visible, but do not launch the old Chrome workflow.
8. Build the native desktop client after the cloud path is deterministic.
