import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { setCookie } from 'hono/cookie'
import { Pool } from 'pg'

export const dashboardRoutes = new Hono<{
  Variables: {
    pool?: Pool
    domain?: string
  }
}>()

/**
 * Dashboard HTML layout template
 */
const layout = (title: string, content: any) => html`
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${title} - Claude Nexus Dashboard</title>
      <style>
        * {
          box-sizing: border-box;
        }
        body {
          margin: 0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          line-height: 1.5;
          color: #1f2937;
          background-color: #f9fafb;
        }
        .container {
          max-width: 1280px;
          margin: 0 auto;
          padding: 0 1rem;
        }
        nav {
          background: white;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
          border-bottom: 1px solid #e5e7eb;
        }
        nav .container {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1rem;
        }
        h1 {
          font-size: 1.25rem;
          font-weight: 600;
          margin: 0;
        }
        h3 {
          font-size: 1.125rem;
          font-weight: 500;
          margin: 0 0 1rem 0;
        }

        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 1rem;
          margin-bottom: 2rem;
        }
        .stat-card {
          background: white;
          padding: 1.5rem;
          border-radius: 0.5rem;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        }
        .stat-label {
          font-size: 0.875rem;
          color: #6b7280;
        }
        .stat-value {
          font-size: 1.5rem;
          font-weight: 700;
          margin: 0.5rem 0;
        }
        .stat-meta {
          font-size: 0.75rem;
          color: #9ca3af;
        }

        .section {
          background: white;
          border-radius: 0.5rem;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
          margin-bottom: 1.5rem;
        }
        .section-header {
          padding: 1rem 1.5rem;
          border-bottom: 1px solid #e5e7eb;
          font-weight: 500;
        }
        .section-content {
          padding: 1.5rem;
        }

        table {
          width: 100%;
          border-collapse: collapse;
        }
        th {
          text-align: left;
          padding: 0.75rem;
          border-bottom: 1px solid #e5e7eb;
          font-size: 0.875rem;
          color: #6b7280;
        }
        td {
          padding: 0.75rem;
          border-bottom: 1px solid #f3f4f6;
        }
        tr:hover {
          background-color: #f9fafb;
        }

        .btn {
          display: inline-block;
          padding: 0.5rem 1rem;
          background: #3b82f6;
          color: white;
          text-decoration: none;
          border-radius: 0.375rem;
          font-size: 0.875rem;
          border: none;
          cursor: pointer;
        }
        .btn:hover {
          background: #2563eb;
        }
        .btn-secondary {
          background: #6b7280;
        }
        .btn-secondary:hover {
          background: #4b5563;
        }

        select {
          padding: 0.5rem;
          border: 1px solid #d1d5db;
          border-radius: 0.375rem;
          font-size: 1rem;
          background: white;
        }

        .text-sm {
          font-size: 0.875rem;
        }
        .text-gray-500 {
          color: #6b7280;
        }
        .text-gray-600 {
          color: #4b5563;
        }
        .text-blue-600 {
          color: #2563eb;
        }
        .mb-6 {
          margin-bottom: 1.5rem;
        }
        .space-x-4 > * + * {
          margin-left: 1rem;
        }
      </style>
      <script src="https://unpkg.com/htmx.org@1.9.10"></script>
    </head>
    <body>
      <nav>
        <div class="container">
          <h1>Claude Nexus Dashboard</h1>
          <div class="space-x-4">
            <span class="text-sm text-gray-600" id="current-domain">All Domains</span>
            <a href="/dashboard/logout" class="text-sm text-blue-600">Logout</a>
          </div>
        </div>
      </nav>
      <main class="container" style="padding: 2rem 1rem;">${content}</main>
    </body>
  </html>
`

/**
 * Main dashboard page - Server-side rendered, no client-side updates
 */
