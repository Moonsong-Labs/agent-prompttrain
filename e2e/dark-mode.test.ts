import { test, expect } from '@playwright/test'

test.describe('Dark Mode Feature', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage before each test
    await page.addInitScript(() => {
      window.localStorage.clear()
    })

    // Wait for dashboard to load
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
  })

  test('should default to light mode', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(page.locator('#theme-icon-light')).toBeVisible()
    await expect(page.locator('#theme-icon-dark')).not.toBeVisible()
  })

  test('should toggle to dark mode when clicked', async ({ page }) => {
    // Initial state - light mode
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

    // Click toggle button
    await page.click('#theme-toggle')

    // Should switch to dark mode
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('#theme-icon-dark')).toBeVisible()
    await expect(page.locator('#theme-icon-light')).not.toBeVisible()
  })

  test('should toggle back to light mode on second click', async ({ page }) => {
    // Switch to dark mode
    await page.click('#theme-toggle')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    // Switch back to light mode
    await page.click('#theme-toggle')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(page.locator('#theme-icon-light')).toBeVisible()
    await expect(page.locator('#theme-icon-dark')).not.toBeVisible()
  })

  test('should persist theme choice across page reloads', async ({ page }) => {
    // Switch to dark mode
    await page.click('#theme-toggle')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    // Reload page
    await page.reload()
    await page.waitForLoadState('networkidle')

    // Should still be in dark mode
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('#theme-icon-dark')).toBeVisible()
  })

  test('should persist theme choice across navigation', async ({ page }) => {
    // Switch to dark mode
    await page.click('#theme-toggle')

    // Navigate to different pages
    await page.click('a[href="/dashboard/requests"]')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    await page.click('a[href="/dashboard/token-usage"]')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    // Go back to dashboard
    await page.click('a[href="/dashboard"]')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })

  test('should apply correct styles in dark mode', async ({ page }) => {
    // Switch to dark mode
    await page.click('#theme-toggle')

    // Check background color changed
    const bodyBgColor = await page
      .locator('body')
      .evaluate(el => window.getComputedStyle(el).backgroundColor)
    expect(bodyBgColor).toBe('rgb(15, 23, 42)') // --bg-primary dark (#0f172a)

    // Check text color changed
    const textColor = await page.locator('body').evaluate(el => window.getComputedStyle(el).color)
    expect(textColor).toBe('rgb(241, 245, 249)') // --text-primary dark (#f1f5f9)

    // Check nav background
    const navBgColor = await page
      .locator('nav')
      .evaluate(el => window.getComputedStyle(el).backgroundColor)
    expect(navBgColor).toBe('rgb(30, 41, 59)') // --bg-secondary dark (#1e293b)
  })

  test('should update highlight.js theme in dark mode', async ({ page }) => {
    // Check initial state
    const lightTheme = page.locator('#hljs-light-theme')
    const darkTheme = page.locator('#hljs-dark-theme')

    await expect(lightTheme).toHaveAttribute('disabled', '')
    await expect(darkTheme).toHaveAttribute('disabled', 'disabled')

    // Switch to dark mode
    await page.click('#theme-toggle')

    // Check themes switched
    await expect(lightTheme).toHaveAttribute('disabled', 'disabled')
    await expect(darkTheme).toHaveAttribute('disabled', '')
  })

  test('should work across all dashboard pages', async ({ page }) => {
    // Test on different routes
    const routes = [
      '/dashboard',
      '/dashboard/requests',
      '/dashboard/token-usage',
    ]

    for (const route of routes) {
      await page.goto(route)
      await page.waitForLoadState('networkidle')

      // Should have theme toggle on all pages
      await expect(page.locator('#theme-toggle')).toBeVisible()

      // Switch to dark mode
      await page.click('#theme-toggle')
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    }
  })

  test('theme toggle should be accessible via keyboard', async ({ page }) => {
    // Focus on theme toggle button
    await page.keyboard.press('Tab') // Skip navigation links
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')

    // Press Enter to toggle
    await page.keyboard.press('Enter')

    // Should switch to dark mode
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })

  test('should save and load theme preference correctly', async ({ page, context }) => {
    // Switch to dark mode
    await page.click('#theme-toggle')

    // Check localStorage
    const theme = await page.evaluate(() => localStorage.getItem('theme'))
    expect(theme).toBe('dark')

    // Open new page in same context
    const newPage = await context.newPage()
    await newPage.goto('/dashboard')
    await newPage.waitForLoadState('networkidle')

    // Should load dark theme
    await expect(newPage.locator('html')).toHaveAttribute('data-theme', 'dark')

    await newPage.close()
  })
})
