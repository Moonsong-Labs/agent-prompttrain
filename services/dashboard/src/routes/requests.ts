import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { ProxyApiClient } from '../services/api-client.js'
import { formatNumber, escapeHtml, formatRelativeTime } from '../utils/formatters.js'
import { layout } from '../layout/index.js'

export const requestsRoutes = new Hono<{
  Variables: {
    apiClient?: ProxyApiClient
    trainId?: string
  }
}>()

/**
 * Requests page - Shows recent API requests
 */
requestsRoutes.get('/requests', async c => {
  const apiClient = c.get('apiClient')
  const trainId = c.req.query('trainId')

  if (!apiClient) {
    return c.html(
      layout(
        'Error',
        html`
          <div class="error-banner">
            <strong>Error:</strong> API client not configured. Please check your configuration.
          </div>
        `
      )
    )
  }

  // Initialize default data
  let stats = {
    totalRequests: 0,
    totalTokens: 0,
    estimatedCost: 0,
    activeDomains: 0,
  }
  let recentRequests: any[] = []
  let domains: Array<{ trainId: string; requestCount: number }> = []
  let error: string | null = null

  // Fetch data from Proxy API with individual error handling
  const results = await Promise.allSettled([
    apiClient.getStats({ domain }),
    apiClient.getRequests({ trainId, limit: 20 }),
    apiClient.getDomains(),
  ])

  // Handle stats result
  if (results[0].status === 'fulfilled') {
    const statsResponse = results[0].value
    stats = {
      totalRequests: statsResponse.totalRequests,
      totalTokens: statsResponse.totalTokens,
      estimatedCost: (statsResponse.totalTokens / 1000) * 0.002,
      activeDomains: statsResponse.activeDomains,
    }
  } else {
    console.error('Failed to fetch stats:', results[0].reason)
  }

  // Handle requests result
  if (results[1].status === 'fulfilled') {
    recentRequests = results[1].value.requests
  } else {
    console.error('Failed to fetch requests:', results[1].reason)
  }

  // Handle domains result
  if (results[2].status === 'fulfilled') {
    domains = results[2].value.domains
  } else {
    console.error('Failed to fetch domains:', results[2].reason)
    // Don't show error banner for domains failure since it's not critical
  }

  // Only show error if critical data (stats or requests) failed
  if (results[0].status === 'rejected' || results[1].status === 'rejected') {
    error = 'Failed to load some dashboard data. Some features may be limited.'
  }

  const content = html`
    ${error ? html`<div class="error-banner">${error}</div>` : ''}

    <div class="mb-6">
      <a href="/dashboard" class="text-blue-600">← Back to Dashboard</a>
    </div>

    <!-- Domain Filter -->
    <div class="mb-6">
      <label class="text-sm text-gray-600">Filter by Domain:</label>
      <select
        onchange="window.location.href = '/dashboard/requests' + (this.value ? '?trainId =' + this.value : '')"
        style="margin-left: 0.5rem;"
      >
        <option value="">All Domains</option>
        ${raw(
          domains
            .map(
              d =>
                `<option value="${d.domain}" ${trainId === d.domain ? 'selected' : ''}>${d.domain} (${d.requestCount})</option>`
            )
            .join('')
        )}
      </select>
    </div>

    <!-- Stats Cards -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Requests</div>
        <div class="stat-value">${stats.totalRequests.toLocaleString()}</div>
        <div class="stat-meta">Last 24 hours</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Tokens</div>
        <div class="stat-value">${formatNumber(stats.totalTokens)}</div>
        <div class="stat-meta">Input + Output</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Estimated Cost</div>
        <div class="stat-value">$${stats.estimatedCost.toFixed(2)}</div>
        <div class="stat-meta">Based on token usage</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Active Domains</div>
        <div class="stat-value">${stats.activeDomains}</div>
        <div class="stat-meta">Unique domains</div>
      </div>
    </div>

    <!-- Recent Requests -->
    <div class="section">
      <div class="section-header">
        Recent Requests
        <a
          href="/dashboard/requests${domain ? '?trainId =' + domain : ''}"
          class="btn btn-secondary"
          style="float: right; font-size: 0.75rem; padding: 0.25rem 0.75rem;"
          >Refresh</a
        >
      </div>
      <div class="section-content">
        ${recentRequests.length === 0
          ? html` <p class="text-gray-500">No requests found</p> `
          : html`
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Domain</th>
                    <th>Model</th>
                    <th>Tokens</th>
                    <th>Status</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  ${raw(
                    recentRequests
                      .map(
                        req => `
                <tr>
                  <td class="text-sm">${formatRelativeTime(req.timestamp)}</td>
                  <td class="text-sm">${escapeHtml(req.domain)}</td>
                  <td class="text-sm">${req.model || 'N/A'}</td>
                  <td class="text-sm">${formatNumber(req.totalTokens || 0)}</td>
                  <td class="text-sm">${req.responseStatus || 'N/A'}</td>
                  <td class="text-sm">
                    <a href="/dashboard/request/${req.requestId}" class="text-blue-600">View</a>
                  </td>
                </tr>
              `
                      )
                      .join('')
                  )}
                </tbody>
              </table>
            `}
      </div>
    </div>
  `

  return c.html(layout('Requests', content))
})
