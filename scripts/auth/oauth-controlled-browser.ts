import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000
const EMAIL_FIELD_TIMEOUT_MS = 20_000
const EMAIL_SUBMISSION_TIMEOUT_MS = 30_000
const TYPING_DELAY_MS = 60
const EMAIL_INPUT_SELECTOR =
  'input[type="email"], input[name="email"], input[autocomplete="email"], input[id*="email" i]'
const BOT_CHALLENGE_PATTERN =
  /security verification|just a moment|verify you are (?:not a bot|human)/i
const EMAIL_SENT_PATTERN = /click the link sent|verification code|check your email/i

/**
 * claude.ai sits behind a Cloudflare bot challenge that rejects the login form when Chrome
 * advertises itself as automated, so the launch options below hide the automation fingerprint.
 */
export type EmailSubmissionResult = 'submitted' | 'challenged' | 'unavailable'

export interface ControlledOAuthBrowser {
  openAuthorization(url: string): Promise<void>
  submitAccountEmail(accountEmail: string): Promise<EmailSubmissionResult>
  openLoginLink(url: string): Promise<void>
  waitForAuthorizationCode(expectedState: string, timeoutMs?: number): Promise<string>
  close(): Promise<void>
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function authorizationCodeFromUrl(value: string, expectedState: string): string | null {
  try {
    const url = new URL(value)
    const queryCode = url.searchParams.get('code')
    const queryState = url.searchParams.get('state')
    if (queryCode && queryState === expectedState) {
      return `${queryCode}#${queryState}`
    }

    const fragment = new URLSearchParams(url.hash.replace(/^#/, ''))
    const fragmentCode = fragment.get('code')
    const fragmentState = fragment.get('state')
    if (fragmentCode && fragmentState === expectedState) {
      return `${fragmentCode}#${fragmentState}`
    }
  } catch {
    // Most candidates are page text rather than URLs.
  }
  return null
}

export function extractAuthorizationCode(
  candidates: string[],
  expectedState: string
): string | null {
  const escapedState = escapeRegExp(expectedState)
  const codePattern = new RegExp(`([^\\s#"'<>]+)#${escapedState}(?=$|[\\s"'<>])`)

  for (const candidate of candidates) {
    const fromUrl = authorizationCodeFromUrl(candidate, expectedState)
    if (fromUrl) {
      return fromUrl
    }

    const match = candidate.match(codePattern)
    if (match?.[1]) {
      return `${match[1]}#${expectedState}`
    }
  }
  return null
}

class PlaywrightOAuthBrowser implements ControlledOAuthBrowser {
  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page
  ) {}

  async openAuthorization(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' })
  }

  async submitAccountEmail(accountEmail: string): Promise<EmailSubmissionResult> {
    await this.dismissCookieBanner()

    const emailInput = this.page.locator(EMAIL_INPUT_SELECTOR).first()

    try {
      await emailInput.waitFor({ state: 'visible', timeout: EMAIL_FIELD_TIMEOUT_MS })
      await emailInput.click()
      await emailInput.pressSequentially(accountEmail, { delay: TYPING_DELAY_MS })

      const submitButton = this.page.getByRole('button', { name: /continue with email/i }).first()
      if ((await submitButton.count()) > 0) {
        await submitButton.click()
      } else {
        await emailInput.press('Enter')
      }
    } catch {
      return 'unavailable'
    }

    return this.waitForEmailSubmission(accountEmail)
  }

  private async dismissCookieBanner(): Promise<void> {
    const accept = this.page.getByRole('button', { name: /accept all cookies/i }).first()
    if ((await accept.count().catch(() => 0)) > 0) {
      await accept.click({ timeout: 5_000 }).catch(() => undefined)
    }
  }

  private async waitForEmailSubmission(accountEmail: string): Promise<EmailSubmissionResult> {
    const deadline = Date.now() + EMAIL_SUBMISSION_TIMEOUT_MS
    let pageText = ''

    while (Date.now() < deadline) {
      pageText = await this.page
        .locator('body')
        .innerText({ timeout: 1_000 })
        .catch(() => '')

      if (pageText.includes(accountEmail) && EMAIL_SENT_PATTERN.test(pageText)) {
        return 'submitted'
      }

      await this.page.waitForTimeout(500)
    }

    return BOT_CHALLENGE_PATTERN.test(pageText) || this.page.url().includes('challenge')
      ? 'challenged'
      : 'unavailable'
  }

  async openLoginLink(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' })
  }

  async waitForAuthorizationCode(
    expectedState: string,
    timeoutMs = Number(process.env.OAUTH_APPROVAL_TIMEOUT_MS) || DEFAULT_APPROVAL_TIMEOUT_MS
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (this.page.isClosed()) {
        throw new Error('The OAuth browser was closed before authorization completed.')
      }

      const pageText = await this.page
        .locator('body')
        .innerText({ timeout: 1_000 })
        .catch(() => '')
      const fieldValues = await this.page
        .locator('input, textarea, code, pre')
        .evaluateAll(elements =>
          elements.map(element => {
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
              return element.value
            }
            return element.textContent || ''
          })
        )
        .catch(() => [] as string[])
      const code = extractAuthorizationCode(
        [this.page.url(), pageText, ...fieldValues],
        expectedState
      )
      if (code) {
        return code
      }

      await this.page.waitForTimeout(500)
    }

    throw new Error('Timed out waiting for Anthropic authorization approval.')
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined)
    await this.browser.close().catch(() => undefined)
  }
}

export async function launchControlledOAuthBrowser(): Promise<ControlledOAuthBrowser> {
  const configuredChannel = (process.env.OAUTH_BROWSER_CHANNEL || 'chrome').trim()
  let browser: Browser

  const launchOptions = {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  }

  try {
    browser = await chromium.launch({
      ...launchOptions,
      channel: configuredChannel || undefined,
    })
  } catch (error) {
    if (!configuredChannel) {
      throw error
    }
    browser = await chromium.launch(launchOptions)
  }

  try {
    const context = await browser.newContext({ viewport: null })
    const page = await context.newPage()
    return new PlaywrightOAuthBrowser(browser, context, page)
  } catch (error) {
    await browser.close().catch(() => undefined)
    throw error
  }
}
