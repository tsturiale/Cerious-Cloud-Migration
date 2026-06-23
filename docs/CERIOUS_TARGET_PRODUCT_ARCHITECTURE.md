# Cerious Systems Target Product Architecture

Cerious has one active product surface:

- Browser terminal: the default authenticated terminal at `http://127.0.0.1:8000/`.

The browser terminal talks to native C++ services through the gateway. The UI is not the source of trading truth.

## Non-Negotiable Rules

- The UI renders and commands; services own state.
- Price display comes from product definitions and market-data subscriptions, not widget-specific pricing code.
- Simulation is its own exchange. It uses the same order lifecycle and position/PnL model as future live venues.
- Exchange is the business destination, such as CME or SIM. FIX/TT FIX is a routing gateway hop, not the destination shown in the normal trader workflow.
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
6. Browser install/bookmark behavior is handled by the browser itself, not by an in-app desktop-client package.

## Service Boundaries

### Terminal Gateway

The gateway is the single client-facing API boundary. It serves REST and WebSocket contracts to the React terminal.

Primary responsibilities:

- Authentication and session validation.
- Workspace snapshot load/save.
- Market-data stream fanout.
- Order/fill/position state fanout.
- Study/algo/audit state fanout.

### Price Service

Owns market-data ingress and normalization.

Current production target:

- CME through Databento live MBP-1 and historical REST.

Future adapters:

- Kalshi.
- Polymarket.

The price service publishes normalized books, trades, top of book, last trade, and product definition metadata. Widgets do not invent exchange rules.

### Studies Service

Owns technical and relative-value calculations:

- user-defined server-side linear regression study.
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
- Native and synthetic order families.
- Cancel/replace.
- Kill all.
- Order status.
- Filled/cancelled removal from working views.

It publishes state to every widget that needs it.

### Routing Gateways

Routing gateways are infrastructure adapters below the order service. TT FIX is a route gateway that can send orders onward to CME and other supported exchanges; it is not itself the business exchange destination. The normal trader workflow should show the destination exchange and product, while FIX session state, rejects, disconnects, and gateway errors are logged to the audit trail and technical monitors.

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

## Implementation Phases

1. Stabilize cloud/web workflow as the default product path.
2. Remove the old Chrome floating-window workflow from active launch paths.
3. Create authoritative order/sim service REST contracts.
4. Add order/fill/position snapshots to the gateway stream.
5. Move manual and algo order placement to service APIs.
6. Update depth ladder, order book, fills, and positions to render service-published state.
7. Keep browser launch as the only active client path.
