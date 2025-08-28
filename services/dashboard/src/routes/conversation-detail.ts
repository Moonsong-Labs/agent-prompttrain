import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { getErrorMessage } from '@agent-prompttrain/shared'
import { csrfProtection } from '../middleware/csrf.js'
import {
  ConversationGraph,
  ConversationNode,
  calculateGraphLayout,
  renderGraphSVG,
  getBranchColor,
} from '../utils/conversation-graph.js'
import { formatNumber, formatDuration, escapeHtml } from '../utils/formatters.js'
import {
  calculateConversationMetrics,
  formatDuration as formatMetricDuration,
} from '../utils/conversation-metrics.js'
import type { ConversationRequest } from '../types/conversation.js'

export const conversationDetailRoutes = new Hono<{
  Variables: {
    csrfToken?: string
  }
}>()

// Apply CSRF protection to all routes
conversationDetailRoutes.use('*', csrfProtection())

/**
 * Detailed conversation view with graph visualization
 */
conversationDetailRoutes.get('/conversation/:id', async c => {
  const conversationId = c.req.param('id')
  const selectedBranch = c.req.query('branch')
  const view = c.req.query('view') || 'tree' // Default to tree view

  // Get storage service from container
  const { container } = await import('../container.js')
  const storageService = container.getStorageService()

  try {
    // Get the specific conversation by ID - optimized query
    const conversation = await storageService.getConversationById(conversationId)

    if (!conversation) {
      return c.html(html`
        <div class="error-banner"><strong>Error:</strong> Conversation not found</div>
      `)
    }

    // Fetch sub-tasks for requests that have task invocations
    const subtasksMap = new Map<string, any[]>()
    for (const req of conversation.requests) {
      if (
        req.task_tool_invocation &&
        Array.isArray(req.task_tool_invocation) &&
        req.task_tool_invocation.length > 0
      ) {
        const subtasks = await storageService.getSubtasksForRequest(req.request_id)
        if (subtasks.length > 0) {
          // Group sub-tasks by their conversation ID
          const subtasksByConversation = subtasks.reduce(
            (acc, subtask) => {
              const convId = subtask.conversation_id || 'unknown'
              if (!acc[convId]) {
                acc[convId] = []
              }
              acc[convId].push(subtask)
              return acc
            },
            {} as Record<string, any[]>
          )

          // Link sub-task conversations to task invocations
          const enrichedInvocations = req.task_tool_invocation.map((invocation: any) => {
            // Find matching sub-task conversation by checking first message content
            for (const [convId, convSubtasks] of Object.entries(subtasksByConversation)) {
              // Check if any subtask in this conversation matches the invocation prompt
              const matches = convSubtasks.some(st => {
                // This is a simplified check - you might need more sophisticated matching
                return st.is_subtask && st.parent_task_request_id === req.request_id
              })
              if (matches) {
                return { ...invocation, linked_conversation_id: convId }
              }
            }
            return invocation
          })

          subtasksMap.set(req.request_id, enrichedInvocations)
        }
      }
    }

    // Use the actual message count from the database
    const requestDetailsMap = new Map<string, { messageCount: number; messageTypes: string[] }>()

    conversation.requests.forEach((req, index) => {
      // Use the actual message count from the request
      const messageCount = req.message_count || 0

      // Simple type assignment based on position
      const messageTypes: string[] = []
      const isFirst = index === 0
      if (!isFirst) {
        messageTypes.push('user') // Previous user message
      }
      messageTypes.push('assistant') // Current assistant response

      requestDetailsMap.set(req.request_id, {
        messageCount: messageCount,
        messageTypes: messageTypes.slice(-2),
      })
    })

    // Build the graph structure - keep original relationships but display in reverse order
    const graphNodes: ConversationNode[] = []
    const graphEdges: Array<{ source: string; target: string }> = []

    // Create a map for quick request lookup by ID
    const requestMap = new Map(conversation.requests.map(req => [req.request_id, req]))

    // First, add all conversation request nodes
    conversation.requests.forEach((req, index) => {
      const details = requestDetailsMap.get(req.request_id) || {
        messageCount: 0,
        messageTypes: [],
      }

      // Get sub-task info
      const enrichedInvocations = subtasksMap.get(req.request_id)
      const hasSubtasks = enrichedInvocations && enrichedInvocations.length > 0
      const subtaskCount = enrichedInvocations?.length || 0

      // Also check raw task_tool_invocation if not in subtasksMap
      const hasTaskInvocation =
        req.task_tool_invocation &&
        Array.isArray(req.task_tool_invocation) &&
        req.task_tool_invocation.length > 0
      const finalHasSubtasks = hasSubtasks || hasTaskInvocation
      const finalSubtaskCount =
        subtaskCount || (hasTaskInvocation ? req.task_tool_invocation.length : 0)

      // Use parent_request_id if available, fallback to hash-based lookup
      let parentId = req.parent_request_id
      if (!parentId && req.parent_message_hash) {
        const parentReq = conversation.requests.find(
          r => r.current_message_hash === req.parent_message_hash
        )
        parentId = parentReq?.request_id
      }

      // Check if the last message in the request is a user message with text content
      let hasUserMessage = false
      const lastMessage = req.last_message
      if (lastMessage?.role === 'user') {
        // Check if content has text type
        if (typeof lastMessage.content === 'string') {
          hasUserMessage = lastMessage.content.trim().length > 0
        } else if (Array.isArray(lastMessage.content)) {
          hasUserMessage = lastMessage.content.some(
            (item: any) => item.type === 'text' && item.text && item.text.trim().length > 0
          )
        }
      }

      // Calculate context tokens for this request
      let contextTokens = 0
      if (req.response_body?.usage) {
        const usage = req.response_body.usage
        contextTokens =
          (usage.input_tokens || 0) +
          (usage.cache_read_input_tokens || 0) +
          (usage.cache_creation_input_tokens || 0)
      }

      // Determine the last message type and tool result status
      let lastMessageType: 'user' | 'assistant' | 'tool_result' = 'assistant'
      let toolResultStatus: 'success' | 'error' | 'mixed' | undefined

      // Check if the last message in the request contains tool results
      if (lastMessage && lastMessage.content && Array.isArray(lastMessage.content)) {
        const toolResults = lastMessage.content.filter((item: any) => item.type === 'tool_result')

        if (toolResults.length > 0) {
          lastMessageType = 'tool_result'

          // Check for errors in tool results
          const hasError = toolResults.some((result: any) => result.is_error === true)
          const hasSuccess = toolResults.some((result: any) => result.is_error !== true)

          if (hasError && hasSuccess) {
            toolResultStatus = 'mixed'
          } else if (hasError) {
            toolResultStatus = 'error'
          } else {
            toolResultStatus = 'success'
          }
        }
      }

      // Override if last message is actually a user message
      if (hasUserMessage) {
        lastMessageType = 'user'
        toolResultStatus = undefined
      }

      graphNodes.push({
        id: req.request_id,
        label: `${req.model}`,
        timestamp: new Date(req.timestamp),
        branchId: req.branch_id || 'main',
        parentId: parentId,
        tokens: req.total_tokens,
        model: req.model,
        hasError: !!req.error,
        messageIndex: index + 1,
        messageCount: details.messageCount,
        messageTypes: details.messageTypes,
        isSubtask: req.is_subtask,
        hasSubtasks: finalHasSubtasks,
        subtaskCount: finalSubtaskCount,
        hasUserMessage: hasUserMessage,
        contextTokens: contextTokens,
        lastMessageType: lastMessageType,
        toolResultStatus: toolResultStatus,
      })
    })

    // Track sub-task numbers across the conversation
    let subtaskNumber = 0

    // Now add sub-task summary nodes for requests that spawned tasks
    for (const req of conversation.requests) {
      // Check if this request has task invocations
      if (
        req.task_tool_invocation &&
        Array.isArray(req.task_tool_invocation) &&
        req.task_tool_invocation.length > 0
      ) {
        // Get actual sub-task count from database
        const actualSubtaskCount = await storageService.countSubtasksForRequests([req.request_id])

        // Even if actualSubtaskCount is 0, show the task invocations if they exist
        const displayCount = actualSubtaskCount || req.task_tool_invocation.length

        // Increment sub-task number
        subtaskNumber++

        // Try to find the linked conversation ID and prompt from the enriched invocations
        const enrichedInvocations = subtasksMap.get(req.request_id)
        let linkedConversationId = null
        let subtaskPrompt = ''

        if (enrichedInvocations && enrichedInvocations.length > 0) {
          // Look for any invocation with a linked conversation
          const linkedInvocation = enrichedInvocations.find(
            (inv: any) => inv.linked_conversation_id
          )
          if (linkedInvocation) {
            linkedConversationId = linkedInvocation.linked_conversation_id
            // Get the prompt from the first invocation
            if (linkedInvocation.input?.prompt) {
              subtaskPrompt = linkedInvocation.input.prompt
            }
          } else if (enrichedInvocations[0]?.input?.prompt) {
            // If no linked conversation yet, still get the prompt from first invocation
            subtaskPrompt = enrichedInvocations[0].input.prompt
          }
        }

        // If we don't have a prompt yet, try from the raw task invocations
        if (
          !subtaskPrompt &&
          req.task_tool_invocation &&
          req.task_tool_invocation[0]?.input?.prompt
        ) {
          subtaskPrompt = req.task_tool_invocation[0].input.prompt
        }

        // If we still don't have a linked conversation, try to find it from sub-tasks
        if (!linkedConversationId) {
          const subtasks = await storageService.getSubtasksForRequest(req.request_id)
          if (subtasks.length > 0 && subtasks[0].conversation_id) {
            linkedConversationId = subtasks[0].conversation_id
          }
        }

        // Create a sub-task summary node
        const subtaskNodeId = `${req.request_id}-subtasks`
        graphNodes.push({
          id: subtaskNodeId,
          label: `sub-task ${subtaskNumber} (${displayCount})`,
          timestamp: new Date(req.timestamp),
          branchId: req.branch_id || 'main',
          parentId: req.request_id, // Parent is the request that spawned it
          tokens: 0, // We don't have aggregate token count here
          model: 'sub-tasks',
          hasError: false,
          messageIndex: req.message_count || 0, // Use parent's message count
          messageCount: req.message_count || 0, // Use parent's message count for positioning
          isSubtask: true,
          hasSubtasks: false,
          subtaskCount: displayCount,
          linkedConversationId: linkedConversationId, // Store the linked conversation ID
          subtaskPrompt: subtaskPrompt, // Store the prompt snippet
        })

        // Add edge from parent request to sub-task node
        graphEdges.push({
          source: req.request_id,
          target: subtaskNodeId,
        })
      }
    }

    const graph: ConversationGraph = {
      nodes: graphNodes,
      edges: graphEdges,
    }

    // Build edges from parent relationships
    graphNodes.forEach(node => {
      if (node.parentId && node.id !== node.parentId) {
        // Verify parent exists in our nodes
        const parentExists = graphNodes.some(n => n.id === node.parentId)
        if (parentExists) {
          graphEdges.push({
            source: node.parentId,
            target: node.id,
          })
        }
      }
    })

    // Calculate layout with reversed flag to show newest at top
    const graphLayout = await calculateGraphLayout(graph, true, requestMap)
    const svgGraph = renderGraphSVG(graphLayout, true)

    // Filter requests by branch if selected
    let filteredRequests = conversation.requests
    if (selectedBranch && selectedBranch !== 'main') {
      // Find the first request in the selected branch
      const branchRequests = conversation.requests.filter(r => r.branch_id === selectedBranch)
      if (branchRequests.length > 0) {
        // Sort by timestamp to get the first request in the branch
        branchRequests.sort(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        )
        const firstBranchRequest = branchRequests[0]

        // Get all requests from main branch that happened before the branch diverged
        const mainRequestsBeforeBranch = conversation.requests.filter(
          r =>
            (r.branch_id === 'main' || !r.branch_id) &&
            new Date(r.timestamp) < new Date(firstBranchRequest.timestamp)
        )

        // Combine main requests before branch + all branch requests
        filteredRequests = [...mainRequestsBeforeBranch, ...branchRequests]
      } else {
        filteredRequests = branchRequests
      }
    } else if (selectedBranch === 'main') {
      // For main branch, show only main branch requests
      filteredRequests = conversation.requests.filter(r => r.branch_id === 'main' || !r.branch_id)
    }

    // Calculate stats
    const totalDuration =
      new Date(conversation.last_message).getTime() - new Date(conversation.first_message).getTime()

    // Calculate AI inference time (sum of all request durations)
    const totalInferenceTime = conversation.requests.reduce(
      (sum, req) => sum + (req.duration_ms || 0),
      0
    )

    // Calculate current context size (last request of conversation)
    // Total input tokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
    let currentContextSize = 0
    const lastRequest = conversation.requests[conversation.requests.length - 1]
    if (lastRequest?.response_body?.usage) {
      const usage = lastRequest.response_body.usage
      currentContextSize =
        (usage.input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0)
    }

    const branchStats = conversation.branches.reduce(
      (acc, branch) => {
        const branchRequests = conversation.requests.filter(r => (r.branch_id || 'main') === branch)
        // Get the max message count from the branch (latest request has the highest count)
        const maxMessageCount = Math.max(...branchRequests.map(r => r.message_count || 0), 0)

        // Calculate context size for the last request of this branch
        let branchContextSize = 0
        if (branchRequests.length > 0) {
          const lastBranchRequest = branchRequests[branchRequests.length - 1]
          if (lastBranchRequest?.response_body?.usage) {
            const usage = lastBranchRequest.response_body.usage
            branchContextSize =
              (usage.input_tokens || 0) +
              (usage.cache_read_input_tokens || 0) +
              (usage.cache_creation_input_tokens || 0)
          }
        }

        acc[branch] = {
          count: maxMessageCount,
          tokens: branchRequests.reduce((sum, r) => sum + r.total_tokens, 0),
          requests: branchRequests.length,
          firstMessage:
            branchRequests.length > 0
              ? Math.min(...branchRequests.map(r => new Date(r.timestamp).getTime()))
              : 0,
          lastMessage:
            branchRequests.length > 0
              ? Math.max(...branchRequests.map(r => new Date(r.timestamp).getTime()))
              : 0,
          contextSize: branchContextSize,
        }
        return acc
      },
      {} as Record<
        string,
        {
          count: number
          tokens: number
          requests: number
          firstMessage: number
          lastMessage: number
          contextSize: number
        }
      >
    )

    // Add main branch if not present
    if (!branchStats.main) {
      const mainRequests = conversation.requests.filter(r => !r.branch_id || r.branch_id === 'main')
      // Get the max message count from the main branch
      const maxMessageCount = Math.max(...mainRequests.map(r => r.message_count || 0), 0)

      // Calculate context size for the last request of main branch
      let mainBranchContextSize = 0
      if (mainRequests.length > 0) {
        const lastMainRequest = mainRequests[mainRequests.length - 1]
        if (lastMainRequest?.response_body?.usage) {
          const usage = lastMainRequest.response_body.usage
          mainBranchContextSize =
            (usage.input_tokens || 0) +
            (usage.cache_read_input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0)
        }
      }

      branchStats.main = {
        count: maxMessageCount,
        tokens: mainRequests.reduce((sum, r) => sum + r.total_tokens, 0),
        requests: mainRequests.length,
        firstMessage:
          mainRequests.length > 0
            ? Math.min(...mainRequests.map(r => new Date(r.timestamp).getTime()))
            : 0,
        lastMessage:
          mainRequests.length > 0
            ? Math.max(...mainRequests.map(r => new Date(r.timestamp).getTime()))
            : 0,
        contextSize: mainBranchContextSize,
      }
    }

    // Calculate total sub-tasks spawned by this conversation
    // First, get the actual count of sub-task requests linked to this conversation
    let totalSubtasksSpawned = 0

    // Get request IDs that have task invocations
    const requestIdsWithTasks = conversation.requests
      .filter(
        req =>
          req.task_tool_invocation &&
          Array.isArray(req.task_tool_invocation) &&
          req.task_tool_invocation.length > 0
      )
      .map(req => req.request_id)

    if (requestIdsWithTasks.length > 0) {
      // Count actual sub-tasks linked to these requests
      totalSubtasksSpawned = await storageService.countSubtasksForRequests(requestIdsWithTasks)
    }

    // Calculate metrics for all requests (conversation level)
    const allMetrics = calculateConversationMetrics(conversation.requests)

    // Calculate conversation-level stats
    const conversationStats = {
      messageCount: conversation.message_count || 0,
      totalTokens: conversation.total_tokens,
      branchCount: Object.keys(branchStats).length,
      duration: totalDuration,
      inferenceTime: totalInferenceTime,
      requestCount: conversation.requests.length,
      totalSubtasks: totalSubtasksSpawned,
      toolExecution: allMetrics.toolExecution,
      userReply: allMetrics.userReply,
      userInteractions: allMetrics.userInteractions,
      currentContextSize: currentContextSize,
    }

    // Calculate branch-specific stats if a branch is selected
    let selectedBranchStats = null
    if (selectedBranch) {
      // Calculate metrics for filtered requests (includes parent branches)
      const branchMetrics = calculateConversationMetrics(filteredRequests)

      // For cumulative stats, use all filtered requests (includes parent branches)
      const cumulativeTokens = filteredRequests.reduce((sum, r) => sum + r.total_tokens, 0)
      const cumulativeInferenceTime = filteredRequests.reduce(
        (sum, req) => sum + (req.duration_ms || 0),
        0
      )

      // Calculate cumulative duration (from first to last request in filtered set)
      let cumulativeDuration = 0
      if (filteredRequests.length > 0) {
        const timestamps = filteredRequests.map(r => new Date(r.timestamp).getTime())
        cumulativeDuration = Math.max(...timestamps) - Math.min(...timestamps)
      }

      // Calculate sub-tasks for all filtered requests
      let cumulativeSubtasks = 0
      const cumulativeRequestIdsWithTasks = filteredRequests
        .filter(
          req =>
            req.task_tool_invocation &&
            Array.isArray(req.task_tool_invocation) &&
            req.task_tool_invocation.length > 0
        )
        .map(req => req.request_id)

      if (cumulativeRequestIdsWithTasks.length > 0) {
        cumulativeSubtasks = await storageService.countSubtasksForRequests(
          cumulativeRequestIdsWithTasks
        )
      }

      // Get the maximum message count from filtered requests (cumulative)
      const maxMessageCount = Math.max(...filteredRequests.map(r => r.message_count || 0), 0)

      // Get context size from branchStats
      const branchContextSize = branchStats[selectedBranch]?.contextSize || 0

      selectedBranchStats = {
        branchName: selectedBranch,
        messageCount: maxMessageCount,
        totalTokens: cumulativeTokens,
        duration: cumulativeDuration,
        inferenceTime: cumulativeInferenceTime,
        requestCount: filteredRequests.length,
        totalSubtasks: cumulativeSubtasks,
        toolExecution: branchMetrics.toolExecution,
        userReply: branchMetrics.userReply,
        userInteractions: branchMetrics.userInteractions,
        currentContextSize: branchContextSize,
      }
    }

    const content = html`
      <div class="mb-6">
        <a href="/dashboard" class="text-blue-600">← Back to Dashboard</a>
      </div>

      <!-- Conversation Details Panel -->
      <div style="margin-bottom: 2rem;">
        <h3
          style="margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600; display: flex; align-items: center; gap: 1rem;"
        >
          Conversation Details
          <span
            style="display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.875rem; font-weight: normal; color: #6b7280;"
          >
            <code
              style="font-family: monospace; background: #f3f4f6; padding: 0.125rem 0.5rem; border-radius: 0.25rem;"
              >${conversationId}</code
            >
            <button
              onclick="navigator.clipboard.writeText('${conversationId}').then(() => {
                const btn = this;
                const originalHTML = btn.innerHTML;
                btn.innerHTML = '✓';
                btn.style.color = '#10b981';
                setTimeout(() => {
                  btn.innerHTML = originalHTML;
                  btn.style.color = '';
                }, 2000);
              })"
              style="background: none; border: none; cursor: pointer; padding: 0.25rem; color: #6b7280; hover:color: #374151;"
              title="Copy conversation ID"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
          </span>
        </h3>
        <div class="conversation-stats-grid">
          <div class="conversation-stat-card">
            <span class="conversation-stat-label">Total Messages:</span>
            <span class="conversation-stat-value">${conversationStats.messageCount}</span>
          </div>
          <div class="conversation-stat-card">
            <span class="conversation-stat-label">Total Sub-tasks:</span>
            <span class="conversation-stat-value">${conversationStats.totalSubtasks}</span>
          </div>
          <div class="conversation-stat-card">
            <span class="conversation-stat-label">Total Tokens:</span>
            <span class="conversation-stat-value"
              >${conversationStats.totalTokens.toLocaleString()}</span
            >
          </div>
          <div class="conversation-stat-card">
            <span class="conversation-stat-label">Current Context Size:</span>
            <span class="conversation-stat-value"
              >${conversationStats.currentContextSize.toLocaleString()} tokens</span
            >
          </div>
          <div class="conversation-stat-card">
            <span class="conversation-stat-label">Branches:</span>
            <span class="conversation-stat-value">${conversationStats.branchCount}</span>
          </div>
          <div class="conversation-stat-card">
            <span class="conversation-stat-label">Total Duration:</span>
            <span class="conversation-stat-value"
              >${formatDuration(conversationStats.duration)}</span
            >
          </div>
          <div class="conversation-stat-card">
            <span class="conversation-stat-label">Total AI Inference:</span>
            <span class="conversation-stat-value"
              >${formatDuration(conversationStats.inferenceTime)}</span
            >
          </div>
          <div class="conversation-stat-card">
            <span class="conversation-stat-label">Total Tool Execution:</span>
            <span class="conversation-stat-value">
              ${conversationStats.toolExecution.count > 0
                ? `${formatMetricDuration(conversationStats.toolExecution.totalMs)} (${conversationStats.toolExecution.count} tools)`
                : 'No tools used'}
            </span>
          </div>
          <div class="conversation-stat-card">
            <span class="conversation-stat-label">Total Time to Reply:</span>
            <span class="conversation-stat-value">
              ${conversationStats.userReply.count > 0
                ? `${formatMetricDuration(conversationStats.userReply.totalMs)} (${conversationStats.userReply.count} intervals)`
                : 'No replies'}
            </span>
          </div>
        </div>
      </div>

      <!-- Branch Details Panel (only show when a branch is selected) -->
      ${selectedBranchStats
        ? html`
            <div style="margin-bottom: 2rem;">
              <h3 style="margin: 0 0 0.5rem 0; font-size: 1.25rem; font-weight: 600;">
                Branch Details:
                <span style="color: ${getBranchColor(selectedBranchStats.branchName)};"
                  >${selectedBranchStats.branchName}</span
                >
              </h3>
              <p style="margin: 0 0 1rem 0; font-size: 0.875rem; color: #6b7280;">
                Includes parent branch history up to this branch
              </p>
              <div class="conversation-stats-grid">
                <div class="conversation-stat-card">
                  <span class="conversation-stat-label">Branch Messages:</span>
                  <span class="conversation-stat-value">${selectedBranchStats.messageCount}</span>
                </div>
                <div class="conversation-stat-card">
                  <span class="conversation-stat-label">Branch Sub-tasks:</span>
                  <span class="conversation-stat-value">${selectedBranchStats.totalSubtasks}</span>
                </div>
                <div class="conversation-stat-card">
                  <span class="conversation-stat-label">Branch Tokens:</span>
                  <span class="conversation-stat-value"
                    >${selectedBranchStats.totalTokens.toLocaleString()}</span
                  >
                </div>
                <div class="conversation-stat-card">
                  <span class="conversation-stat-label">Current Context Size:</span>
                  <span class="conversation-stat-value"
                    >${selectedBranchStats.currentContextSize.toLocaleString()} tokens</span
                  >
                </div>
                <div class="conversation-stat-card">
                  <span class="conversation-stat-label">Branch Requests:</span>
                  <span class="conversation-stat-value">${selectedBranchStats.requestCount}</span>
                </div>
                <div class="conversation-stat-card">
                  <span class="conversation-stat-label">Branch Duration:</span>
                  <span class="conversation-stat-value"
                    >${formatDuration(selectedBranchStats.duration)}</span
                  >
                </div>
                <div class="conversation-stat-card">
                  <span class="conversation-stat-label">Branch AI Inference:</span>
                  <span class="conversation-stat-value"
                    >${formatDuration(selectedBranchStats.inferenceTime)}</span
                  >
                </div>
                <div class="conversation-stat-card">
                  <span class="conversation-stat-label">Branch Tool Execution:</span>
                  <span class="conversation-stat-value">
                    ${selectedBranchStats.toolExecution.count > 0
                      ? `${formatMetricDuration(selectedBranchStats.toolExecution.totalMs)} (${selectedBranchStats.toolExecution.count} tools)`
                      : 'No tools used'}
                  </span>
                </div>
                <div class="conversation-stat-card">
                  <span class="conversation-stat-label">Branch Time to Reply:</span>
                  <span class="conversation-stat-value">
                    ${selectedBranchStats.userReply.count > 0
                      ? `${formatMetricDuration(selectedBranchStats.userReply.totalMs)} (${selectedBranchStats.userReply.count} intervals)`
                      : 'No replies'}
                  </span>
                </div>
              </div>
            </div>
          `
        : ''}

      <!-- Branch Filter -->
      <div class="branch-filter" id="branch-filter">
        <span class="text-sm text-gray-600">Filter by branch:</span>
        <a
          href="/dashboard/conversation/${conversationId}"
          class="branch-chip ${!selectedBranch ? 'branch-chip-active' : 'branch-chip-main'}"
          style="${!selectedBranch
            ? 'background: #f3f4f6; color: #1f2937; border-color: #9ca3af;'
            : ''}"
        >
          All Branches
        </a>
        ${raw(
          Object.entries(branchStats)
            .map(([branch, stats]) => {
              const color = getBranchColor(branch)
              const isActive = selectedBranch === branch
              return `
            <a href="/dashboard/conversation/${conversationId}?branch=${branch}"
               class="branch-chip ${isActive ? 'branch-chip-active' : ''}"
               style="${branch !== 'main' ? `background: ${color}20; color: ${color}; border-color: ${color};` : 'background: #f3f4f6; color: #4b5563; border-color: #e5e7eb;'}${isActive ? ' font-weight: 600;' : ''}">
              ${branch} (${stats.count} messages, ${formatNumber(stats.tokens)} tokens)
            </a>
          `
            })
            .join('')
        )}
      </div>

      <!-- Tab Navigation -->
      <div class="tab-container" style="margin: 1.5rem 0; border-bottom: 1px solid #e5e7eb;">
        <div style="display: flex; gap: 0;">
          <button
            id="tree-tab"
            class="tab-button ${view === 'tree' ? 'tab-active' : 'tab-inactive'}"
            style="
              padding: 0.75rem 1.5rem;
              background: none;
              border: none;
              cursor: pointer;
              text-decoration: none;
              font-weight: 500;
              border-bottom: 2px solid ${view === 'tree' ? '#3b82f6' : 'transparent'};
              color: ${view === 'tree' ? '#3b82f6' : '#6b7280'};
              transition: all 0.2s;
            "
            onclick="switchTab('tree')"
          >
            Tree View
          </button>
          <button
            id="timeline-tab"
            class="tab-button ${view === 'timeline' ? 'tab-active' : 'tab-inactive'}"
            style="
              padding: 0.75rem 1.5rem;
              background: none;
              border: none;
              cursor: pointer;
              text-decoration: none;
              font-weight: 500;
              border-bottom: 2px solid ${view === 'timeline' ? '#3b82f6' : 'transparent'};
              color: ${view === 'timeline' ? '#3b82f6' : '#6b7280'};
              transition: all 0.2s;
            "
            onclick="switchTab('timeline')"
          >
            Timeline
          </button>
          <button
            id="analytics-tab"
            class="tab-button ${view === 'analytics' ? 'tab-active' : 'tab-inactive'}"
            style="
              padding: 0.75rem 1.5rem;
              background: none;
              border: none;
              cursor: pointer;
              text-decoration: none;
              font-weight: 500;
              border-bottom: 2px solid ${view === 'analytics' ? '#3b82f6' : 'transparent'};
              color: ${view === 'analytics' ? '#3b82f6' : '#6b7280'};
              transition: all 0.2s;
            "
            onclick="switchTab('analytics')"
          >
            AI Analysis
          </button>
        </div>
      </div>

      <!-- Main Content -->
      <div class="conversation-content">
        <!-- Graph Visualization -->
        <div
          id="tree-panel"
          class="conversation-graph"
          style="display: ${view === 'tree'
            ? 'block'
            : 'none'}; width: 100%; position: relative; overflow: hidden; cursor: grab;"
        >
          <div id="tree-container" style="position: relative; transform: translate(0px, 0px);">
            ${raw(svgGraph)}
          </div>
        </div>

        <!-- Timeline -->
        <div
          id="timeline-panel"
          class="conversation-timeline"
          style="display: ${view === 'timeline' ? 'block' : 'none'};"
        >
          ${raw(renderConversationMessages(filteredRequests, conversation.branches, subtasksMap))}
        </div>

        <!-- AI Analysis -->
        <div
          id="analytics-panel"
          class="conversation-analytics"
          style="display: ${view === 'analytics' ? 'block' : 'none'};"
        >
          <!-- AI Analysis Panel -->
          <div
            id="analysis-panel"
            hx-get="/partials/analysis/status/${conversationId}/${selectedBranch || 'main'}"
            hx-trigger="load"
            hx-swap="outerHTML"
          >
            <div class="section">
              <div class="section-content">
                <div style="display: flex; align-items: center; gap: 0.75rem; color: #6b7280;">
                  <span class="spinner"></span>
                  <span>Loading AI Analysis...</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <script>
        // Tab switching functionality
        function switchTab(tabName) {
          // Update panel visibility
          document.getElementById('tree-panel').style.display =
            tabName === 'tree' ? 'block' : 'none'
          document.getElementById('timeline-panel').style.display =
            tabName === 'timeline' ? 'block' : 'none'
          document.getElementById('analytics-panel').style.display =
            tabName === 'analytics' ? 'block' : 'none'

          // Update tab styles
          const treeTab = document.getElementById('tree-tab')
          const timelineTab = document.getElementById('timeline-tab')
          const analyticsTab = document.getElementById('analytics-tab')

          // Reset all tabs
          const allTabs = [treeTab, timelineTab, analyticsTab]
          allTabs.forEach(tab => {
            tab.style.borderBottomColor = 'transparent'
            tab.style.color = '#6b7280'
            tab.classList.remove('tab-active')
            tab.classList.add('tab-inactive')
          })

          // Activate selected tab
          const activeTab =
            tabName === 'tree' ? treeTab : tabName === 'timeline' ? timelineTab : analyticsTab
          activeTab.style.borderBottomColor = '#3b82f6'
          activeTab.style.color = '#3b82f6'
          activeTab.classList.add('tab-active')
          activeTab.classList.remove('tab-inactive')

          // Update URL without reload
          const url = new URL(window.location)
          url.searchParams.set('view', tabName)
          window.history.replaceState({}, '', url)
        }

        // Add hover effects for tabs
        document.addEventListener('DOMContentLoaded', function () {
          const tabs = document.querySelectorAll('.tab-button')
          tabs.forEach(tab => {
            tab.addEventListener('mouseenter', function () {
              if (this.classList.contains('tab-inactive')) {
                this.style.color = '#4b5563'
              }
            })
            tab.addEventListener('mouseleave', function () {
              if (this.classList.contains('tab-inactive')) {
                this.style.color = '#6b7280'
              }
            })
          })

          // Add hover functionality for sub-task tooltips
          const subtaskGroups = document.querySelectorAll('.subtask-node-group')

          subtaskGroups.forEach(group => {
            const promptHover = group.querySelector('.subtask-prompt-hover')
            if (promptHover) {
              group.addEventListener('mouseenter', function () {
                promptHover.style.display = 'block'
              })

              group.addEventListener('mouseleave', function () {
                promptHover.style.display = 'none'
              })
            }
          })

          // Add panning and zooming functionality to tree view
          const treePanel = document.getElementById('tree-panel')
          const treeContainer = document.getElementById('tree-container')

          if (treePanel && treeContainer) {
            // Set transform origin to top-left for predictable scaling
            treeContainer.style.transformOrigin = '0 0'

            // State variables for pan and zoom
            let isPanning = false
            let startX = 0
            let startY = 0
            let scale = 1.0
            let translateX = 0
            let translateY = 0
            let lastTranslateX = 0
            let lastTranslateY = 0

            // Configuration
            const ZOOM_INTENSITY = 0.1
            const MIN_SCALE = 0.1
            const MAX_SCALE = 5.0

            // Parse existing transform to initialize state
            const initTransform = () => {
              const transform = treeContainer.style.transform
              const translateMatch = transform.match(
                /translate\\((-?\\d+(?:\\.\\d+)?)px,\\s*(-?\\d+(?:\\.\\d+)?)px\\)/
              )
              const scaleMatch = transform.match(/scale\\(([\\d.]+)\\)/)

              if (translateMatch) {
                translateX = parseFloat(translateMatch[1])
                translateY = parseFloat(translateMatch[2])
              }
              if (scaleMatch) {
                scale = parseFloat(scaleMatch[1])
              }
            }

            // Initialize from existing transform if any
            initTransform()

            // Centralized transform update function
            const updateTransform = () => {
              treeContainer.style.transform =
                'translate(' + translateX + 'px, ' + translateY + 'px) scale(' + scale + ')'
            }

            // Zoom functionality with mouse wheel
            treePanel.addEventListener('wheel', e => {
              e.preventDefault()

              // Calculate new scale
              const direction = e.deltaY < 0 ? 1 : -1
              const scaleFactor = 1 + direction * ZOOM_INTENSITY
              const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * scaleFactor))

              // If scale is at its limit, do nothing
              if (newScale === scale) {
                return
              }

              // Calculate cursor position relative to the panel
              const rect = treePanel.getBoundingClientRect()
              const mouseX = e.clientX - rect.left
              const mouseY = e.clientY - rect.top

              // Calculate new translation to center zoom on cursor
              translateX = mouseX - (mouseX - translateX) * (newScale / scale)
              translateY = mouseY - (mouseY - translateY) * (newScale / scale)

              // Update state and apply transform
              scale = newScale
              updateTransform()
            })

            // Panning functionality with mouse drag
            treePanel.addEventListener('mousedown', e => {
              // Only start panning if clicking on the panel itself or SVG elements
              if (e.target.tagName === 'A' || e.target.closest('a')) {
                return // Don't pan when clicking links
              }

              isPanning = true
              treePanel.style.cursor = 'grabbing'
              startX = e.clientX
              startY = e.clientY

              // Capture the translation state at the moment panning starts
              lastTranslateX = translateX
              lastTranslateY = translateY

              e.preventDefault()
            })

            document.addEventListener('mousemove', e => {
              if (!isPanning) return

              e.preventDefault()
              const deltaX = e.clientX - startX
              const deltaY = e.clientY - startY

              translateX = lastTranslateX + deltaX
              translateY = lastTranslateY + deltaY

              updateTransform()
            })

            document.addEventListener('mouseup', () => {
              if (isPanning) {
                isPanning = false
                treePanel.style.cursor = 'grab'
              }
            })

            // Handle mouse leave to stop panning
            document.addEventListener('mouseleave', () => {
              if (isPanning) {
                isPanning = false
                treePanel.style.cursor = 'grab'
              }
            })

            // Prevent text selection while panning
            treePanel.addEventListener('selectstart', e => {
              if (isPanning) {
                e.preventDefault()
              }
            })
          }
        })
      </script>
    `

    // Use the shared layout
    const { layout } = await import('../layout/index.js')
    return c.html(layout('Conversation Detail', content, '', c))
  } catch (error) {
    console.error('Error loading conversation detail:', error)
    const { layout } = await import('../layout/index.js')
    return c.html(
      layout(
        'Error',
        html`
          <div class="error-banner">
            <strong>Error:</strong> ${getErrorMessage(error) || 'Failed to load conversation'}
          </div>
        `,
        '',
        c
      )
    )
  }
})

