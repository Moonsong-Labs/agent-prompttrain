import { test, expect } from '@playwright/test'
import { ConsoleMonitor } from '../utils/console-monitor'
import { testData } from '../fixtures/test-data'

test.describe('@journey Critical User Journeys', () => {
  test.describe.configure({ mode: 'serial' })
  let monitor: ConsoleMonitor | undefined

  test.beforeEach(async ({ page }) => {
    monitor = new ConsoleMonitor(page)
    await monitor.startMonitoring()
  })

  test.afterEach(async ({ page }) => {
    if (!page.isClosed()) await page.waitForLoadState('networkidle')
    monitor?.assertNoErrors()
  })

  test('Journey 1: View request details flow', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByTestId('requests-link').click()
    await expect(page).toHaveURL(/\/dashboard\/requests$/)
    await expect(page.getByTestId('request-row')).toContainText(testData.projectId)
    await page.getByTestId('request-link').click()
    await expect(page).toHaveURL(`/dashboard/request/${testData.requestId}`)
    await expect(page.getByTestId('page-content')).toContainText('E2E test message')
    await expect(page.getByTestId('page-content')).toContainText('E2E test response')
  })

  test('Journey 2: Check token usage and analytics', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByTestId('token-usage-link').click()
    await expect(page).toHaveURL(/\/dashboard\/token-usage$/)
    await expect(page.getByTestId('token-usage-heading')).toContainText('Token Usage')
    await expect(page.getByTestId('page-content')).toContainText(testData.accountId)
    await expect(page.getByTestId('token-usage-chart').first()).toBeVisible()
  })

  test('Journey 3: Navigate conversation tree', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByTestId('conversation-link').click()
    await expect(page).toHaveURL(`/dashboard/conversation/${testData.conversationId}`)
    await expect(page.getByTestId('tree-container')).not.toBeEmpty()
    await expect(page.getByTestId('tree-panel')).toBeVisible()
    await page.getByTestId('timeline-tab').click()
    await expect(page.getByTestId('timeline-panel')).toBeVisible()
    await expect(page.getByTestId('tree-panel')).not.toBeVisible()
  })

  test('Journey 4: Search conversations and filter requests', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByTestId('conversation-search').fill(testData.projectId)
    await page.getByTestId('conversation-search-submit').click()
    await expect(page.getByTestId('conversation-link')).toHaveCount(1)
    await page.getByTestId('conversation-search').fill('no-matching-e2e-conversation')
    await page.getByTestId('conversation-search-submit').click()
    await expect(page.getByTestId('conversation-link')).toHaveCount(0)

    await page.getByTestId('requests-link').click()
    await page.getByTestId('project-filter').selectOption(testData.projectId)
    await expect(page).toHaveURL(/projectId=project-e2e/)
    await expect(page.getByTestId('request-row')).toContainText(testData.projectId)
  })

  test('Journey 5: View AI analysis results', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByTestId('conversation-link').click()
    await page.getByTestId('analytics-tab').click()
    await expect(page.getByTestId('analysis-panel')).toBeVisible()
    await expect(page.getByTestId('analysis-panel')).toContainText(testData.analysis)
  })

  test('Journey 6: Dashboard navigation performance', async ({ page }) => {
    const durations: number[] = []
    for (const { path } of testData.dashboardRoutes) {
      const startTime = Date.now()
      const response = await page.goto(path, { waitUntil: 'domcontentloaded' })
      expect(response?.status()).toBe(200)
      await expect(page.getByTestId('navigation')).toBeVisible()
      durations.push(Date.now() - startTime)
      expect(durations.at(-1)).toBeLessThan(process.env.CI ? 3000 : 2000)
    }
    const average = durations.reduce((sum, duration) => sum + duration, 0) / durations.length
    expect(average).toBeLessThan(process.env.CI ? 2000 : 1500)
  })
})
