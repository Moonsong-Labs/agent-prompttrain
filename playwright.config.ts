import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.TEST_BASE_URL || 'http://localhost:3001'
const proxyURL = process.env.TEST_PROXY_URL || 'http://localhost:3000'
const startServers = process.env.TEST_START_SERVERS === 'true'
if (startServers && (!process.env.E2E_DATABASE_URL || !process.env.DASHBOARD_API_KEY)) {
  throw new Error('Managed E2E servers require E2E_DATABASE_URL and DASHBOARD_API_KEY')
}
const serverEnv = {
  DATABASE_URL: process.env.E2E_DATABASE_URL || '',
  INTERNAL_API_KEY: process.env.DASHBOARD_API_KEY || '',
  STORAGE_ENABLED: 'true',
  AI_WORKER_ENABLED: 'false',
  SLACK_ENABLED: 'false',
  LOG_LEVEL: 'error',
  PROXY_API_URL: proxyURL,
}

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './e2e',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only - can be overridden by TEST_RETRIES env var */
  retries: process.env.TEST_RETRIES ? parseInt(process.env.TEST_RETRIES) : process.env.CI ? 2 : 0,
  /* Parallel workers - more on CI for smoke tests */
  workers: process.env.CI ? 4 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: process.env.CI
    ? [['html'], ['junit', { outputFile: 'test-results/junit.xml' }]]
    : 'html',
  /* Test timeout */
  timeout: 30000,
  /* Global timeout for the whole test run */
  globalTimeout: process.env.CI ? 10 * 60 * 1000 : undefined, // 10 minutes on CI
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL,
    extraHTTPHeaders: { 'X-Auth-Request-Email': 'test@ci.localhost' },
    colorScheme: 'light',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',

    /* Screenshot on failure */
    screenshot: 'only-on-failure',

    /* Video recording */
    video: process.env.CI ? 'retain-on-failure' : 'off',

    /* Viewport size */
    viewport: { width: 1280, height: 720 },
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },

    /* Test against mobile viewports. */
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    },
  ],

  /* Run your local dev server before starting the tests */
  webServer: startServers
    ? [
        {
          command: 'bun services/proxy/dist/main.js',
          url: `${proxyURL}/health`,
          env: { ...serverEnv, PORT: new URL(proxyURL).port },
          reuseExistingServer: false,
          timeout: 60_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
        {
          command: 'bun services/dashboard/dist/main.js',
          url: `${baseURL}/health`,
          env: { ...serverEnv, PORT: new URL(baseURL).port },
          reuseExistingServer: false,
          timeout: 60_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      ]
    : process.env.CI
      ? undefined // In CI, we'll start the server manually
      : {
          command: 'bun run dev:dashboard',
          url: 'http://localhost:3001',
          reuseExistingServer: true,
          timeout: 120 * 1000,
        },
})