/**
 * HTMX endpoint for updating just the messages part
 */
conversationDetailRoutes.get('/conversation/:id/messages', async c => {
  const conversationId = c.req.param('id')
  const selectedBranch = c.req.query('branch')

  // Get storage service from container
  const { container } = await import('../container.js')
  const storageService = container.getStorageService()

  try {
    const conversation = await storageService.getConversationById(conversationId)

    if (!conversation) {
      return c.html(html`<div class="error-banner">Conversation not found</div>`)
    }

    let filteredRequests = conversation.requests
    if (selectedBranch && selectedBranch !== 'main') {
      // Find the first request in the selected branch
      const branchRequests = conversation.requests.filter(r => r.branch_id === selectedBranch)
      if (branchRequests.length > 0) {
        // Sort by timestamp to get the first request in the branch
        branchRequests.sort(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        )
        const firstBranchRequest = branchRequests[0]

        // Get all requests from main branch that happened before the branch diverged
        const mainRequestsBeforeBranch = conversation.requests.filter(
          r =>
            (r.branch_id === 'main' || !r.branch_id) &&
            new Date(r.timestamp) < new Date(firstBranchRequest.timestamp)
        )

        // Combine main requests before branch + all branch requests
        filteredRequests = [...mainRequestsBeforeBranch, ...branchRequests]
      } else {
        filteredRequests = branchRequests
      }
    } else if (selectedBranch === 'main') {
      // For main branch, show only main branch requests
      filteredRequests = conversation.requests.filter(r => r.branch_id === 'main' || !r.branch_id)
    }

    return c.html(renderConversationMessages(filteredRequests, conversation.branches))
  } catch (error) {
    console.error('Error loading conversation messages:', error)
    return c.html(html`<div class="error-banner">Failed to load messages</div>`)
  }
})