dashboardRoutes.get('/', async c => {
  const pool = c.get('pool')
  const domain = c.req.query('domain')

  // Get stats from database
  const stats = {
    totalRequests: 0,
    totalTokens: 0,
    estimatedCost: 0,
    activeDomains: 0,
    recentRequests: [] as any[],
  }

  if (pool) {
    try {
      // Get basic stats
      const statsQuery = `
        SELECT 
          COUNT(*) as total_requests,
          SUM(COALESCE(total_tokens, COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0), 0)) as total_tokens,
          COUNT(DISTINCT domain) as active_domains
        FROM api_requests
        WHERE timestamp > NOW() - INTERVAL '24 hours'
        ${domain ? 'AND domain = $1' : ''}
      `

      const statsResult = await pool.query(statsQuery, domain ? [domain] : [])
      const row = statsResult.rows[0]

      stats.totalRequests = parseInt(row.total_requests) || 0
      stats.totalTokens = parseInt(row.total_tokens) || 0
      stats.activeDomains = parseInt(row.active_domains) || 0
      stats.estimatedCost = (stats.totalTokens / 1000) * 0.002 // Rough estimate

      // Get recent requests
      const requestsQuery = `
        SELECT 
          request_id,
          domain,
          model,
          COALESCE(total_tokens, COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0), 0) as total_tokens,
          input_tokens,
          output_tokens,
          timestamp,
          response_status
        FROM api_requests
        ${domain ? 'WHERE domain = $1' : ''}
        ORDER BY timestamp DESC
        LIMIT 20
      `

      const requestsResult = await pool.query(requestsQuery, domain ? [domain] : [])
      stats.recentRequests = requestsResult.rows
    } catch (error) {
      console.error('Failed to get stats:', error)
    }
  }

  // Get list of domains for filter
  let domains: string[] = []
  if (pool) {
    try {
      const domainsResult = await pool.query(
        'SELECT DISTINCT domain FROM api_requests ORDER BY domain'
      )
      domains = domainsResult.rows.map(r => r.domain)
    } catch (error) {
      console.error('Failed to get domains:', error)
    }
  }

  const content = html`
    <!-- Domain Filter -->
    <div class="mb-6">
      <label class="text-sm text-gray-600">Filter by Domain:</label>
      <select
        onchange="window.location.href = '/dashboard' + (this.value ? '?domain=' + this.value : '')"
        style="margin-left: 0.5rem;"
      >
        <option value="">All Domains</option>
        ${raw(
          domains
            .map(d => `<option value="${d}" ${domain === d ? 'selected' : ''}>${d}</option>`)
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
          href="/dashboard"
          class="btn btn-secondary"
          style="float: right; font-size: 0.75rem; padding: 0.25rem 0.75rem;"
          >Refresh</a
        >
      </div>
      <div class="section-content">
        ${stats.recentRequests.length === 0
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
                  </tr>
                </thead>
                <tbody>
                  ${raw(
                    stats.recentRequests
                      .map(
                        req => `
                <tr>
                  <td class="text-sm">${formatTimestamp(req.timestamp)}</td>
                  <td class="text-sm">${req.domain}</td>
                  <td class="text-sm">${req.model || 'N/A'}</td>
                  <td class="text-sm">${formatNumber(req.total_tokens || 0)}</td>
                  <td class="text-sm">${req.response_status || 'N/A'}</td>
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

  return c.html(layout('Dashboard', content))
})

/**
 * Login page
 */
dashboardRoutes.get('/login', c => {
  const content = html`
    <div
      style="max-width: 400px; margin: 4rem auto; background: white; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);"
    >
      <h2 style="margin: 0 0 1.5rem 0;">Dashboard Login</h2>
      <form method="POST" action="/dashboard/login">
        <div style="margin-bottom: 1rem;">
          <label style="display: block; margin-bottom: 0.5rem; font-size: 0.875rem; color: #374151;"
            >API Key</label
          >
          <input
            type="password"
            name="key"
            required
            style="width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.375rem;"
            placeholder="Enter your dashboard API key"
          />
        </div>
        <button type="submit" class="btn" style="width: 100%;">Login</button>
      </form>
      <p style="margin-top: 1rem; font-size: 0.875rem; color: #6b7280; text-align: center;">
        Set DASHBOARD_API_KEY environment variable
      </p>
    </div>
  `

  return c.html(layout('Login', content))
})

/**
 * Handle login POST
 */
dashboardRoutes.post('/login', async c => {
  const { key } = await c.req.parseBody()

  if (key === process.env.DASHBOARD_API_KEY) {
    setCookie(c, 'dashboard_auth', key as string, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    })
    return c.redirect('/dashboard')
  }

  return c.redirect('/dashboard/login?error=invalid')
})

/**
 * Logout
 */
dashboardRoutes.get('/logout', c => {
  setCookie(c, 'dashboard_auth', '', { maxAge: 0 })
  return c.redirect('/dashboard/login')
})

// Helper functions
function formatNumber(num: number): string {
  if (!num) {
    return '0'
  }
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M'
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K'
  }
  return num.toString()
}

function formatTimestamp(date: Date | string): string {
  const d = new Date(date)
  return d.toLocaleString()
}
