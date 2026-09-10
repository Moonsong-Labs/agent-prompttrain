import { test, expect } from '@playwright/test'
import { ConsoleMonitor } from '../utils/console-monitor'
import { testData } from '../fixtures/test-data'

test.describe('@smoke Dashboard Pages Smoke Tests', () => {
  test.describe.configure({ mode: 'serial' })

  for (const route of testData.dashboardRoutes) {
    test(`${route.name} (${route.path}) loads without console errors`, async ({ page }) => {
      const monitor = new ConsoleMonitor(page)
      await monitor.startMonitoring()
      const response = await page.goto(route.path)
      expect(response?.status()).toBe(200)
      await expect(page.getByTestId('navigation')).toBeVisible()
      await expect(page.getByTestId('page-content')).not.toBeEmpty()
      await expect(page.getByTestId('page-error')).toHaveCount(0)
      await expect(page).toHaveTitle(/Agent Prompt Train Dashboard/)
      await page.waitForLoadState('networkidle')
      monitor.assertNoErrors()
    })
  }

  test('404 page handles gracefully', async ({ page }) => {
    const response = await page.goto('/non-existent-page')
    expect(response?.status()).toBe(404)
  })

  test('Dashboard loads within performance budget', async ({ page }) => {
    const startTime = Date.now()
    const response = await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
    expect(response?.status()).toBe(200)
    await expect(page.getByTestId('navigation')).toBeVisible()
    expect(Date.now() - startTime).toBeLessThan(process.env.CI ? 3000 : 2000)
  })
})