/**
 * Helper to extract the last message content from a request
 */
function getLastMessageContent(req: ConversationRequest): string {
  try {
    // Check if we have the optimized last_message field
    if (req.last_message) {
      const lastMessage = req.last_message

      // Handle the last message directly
      if (typeof lastMessage.content === 'string') {
        const content = lastMessage.content.trim()
        return content.length > 80 ? content.substring(0, 77) + '...' : content
      } else if (Array.isArray(lastMessage.content)) {
        for (const block of lastMessage.content) {
          if (block.type === 'text' && block.text) {
            const content = block.text.trim()
            return content.length > 80 ? content.substring(0, 77) + '...' : content
          } else if (block.type === 'tool_use' && block.name) {
            return `🔧 Tool: ${block.name}${block.input?.prompt ? ' - ' + block.input.prompt.substring(0, 50) + '...' : ''}`
          } else if (block.type === 'tool_result' && block.tool_use_id) {
            return `✅ Tool Result${block.content ? ': ' + (typeof block.content === 'string' ? block.content : JSON.stringify(block.content)).substring(0, 50) + '...' : ''}`
          }
        }
      }

      // Fallback to role-based description
      if (lastMessage.role === 'assistant') {
        return '🤖 Assistant response'
      } else if (lastMessage.role === 'user') {
        return '👤 User message'
      } else if (lastMessage.role === 'system') {
        return '⚙️ System message'
      }
    }

    // Legacy fallback for old data structure
    if (!req.body || !req.body.messages || !Array.isArray(req.body.messages)) {
      return 'Request ID: ' + req.request_id
    }

    const messages = req.body.messages
    if (messages.length === 0) {
      return 'Request ID: ' + req.request_id
    }

    // Get the last message
    const lastMessage = messages[messages.length - 1]

    // Handle different message formats
    if (typeof lastMessage.content === 'string') {
      // Simple string content
      const content = lastMessage.content.trim()
      return content.length > 80 ? content.substring(0, 77) + '...' : content
    } else if (Array.isArray(lastMessage.content)) {
      // Array of content blocks
      for (const block of lastMessage.content) {
        if (block.type === 'text' && block.text) {
          const content = block.text.trim()
          return content.length > 80 ? content.substring(0, 77) + '...' : content
        } else if (block.type === 'tool_use' && block.name) {
          return `🔧 Tool: ${block.name}${block.input?.prompt ? ' - ' + block.input.prompt.substring(0, 50) + '...' : ''}`
        } else if (block.type === 'tool_result' && block.tool_use_id) {
          return `✅ Tool Result${block.content ? ': ' + (typeof block.content === 'string' ? block.content : JSON.stringify(block.content)).substring(0, 50) + '...' : ''}`
        }
      }
    }

    // Fallback to role-based description
    if (lastMessage.role === 'assistant') {
      return '🤖 Assistant response'
    } else if (lastMessage.role === 'user') {
      return '👤 User message'
    } else if (lastMessage.role === 'system') {
      return '⚙️ System message'
    }

    return 'Request ID: ' + req.request_id
  } catch (_error) {
    return 'Request ID: ' + req.request_id
  }
}

