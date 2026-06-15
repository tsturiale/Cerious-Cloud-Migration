import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,          // per-test max
  expect: { timeout: 12_000 },
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,               // fail fast so we see real issues
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'playwright-results.json' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    headless: true,           // headless = faster, no GPU overhead
    viewport: { width: 1600, height: 900 },
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
    actionTimeout: 12_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
