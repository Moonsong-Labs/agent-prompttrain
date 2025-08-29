import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { ProxyApiClient } from '../../services/api-client.js'
import { getErrorMessage } from '@agent-prompttrain/shared'
import type { ApiRequest } from '../../types/conversation.js'

export const analyticsConversationPartialRoutes = new Hono<{
  Variables: {
    apiClient?: ProxyApiClient
  }
}>()

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

/**
 * Analytics panel for conversation details
 */
analyticsConversationPartialRoutes.get(
  '/partials/analytics/conversation/:conversationId',
  async c => {
    const apiClient = c.get('apiClient')
    const conversationId = c.req.param('conversationId')
    const branch = c.req.query('branch') || 'main'

    if (!apiClient) {
      return c.html(html`
        <div class="error-banner"><strong>Error:</strong> API client not configured</div>
      `)
    }

    try {
      // Get storage service for conversation data
      const { container } = await import('../../container.js')
      const storageService = container.getStorageService()

      // Get conversation requests
      const conversation = await storageService.getConversationById(conversationId)
      if (!conversation) {
        return c.html(html`
          <div class="error-banner"><strong>Error:</strong> Conversation not found</div>
        `)
      }

      // Filter requests by branch
      const filteredRequests =
        branch === 'All Branches'
          ? conversation.requests
          : conversation.requests.filter(req => req.branch_id === branch)

      // Calculate token usage stats
      const tokenStats = {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        byModel: {} as Record<
          string,
          {
            input: number
            output: number
            cacheRead: number
            cacheCreation: number
            requests: number
          }
        >,
        byAccount: {} as Record<
          string,
          { input: number; output: number; total: number; requests: number }
        >,
        timeline: [] as Array<{ timestamp: Date; cumulativeTokens: number; model: string }>,
      }

      // Process each request
      filteredRequests.forEach((req: ApiRequest) => {
        const usage = req.response_body?.usage
        if (usage) {
          const inputTokens = usage.input_tokens || 0
          const outputTokens = usage.output_tokens || 0
          const cacheReadTokens = usage.cache_read_input_tokens || 0
          const cacheCreationTokens = usage.cache_creation_input_tokens || 0

          tokenStats.totalInputTokens += inputTokens
          tokenStats.totalOutputTokens += outputTokens
          tokenStats.totalCacheReadTokens += cacheReadTokens
          tokenStats.totalCacheCreationTokens += cacheCreationTokens

          // By model
          const model = req.model || 'unknown'
          if (!tokenStats.byModel[model]) {
            tokenStats.byModel[model] = {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheCreation: 0,
              requests: 0,
            }
          }
          tokenStats.byModel[model].input += inputTokens
          tokenStats.byModel[model].output += outputTokens
          tokenStats.byModel[model].cacheRead += cacheReadTokens
          tokenStats.byModel[model].cacheCreation += cacheCreationTokens
          tokenStats.byModel[model].requests++

          // By account
          const account = req.account_id || 'unknown'
          if (!tokenStats.byAccount[account]) {
            tokenStats.byAccount[account] = { input: 0, output: 0, total: 0, requests: 0 }
          }
          tokenStats.byAccount[account].input += inputTokens
          tokenStats.byAccount[account].output += outputTokens
          tokenStats.byAccount[account].total += inputTokens + outputTokens
          tokenStats.byAccount[account].requests++

          // Timeline
          tokenStats.timeline.push({
            timestamp: new Date(req.timestamp),
            cumulativeTokens: inputTokens + outputTokens,
            model,
          })
        }
      })

      // Sort timeline and calculate cumulative
      tokenStats.timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      let cumulative = 0
      tokenStats.timeline = tokenStats.timeline.map(point => ({
        ...point,
        cumulativeTokens: (cumulative += point.cumulativeTokens),
      }))

      // Calculate costs (rough estimates)
      const costs = {
        total: 0,
        byModel: {} as Record<string, number>,
      }

      Object.entries(tokenStats.byModel).forEach(([model, stats]) => {
        // Rough cost estimates per 1M tokens
        const rates = {
          'claude-3-opus': { input: 15, output: 75 },
          'claude-3-sonnet': { input: 3, output: 15 },
          'claude-3-haiku': { input: 0.25, output: 1.25 },
          'claude-2': { input: 8, output: 24 },
        }

        const modelKey =
          Object.keys(rates).find(key => model.toLowerCase().includes(key.split('-').pop()!)) ||
          'claude-3-sonnet'
        const rate = rates[modelKey as keyof typeof rates]

        const cost = (stats.input / 1000000) * rate.input + (stats.output / 1000000) * rate.output
        costs.byModel[model] = cost
        costs.total += cost
      })

      const content = html`
        <div style="padding: 1.5rem;">
          <!-- Token Usage Overview -->
          <div style="margin-bottom: 2rem;">
            <h4 style="margin: 0 0 1rem 0; font-size: 1.125rem; font-weight: 600;">
              Token Usage Overview
            </h4>
            <div class="stats-grid">
              <div class="stat-card">
                <div class="stat-label">Total Input Tokens</div>
                <div class="stat-value">${formatNumber(tokenStats.totalInputTokens)}</div>
                <div class="stat-meta">Messages sent</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Total Output Tokens</div>
                <div class="stat-value">${formatNumber(tokenStats.totalOutputTokens)}</div>
                <div class="stat-meta">Responses generated</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Cache Read Tokens</div>
                <div class="stat-value">${formatNumber(tokenStats.totalCacheReadTokens)}</div>
                <div class="stat-meta">From cache</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Cache Creation</div>
                <div class="stat-value">${formatNumber(tokenStats.totalCacheCreationTokens)}</div>
                <div class="stat-meta">Cached for reuse</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Estimated Cost</div>
                <div class="stat-value">$${costs.total.toFixed(2)}</div>
                <div class="stat-meta">Based on usage</div>
              </div>
            </div>
          </div>

          <!-- Token Usage Timeline Chart -->
          ${tokenStats.timeline.length > 1
            ? html`
                <div style="margin-bottom: 2rem;">
                  <h4 style="margin: 0 0 1rem 0; font-size: 1.125rem; font-weight: 600;">
                    Token Usage Timeline
                  </h4>
                  <div
                    style="width: 100%; height: 300px; background: white; border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 1rem;"
                  >
                    <canvas
                      id="conversationTimelineChart"
                      style="width: 100%; height: 100%;"
                    ></canvas>
                  </div>
                </div>
                <script>
                  ;(function () {
                    const canvas = document.getElementById('conversationTimelineChart')
                    if (!canvas) return

                    const ctx = canvas.getContext('2d')
                    const rect = canvas.getBoundingClientRect()
                    canvas.width = rect.width * window.devicePixelRatio
                    canvas.height = rect.height * window.devicePixelRatio
                    ctx.scale(window.devicePixelRatio, window.devicePixelRatio)

                    const data = ${JSON.stringify(
                      tokenStats.timeline.map(p => ({
                        time: p.timestamp.toLocaleTimeString(),
                        tokens: p.cumulativeTokens,
                        model: p.model,
                      }))
                    )}

                    const padding = { top: 20, right: 20, bottom: 40, left: 60 }
                    const chartWidth = rect.width - padding.left - padding.right
                    const chartHeight = rect.height - padding.top - padding.bottom

                    // Find max tokens
                    const maxTokens = Math.max(...data.map(d => d.tokens))

                    // Clear canvas
                    ctx.fillStyle = '#ffffff'
                    ctx.fillRect(0, 0, rect.width, rect.height)

                    // Draw axes
                    ctx.strokeStyle = '#e5e7eb'
                    ctx.lineWidth = 1
                    ctx.beginPath()
                    ctx.moveTo(padding.left, padding.top)
                    ctx.lineTo(padding.left, padding.top + chartHeight)
                    ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight)
                    ctx.stroke()

                    // Draw grid lines and Y labels
                    ctx.fillStyle = '#6b7280'
                    ctx.font = '12px sans-serif'
                    ctx.textAlign = 'right'

                    const ySteps = 5
                    for (let i = 0; i <= ySteps; i++) {
                      const y = padding.top + (chartHeight * i) / ySteps
                      const value = maxTokens * (1 - i / ySteps)

                      // Grid line
                      ctx.strokeStyle = '#f3f4f6'
                      ctx.beginPath()
                      ctx.moveTo(padding.left, y)
                      ctx.lineTo(padding.left + chartWidth, y)
                      ctx.stroke()

                      // Label
                      ctx.fillStyle = '#6b7280'
                      ctx.fillText(formatNumber(value), padding.left - 10, y + 4)
                    }

                    // Draw line
                    ctx.beginPath()
                    ctx.lineWidth = 2
                    ctx.strokeStyle = '#3b82f6'

                    data.forEach((point, index) => {
                      const x = padding.left + (index / (data.length - 1)) * chartWidth
                      const y = padding.top + (1 - point.tokens / maxTokens) * chartHeight

                      if (index === 0) {
                        ctx.moveTo(x, y)
                      } else {
                        ctx.lineTo(x, y)
                      }
                    })

                    ctx.stroke()

                    // Draw points
                    data.forEach((point, index) => {
                      const x = padding.left + (index / (data.length - 1)) * chartWidth
                      const y = padding.top + (1 - point.tokens / maxTokens) * chartHeight

                      ctx.fillStyle = '#3b82f6'
                      ctx.beginPath()
                      ctx.arc(x, y, 3, 0, Math.PI * 2)
                      ctx.fill()
                    })

                    // Helper
                    function formatNumber(num) {
                      if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
                      if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
                      return num.toString()
                    }
                  })()
                </script>
              `
            : ''}

          <!-- Usage by Model -->
          <div style="margin-bottom: 2rem;">
            <h4 style="margin: 0 0 1rem 0; font-size: 1.125rem; font-weight: 600;">
              Usage by Model
            </h4>
            <div style="overflow-x: auto;">
              <table style="width: 100%;">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Requests</th>
                    <th>Input Tokens</th>
                    <th>Output Tokens</th>
                    <th>Cache Read</th>
                    <th>Cache Creation</th>
                    <th>Est. Cost</th>
                  </tr>
                </thead>
                <tbody>
                  ${raw(
                    Object.entries(tokenStats.byModel)
                      .map(
                        ([model, stats]) => `
                      <tr>
                        <td class="text-sm">${model}</td>
                        <td class="text-sm">${stats.requests}</td>
                        <td class="text-sm">${formatNumber(stats.input)}</td>
                        <td class="text-sm">${formatNumber(stats.output)}</td>
                        <td class="text-sm">${formatNumber(stats.cacheRead)}</td>
                        <td class="text-sm">${formatNumber(stats.cacheCreation)}</td>
                        <td class="text-sm">$${(costs.byModel[model] || 0).toFixed(2)}</td>
                      </tr>
                    `
                      )
                      .join('')
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <!-- Usage by Account -->
          ${Object.keys(tokenStats.byAccount).length > 1
            ? html`
                <div>
                  <h4 style="margin: 0 0 1rem 0; font-size: 1.125rem; font-weight: 600;">
                    Usage by Account
                  </h4>
                  <div style="overflow-x: auto;">
                    <table style="width: 100%;">
                      <thead>
                        <tr>
                          <th>Account</th>
                          <th>Requests</th>
                          <th>Input Tokens</th>
                          <th>Output Tokens</th>
                          <th>Total Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${raw(
                          Object.entries(tokenStats.byAccount)
                            .map(
                              ([account, stats]) => `
                        <tr>
                          <td class="text-sm">${account}</td>
                          <td class="text-sm">${stats.requests}</td>
                          <td class="text-sm">${formatNumber(stats.input)}</td>
                          <td class="text-sm">${formatNumber(stats.output)}</td>
                          <td class="text-sm">${formatNumber(stats.total)}</td>
                        </tr>
                      `
                            )
                            .join('')
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              `
            : ''}
        </div>
      `

      return c.html(content)
    } catch (error) {
      console.error('Failed to fetch conversation analytics:', getErrorMessage(error))
      return c.html(html`
        <div class="error-banner">
          <strong>Error:</strong> Failed to load conversation analytics
        </div>
      `)
    }
  }
)