/**
 * Helper to extract the response summary from a request
 */
function getResponseSummary(req: ConversationRequest): string {
  try {
    if (!req.response_body) {
      return req.error ? '❌ Error response' : '⏳ No response'
    }

    const response = req.response_body

    // Handle different response formats
    if (typeof response === 'string') {
      // Simple string response
      const content = response.trim()
      return '🤖 ' + (content.length > 80 ? content.substring(0, 77) + '...' : content)
    } else if (response.content) {
      // Handle content array or string
      if (typeof response.content === 'string') {
        const content = response.content.trim()
        return '🤖 ' + (content.length > 80 ? content.substring(0, 77) + '...' : content)
      } else if (Array.isArray(response.content)) {
        // Array of content blocks
        for (const block of response.content) {
          if (block.type === 'text' && block.text) {
            const content = block.text.trim()
            return '🤖 ' + (content.length > 80 ? content.substring(0, 77) + '...' : content)
          } else if (block.type === 'tool_use' && block.name) {
            return `🤖 🔧 ${block.name}${block.input?.prompt ? ': ' + block.input.prompt.substring(0, 50) + '...' : ''}`
          }
        }
      }
    } else if (response.error) {
      // Error response
      return `❌ ${response.error.type || 'Error'}${response.error.message ? ': ' + response.error.message.substring(0, 50) + '...' : ''}`
    }

    // Fallback
    return '🤖 Response received'
  } catch (_error) {
    return '🤖 Response'
  }
}

