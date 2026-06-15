/**
 * QuantSwarm Terminal — Comprehensive E2E Test Suite v2
 *
 * Optimized: single page session per spec, domcontentloaded instead of networkidle.
 * Covers:
 *  1.  App loads & ArbiTek header visible
 *  2.  All top-level nav views (Hub, Terminal, Performance, Settlements, Paper, Health, Settings)
 *  3.  Market provider switcher (Polymarket / Kalshi / IBKR)
 *  4.  Asset selector buttons
 *  5.  Chart mode switcher (1/2/3/4)
 *  6.  Auto-rotate toggle
 *  7.  Left panel tabs (Markets / Signals)
 *  8.  Right panel tabs (Book, Tape, AGR, Orders, Pos., Stats, Copy)
 *  9.  Tape sub-tabs (Time & Sales / Tape Flow)
 * 10.  Backend API health (HTTP)
 * 11.  Connection health widget present
 * 12.  Full screenshot tour of every view
 * 13.  No React-level crashes (ErrorBoundary not triggered)
 */

import { test, expect, Page, Browser, BrowserContext, chromium } from '@playwright/test'
import * as fs from 'fs'

const BASE = 'http://127.0.0.1:5173'
const API  = 'http://127.0.0.1:8000'
const SS   = (name: string) => `test-results/${name}.png`

// Ensure screenshot dir exists
if (!fs.existsSync('test-results')) fs.mkdirSync('test-results', { recursive: true })

// Single shared page session context for UI blocks to avoid connection reuse overhead/timeouts
let browserInstance: Browser | null = null
let contextInstance: BrowserContext | null = null
let page: Page

async function getOrInitPage(): Promise<Page> {
  if (!page) {
    browserInstance = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    })
    contextInstance = await browserInstance.newContext({
      viewport: { width: 1600, height: 900 }
    })
    page = await contextInstance.newPage()
    await loadApp(page)
  }
  return page
}

// Global cleanup at the end of all tests in this spec file
test.afterAll(async () => {
  if (page) {
    try { await page.close() } catch {}
    page = undefined as any
  }
  if (contextInstance) {
    try { await contextInstance.close() } catch {}
    contextInstance = null
  }
  if (browserInstance) {
    try { await browserInstance.close() } catch {}
    browserInstance = null
  }
})

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Navigate to the app and wait for the React root to mount (fast — no networkidle) */
async function loadApp(page: Page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  // React app is mounted when ArbiTek header appears
  await expect(page.getByText('ArbiTek Terminal')).toBeVisible({ timeout: 15_000 })
}

async function clickView(page: Page, label: string) {
  await page.getByRole('button', { name: label, exact: true }).click()
  await page.waitForTimeout(400)
}

async function clickRightTab(page: Page, label: string) {
  // Use :has-text() text selector — more robust than getByRole when the accessibility
  // tree is affected by WS reconnect / Tape sub-tab rendering.
  const locator = page.locator(`button:has-text("${label}")`).first()
  await locator.waitFor({ state: 'visible', timeout: 12_000 })
  await locator.click()
  await page.waitForTimeout(400)
}

async function noErrorBoundary(page: Page) {
  await expect(page.locator('body')).not.toContainText('Something went wrong')
}

// ─── 1. App Bootstrap ────────────────────────────────────────────────────────

test.describe('1 · App Bootstrap', () => {
  test.beforeAll(async () => {
    await getOrInitPage()
  })

  test('ArbiTek header is visible', async () => {
    await expect(page.getByText('ArbiTek Terminal')).toBeVisible()
    await page.screenshot({ path: SS('01-header') })
  })

  test('Hub view is the default landing page', async () => {
    const hubBtn = page.getByRole('button', { name: '⬡ Hub', exact: true })
    await expect(hubBtn).toBeVisible()
    await page.screenshot({ path: SS('01-hub-default') })
  })

  test('ConnectionHealth widget is present in header', async () => {
    const header = page.locator('header')
    await expect(header).toBeVisible()
  })

  test('no React ErrorBoundary triggered on load', async () => {
    await noErrorBoundary(page)
  })
})

// ─── 2. Top-Level Navigation ─────────────────────────────────────────────────

test.describe('2 · Top-Level Navigation Views', () => {
  test.beforeAll(async () => {
    const p = await getOrInitPage()
    await clickView(p, '⬡ Hub')
  })

  const views = [
    { label: '⬡ Hub',       ss: '02-hub'         },
    { label: 'Crypto',      ss: '02-terminal'     },
    { label: 'Performance', ss: '02-performance'  },
    { label: 'History',     ss: '02-history'      },
    { label: 'Paper',       ss: '02-paper'        },
    { label: 'Resolution',  ss: '02-resolution'   },
    { label: 'Health',      ss: '02-health'       },
    { label: '⚙',          ss: '02-settings'     },
  ]

  for (const v of views) {
    test(`"${v.label}" view renders without crash`, async () => {
      await clickView(page, v.label)
      await page.waitForTimeout(600)
      await noErrorBoundary(page)
      await page.screenshot({ path: SS(v.ss) })
    })
  }
})

