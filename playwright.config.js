import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests against the Vite demo. The three browser projects run the whole
 * suite; chromium-dpr1 runs only core.spec.js, at pixel ratio 1. The browsers
 * differ in how they handle WebGL, foreignObject and canvas copying, which is
 * exactly what we want to check.
 */
const viewport = { width: 1480, height: 1000 };

/**
 * Firefox is left out unless FIREFOX=1. The Firefox that Playwright ships is its own
 * patched Nightly, and as of Playwright 1.63 that build quits on startup with
 * "Could not find profile folder" on macOS 27, before it loads a page. The library
 * itself is fine in Firefox; only this build can't start.
 */
const runFirefox = !!process.env.FIREFOX;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: {
    timeout: 30_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' }
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://localhost:5173',
    viewport,
    deviceScaleFactor: 2,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport, deviceScaleFactor: 2 } },
    ...(runFirefox ? [{
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        viewport,
        deviceScaleFactor: 2,
        launchOptions: { firefoxUserPrefs: { 'webgl.force-enabled': true, 'webgl.disabled': false } }
      }
    }] : []),
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport, deviceScaleFactor: 2 } },
    { name: 'chromium-dpr1', use: { ...devices['Desktop Chrome'], viewport, deviceScaleFactor: 1 }, testMatch: /core/ }
  ]
});