/**
 * Helper to render conversation messages
 */
function renderConversationMessages(
  requests: ConversationRequest[],
  _branches: string[],
  subtasksMap?: Map<string, any[]>
) {
  // Sort requests by timestamp in descending order (newest first)
  const sortedRequests = [...requests].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  )

  return html`
    <div style="display: grid; gap: 0.25rem;">
      ${raw(
        sortedRequests
          .map(req => {
            const branch = req.branch_id || 'main'
            const branchColor = getBranchColor(branch)

            // Check if this request has sub-tasks based on task_tool_invocation
            const taskInvocations = subtasksMap?.get(req.request_id) || req.task_tool_invocation
            const hasTaskInvocation =
              taskInvocations && Array.isArray(taskInvocations) && taskInvocations.length > 0

            return `
          <div class="section" id="message-${req.request_id}">
            <div class="section-header" style="display: flex; justify-content: space-between; align-items: center; padding: 0.625rem 1rem;">
              <div style="display: flex; align-items: center; gap: 0.5rem;">
                <span style="font-size: 0.875rem; color: #6b7280;">
                  ${new Date(req.timestamp).toLocaleString()}
                </span>
                <a href="/dashboard/request/${req.request_id}" 
                   class="request-id-link"
                   style="font-size: 0.75rem; color: #3b82f6; text-decoration: none; font-family: monospace; border: 1px solid #e5e7eb; padding: 0.125rem 0.375rem; border-radius: 0.25rem; background: #f9fafb; transition: all 0.2s; display: inline-block;"
                   onmouseover="this.style.backgroundColor='#3b82f6'; this.style.color='white'; this.style.borderColor='#3b82f6';"
                   onmouseout="this.style.backgroundColor='#f9fafb'; this.style.color='#3b82f6'; this.style.borderColor='#e5e7eb';"
                   title="Click to view request details">
                  ${req.request_id}
                </a>
                ${
                  branch !== 'main'
                    ? `
                  <span style="margin-left: 0.5rem; font-size: 0.7rem; background: ${branchColor}20; color: ${branchColor}; padding: 0.125rem 0.375rem; border-radius: 0.25rem; border: 1px solid ${branchColor};">
                    ${escapeHtml(branch)}
                  </span>
                `
                    : ''
                }
                ${
                  req.is_subtask
                    ? '<span style="margin-left: 0.5rem; font-size: 0.875rem;" title="Sub-task conversation">🔗</span>'
                    : ''
                }
                ${
                  hasTaskInvocation
                    ? `<span style="margin-left: 0.5rem; font-size: 0.875rem;" title="Has sub-tasks">📋 (${taskInvocations.length})</span>`
                    : ''
                }
              </div>
              <div style="display: flex; gap: 0.75rem; align-items: center;">
                <span class="text-sm text-gray-600">${req.message_count || 0} messages</span>
                <span class="text-sm text-gray-600">${formatNumber(req.total_tokens)} tokens</span>
                ${req.duration_ms ? `<span class="text-sm text-gray-600">${formatDuration(req.duration_ms)}</span>` : ''}
                ${req.error ? '<span style="color: #ef4444; font-size: 0.875rem;">Error</span>' : ''}
              </div>
            </div>
            <div class="section-content" style="padding: 0.75rem 1rem;">
              <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <div style="flex: 1; margin-right: 1rem;">
                  <div class="text-sm text-gray-700" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 0.25rem;">
                    ${escapeHtml(getResponseSummary(req))}
                  </div>
                  <div class="text-sm text-gray-600" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    👤 ${escapeHtml(getLastMessageContent(req).replace(/^(👤|🤖|⚙️|🔧|✅)\s*/, ''))}
                  </div>
                </div>
                <div style="display: flex; gap: 1rem; align-items: center;">
                  ${
                    req.parent_task_request_id
                      ? `<a href="/dashboard/request/${req.parent_task_request_id}" class="text-sm text-blue-600" title="View parent task">
                          ↑ Parent Task
                        </a>`
                      : ''
                  }
                  ${
                    hasTaskInvocation
                      ? `<button onclick="toggleSubtasks('${req.request_id}')" class="text-sm text-blue-600" style="cursor: pointer; background: none; border: none; padding: 0;">
                          View Sub-tasks ▼
                        </button>`
                      : ''
                  }
                </div>
              </div>
              ${
                hasTaskInvocation
                  ? `<div id="subtasks-${req.request_id}" style="display: none; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #e5e7eb;">
                      <div class="text-sm text-gray-600" style="margin-bottom: 0.5rem;">Sub-tasks spawned by this request:</div>
                      ${taskInvocations
                        .map(
                          (task: any) => `
                          <div style="margin-bottom: 0.5rem; padding: 0.5rem; background: #f9fafb; border-radius: 0.25rem;">
                            <div style="font-size: 0.875rem; color: #4b5563;">
                              <strong>Task:</strong> ${escapeHtml(task.name || 'Unnamed task')}
                            </div>
                            ${task.input?.prompt ? `<div style="font-size: 0.75rem; color: #6b7280; margin-top: 0.25rem;">${escapeHtml(task.input.prompt.substring(0, 200))}${task.input.prompt.length > 200 ? '...' : ''}</div>` : ''}
                            ${task.input?.description ? `<div style="font-size: 0.75rem; color: #6b7280; margin-top: 0.25rem;">Description: ${escapeHtml(task.input.description)}</div>` : ''}
                            ${
                              task.linked_conversation_id
                                ? `
                              <div style="margin-top: 0.5rem;">
                                <a href="/dashboard/conversation/${task.linked_conversation_id}" class="text-sm text-blue-600">
                                  View sub-task conversation →
                                </a>
                              </div>
                            `
                                : '<div style="margin-top: 0.5rem; font-size: 0.75rem; color: #9ca3af;">Sub-task not yet linked</div>'
                            }
                          </div>
                        `
                        )
                        .join('')}
                    </div>`
                  : ''
              }
            </div>
          </div>
        `
          })
          .join('')
      )}
    </div>

    <script>
      function toggleSubtasks(requestId) {
        const subtasksDiv = document.getElementById('subtasks-' + requestId)
        if (subtasksDiv) {
          subtasksDiv.style.display = subtasksDiv.style.display === 'none' ? 'block' : 'none'
        }
      }
    </script>
  `
}
