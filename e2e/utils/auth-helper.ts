import { Page, Browser, BrowserContext } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const AUTH_FILE = path.join(__dirname, '../../.auth/user.json')

export class AuthHelper {
  private userEmail: string
  private baseUrl: string

  constructor(userEmail?: string, baseUrl?: string) {
    // Use test user email - simulates oauth2-proxy header
    this.userEmail =
      userEmail ||
      process.env.DASHBOARD_DEV_USER_EMAIL ||
      (process.env.CI ? 'test@ci.localhost' : 'test@localhost')
    this.baseUrl = baseUrl || process.env.TEST_BASE_URL || 'http://localhost:3001'
  }

  /**
   * Perform authentication by simulating oauth2-proxy headers and save storage state
   */
  async authenticate(page: Page): Promise<void> {
    // Set oauth2-proxy authentication headers on the page context
    // This simulates what oauth2-proxy would pass to the dashboard
    await page.context().setExtraHTTPHeaders({
      'X-Auth-Request-Email': this.userEmail,
    })

    // Navigate to dashboard
    const response = await page.goto(this.baseUrl, {
      waitUntil: 'networkidle',
      timeout: 30000,
    })

    // Check if we got a successful response
    if (!response || response.status() !== 200) {
      throw new Error(`Failed to load dashboard: ${response?.status()}`)
    }

    // The dashboard should accept the oauth2-proxy header auth
    // We don't need to wait for a cookie as header auth is sufficient

    // Save the storage state for reuse (even if empty, for consistency)
    await this.saveStorageState(page)
  }

  /**
   * Save the current storage state (cookies, localStorage)
   */
  async saveStorageState(page: Page): Promise<void> {
    const context = page.context()

    // Ensure directory exists
    const authDir = path.dirname(AUTH_FILE)
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true })
    }

    // Save storage state
    await context.storageState({ path: AUTH_FILE })
  }

  /**
   * Load saved storage state into a new context
   */
  async loadStorageState(browser: Browser): Promise<BrowserContext> {
    // Check if auth file exists
    if (!fs.existsSync(AUTH_FILE)) {
      throw new Error('Authentication file not found. Run authenticate() first.')
    }

    // Create context with saved storage state
    const context = await browser.newContext({
      storageState: AUTH_FILE,
    })

    return context
  }

  /**
   * Check if storage state file exists
   */
  hasStorageState(): boolean {
    return fs.existsSync(AUTH_FILE)
  }

  /**
   * Clear saved authentication
   */
  clearAuth(): void {
    if (fs.existsSync(AUTH_FILE)) {
      fs.unlinkSync(AUTH_FILE)
    }
  }

  /**
   * Setup authentication for a page (adds oauth2-proxy headers)
   */
  async setupPageAuth(page: Page): Promise<void> {
    // Add oauth2-proxy header to all requests
    await page.setExtraHTTPHeaders({
      'X-Auth-Request-Email': this.userEmail,
    })
  }

  /**
   * Check if authentication is still valid
   */
  async isAuthValid(page: Page): Promise<boolean> {
    try {
      // Try to access a protected route
      const response = await page.goto(`${this.baseUrl}/api/requests`, {
        waitUntil: 'domcontentloaded',
      })

      return response?.status() === 200
    } catch {
      return false
    }
  }

  /**
   * Get authenticated context with retries
   */
  async getAuthenticatedContext(browser: Browser, retries: number = 2): Promise<BrowserContext> {
    // Create a context with oauth2-proxy headers
    // This simulates what oauth2-proxy would pass to the dashboard

    for (let i = 0; i <= retries; i++) {
      try {
        // Create context with oauth2-proxy authentication headers
        const context = await browser.newContext({
          extraHTTPHeaders: {
            'X-Auth-Request-Email': this.userEmail,
          },
        })

        // Verify the context works by testing a simple request
        const page = await context.newPage()
        const response = await page.goto(this.baseUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        })

        if (!response || (response.status() !== 200 && response.status() !== 304)) {
          await page.close()
          await context.close()
          throw new Error(`Dashboard returned status ${response?.status()}`)
        }

        await page.close()
        return context
      } catch (error) {
        if (i === retries) {
          throw new Error(
            `Failed to create authenticated context after ${retries + 1} attempts: ${error}`
          )
        }
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }

    throw new Error('Authentication failed')
  }
}
