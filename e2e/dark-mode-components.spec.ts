import { test, expect } from '@playwright/test'
import { testData } from './fixtures/test-data'

test.describe('Dark Mode Component Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByTestId('theme-toggle').click()
    await expect(page.getByTestId('document')).toHaveAttribute('data-theme', 'dark')
  })

  test('navigation bar should have proper contrast in dark mode', async ({ page }) => {
    await expect(page.getByTestId('navigation')).toHaveCSS('background-color', 'rgb(30, 41, 59)')
    await expect(page.getByTestId('navigation-title')).toHaveCSS('color', 'rgb(241, 245, 249)')
    await expect(page.getByTestId('dashboard-link')).toHaveCSS('color', 'rgb(96, 165, 250)')
  })

  test('tables should be readable in dark mode', async ({ page }) => {
    await page.goto('/dashboard/requests')
    await expect(page.getByTestId('requests-table')).toBeVisible()
    await expect(page.getByTestId('requests-table-heading')).toHaveCSS(
      'color',
      'rgb(203, 213, 225)'
    )
    await expect(page.getByTestId('requests-table-heading')).toHaveCSS(
      'border-bottom-color',
      'rgb(51, 65, 85)'
    )
  })

  test('stat cards should have proper styling in dark mode', async ({ page }) => {
    await expect(page.getByTestId('stat-card').first()).toHaveCSS(
      'background-color',
      'rgb(30, 41, 59)'
    )
    await expect(page.getByTestId('stat-label').first()).toHaveCSS('color', 'rgb(203, 213, 225)')
  })

  test('secondary buttons should have proper hover states in dark mode', async ({ page }) => {
    const button = page.getByTestId('conversation-search-submit')
    await expect(button).toHaveCSS('background-color', 'rgb(71, 85, 105)')
    await button.hover()
    await expect(button).toHaveCSS('background-color', 'rgb(100, 116, 139)')
  })

  test('search remains usable in dark mode', async ({ page }) => {
    await page.getByTestId('conversation-search').fill(testData.projectId)
    await page.getByTestId('conversation-search-submit').click()
    await expect(page.getByTestId('conversation-link')).toBeVisible()
    await expect(page.getByTestId('document')).toHaveAttribute('data-theme', 'dark')
  })

  test('request messages remain visible in dark mode', async ({ page }) => {
    await page.goto(`/dashboard/request/${testData.requestId}`)
    await expect(page.getByTestId('document')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByTestId('page-content')).toContainText('E2E test message')
    await expect(page.getByTestId('page-content')).toContainText('E2E test response')
  })

  test('token usage charts remain visible in dark mode', async ({ page }) => {
    await page.getByTestId('token-usage-link').click()
    await expect(page.getByTestId('document')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByTestId('token-usage-chart').first()).toBeVisible()
  })

  test('theme toggle button should remain visible and functional', async ({ page }) => {
    const toggle = page.getByTestId('theme-toggle')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveCSS('border-top-color', 'rgb(51, 65, 85)')
    await page.getByTestId('navigation-title').hover()
    await expect(toggle).toHaveCSS('color', 'rgb(203, 213, 225)')
    await toggle.hover()
    await expect(toggle).toHaveCSS('background-color', 'rgb(51, 65, 85)')
  })
})
