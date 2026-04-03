import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { ProxyApiClient } from '../services/api-client.js'
import { container } from '../container.js'

export const publicTokenUsageRoutes = new Hono()

/**
 * Format ISO timestamp to human-readable time left (e.g. "2d 5h 30m")
 */
function formatTimeLeft(isoTimestamp: string): string {
  const resetDate = new Date(isoTimestamp)
  const now = new Date()
  const diffMs = resetDate.getTime() - now.getTime()

  if (diffMs <= 0) {
    return '<span style="font-family: monospace;">now</span>'
  }

  const totalMins = Math.floor(diffMs / (1000 * 60))
  const days = Math.floor(totalMins / (60 * 24))
  const hours = Math.floor((totalMins % (60 * 24)) / 60)
  const mins = totalMins % 60

  const parts: string[] = []

  if (days > 0) {
    parts.push(
      `<span style="display: inline-block; width: 2ch; text-align: right;">${days}</span>d`
    )
  } else {
    parts.push('<span style="display: inline-block; width: 3ch;"></span>')
  }

  if (days > 0 || hours > 0) {
    parts.push(
      `<span style="display: inline-block; width: 2ch; text-align: right;">${hours}</span>h`
    )
  } else {
    parts.push('<span style="display: inline-block; width: 3ch;"></span>')
  }

  parts.push(`<span style="display: inline-block; width: 2ch; text-align: right;">${mins}</span>m`)

  return `<span style="font-family: monospace; white-space: pre;">${parts.join(' ')}</span>`
}

/**
 * Format ISO timestamp to relative time (e.g. "5 minutes ago")
 */
function formatRelativeTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()

  if (diffMs < 60_000) {
    return 'just now'
  }
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) {
    return `${mins} minute${mins === 1 ? '' : 's'} ago`
  }
  const hours = Math.floor(mins / 60)
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`
  }
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Get progress bar color based on utilization percentage
 */
function getBarColor(utilization: number): string {
  if (utilization > 80) {
    return '#ef4444'
  }
  if (utilization > 50) {
    return '#fb923c'
  }
  return '#10b981'
}

/**
 * Public token usage status page — no authentication required.
 * Shows OAuth usage (5h/7d windows) for all accounts from the Anthropic API.
 */
publicTokenUsageRoutes.get('/token-usage', async c => {
  const apiClient = container.getApiClient() as ProxyApiClient

  try {
    // Fetch account list to get account IDs
    const accountsData = await apiClient.getAccountsTokenUsage()

    // Fetch OAuth usage for all accounts in parallel
    const oauthResults = await Promise.all(
      accountsData.accounts.map(account =>
        apiClient
          .getOAuthUsage(account.accountId)
          .then(data => ({ accountId: account.accountId, data }))
          .catch(() => ({ accountId: account.accountId, data: null }))
      )
    )

    // Build account rows HTML — only show accounts with Anthropic OAuth usage data
    const accountRows = oauthResults
      .filter(({ data }) => data?.available && data.windows.length > 0)
      .map(({ accountId, data: oauthData }) => {
        // data is guaranteed non-null by the filter above
        const data = oauthData!

        const windowBars = data.windows
          .map(w => {
            const color = getBarColor(w.utilization)
            const timeLeft = formatTimeLeft(w.resets_at_iso)
            return `
            <div class="window-row">
              <div class="window-label">${escapeHtml(w.name)}</div>
              <div class="bar-container">
                <div class="bar-bg">
                  <div class="bar-fill" style="background: ${color}; width: ${Math.min(100, w.utilization)}%;"></div>
                  <div class="bar-text">${w.utilization.toFixed(1)}%</div>
                </div>
              </div>
              <div class="time-left"><strong>${timeLeft}</strong> left</div>
            </div>`
          })
          .join('')

        const lastCheckedText = data.is_estimated
          ? `&#9888; Est. ${formatRelativeTime(data.fetched_at)}`
          : formatRelativeTime(data.fetched_at)

        const lastCheckedColor = data.is_estimated ? '#92400e' : '#9ca3af'

        return `
        <div class="card">
          <div class="card-header">
            <span class="account-name">${escapeHtml(accountId)}</span>
            <span class="last-checked" style="color: ${lastCheckedColor};">${lastCheckedText}</span>
          </div>
          <div class="windows">${windowBars}</div>
        </div>`
      })
      .join('')

    const page = html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Token Usage Status</title>
          <style>
            * {
              box-sizing: border-box;
              margin: 0;
              padding: 0;
            }
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              background: #f9fafb;
              color: #1f2937;
              padding: 16px;
            }
            h1 {
              font-size: 18px;
              font-weight: 700;
              margin-bottom: 12px;
              color: #111827;
            }
            .grid {
              display: grid;
              grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
              gap: 8px;
            }
            .card {
              background: #fff;
              border: 1px solid #e5e7eb;
              border-radius: 6px;
              padding: 10px 12px;
            }
            .card-header {
              display: flex;
              align-items: baseline;
              justify-content: space-between;
              margin-bottom: 6px;
            }
            .account-name {
              font-size: 14px;
              font-weight: 600;
              color: #1f2937;
            }
            .last-checked {
              font-size: 11px;
              color: #9ca3af;
            }
            .windows {
              display: grid;
              gap: 4px;
            }
            .window-row {
              display: flex;
              align-items: center;
              gap: 8px;
            }
            .window-label {
              min-width: 90px;
              font-size: 12px;
              font-weight: 500;
              color: #374151;
            }
            .bar-container {
              flex: 1;
              max-width: 180px;
            }
            .bar-bg {
              position: relative;
              background: #f3f4f6;
              height: 18px;
              border-radius: 3px;
              overflow: hidden;
            }
            .bar-fill {
              position: absolute;
              left: 0;
              top: 0;
              height: 100%;
              transition: width 0.3s ease;
            }
            .bar-text {
              position: absolute;
              left: 0;
              top: 0;
              width: 100%;
              height: 100%;
              display: flex;
              align-items: center;
              justify-content: center;
              font-weight: 600;
              font-size: 11px;
              color: #1f2937;
            }
            .time-left {
              min-width: 90px;
              font-size: 11px;
              color: #6b7280;
            }
          </style>
        </head>
        <body>
          <h1>Token Usage Status</h1>
          <div class="grid">${raw(accountRows)}</div>
        </body>
      </html>`

    return c.html(page)
  } catch {
    const page = html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Token Usage Status</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              background: #f9fafb;
              color: #1f2937;
              padding: 16px;
            }
          </style>
        </head>
        <body>
          <h1 style="font-size: 18px; margin-bottom: 12px;">Token Usage Status</h1>
          <div
            style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 12px; color: #991b1b; font-size: 13px;"
          >
            <strong>Error:</strong> Unable to load token usage data. Please try again later.
          </div>
        </body>
      </html>`

    return c.html(page, 500)
  }
})
