import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { ProxyApiClient } from '../services/api-client.js'
import { getErrorMessage, getModelContextLimit, getBatteryColor } from '@agent-prompttrain/shared'
import {
  formatNumber,
  formatDuration,
  escapeHtml,
  formatRelativeTime,
} from '../utils/formatters.js'
import { layout } from '../layout/index.js'

export const overviewRoutes = new Hono<{
  Variables: {
    apiClient?: ProxyApiClient
    trainId?: string
  }
}>()

/**
 * Main dashboard page - Shows conversations overview with branches
 */
overviewRoutes.get('/', async c => {
  const trainId = c.req.query('trainId')
  const page = parseInt(c.req.query('page') || '1')
  const perPage = parseInt(c.req.query('per_page') || '50')
  const searchQuery = c.req.query('search')?.toLowerCase()

  // Validate pagination params
  const currentPage = Math.max(1, page)
  const itemsPerPage = Math.min(Math.max(10, perPage), 100) // Between 10 and 100

  // Get API client from context
  const apiClient = c.get('apiClient')

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

  try {
    // Calculate offset for pagination
    const offset = (currentPage - 1) * itemsPerPage

    // Fetch dashboard stats and the requested page of conversations in parallel
    const [statsResult, conversationsResult] = await Promise.all([
      apiClient.getDashboardStats({ trainId }),
      apiClient.getConversations({
        trainId,
        limit: itemsPerPage,
        offset: searchQuery ? 0 : offset, // For search, get all and filter client-side for now
      }),
    ])

    const apiConversations = conversationsResult.conversations
    const dashboardStats = statsResult

    // Create flat list of conversations (simplified for now)
    const conversationBranches: Array<{
      conversationId: string
      accountId?: string
      branch: string
      branchCount: number
      subtaskBranchCount: number
      compactBranchCount: number
      userBranchCount: number
      messageCount: number
      tokens: number
      firstMessage: Date
      lastMessage: Date
      trainId: string
      latestRequestId?: string
      latestModel?: string
      latestContextTokens?: number
      isSubtask?: boolean
      parentTaskRequestId?: string
      parentConversationId?: string
      subtaskMessageCount?: number
    }> = []

    // Process API conversations
    apiConversations.forEach(conv => {
      conversationBranches.push({
        conversationId: conv.conversationId,
        accountId: conv.accountId,
        branch: 'main', // API doesn't return branch info yet
        branchCount: conv.branchCount || 1,
        subtaskBranchCount: conv.subtaskBranchCount || 0,
        compactBranchCount: conv.compactBranchCount || 0,
        userBranchCount: conv.userBranchCount || 0,
        messageCount: conv.messageCount,
        tokens: conv.totalTokens,
        firstMessage: new Date(conv.firstMessageTime),
        lastMessage: new Date(conv.lastMessageTime),
        trainId: conv.trainId ,
        latestRequestId: conv.latestRequestId,
        latestModel: conv.latestModel,
        latestContextTokens: conv.latestContextTokens,
        isSubtask: conv.isSubtask,
        parentTaskRequestId: conv.parentTaskRequestId,
        parentConversationId: conv.parentConversationId,
        subtaskMessageCount: conv.subtaskMessageCount,
      })
    })

    // Apply search filter if provided
    let filteredBranches = conversationBranches
    if (searchQuery) {
      filteredBranches = conversationBranches.filter(branch => {
        return (
          branch.conversationId.toLowerCase().includes(searchQuery) ||
          branch.branch.toLowerCase().includes(searchQuery) ||
          branch.trainId.toLowerCase().includes(searchQuery)
        )
      })
    }

    // Sort by last message time
    filteredBranches.sort((a, b) => b.lastMessage.getTime() - a.lastMessage.getTime())

    // No longer filter subtasks - display all conversations at the same level
    const groupedConversations = filteredBranches

    // Get unique train IDs for the dropdown
    const uniqueTrainIds = [...new Set(conversationBranches.map(branch => branch.trainId))].sort()

    // Use pre-computed stats from the API instead of calculating client-side
    const totalRequests = dashboardStats.totalRequests
    const totalTokens = dashboardStats.totalTokens
    const uniqueAccounts = dashboardStats.activeUsers

    // Use server-side pagination info
    const totalItems = conversationsResult.pagination?.total || groupedConversations.length
    const totalPages =
      conversationsResult.pagination?.totalPages || Math.ceil(totalItems / itemsPerPage)

    // For initial implementation, still use client-side pagination if search is active
    // This will be optimized in a future iteration
    const paginatedBranches = searchQuery
      ? groupedConversations.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage)
      : groupedConversations

    const content = html`
      <div
        style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;"
      >
        <h2 style="margin: 0;">Conversations Overview</h2>
        <div style="display: flex; gap: 1rem; align-items: center;">
          <!-- Search Bar -->
          <form action="/dashboard" method="get" style="display: flex; gap: 0.5rem;">
            ${trainId
              ? html`<input type="hidden" name="trainId" value="${escapeHtml(trainId)}" />`
              : ''}
            <input type="hidden" name="page" value="1" />
            <input type="hidden" name="per_page" value="${itemsPerPage}" />
            <input
              type="search"
              name="search"
              placeholder="Search conversations..."
              value="${escapeHtml(c.req.query('search') || '')}"
              style="padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.375rem; width: 250px; font-size: 0.875rem;"
            />
            <button
              type="submit"
              class="btn btn-secondary"
              style="padding: 0.5rem 1rem; font-size: 0.875rem;"
            >
              Search
            </button>
          </form>
          <a
            href="/dashboard?refresh=true&page=${currentPage}&per_page=${itemsPerPage}${trainId
              ? `&trainId=${encodeURIComponent(trainId)}`
              : ''}${searchQuery
              ? `&search=${encodeURIComponent(c.req.query('search') || '')}`
              : ''}"
            class="btn btn-secondary"
            style="font-size: 0.875rem;"
          >
            Refresh
          </a>
        </div>
      </div>

      <!-- Train Filter -->
      <div style="margin-bottom: 1.5rem;">
        <label class="text-sm text-gray-600">Filter by Train ID:</label>
        <select
          onchange="window.location.href = '/dashboard' + (this.value ? '?trainId=' + this.value : '?') + '&page=1&per_page=${itemsPerPage}${searchQuery
            ? `&search=${encodeURIComponent(c.req.query('search') || '')}`
            : ''}'"
          style="margin-left: 0.5rem; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.375rem; font-size: 0.875rem;"
        >
          <option value="">All Train IDs</option>
          ${raw(
            uniqueTrainIds
              .map(
                id =>
                  `<option value="${escapeHtml(id)}" ${trainId === id ? 'selected' : ''}>${escapeHtml(id)}</option>`
              )
              .join('')
          )}
        </select>
      </div>

      <!-- Stats Summary -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Conversations</div>
          <div class="stat-value">${dashboardStats.totalConversations}</div>
          <div class="stat-meta">Unique conversations</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Active Accounts</div>
          <div class="stat-value">${uniqueAccounts}</div>
          <div class="stat-meta">Unique account IDs</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Requests</div>
          <div class="stat-value">${totalRequests}</div>
          <div class="stat-meta">Across all conversations</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Tokens</div>
          <div class="stat-value">${formatNumber(totalTokens)}</div>
          <div class="stat-meta">Combined usage</div>
        </div>
      </div>

      <!-- Conversations Table -->
      <div class="section">
        <div class="section-header">
          Conversations
          <span class="text-sm text-gray-500" style="float: right;">
            Showing ${paginatedBranches.length} of ${totalItems}
            ${searchQuery ? 'filtered ' : ''}conversations (Page ${currentPage} of ${totalPages})
          </span>
        </div>
        <div class="section-content">
          ${paginatedBranches.length === 0
            ? html`<p class="text-gray-500">No conversations found</p>`
            : html`
                <table>
                  <thead>
                    <tr>
                      <th>Conversation</th>
                      <th>Branches</th>
                      <th>Account</th>
                      <th>Train ID</th>
                      <th>Requests</th>
                      <th>Tokens</th>
                      <th>Context</th>
                      <th>Duration</th>
                      <th>Last Activity</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${raw(
                      paginatedBranches
                        .map(branch => {
                          const duration =
                            branch.lastMessage.getTime() - branch.firstMessage.getTime()

                          return `
                            <tr>
                              <td class="text-sm">
                                <a href="/dashboard/conversation/${branch.conversationId}${branch.branch !== 'main' ? `?branch=${branch.branch}` : ''}" 
                                   class="text-blue-600" 
                                   style="font-family: monospace; font-size: 0.75rem;">
                                  ${branch.conversationId.substring(0, 8)}...
                                </a>
                              </td>
                              <td class="text-sm">
                                ${(() => {
                                  const parts = []
                                  if (branch.subtaskBranchCount > 0) {
                                    parts.push(`${branch.subtaskBranchCount}💻`)
                                  }
                                  if (branch.compactBranchCount > 0) {
                                    parts.push(`${branch.compactBranchCount}📦`)
                                  }
                                  if (branch.userBranchCount > 0) {
                                    parts.push(`${branch.userBranchCount}🌿`)
                                  }

                                  // If no special branches, just show the total branch count
                                  let displayText
                                  const hasMultipleBranches = branch.branchCount > 1

                                  if (parts.length > 0) {
                                    displayText = parts.join(', ')
                                  } else {
                                    // Only show branch count if more than 1
                                    displayText =
                                      branch.branchCount > 1 ? branch.branchCount.toString() : ''
                                  }
                                  // Truncate if too many branches to prevent UI overflow
                                  const totalBranches =
                                    branch.subtaskBranchCount +
                                    branch.compactBranchCount +
                                    branch.userBranchCount
                                  if (totalBranches > 99) {
                                    displayText = '99+...'
                                  }

                                  // Add hover tooltip with full details if truncated or has branches
                                  const titleText =
                                    totalBranches > 0 || hasMultipleBranches
                                      ? `Total branches: ${branch.branchCount} (${branch.subtaskBranchCount} subtasks, ${branch.compactBranchCount} compacted, ${branch.userBranchCount} user branches)`
                                      : '' // No tooltip for single branch with no special types

                                  return `<span style="color: ${hasMultipleBranches ? '#2563eb' : '#6b7280'}; font-weight: ${hasMultipleBranches ? '600' : 'normal'};" ${titleText ? `title="${titleText}"` : ''}>
                                    ${displayText}
                                  </span>`
                                })()}
                              </td>
                              <td class="text-sm">
                                ${
                                  branch.accountId
                                    ? `<a href="/dashboard/token-usage?accountId=${encodeURIComponent(branch.accountId)}" 
                                         class="text-blue-600" 
                                         style="font-family: monospace; font-size: 0.75rem;"
                                         title="View token usage for ${escapeHtml(branch.accountId)}">
                                        ${
                                          branch.accountId.length > 20
                                            ? escapeHtml(branch.accountId.substring(0, 17)) + '...'
                                            : escapeHtml(branch.accountId)
                                        }
                                      </a>`
                                    : '<span class="text-gray-400">N/A</span>'
                                }
                              </td>
                              <td class="text-sm">${escapeHtml(branch.trainId)}</td>
                              <td class="text-sm">${branch.messageCount}</td>
                              <td class="text-sm">${formatNumber(branch.tokens)}</td>
                              <td class="text-sm">${
                                branch.latestContextTokens && branch.latestModel
                                  ? (() => {
                                      const { limit: maxTokens, isEstimate } = getModelContextLimit(
                                        branch.latestModel
                                      )
                                      const percentage = branch.latestContextTokens / maxTokens
                                      const batteryColor = getBatteryColor(percentage)
                                      const isOverflow = percentage > 1
                                      const percentageText = (percentage * 100).toFixed(1)

                                      return `
                                  <div style="display: inline-flex; align-items: center; gap: 4px;">
                                    <svg width="16" height="30" viewBox="0 0 16 30" xmlns="http://www.w3.org/2000/svg">
                                      <!-- Battery nub (positive terminal) -->
                                      <rect x="6" y="1" width="4" height="3" rx="1" ry="1" style="fill: #888;" />
                                      <!-- Battery casing -->
                                      <rect x="3" y="4" width="10" height="24" rx="2" ry="2" style="fill: #f0f0f0; stroke: #888; stroke-width: 1;" />
                                      <!-- Battery level fill (from bottom to top) -->
                                      <rect x="4" y="${5 + (1 - Math.min(percentage, 1)) * 22}" width="8" height="${Math.min(percentage, 1) * 22}" rx="1" ry="1" style="fill: ${batteryColor};" />
                                      ${isOverflow ? '<text x="8" y="18" text-anchor="middle" style="font-size: 8px; font-weight: bold; fill: white;">!</text>' : ''}
                                    </svg>
                                    <span style="font-size: 11px; color: #6b7280;" title="${branch.latestContextTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens${isEstimate ? ' (estimated)' : ''}">${percentageText}%</span>
                                  </div>
                                `
                                    })()
                                  : '<span class="text-gray-400">-</span>'
                              }</td>
                              <td class="text-sm">${formatDuration(duration)}</td>
                              <td class="text-sm">${formatRelativeTime(branch.lastMessage)}</td>
                              <td class="text-sm">
                                <div style="display: flex; gap: 0.5rem; align-items: center;">
                                  ${
                                    branch.parentTaskRequestId
                                      ? `<a href="/dashboard/request/${branch.parentTaskRequestId}" class="text-purple-600" title="View parent task" style="font-size: 0.75rem;">Parent ↑</a>`
                                      : ''
                                  }
                                  ${
                                    branch.latestRequestId
                                      ? `<a href="/dashboard/request/${branch.latestRequestId}" class="text-blue-600" title="View latest request">Latest →</a>`
                                      : '<span class="text-gray-400">N/A</span>'
                                  }
                                </div>
                              </td>
                            </tr>
                          `
                        })
                        .join('')
                    )}
                  </tbody>
                </table>

                ${totalPages > 1
                  ? html`
                      <div
                        style="display: flex; justify-content: center; align-items: center; gap: 1rem; margin-top: 2rem; padding: 1rem 0;"
                      >
                        ${currentPage > 1
                          ? html`
                              <a
                                href="?page=${currentPage - 1}${trainId
                                  ? `&trainId=${trainId}`
                                  : ''}&per_page=${itemsPerPage}${searchQuery
                                  ? `&search=${encodeURIComponent(c.req.query('search') || '')}`
                                  : ''}"
                                class="pagination-link"
                              >
                                ← Previous
                              </a>
                            `
                          : html` <span class="pagination-disabled">← Previous</span> `}

                        <div style="display: flex; gap: 0.5rem;">
                          ${generatePageNumbers(currentPage, totalPages).map(pageNum =>
                            pageNum === '...'
                              ? html`<span style="padding: 0.5rem;">...</span>`
                              : pageNum === currentPage
                                ? html`<span class="pagination-current">${pageNum}</span>`
                                : html`
                                    <a
                                      href="?page=${pageNum}${trainId
                                        ? `&trainId=${trainId}`
                                        : ''}&per_page=${itemsPerPage}${searchQuery
                                        ? `&search=${encodeURIComponent(c.req.query('search') || '')}`
                                        : ''}"
                                      class="pagination-link"
                                    >
                                      ${pageNum}
                                    </a>
                                  `
                          )}
                        </div>

                        ${currentPage < totalPages
                          ? html`
                              <a
                                href="?page=${currentPage + 1}${trainId
                                  ? `&trainId=${trainId}`
                                  : ''}&per_page=${itemsPerPage}${searchQuery
                                  ? `&search=${encodeURIComponent(c.req.query('search') || '')}`
                                  : ''}"
                                class="pagination-link"
                              >
                                Next →
                              </a>
                            `
                          : html` <span class="pagination-disabled">Next →</span> `}

                        <div style="margin-left: 2rem; color: #6b7280; font-size: 0.875rem;">
                          Items per page:
                          <select
                            onchange="window.location.href='?page=1${trainId
                              ? `&trainId=${trainId}`
                              : ''}&per_page=' + this.value + '${searchQuery
                              ? `&search=${encodeURIComponent(c.req.query('search') || '')}`
                              : ''}'"
                            style="margin-left: 0.5rem; padding: 0.25rem 0.5rem; border: 1px solid #e5e7eb; border-radius: 0.375rem;"
                          >
                            <option value="10" ${itemsPerPage === 10 ? 'selected' : ''}>10</option>
                            <option value="25" ${itemsPerPage === 25 ? 'selected' : ''}>25</option>
                            <option value="50" ${itemsPerPage === 50 ? 'selected' : ''}>50</option>
                            <option value="100" ${itemsPerPage === 100 ? 'selected' : ''}>
                              100
                            </option>
                          </select>
                        </div>
                      </div>
                    `
                  : ''}
              `}
        </div>
      </div>
    `

    return c.html(layout('Dashboard', content))
  } catch (error) {
    return c.html(
      layout(
        'Error',
        html`
          <div class="error-banner">
            <strong>Error:</strong> ${getErrorMessage(error) || 'Failed to load conversations'}
          </div>
        `
      )
    )
  }
})

function generatePageNumbers(current: number, total: number): (number | string)[] {
  const pages: (number | string)[] = []
  const maxVisible = 7 // Maximum number of page buttons to show

  if (total <= maxVisible) {
    // Show all pages if total is small
    for (let i = 1; i <= total; i++) {
      pages.push(i)
    }
  } else {
    // Always show first page
    pages.push(1)

    if (current > 3) {
      pages.push('...')
    }

    // Show pages around current
    const start = Math.max(2, current - 1)
    const end = Math.min(total - 1, current + 1)

    for (let i = start; i <= end; i++) {
      pages.push(i)
    }

    if (current < total - 2) {
      pages.push('...')
    }

    // Always show last page
    if (total > 1) {
      pages.push(total)
    }
  }

  return pages
}