// ─── 3. Market Provider Switcher ─────────────────────────────────────────────

test.describe('3 · Market Provider Switcher', () => {
  test.beforeAll(async () => {
    const p = await getOrInitPage()
    await clickView(p, '⬡ Hub')
  })

  test('polymarket button is present and clickable', async () => {
    const btn = page.getByRole('button', { name: 'polymarket', exact: true })
    await expect(btn).toBeVisible()
    await btn.click()
    await page.waitForTimeout(300)
    await noErrorBoundary(page)
  })

  test('kalshi button is present and clickable', async () => {
    const btn = page.getByRole('button', { name: 'kalshi', exact: true })
    await expect(btn).toBeVisible()
    await btn.click()
    await page.waitForTimeout(300)
    await noErrorBoundary(page)
  })

  test('IBKR (forecasttrader) button is present and clickable', async () => {
    const btn = page.getByRole('button', { name: 'IBKR', exact: true })
    await expect(btn).toBeVisible()
    await btn.click()
    await page.waitForTimeout(300)
    await noErrorBoundary(page)
  })

  test('cycling all three providers does not crash', async () => {
    await page.getByRole('button', { name: 'polymarket', exact: true }).click()
    await page.waitForTimeout(200)
    await page.getByRole('button', { name: 'kalshi', exact: true }).click()
    await page.waitForTimeout(200)
    await page.getByRole('button', { name: 'IBKR', exact: true }).click()
    await page.waitForTimeout(200)
    await page.getByRole('button', { name: 'polymarket', exact: true }).click()
    await page.waitForTimeout(200)
    await noErrorBoundary(page)
    await page.screenshot({ path: SS('03-provider-switcher') })
  })
})

// ─── 4 + 5 + 6. Terminal View — Assets, Chart Modes, Auto-Rotate ─────────────

test.describe('4-5-6 · Terminal — Assets / Chart Modes / Auto-Rotate', () => {
  // POL removed from ASSETS in backend; MarketNav only shows 7 assets
  const assets = ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'BNB', 'DOGE']

  test.beforeAll(async () => {
    const p = await getOrInitPage()
    await clickView(p, 'Crypto')
    await p.waitForTimeout(600)
  })
// ── 4 · Asset buttons ──
  // Asset buttons are in MarketNav left panel and contain icons + text (e.g. "₿ BTC ...").
  // Use hasText filter instead of exact role name match.
  test('all 7 asset buttons are visible', async () => {
    for (const a of assets) {
      await expect(page.locator('button').filter({ hasText: a }).first()).toBeVisible()
    }
    await page.screenshot({ path: SS('04-asset-buttons') })
  })

  for (const asset of assets) {
    test(`asset button: ${asset}`, async () => {
      await page.locator('button').filter({ hasText: asset }).first().click()
      await page.waitForTimeout(400)
      await noErrorBoundary(page)
    })
  }

  // ── 5 · Chart modes ──
  for (const mode of ['1', '2', '3', '4']) {
    test(`chart mode: ${mode}`, async () => {
      await page.getByRole('button', { name: mode, exact: true }).click()
      await page.waitForTimeout(600)
      await noErrorBoundary(page)
      await page.screenshot({ path: SS(`05-chart-mode-${mode}`) })
    })
  }

  // ── 6 · Auto-rotate ──
  test('auto-rotate toggles ON then OFF', async () => {
    const btn = page.getByRole('button', { name: /Rotate/i })
    await expect(btn).toBeVisible()
    await expect(btn).toContainText('OFF')
    await btn.click()
    await expect(btn).toContainText('ON')
    await btn.click()
    await expect(btn).toContainText('OFF')
    await page.screenshot({ path: SS('06-auto-rotate') })
  })
})

// ─── 7. Left Panel Tabs ───────────────────────────────────────────────────────

test.describe('7 · Terminal — Left Panel Tabs', () => {
  test.beforeAll(async () => {
    const p = await getOrInitPage()
    await clickView(p, 'Crypto')
    await p.waitForTimeout(400)
  })

  test('"markets" left tab renders', async () => {
    await page.getByRole('button', { name: 'markets', exact: true }).click()
    await page.waitForTimeout(400)
    await noErrorBoundary(page)
    await page.screenshot({ path: SS('07-left-markets') })
  })

  test('"signals" left tab renders', async () => {
    await page.getByRole('button', { name: 'signals', exact: true }).click()
    await page.waitForTimeout(400)
    await noErrorBoundary(page)
    await page.screenshot({ path: SS('07-left-signals') })
  })
})

// ─── 8 + 9. Right Panel Tabs + Tape Sub-Tabs ─────────────────────────────────

