import { test, expect } from '@playwright/test'

test.describe('Dark Mode Feature', () => {
  test.beforeEach(async ({ page }) => {
    // Playwright provides fresh storage for each test, preserving it across navigation.
    // Wait for dashboard to load
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
  })

  test('should default to light mode', async ({ page }) => {
    await expect(page.getByTestId('document')).toHaveAttribute('data-theme', 'light')
    await expect(page.getByTestId('theme-icon-light')).toBeVisible()
    await expect(page.getByTestId('theme-icon-dark')).not.toBeVisible()
  })

  test('should toggle to dark mode when clicked', async ({ page }) => {
    // Initial state - light mode
    await expect(page.getByTestId('document')).toHaveAttribute('data-theme', 'light')

    // Click toggle button
    await page.getByTestId('theme-toggle').click()

    // Should switch to dark mode
    await expect(page.getByTestId('document')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByTestId('theme-icon-dark')).toBeVisible()
    await expect(page.getByTestId('theme-icon-light')).not.toBeVisible()
  })

  test('should toggle back to light mode on second click', async ({ page }) => {
    // Switch to dark mode
    await page.getByTestId('theme-toggle').click()
    await expect(page.getByTestId('document')).toHaveAttribute('data-theme', 'dark')

    // Switch back to light mode
    await page.getByTestId('theme-toggle').click()
    await expect(page.getByTestId('document')).toHaveAttribute('data-theme', 'light')
    await expect(page.getByTestId('theme-icon-light')).toBeVisible()
    await expect(page.getByTestId('theme-icon-dark')).not.toBeVisible()
  })

  test('should persist theme choice across page reloads', async ({ page }) => {
    // Switch to dark mode
    await page.getByTestId('theme-toggle').click()
    await expect(page.getByTestId('document')).toHaveAttribute('data-theme', 'dark')

    // Reload page
    await page.reload()
    await page.waitForLoadState('networkidle')

    // Should still be in dark mode
    await expect(page.getByTestId('document')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByTestId('theme-icon-dark')).toBeVisible()
  })

  test('should persist theme choice across navigation', async ({ page }) => {
    // Switch to dark mode
    await page.getByTestId('theme-toggle').click()

    // Navigate to different pages
    await page.getByTestId('requests-link').click()
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('document')).toHaveAttribute('data-theme', 'dark')

    await page.getByTestId('token-usage-link').click()
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('document')).toHaveAttribute('data-theme', 'dark')

    // Go back to dashboard
    await page.getByTestId('dashboard-link').click()
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('document')).toHaveAttribute('data-theme', 'dark')
  })

  test('should apply correct styles in dark mode', async ({ page }) => {
    // Switch to dark mode
    await page.getByTestId('theme-toggle').click()

    // Wait for CSS transitions to settle before checking the final theme colors.
    await expect(page.getByTestId('page-body')).toHaveCSS('background-color', 'rgb(15, 23, 42)')
    await expect(page.getByTestId('page-body')).toHaveCSS('color', 'rgb(241, 245, 249)')
    await expect(page.getByTestId('navigation')).toHaveCSS('background-color', 'rgb(30, 41, 59)')
  })

  test('should update highlight.js theme in dark mode', async ({ page }) => {
    // The overview omits code-viewer assets; requests includes highlight.js.
    await page.goto('/dashboard/requests')
    const lightTheme = page.getByTestId('hljs-light-theme')
    const darkTheme = page.getByTestId('hljs-dark-theme')

    await expect(lightTheme).toHaveJSProperty('disabled', false)
    await expect(darkTheme).toHaveJSProperty('disabled', true)

    // Switch to dark mode
    await page.getByTestId('theme-toggle').click()

    // Check themes switched
    await expect(lightTheme).toHaveJSProperty('disabled', true)
    await expect(darkTheme).toHaveJSProperty('disabled', false)
  })

  test('should work across all dashboard pages', async ({ page }) => {
    // Test on different routes
    const routes = ['/dashboard', '/dashboard/requests', '/dashboard/token-usage']

    for (const route of routes) {
      await page.goto(route)
      await page.waitForLoadState('networkidle')

      // Should have theme toggle on all pages
      await expect(page.getByTestId('theme-toggle')).toBeVisible()

      await page.getByTestId('theme-toggle').click()
      await expect(page.getByTestId('document')).toHaveAttribute('data-theme', 'dark')
      await page.getByTestId('theme-toggle').click()
      await expect(page.getByTestId('document')).toHaveAttribute('data-theme', 'light')
    }
  })

  test('theme toggle should be accessible via keyboard', async ({ page }) => {
    await page.getByTestId('theme-toggle').focus()
    await expect(page.getByTestId('theme-toggle')).toBeFocused()
    await page.keyboard.press('Enter')

    // Should switch to dark mode
    await expect(page.getByTestId('document')).toHaveAttribute('data-theme', 'dark')
  })

  test('should save and load theme preference correctly', async ({ page, context }) => {
    // Switch to dark mode
    await page.getByTestId('theme-toggle').click()

    // Check localStorage
    const theme = await page.evaluate(() => localStorage.getItem('theme'))
    expect(theme).toBe('dark')

    // Open new page in same context
    const newPage = await context.newPage()
    await newPage.goto('/dashboard')
    await newPage.waitForLoadState('networkidle')

    // Should load dark theme
    await expect(newPage.getByTestId('document')).toHaveAttribute('data-theme', 'dark')

    await newPage.close()
  })
})
