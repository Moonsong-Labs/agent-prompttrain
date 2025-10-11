import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { getErrorMessage } from '@agent-prompttrain/shared'
import { parseConversation, calculateCost } from '../utils/conversation.js'
import { formatDuration, escapeHtml } from '../utils/formatters.js'
import { layout } from '../layout/index.js'
import { isSparkRecommendation, parseSparkRecommendation } from '../utils/spark.js'
import { renderSparkRecommendationInline } from '../components/spark-recommendation-inline.js'

export const requestDetailsRoutes = new Hono<{
  Variables: {
    projectId?: string
    auth?: {
      principal: string
      dashboardKey: string
    }
  }
}>()

/**
 * Request details page with conversation view
 */
requestDetailsRoutes.get('/request/:id', async c => {
  const requestId = c.req.param('id')
  const auth = c.get('auth')

  // Use storage service directly instead of API client
  const { container } = await import('../container.js')
  const storageService = container.getStorageService()

  try {
    const requestDetails = await storageService.getRequestDetails(requestId)

    if (!requestDetails.request) {
      return c.html(
        layout(
          'Error',
          html` <div class="error-banner"><strong>Error:</strong> Request not found.</div> `,
          '',
          c
        )
      )
    }

    // Check if user has access to this request's project
    if (auth?.principal) {
      const hasAccess = await storageService.checkUserProjectAccess(
        auth.principal,
        requestDetails.request.projectId
      )

      if (!hasAccess) {
        return c.html(
          layout(
            'Error',
            html`
              <div class="error-banner">
                <strong>Error:</strong> Access denied. You don't have permission to view this
                request.
              </div>
            `,
            '',
            c
          )
        )
      }
    }

    // Map from storage format to API format
    const details = {
      requestId: requestDetails.request.request_id,
      projectId: requestDetails.request.projectId,
      model: requestDetails.request.model,
      timestamp: requestDetails.request.timestamp,
      inputTokens: requestDetails.request.input_tokens,
      outputTokens: requestDetails.request.output_tokens,
      totalTokens: requestDetails.request.total_tokens,
      durationMs: requestDetails.request.duration_ms,
      responseStatus: 200, // Not stored in request, default to 200
      error: requestDetails.request.error,
      requestType: requestDetails.request.request_type,
      conversationId: requestDetails.request.conversation_id,
      branchId: requestDetails.request.branch_id,
      parentRequestId: requestDetails.request.parent_request_id,
      requestBody: requestDetails.request_body,
      responseBody: requestDetails.response_body,
      streamingChunks: requestDetails.chunks.map(chunk => ({
        chunkIndex: chunk.chunk_index,
        timestamp: chunk.timestamp,
        data: chunk.data,
        tokenCount: chunk.token_count || 0,
      })),
      // Fields not in storage but expected by template
      requestHeaders: undefined,
      responseHeaders: undefined,
      telemetry: undefined,
      method: 'POST',
      endpoint: '/v1/messages',
      streaming: requestDetails.chunks.length > 0,
    }

    // Parse conversation data
    const conversation = await parseConversation({
      request_body: details.requestBody,
      response_body: details.responseBody,
      request_tokens: details.inputTokens,
      response_tokens: details.outputTokens,
      model: details.model,
      duration: details.durationMs,
      status_code: details.responseStatus,
      timestamp: details.timestamp,
    })

    // Calculate cost
    const cost = calculateCost(conversation.totalInputTokens, conversation.totalOutputTokens)

    // Detect Spark recommendations
    const sparkRecommendations: Array<{
      sessionId: string
      recommendation: any
      messageIndex: number
    }> = []

    // Look through raw request/response for Spark tool usage
    if (details.requestBody?.messages && details.responseBody) {
      const allMessages = [...(details.requestBody.messages || []), details.responseBody]

      for (let i = 0; i < allMessages.length - 1; i++) {
        const msg = allMessages[i]
        const nextMsg = allMessages[i + 1]

        if (msg.content && Array.isArray(msg.content)) {
          for (const content of msg.content) {
            if (content.type === 'tool_use' && isSparkRecommendation(content)) {
              // Look for corresponding tool_result in next message
              if (nextMsg.content && Array.isArray(nextMsg.content)) {
                const toolResult = nextMsg.content.find(
                  (item: any) => item.type === 'tool_result' && item.tool_use_id === content.id
                )

                if (toolResult) {
                  const recommendation = parseSparkRecommendation(toolResult, content)
                  if (recommendation) {
                    sparkRecommendations.push({
                      sessionId: recommendation.sessionId,
                      recommendation,
                      messageIndex: i,
                    })
                  }
                }
              }
            }
          }
        }
      }
    }

    // Fetch existing feedback for Spark recommendations if any
    let sparkFeedbackMap: Record<string, any> = {}
    if (sparkRecommendations.length > 0) {
      try {
        // Get API client from container for Spark API calls
        const apiClient = container.getApiClient()
        const sessionIds = sparkRecommendations.map(r => r.sessionId)
        const feedbackResponse = await apiClient.post<{ results: Record<string, any> }>(
          '/api/spark/feedback/batch',
          {
            session_ids: sessionIds,
          }
        )

        if (feedbackResponse.results) {
          sparkFeedbackMap = feedbackResponse.results
        }
      } catch (error) {
        console.error('Failed to fetch Spark feedback:', error)
      }
    }

    // Track user message indices for navigation (only text/image messages, no tools)
    const userMessageIndices: number[] = []
    conversation.messages
      .slice()
      .reverse()
      .forEach((msg, idx) => {
        if (msg.role === 'user' && !msg.isToolUse && !msg.isToolResult) {
          userMessageIndices.push(idx)
        }
      })

    // Format messages for display - reverse order to show newest first
    const messagesHtml = await Promise.all(
      conversation.messages
        .slice()
        .reverse()
        .map(async (msg, idx) => {
          const messageId = `message-${idx}`
          const contentId = `content-${idx}`
          const truncatedId = `truncated-${idx}`

          // Check if this message contains a Spark recommendation
          let sparkHtml = ''
          if (msg.sparkRecommendation) {
            const feedbackForSession = sparkFeedbackMap[msg.sparkRecommendation.sessionId]
            sparkHtml = await renderSparkRecommendationInline(
              msg.sparkRecommendation.recommendation,
              msg.sparkRecommendation.sessionId,
              idx,
              feedbackForSession
            )

            // Replace the marker in the content with the Spark HTML
            msg.htmlContent = msg.htmlContent.replace(
              `[[SPARK_RECOMMENDATION:${msg.sparkRecommendation.sessionId}]]`,
              sparkHtml
            )
            if (msg.truncatedHtml) {
              msg.truncatedHtml = msg.truncatedHtml.replace(
                `[[SPARK_RECOMMENDATION:${msg.sparkRecommendation.sessionId}]]`,
                '<div class="spark-inline-recommendation"><div class="spark-inline-header"><div class="spark-inline-title"><span class="spark-icon">✨</span><span class="spark-label">Spark Recommendation</span></div></div><div style="padding: 0.5rem 1rem; text-align: center; color: #64748b; font-size: 0.875rem;">Show more to view recommendation</div></div>'
              )
            }
          }

          // Add special classes for tool messages
          let messageClass = `message message-${msg.role}`
          if (msg.isToolUse) {
            messageClass += ' message-tool-use'
          } else if (msg.isToolResult) {
            messageClass += ' message-tool-result'
          }

          // Add special styling for assistant messages
          if (msg.role === 'assistant') {
            messageClass += ' message-assistant-response'
          }

          // Format role display
          let roleDisplay = msg.role.charAt(0).toUpperCase() + msg.role.slice(1)
          if (msg.isToolUse) {
            roleDisplay = 'Tool 🔧'
          } else if (msg.isToolResult) {
            roleDisplay = 'Result ✅'
          } else if (msg.role === 'system') {
            roleDisplay = 'System ⚙️'
          }

          // Add navigation buttons for user messages (only text/image content, no tools)
          let navigationButtons = ''
          if (msg.role === 'user' && !msg.isToolUse && !msg.isToolResult) {
            const currentUserIndex = userMessageIndices.indexOf(idx)
            const hasPrev = currentUserIndex < userMessageIndices.length - 1
            const hasNext = currentUserIndex > 0

            navigationButtons = `
              <div class="nav-arrows-container">
                <button class="nav-arrow nav-up" ${!hasNext ? 'disabled' : ''} 
                  onclick="${hasNext ? `document.getElementById('message-${userMessageIndices[currentUserIndex - 1]}').scrollIntoView({behavior: 'smooth', block: 'center'})` : ''}"
                  title="Previous user message">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 15l-6-6-6 6"/>
                  </svg>
                </button>
                <button class="nav-arrow nav-down" ${!hasPrev ? 'disabled' : ''} 
                  onclick="${hasPrev ? `document.getElementById('message-${userMessageIndices[currentUserIndex + 1]}').scrollIntoView({behavior: 'smooth', block: 'center'})` : ''}"
                  title="Next user message">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M6 9l6 6 6-6"/>
                  </svg>
                </button>
              </div>
            `
          }

          return `
        <div class="${messageClass}" id="message-${idx}" data-message-index="${idx}">
          <div class="message-index">${conversation.messages.length - idx}</div>
          <div class="message-meta">
            <div class="message-role">${roleDisplay}</div>
            <div class="message-actions">
              <button class="copy-message-link" data-message-index="${idx}" title="Copy link to this message">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                </svg>
              </button>
              ${navigationButtons}
            </div>
          </div>
          <div class="message-content">
            ${msg.isToolUse && msg.toolName ? `<span class="tool-name-label">${msg.toolName}</span>` : ''}
            ${
              msg.isLong
                ? `
              <div id="${truncatedId}" class="message-truncated">
                ${msg.truncatedHtml}
                ${
                  msg.hiddenLineCount === -1
                    ? ''
                    : `<span class="show-more-btn" onclick="toggleMessage('${messageId}')">Show more${msg.hiddenLineCount && msg.hiddenLineCount > 0 ? ` (${msg.hiddenLineCount} lines)` : ''}</span>`
                }
              </div>
              <div id="${contentId}" class="hidden">
                ${msg.htmlContent}
                <span class="show-more-btn" onclick="toggleMessage('${messageId}')">Show less</span>
              </div>
            `
                : msg.htmlContent
            }
          </div>
        </div>
      `
        })
    )

    const content = html`
      <div class="mb-6">
        <a href="/dashboard" class="text-blue-600">← Back to Dashboard</a>
      </div>

      <!-- Error Banner if present -->
      ${conversation.error
        ? html`
            <div class="error-banner">
              <strong>Error (${conversation.error.statusCode || 'Unknown'}):</strong> ${conversation
                .error.message}
            </div>
          `
        : ''}

      <!-- Request Summary -->
      <div class="section">
        <div class="section-header">Request Summary</div>
        <div
          class="section-content"
          style="display: flex; gap: 2rem; align-items: start; flex-wrap: wrap;"
        >
          <!-- Left side: Main details -->
          <div style="flex: 1; min-width: 300px;">
            <dl
              style="display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; font-size: 0.875rem;"
            >
              <dt class="text-gray-600">Request ID:</dt>
              <dd style="display: flex; align-items: center; gap: 0.5rem;">
                <span class="font-mono">${details.requestId}</span>
                <button
                  class="copy-btn"
                  onclick="copyToClipboard('${details.requestId}', this)"
                  title="Copy request ID"
                  style="
                    padding: 0.25rem;
                    border: 1px solid #e5e7eb;
                    border-radius: 0.25rem;
                    background: white;
                    cursor: pointer;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.2s;
                  "
                  onmouseover="this.style.backgroundColor='#f3f4f6'"
                  onmouseout="this.style.backgroundColor='white'"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                </button>
              </dd>

              ${details.conversationId
                ? html`
                    <dt class="text-gray-600">Conversation ID:</dt>
                    <dd style="display: flex; align-items: center; gap: 0.5rem;">
                      <a
                        href="/dashboard/conversation/${details.conversationId}"
                        class="font-mono text-blue-600 hover:text-blue-800 hover:underline"
                      >
                        ${details.conversationId}
                      </a>
                      <button
                        class="copy-btn"
                        onclick="copyToClipboard('${details.conversationId}', this)"
                        title="Copy conversation ID"
                        style="
                          padding: 0.25rem;
                          border: 1px solid #e5e7eb;
                          border-radius: 0.25rem;
                          background: white;
                          cursor: pointer;
                          display: inline-flex;
                          align-items: center;
                          justify-content: center;
                          transition: all 0.2s;
                        "
                        onmouseover="this.style.backgroundColor='#f3f4f6'"
                        onmouseout="this.style.backgroundColor='white'"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                      </button>
                    </dd>
                  `
                : ''}
              ${details.parentRequestId
                ? html`
                    <dt class="text-gray-600">Parent Request:</dt>
                    <dd>
                      <a
                        href="/dashboard/request/${details.parentRequestId}"
                        class="font-mono text-blue-600 hover:text-blue-800 hover:underline"
                      >
                        ${details.parentRequestId}
                      </a>
                    </dd>
                  `
                : ''}

              <dt class="text-gray-600">Branch:</dt>
              <dd>${details.branchId || 'main'}</dd>

              <dt class="text-gray-600">Project ID:</dt>
              <dd>${details.projectId}</dd>

              <dt class="text-gray-600">Model:</dt>
              <dd>${conversation.model}</dd>

              <dt class="text-gray-600">Timestamp:</dt>
              <dd>${new Date(details.timestamp).toLocaleString()}</dd>

              <dt class="text-gray-600">Tokens:</dt>
              <dd>
                <span class="cost-info" style="font-size: 0.8rem;">
                  <span>Input: ${conversation.totalInputTokens.toLocaleString()}</span>
                  <span>Output: ${conversation.totalOutputTokens.toLocaleString()}</span>
                  <span
                    >Total:
                    ${(
                      conversation.totalInputTokens + conversation.totalOutputTokens
                    ).toLocaleString()}</span
                  >
                </span>
              </dd>

              <dt class="text-gray-600">Cost:</dt>
              <dd>${cost.formattedTotal}</dd>

              <dt class="text-gray-600">Duration:</dt>
              <dd>${conversation.duration ? formatDuration(conversation.duration) : 'N/A'}</dd>

              <dt class="text-gray-600">Status:</dt>
              <dd>${details.responseStatus}</dd>
            </dl>
          </div>

          <!-- Right side: Tool usage badges -->
          ${raw(
            Object.keys(conversation.toolUsage).length > 0
              ? (() => {
                  // Create a stable-sorted list of tools
                  const sortedTools = Object.entries(conversation.toolUsage).sort(
                    ([toolA, countA], [toolB, countB]) =>
                      countB - countA || toolA.localeCompare(toolB)
                  )

                  // Calculate total
                  const totalCalls = sortedTools.reduce((sum, [, count]) => sum + count, 0)

                  // Function to get color based on usage proportion
                  const getColorForProportion = (count: number) => {
                    const proportion = count / totalCalls
                    if (proportion >= 0.3) {
                      // High usage (30%+) - blue tones
                      return {
                        bg: '#dbeafe', // blue-100
                        color: '#1e40af', // blue-800
                        countBg: '#3b82f6', // blue-500
                        countColor: '#ffffff',
                      }
                    } else if (proportion >= 0.15) {
                      // Medium usage (15-30%) - green tones
                      return {
                        bg: '#d1fae5', // green-100
                        color: '#065f46', // green-800
                        countBg: '#10b981', // green-500
                        countColor: '#ffffff',
                      }
                    } else if (proportion >= 0.05) {
                      // Low usage (5-15%) - amber tones
                      return {
                        bg: '#fef3c7', // amber-100
                        color: '#92400e', // amber-800
                        countBg: '#f59e0b', // amber-500
                        countColor: '#ffffff',
                      }
                    } else {
                      // Very low usage (<5%) - gray tones
                      return {
                        bg: '#f3f4f6', // gray-100
                        color: '#374151', // gray-700
                        countBg: '#6b7280', // gray-500
                        countColor: '#ffffff',
                      }
                    }
                  }

                  // Generate tool badges
                  const toolBadges = sortedTools
                    .map(([tool, count]) => {
                      const colors = getColorForProportion(count)
                      const percentage = ((count / totalCalls) * 100).toFixed(0)
                      return `
                <span style="
                  display: inline-block;
                  background-color: ${colors.bg};
                  color: ${colors.color};
                  padding: 0.125rem 0.5rem;
                  margin: 0.125rem;
                  border-radius: 9999px;
                  font-size: 0.75rem;
                  font-weight: 500;
                  white-space: nowrap;
                " title="${escapeHtml(tool)}: ${count} calls (${percentage}%)">
                  ${escapeHtml(tool)}
                  <span style="
                    background-color: ${colors.countBg};
                    color: ${colors.countColor};
                    padding: 0 0.375rem;
                    margin-left: 0.25rem;
                    border-radius: 9999px;
                    font-weight: 600;
                  ">${count}</span>
                </span>
              `
                    })
                    .join('')

                  // Return the full HTML string
                  return `
          <div style="min-width: 200px; max-width: 300px; flex-shrink: 0;">
            <div style="
              display: flex;
              align-items: baseline;
              justify-content: space-between;
              margin-bottom: 0.375rem;
            ">
              <h4 style="margin: 0; font-size: 0.875rem; font-weight: 600; color: #4b5563;">
                Tool Usage
              </h4>
              <span style="font-size: 0.75rem; color: #6b7280;">
                Total: ${totalCalls}
              </span>
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 0.25rem;">
              ${toolBadges}
            </div>
          </div>
          `
                })()
              : ''
          )}
        </div>
      </div>

      <!-- View Toggle with Controls -->
      <div
        class="view-toggle"
        style="display: flex; justify-content: space-between; align-items: center;"
      >
        <div style="display: flex; gap: 0.5rem;">
          <button class="active" onclick="showView('conversation')">Conversation</button>
          <button onclick="showView('raw')">Raw JSON</button>
          <button onclick="showView('headers')">Headers & Metadata</button>
        </div>
        <label
          style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; font-size: 0.875rem; color: #374151; margin-bottom: 0;"
        >
          <input
            type="checkbox"
            id="hide-tools-checkbox"
            onchange="toggleToolMessages()"
            style="cursor: pointer;"
          />
          <span>Hide tool use/results</span>
        </label>
      </div>

      <!-- Conversation View -->
      <div id="conversation-view" class="conversation-container">
        ${raw(
          messagesHtml
            .map((html, index) => {
              // Add a separator after the first message (the response)
              if (index === 0 && messagesHtml.length > 1) {
                return (
                  html + '<div style="border-bottom: 2px solid #e5e7eb; margin: 1.5rem 0;"></div>'
                )
              }
              return html
            })
            .join('')
        )}
      </div>

      <!-- Raw JSON View (hidden by default) -->
      <div id="raw-view" class="hidden">
        ${details.requestBody
          ? html`
              <div class="section">
                <div class="section-header">
                  Request Body
                  <button
                    class="btn btn-secondary"
                    style="float: right; font-size: 0.75rem; padding: 0.25rem 0.75rem;"
                    onclick="copyJsonToClipboard('request')"
                  >
                    Copy JSON
                  </button>
                </div>
                <div class="section-content" id="request-json-container">
                  <!-- Will be populated by JavaScript with multiple viewers -->
                </div>
              </div>
            `
          : ''}
        ${details.responseBody
          ? html`
              <div class="section">
                <div class="section-header">
                  Response Body
                  <button
                    class="btn btn-secondary"
                    style="float: right; font-size: 0.75rem; padding: 0.25rem 0.75rem;"
                    onclick="copyJsonToClipboard('response')"
                  >
                    Copy JSON
                  </button>
                </div>
                <div class="section-content" id="response-json-container">
                  <!-- Will be populated by JavaScript with multiple viewers -->
                </div>
              </div>
            `
          : ''}
        ${details.streamingChunks?.length > 0
          ? html`
              <div class="section">
                <div class="section-header">
                  Streaming Chunks (${details.streamingChunks.length})
                </div>
                <div class="section-content">
                  <div id="chunks-container" style="max-height: 400px; overflow-y: auto;">
                    ${raw(
                      details.streamingChunks
                        .map(
                          (chunk, i) => `
                  <div style="margin-bottom: 0.5rem; padding: 0.5rem; background: #f9fafb; border-radius: 0.25rem;">
                    <div class="text-sm text-gray-600">Chunk ${chunk.chunkIndex} - ${chunk.tokenCount || 0} tokens</div>
                    <div id="chunk-${i}" style="margin: 0.25rem 0 0 0; background: white; padding: 0.5rem; border-radius: 0.25rem; border: 1px solid #e5e7eb;"></div>
                  </div>
                `
                        )
                        .join('')
                    )}
                  </div>
                </div>
              </div>
            `
          : ''}
      </div>

      <!-- Headers & Metadata View (hidden by default) -->
      <div id="headers-view" class="hidden">
        ${details.requestHeaders
          ? html`
              <div class="section">
                <div class="section-header">Request Headers</div>
                <div class="section-content">
                  <andypf-json-viewer
                    id="request-headers"
                    expand-icon-type="arrow"
                    expanded="true"
                    expand-level="10"
                    theme='{"base00": "#f9fafb", "base01": "#f3f4f6", "base02": "#e5e7eb", "base03": "#d1d5db", "base04": "#9ca3af", "base05": "#374151", "base06": "#1f2937", "base07": "#111827", "base08": "#ef4444", "base09": "#f97316", "base0A": "#eab308", "base0B": "#22c55e", "base0C": "#06b6d4", "base0D": "#3b82f6", "base0E": "#8b5cf6", "base0F": "#ec4899"}'
                  ></andypf-json-viewer>
                </div>
              </div>
            `
          : ''}
        ${details.responseHeaders
          ? html`
              <div class="section">
                <div class="section-header">Response Headers</div>
                <div class="section-content">
                  <andypf-json-viewer
                    id="response-headers"
                    expand-icon-type="arrow"
                    expanded="true"
                    expand-level="10"
                    theme='{"base00": "#f9fafb", "base01": "#f3f4f6", "base02": "#e5e7eb", "base03": "#d1d5db", "base04": "#9ca3af", "base05": "#374151", "base06": "#1f2937", "base07": "#111827", "base08": "#ef4444", "base09": "#f97316", "base0A": "#eab308", "base0B": "#22c55e", "base0C": "#06b6d4", "base0D": "#3b82f6", "base0E": "#8b5cf6", "base0F": "#ec4899"}'
                  ></andypf-json-viewer>
                </div>
              </div>
            `
          : ''}

        <div class="section">
          <div class="section-header">Request Metadata</div>
          <div class="section-content">
            <andypf-json-viewer
              id="request-metadata"
              expand-icon-type="arrow"
              expanded="true"
              expand-level="10"
              theme='{"base00": "#f9fafb", "base01": "#f3f4f6", "base02": "#e5e7eb", "base03": "#d1d5db", "base04": "#9ca3af", "base05": "#374151", "base06": "#1f2937", "base07": "#111827", "base08": "#ef4444", "base09": "#f97316", "base0A": "#eab308", "base0B": "#22c55e", "base0C": "#06b6d4", "base0D": "#3b82f6", "base0E": "#8b5cf6", "base0F": "#ec4899"}'
            ></andypf-json-viewer>
          </div>
        </div>

        ${details.telemetry
          ? html`
              <div class="section">
                <div class="section-header">Telemetry & Performance</div>
                <div class="section-content">
                  <andypf-json-viewer
                    id="telemetry-data"
                    expand-icon-type="arrow"
                    expanded="true"
                    expand-level="10"
                    theme='{"base00": "#f9fafb", "base01": "#f3f4f6", "base02": "#e5e7eb", "base03": "#d1d5db", "base04": "#9ca3af", "base05": "#374151", "base06": "#1f2937", "base07": "#111827", "base08": "#ef4444", "base09": "#f97316", "base0A": "#eab308", "base0B": "#22c55e", "base0C": "#06b6d4", "base0D": "#3b82f6", "base0E": "#8b5cf6", "base0F": "#ec4899"}'
                  ></andypf-json-viewer>
                </div>
              </div>
            `
          : ''}
      </div>

      <!-- JavaScript for view toggling and message expansion -->
      <script>
        // Store the JSON data in hidden divs to avoid escaping issues
        const getJsonData = id => {
          const el = document.getElementById(id)
          return el ? JSON.parse(el.textContent) : null
        }

        // Function to toggle message expansion (make it global for event delegation)
        window.toggleMessage = function (messageId) {
          const idx = messageId.split('-')[1]
          const content = document.getElementById('content-' + idx)
          const truncated = document.getElementById('truncated-' + idx)

          if (content && truncated) {
            if (content.classList.contains('hidden')) {
              content.classList.remove('hidden')
              truncated.classList.add('hidden')
            } else {
              content.classList.add('hidden')
              truncated.classList.remove('hidden')
            }
          }
        }

        // Function to copy text to clipboard
        function copyToClipboard(text, button) {
          navigator.clipboard
            .writeText(text)
            .then(() => {
              // Store original HTML
              const originalHTML = button.innerHTML

              // Show success icon
              button.innerHTML =
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><path d="M20 6L9 17l-5-5"></path></svg>'
              button.style.borderColor = '#10b981'

              // Revert after 2 seconds
              setTimeout(() => {
                button.innerHTML = originalHTML
                button.style.borderColor = '#e5e7eb'
              }, 2000)
            })
            .catch(err => {
              console.error('Failed to copy:', err)
              // Show error feedback
              button.style.borderColor = '#ef4444'
              setTimeout(() => {
                button.style.borderColor = '#e5e7eb'
              }, 2000)
            })
        }

        // Function to toggle tool messages visibility
        function toggleToolMessages() {
          const checkbox = document.getElementById('hide-tools-checkbox')
          const conversationView = document.getElementById('conversation-view')

          if (checkbox.checked) {
            conversationView.classList.add('hide-tools')
            localStorage.setItem('hideToolMessages', 'true')
          } else {
            conversationView.classList.remove('hide-tools')
            localStorage.setItem('hideToolMessages', 'false')
          }
        }

        // Add copy link functionality
        document.addEventListener('DOMContentLoaded', function () {
          // Restore tool messages visibility preference
          const hideToolsPref = localStorage.getItem('hideToolMessages')
          if (hideToolsPref === 'true') {
            const checkbox = document.getElementById('hide-tools-checkbox')
            const conversationView = document.getElementById('conversation-view')
            if (checkbox && conversationView) {
              checkbox.checked = true
              conversationView.classList.add('hide-tools')
            }
          }

          // Function to show image in lightbox
          function showImageLightbox(imgSrc) {
            // Create lightbox overlay
            const lightbox = document.createElement('div')
            lightbox.className = 'image-lightbox'

            // Create image element
            const img = document.createElement('img')
            img.src = imgSrc
            img.alt = 'Enlarged image'

            // Create close button
            const closeBtn = document.createElement('button')
            closeBtn.className = 'image-lightbox-close'
            closeBtn.innerHTML = '×'
            closeBtn.setAttribute('aria-label', 'Close image')

            // Add elements to lightbox
            lightbox.appendChild(img)
            lightbox.appendChild(closeBtn)

            // Add to body
            document.body.appendChild(lightbox)

            // Click handlers to close
            const closeLightbox = () => {
              lightbox.remove()
            }

            closeBtn.addEventListener('click', closeLightbox)
            lightbox.addEventListener('click', function (e) {
              if (e.target === lightbox) {
                closeLightbox()
              }
            })

            // ESC key to close
            const escHandler = e => {
              if (e.key === 'Escape') {
                closeLightbox()
                document.removeEventListener('keydown', escHandler)
              }
            }
            document.addEventListener('keydown', escHandler)
          }

          // Add click handler using event delegation for thumbnail images
          document.addEventListener('click', function (e) {
            const target = e.target

            // Handle thumbnail images - show lightbox
            if (
              target.tagName === 'IMG' &&
              target.getAttribute('data-thumbnail-expand') === 'true'
            ) {
              e.preventDefault()
              e.stopPropagation()
              showImageLightbox(target.src)
            }

            // Handle regular tool-result images - also show lightbox
            else if (target.tagName === 'IMG' && target.classList.contains('tool-result-image')) {
              e.preventDefault()
              e.stopPropagation()
              showImageLightbox(target.src)
            }
          })

          // Add tooltips to existing thumbnail images
          document.querySelectorAll('img[data-thumbnail-expand="true"]').forEach(img => {
            img.title = 'Click to enlarge image'
          })

          // Add tooltips to regular tool-result images
          document.querySelectorAll('img.tool-result-image').forEach(img => {
            img.title = 'Click to enlarge image'
          })

          // Handle copy link buttons
          document.querySelectorAll('.copy-message-link').forEach(button => {
            button.addEventListener('click', function (e) {
              e.preventDefault()
              const messageIndex = this.getAttribute('data-message-index')
              const url =
                window.location.origin + window.location.pathname + '#message-' + messageIndex

              navigator.clipboard
                .writeText(url)
                .then(() => {
                  // Show feedback
                  const originalHtml = this.innerHTML
                  this.innerHTML =
                    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"></path></svg>'
                  this.style.color = '#10b981'

                  setTimeout(() => {
                    this.innerHTML = originalHtml
                    this.style.color = ''
                  }, 2000)
                })
                .catch(err => {
                  console.error('Failed to copy link:', err)
                })
            })
          })

          // Scroll to message if hash is present
          if (window.location.hash) {
            const messageElement = document.querySelector(window.location.hash)
            if (messageElement) {
              messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
              messageElement.style.backgroundColor = '#fef3c7'
              setTimeout(() => {
                messageElement.style.backgroundColor = ''
              }, 2000)
            }
          }
        })
      </script>

      <!-- Hidden data storage -->
      <div style="display: none;">
        <div id="request-data-storage">
          ${details.requestBody ? JSON.stringify(details.requestBody) : 'null'}
        </div>
        <div id="response-data-storage">
          ${details.responseBody ? JSON.stringify(details.responseBody) : 'null'}
        </div>
        <div id="chunks-data-storage">
          ${details.streamingChunks ? JSON.stringify(details.streamingChunks) : '[]'}
        </div>
        <div id="request-headers-storage">
          ${details.requestHeaders ? JSON.stringify(details.requestHeaders) : 'null'}
        </div>
        <div id="response-headers-storage">
          ${details.responseHeaders ? JSON.stringify(details.responseHeaders) : 'null'}
        </div>
        <div id="telemetry-data-storage">
          ${details.telemetry ? JSON.stringify(details.telemetry) : 'null'}
        </div>
        <div id="metadata-storage">
          ${JSON.stringify({
            id: details.requestId || '',
            projectId: details.projectId || '',
            timestamp: details.timestamp || '',
            method: details.method || 'POST',
            endpoint: details.endpoint || '/v1/messages',
            model: details.model || 'unknown',
            inputTokens: details.inputTokens || 0,
            outputTokens: details.outputTokens || 0,
            totalTokens: (details.inputTokens || 0) + (details.outputTokens || 0),
            durationMs: details.durationMs || 0,
            responseStatus: details.responseStatus || 0,
            streaming: details.streaming === true,
          })}
        </div>
      </div>

      <script>
        // Get the JSON data from hidden elements
        const requestData = getJsonData('request-data-storage')
        const responseData = getJsonData('response-data-storage')
        const streamingChunks = getJsonData('chunks-data-storage') || []
        const requestHeaders = getJsonData('request-headers-storage')
        const responseHeaders = getJsonData('response-headers-storage')
        const telemetryData = getJsonData('telemetry-data-storage')
        const requestMetadata = getJsonData('metadata-storage')

        // Function to set up JSON viewer with selective collapse using MutationObserver
        function setupJsonViewer(containerId, data, keysToCollapse = ['tools', 'system']) {
          const container = document.getElementById(containerId)
          if (!container || !data) return

          container.innerHTML = '' // Clear existing content

          // Add show-copy class to container to enable copy functionality
          container.classList.add('show-copy')

          // Create a single viewer for visual cohesion
          const viewer = document.createElement('andypf-json-viewer')
          viewer.setAttribute('expand-icon-type', 'arrow')
          viewer.setAttribute('expanded', 'true')
          viewer.setAttribute('expand-level', '10')
          viewer.setAttribute('show-copy', 'true')
          viewer.setAttribute(
            'theme',
            '{"base00": "#f9fafb", "base01": "#f3f4f6", "base02": "#e5e7eb", "base03": "#d1d5db", "base04": "#9ca3af", "base05": "#374151", "base06": "#1f2937", "base07": "#111827", "base08": "#ef4444", "base09": "#f97316", "base0A": "#eab308", "base0B": "#22c55e", "base0C": "#06b6d4", "base0D": "#3b82f6", "base0E": "#8b5cf6", "base0F": "#ec4899"}'
          )
          viewer.data = data
          container.appendChild(viewer)

          // Use MutationObserver to detect when content is rendered and collapse specific keys
          customElements.whenDefined('andypf-json-viewer').then(() => {
            // Inject dense styles into shadow DOM
            function injectDenseStyles() {
              if (!viewer.shadowRoot) return

              // Check if we already injected styles
              if (viewer.shadowRoot.querySelector('#dense-styles')) return

              const style = document.createElement('style')
              style.id = 'dense-styles'
              style.textContent =
                /* Row and general spacing */
                '.data-row { line-height: 1.2 !important; padding: 1px 0 !important; margin: 0 !important; } ' +
                '.data-row .data-row { padding-left: 16px !important; margin-left: 4px !important; border-left: solid 1px var(--base02) !important; } ' +
                '.key-value-wrapper { display: inline-flex !important; align-items: center !important; } ' +
                '.key, .value, .property { font-size: 10px !important; line-height: 1.05 !important; } ' +
                '.comma, .bracket { font-size: 10px !important; } ' +
                /* Copy icon sizing and spacing */
                '.copy.icon { width: 6px !important; height: 8px !important; margin-left: 6px !important; opacity: 0 !important; transition: opacity 0.2s !important; } ' +
                '.key-value-wrapper:hover .copy.icon { opacity: 1 !important; } ' +
                '.icon-wrapper:has(.copy.icon) { display: inline-flex !important; width: 20px !important; margin-left: 4px !important; flex-shrink: 0 !important; } ' +
                '.copy.icon:before { width: 6px !important; height: 8px !important; } ' +
                /* CSS Triangle Arrow sizing - override the border-based arrow */
                '.expand-icon-arrow .expand.icon { ' +
                'width: 0 !important; height: 0 !important; ' +
                'border-left: solid 4px var(--base0E) !important; ' +
                'border-top: solid 4px transparent !important; ' +
                'border-bottom: solid 4px transparent !important; ' +
                'margin-right: 4px !important; margin-left: 2px !important; ' +
                '} ' +
                '.expand-icon-arrow .expanded>.key-value-wrapper .expand.icon, ' +
                '.expand-icon-arrow .expanded.icon.expand { ' +
                'border-left-color: var(--base0D) !important; ' +
                '} ' +
                /* Square/Circle icon sizing */
                '.expand-icon-square .expand.icon, .expand-icon-circle .expand.icon { ' +
                'width: 7px !important; height: 7px !important; ' +
                '} ' +
                /* Icon wrapper spacing */
                '.icon-wrapper { margin-right: 2px !important; }'
              viewer.shadowRoot.appendChild(style)
            }

            // Function to collapse specific keys by clicking on the SVG expand/collapse icons
            function collapseSpecificKeys() {
              if (!viewer.shadowRoot) {
                return false
              }

              let collapsedCount = 0

              // Strategy: Find all .data-row elements that contain our target keys
              const dataRows = viewer.shadowRoot.querySelectorAll('.data-row')

              dataRows.forEach((row, index) => {
                // Look for the key element specifically, not just text content
                const keyElement = row.querySelector('.key')
                if (!keyElement) return

                const keyText = keyElement.textContent || ''

                keysToCollapse.forEach(keyToCollapse => {
                  // Check if this key element exactly matches our target
                  if (keyText === '"' + keyToCollapse + '"' || keyText === keyToCollapse) {
                    // Look for the expand icon within this row - it has class "expand icon clickable"
                    const expandIcon = row.querySelector('.expand.icon.clickable')
                    if (expandIcon) {
                      expandIcon.click()
                      collapsedCount++
                    }
                  }
                })
              })

              return collapsedCount > 0
            }

            // Start observing the shadow root for changes
            if (viewer.shadowRoot) {
              // Inject dense styles first
              injectDenseStyles()

              // Collapse specific keys after a short delay to ensure DOM is ready
              setTimeout(() => {
                collapseSpecificKeys()
              }, 100)
            }
          })
        }

        function showView(view) {
          const conversationView = document.getElementById('conversation-view')
          const rawView = document.getElementById('raw-view')
          const headersView = document.getElementById('headers-view')
          const buttons = document.querySelectorAll('.view-toggle button')

          // Hide all views
          conversationView.classList.add('hidden')
          rawView.classList.add('hidden')
          headersView.classList.add('hidden')

          // Remove active from all buttons
          buttons.forEach(btn => btn.classList.remove('active'))

          if (view === 'conversation') {
            conversationView.classList.remove('hidden')
            buttons[0].classList.add('active')
          } else if (view === 'raw') {
            rawView.classList.remove('hidden')
            buttons[1].classList.add('active')

            // Use the new approach with MutationObserver for selective collapse
            setupJsonViewer('request-json-container', requestData)
            setupJsonViewer('response-json-container', responseData)

            // Parse and render streaming chunks
            streamingChunks.forEach((chunk, i) => {
              const chunkContainer = document.getElementById('chunk-' + i)
              if (chunkContainer) {
                try {
                  const chunkData = JSON.parse(chunk.data)
                  // Create a andypf-json-viewer element for each chunk
                  const viewer = document.createElement('andypf-json-viewer')
                  viewer.setAttribute('expand-icon-type', 'arrow')
                  viewer.setAttribute('expanded', 'true')
                  viewer.setAttribute('expand-level', '2')
                  viewer.setAttribute('show-copy', 'true')
                  viewer.setAttribute(
                    'theme',
                    '{"base00": "#f9fafb", "base01": "#f3f4f6", "base02": "#e5e7eb", "base03": "#d1d5db", "base04": "#9ca3af", "base05": "#374151", "base06": "#1f2937", "base07": "#111827", "base08": "#ef4444", "base09": "#f97316", "base0A": "#eab308", "base0B": "#22c55e", "base0C": "#06b6d4", "base0D": "#3b82f6", "base0E": "#8b5cf6", "base0F": "#ec4899"}'
                  )
                  viewer.data = chunkData
                  chunkContainer.innerHTML = ''
                  chunkContainer.appendChild(viewer)
                } catch (e) {
                  // If not valid JSON, display as text
                  chunkContainer.textContent = chunk.data
                }
              }
            })
          } else if (view === 'headers') {
            headersView.classList.remove('hidden')
            buttons[2].classList.add('active')

            // Render headers and metadata using andypf-json-viewer
            setTimeout(() => {
              // Render request headers
              if (requestHeaders) {
                const requestHeadersViewer = document.getElementById('request-headers')
                if (requestHeadersViewer) {
                  requestHeadersViewer.data = requestHeaders
                }
              }

              // Render response headers
              if (responseHeaders) {
                const responseHeadersViewer = document.getElementById('response-headers')
                if (responseHeadersViewer) {
                  responseHeadersViewer.data = responseHeaders
                }
              }

              // Render request metadata
              const metadataViewer = document.getElementById('request-metadata')
              if (metadataViewer && requestMetadata) {
                metadataViewer.data = requestMetadata
              }

              // Render telemetry data
              if (telemetryData) {
                const telemetryViewer = document.getElementById('telemetry-data')
                if (telemetryViewer) {
                  telemetryViewer.data = telemetryData
                }
              }
            }, 100)
          }
        }

        // Copy JSON to clipboard
        function copyJsonToClipboard(type) {
          let data
          if (type === 'request') {
            data = requestData
          } else if (type === 'response') {
            data = responseData
          }

          if (data) {
            const jsonString = JSON.stringify(data, null, 2)
            navigator.clipboard
              .writeText(jsonString)
              .then(() => {
                // Find the button that was clicked and update its text
                const buttons = document.querySelectorAll('button')
                buttons.forEach(btn => {
                  if (btn.onclick && btn.onclick.toString().includes("'" + type + "'")) {
                    const originalText = btn.textContent
                    btn.textContent = 'Copied!'
                    btn.style.background = '#10b981'
                    setTimeout(() => {
                      btn.textContent = originalText
                      btn.style.background = ''
                    }, 2000)
                  }
                })
              })
              .catch(err => {
                console.error('Failed to copy to clipboard:', err)
                alert('Failed to copy to clipboard')
              })
          }
        }

        // Initialize syntax highlighting and JSON viewers
        document.addEventListener('DOMContentLoaded', function () {
          hljs.highlightAll()

          // Initialize JSON viewers on page load if raw view is active
          if (!document.getElementById('raw-view').classList.contains('hidden')) {
            setupJsonViewer('request-json-container', requestData)
            setupJsonViewer('response-json-container', responseData)
          }
        })
      </script>
    `

    return c.html(layout('Request Details', content, '', c))
  } catch (error) {
    return c.html(
      layout(
        'Error',
        html`
          <div class="error-banner">
            <strong>Error:</strong> ${getErrorMessage(error) || 'Failed to load request details'}
          </div>
          <div class="mb-6">
            <a href="/dashboard" class="text-blue-600">← Back to Dashboard</a>
          </div>
        `,
        '',
        c
      )
    )
  }
})
