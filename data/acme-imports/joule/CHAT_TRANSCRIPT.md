# Joule Chat Transcript

This file captures the working thread that led to the Joule project split.

## User Requests

1. Clean up the project so it can be worked on through Codex, and reopen the dashboard in Codex.
2. Provide a link to reopen the dashboard.
3. Improve top-of-page summaries using market/news context from Bloomberg, Wall Street Journal, Reuters, MSNBC, Barchart, and related sources.
4. Add market depth windows for last traded price, best bid, best offer, and spread visualization.
5. Remove the market depth section and improve the GUI, including freely draggable/resizable windows.
6. Expand the usable desktop area and improve recoverability for windows moved too far right.
7. Replace static breadth/best spread widgets with eligible trading spreads and an algorithmic approach section.
8. Add a Formula One style risk-on/off strength light indicator with quantitative support.
9. Prepare backend and UI scaffolding for live market data APIs, DOM/depth trader ladders, trade analytics, order/fill windows, account upload analytics, and working algo controls.
10. Remove the word TT from spread configurations, rename MD Trader windows to Depth Trader, and add fill/P&L windows.
11. Increase the risk strength indicator to seven lights.
12. Make sure Save Workspace works.
13. Create a desktop app-style launcher that autostarts needed services.
14. Source one day of free tick data for ES, YM, NQ, and RTY, synthesize five levels of depth, and build a simulator to power Depth Trader windows.
15. Correct the Depth Trader implementation so the price column is static, book quantities move against the static price grid, and fake orders can fill.
16. Fix P&L, make bid clicks stage working buy limits that fill when the market trades there, keep the price column static, keep Depth Trader titles fixed, and remove unwanted scrolling once windows are sized.
17. Tidy the top panel, consolidate and reduce button sizes, branch this RVEX version, and create a new project called Joule.
18. Create the standalone Joule project folder and put this chat inside it.

## Implemented In RVEX Before The Split

- Freeform dashboard desktop with draggable and resizable panels.
- Save Workspace and Gather Windows controls.
- Compact top action bar.
- Seven-light risk-on/off strength indicator.
- Live/delayed quote scaffolding.
- Backend endpoints for market data, orders, fills, algos, and simulator seed data.
- Depth Trader windows with static price ladders, bid/offer book movement, working order staging, fake fills, and fill/P&L reporting.
- Desktop launcher scripts.
- A local RVEX snapshot folder at `branches/rvex-static-depth-trader-2026-05-30`.

## Joule Split

Joule is intended as a separate project area so future work can evolve without making RVEX more tangled. The first decision is whether Joule inherits the RVEX window system and market-data simulator, or starts with a cleaner architecture around the same ideas.