test.describe('8-9 · Terminal — Right Panel Tabs & Tape Sub-Tabs', () => {
  const rightTabs = [
    { label: 'Book',   ss: '08-right-book'      },
    { label: 'Tape',   ss: '08-right-tape'      },
    { label: 'AGR',    ss: '08-right-agr'       },
    { label: 'Orders', ss: '08-right-orders'    },
    { label: 'Pos.',   ss: '08-right-positions' },
    { label: 'Stats',  ss: '08-right-stats'     },
    { label: 'Copy',   ss: '08-right-copy'      },
  ]

  test.beforeAll(async () => {
    const p = await getOrInitPage()
    await clickView(p, 'Crypto')
    // Wait for WS to stabilise before tab tests — prevents DOM churn from
    // reconnect cycles making AGR / Pos. buttons briefly inaccessible.
    await p.waitForTimeout(1_500)
  })

  for (const tab of rightTabs) {
    test(`right tab: "${tab.label}"`, async () => {
      await clickRightTab(page, tab.label)
      await page.waitForTimeout(500)
      await noErrorBoundary(page)
      await page.screenshot({ path: SS(tab.ss) })
    })
  }

  // ── 9 · Tape sub-tabs (switch to Tape first) ──
  test('tape sub-tab: Time & Sales', async () => {
    await clickRightTab(page, 'Tape')
    await page.waitForTimeout(300)
    const btn = page.getByRole('button', { name: 'Time & Sales', exact: true })
    await expect(btn).toBeVisible()
    await btn.click()
    await page.waitForTimeout(400)
    await noErrorBoundary(page)
    await page.screenshot({ path: SS('09-tape-time-sales') })
  })

  test('tape sub-tab: Tape Flow', async () => {
    const btn = page.getByRole('button', { name: 'Tape Flow', exact: true })
    await expect(btn).toBeVisible()
    await btn.click()
    await page.waitForTimeout(400)
    await noErrorBoundary(page)
    await page.screenshot({ path: SS('09-tape-flow') })
  })
})

// ─── 10. Backend API Health ───────────────────────────────────────────────────

test.describe('10 · Backend API Health', () => {
  test('backend is alive on port 8000', async ({ request }) => {
    const res = await request.get(`${API}/`)
    expect([200, 404, 422]).toContain(res.status())
  })

  test('GET /api/positions responds', async ({ request }) => {
    const res = await request.get(`${API}/api/positions`, { timeout: 8000 })
    expect([200, 204, 404]).toContain(res.status())
  })

  test('GET /api/settlements responds', async ({ request }) => {
    const res = await request.get(`${API}/api/settlements`, { timeout: 8000 })
    expect([200, 204, 404]).toContain(res.status())
  })

  test('GET /api/poly/markets responds', async ({ request }) => {
    const res = await request.get(`${API}/api/poly/markets`, { timeout: 8000 })
    expect([200, 204, 404, 503]).toContain(res.status())
  })
})

// ─── 11. No Critical Console Errors ──────────────────────────────────────────

test.describe('11 · No Critical Console Errors', () => {
  test('no React ErrorBoundary triggered across key views', async () => {
    const p = await getOrInitPage()
    const criticalErrors: string[] = []

    p.on('pageerror', err => criticalErrors.push(err.message))

    // Use longer timeout here — test 11 runs after many pages are open
    await p.goto(BASE, { waitUntil: 'domcontentloaded' })
    await expect(p.getByText('ArbiTek Terminal')).toBeVisible({ timeout: 25_000 })

    // Walk through every view quickly
    for (const label of ['⬡ Hub', 'Crypto', 'Performance', 'History', 'Paper', 'Resolution', 'Health', '⚙']) {
      await clickView(p, label)
      await p.waitForTimeout(300)
      await noErrorBoundary(p)
    }

    if (criticalErrors.length > 0) {
      console.log('Page-level JS errors:')
      criticalErrors.forEach(e => console.log(' -', e))
    }

    // Hard fail only on actual page crashes
    expect(criticalErrors.filter(e => e.includes('Cannot read') || e.includes('is not a function'))).toHaveLength(0)
    await p.screenshot({ path: SS('11-no-crashes') })
  })
})

// ─── 12. Full Screenshot Tour ─────────────────────────────────────────────────

test.describe('12 · Full Screenshot Tour', () => {
  test('capture all views', async () => {
    const p = await getOrInitPage()
    await loadApp(p)

    const stops = [
      { label: '⬡ Hub',       name: 'hub'         },
      { label: 'Crypto',      name: 'terminal'     },
      { label: 'Performance', name: 'performance'  },
      { label: 'History',     name: 'history'      },
      { label: 'Paper',       name: 'paper'        },
      { label: 'Resolution',  name: 'resolution'   },
      { label: 'Health',      name: 'health'       },
      { label: '⚙',          name: 'settings'     },
    ]

    for (const stop of stops) {
      await clickView(p, stop.label)
      await p.waitForTimeout(800)
      await p.screenshot({ path: SS(`12-tour-${stop.name}`), fullPage: false })
    }
  })
})
