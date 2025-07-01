import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { getErrorMessage } from '@claude-nexus/shared'
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

export const conversationDetailRoutes = new Hono()

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

      // Check if request contains a user message (not just tool results)
      let hasUserMessage = false
      if (req.body?.messages && Array.isArray(req.body.messages)) {
        const lastMessage = req.body.messages[req.body.messages.length - 1]
        if (lastMessage?.role === 'user' && lastMessage.content) {
          // Check if it's a text message, not just tool results
          if (typeof lastMessage.content === 'string') {
            hasUserMessage = lastMessage.content.trim().length > 0
          } else if (Array.isArray(lastMessage.content)) {
            hasUserMessage = lastMessage.content.some(
              (item: any) => item.type === 'text' && item.text && item.text.trim().length > 0
            )
          }
        }
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

    const branchStats = conversation.branches.reduce(
      (acc, branch) => {
        const branchRequests = conversation.requests.filter(r => (r.branch_id || 'main') === branch)
        // Get the max message count from the branch (latest request has the highest count)
        const maxMessageCount = Math.max(...branchRequests.map(r => r.message_count || 0), 0)
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
        }
      >
    )

    // Add main branch if not present
    if (!branchStats.main) {
      const mainRequests = conversation.requests.filter(r => !r.branch_id || r.branch_id === 'main')
      // Get the max message count from the main branch
      const maxMessageCount = Math.max(...mainRequests.map(r => r.message_count || 0), 0)
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

    // Calculate metrics using the new utility
    const metrics = calculateConversationMetrics(filteredRequests)

    // Calculate stats for selected branch or total
    let displayStats
    if (selectedBranch && branchStats[selectedBranch]) {
      // For branch stats, use the filtered requests which include main branch history
      const maxMessageCount = Math.max(...filteredRequests.map(r => r.message_count || 0), 0)
      const totalTokens = filteredRequests.reduce((sum, r) => sum + r.total_tokens, 0)
      const timestamps = filteredRequests.map(r => new Date(r.timestamp).getTime())
      const duration = timestamps.length > 0 ? Math.max(...timestamps) - Math.min(...timestamps) : 0
      const inferenceTime = filteredRequests.reduce((sum, req) => sum + (req.duration_ms || 0), 0)

      // Calculate sub-tasks for filtered branch
      let branchSubtasks = 0
      const branchRequestIdsWithTasks = filteredRequests
        .filter(
          req =>
            req.task_tool_invocation &&
            Array.isArray(req.task_tool_invocation) &&
            req.task_tool_invocation.length > 0
        )
        .map(req => req.request_id)

      if (branchRequestIdsWithTasks.length > 0) {
        branchSubtasks = await storageService.countSubtasksForRequests(branchRequestIdsWithTasks)
      }

      displayStats = {
        messageCount: maxMessageCount,
        totalTokens: totalTokens,
        branchCount: 1,
        duration: duration,
        inferenceTime: inferenceTime,
        requestCount: filteredRequests.length,
        totalSubtasks: branchSubtasks,
        toolExecution: metrics.toolExecution,
        userReply: metrics.userReply,
        userInteractions: metrics.userInteractions,
      }
    } else {
      // Show total stats for all branches
      // Calculate metrics for all requests
      const allMetrics = calculateConversationMetrics(conversation.requests)

      displayStats = {
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
      }
    }

    const content = html`
      <div class="mb-6">
        <a href="/dashboard" class="text-blue-600">← Back to Dashboard</a>
      </div>

      <h2 style="margin: 0 0 1.5rem 0;">Conversation Details</h2>

      <!-- Stats Grid -->
      <div class="conversation-stats-grid">
        <div class="conversation-stat-card">
          <span class="conversation-stat-label"
            >${selectedBranch ? 'Branch' : 'Total'} Messages:</span
          >
          <span class="conversation-stat-value">${displayStats.messageCount}</span>
        </div>
        <div class="conversation-stat-card">
          <span class="conversation-stat-label"
            >${selectedBranch ? 'Branch' : 'Total'} Sub-tasks:</span
          >
          <span class="conversation-stat-value">${displayStats.totalSubtasks}</span>
        </div>
        <div class="conversation-stat-card">
          <span class="conversation-stat-label"
            >${selectedBranch ? 'Branch' : 'Total'} Tokens:</span
          >
          <span class="conversation-stat-value">${displayStats.totalTokens.toLocaleString()}</span>
        </div>
        <div class="conversation-stat-card">
          <span class="conversation-stat-label"
            >${selectedBranch ? 'Branch Requests' : 'Branches'}:</span
          >
          <span class="conversation-stat-value"
            >${selectedBranch ? displayStats.requestCount : displayStats.branchCount}</span
          >
        </div>
        <div class="conversation-stat-card">
          <span class="conversation-stat-label">Duration:</span>
          <span class="conversation-stat-value">${formatDuration(displayStats.duration)}</span>
        </div>
        <div class="conversation-stat-card">
          <span class="conversation-stat-label">AI Inference:</span>
          <span class="conversation-stat-value">${formatDuration(displayStats.inferenceTime)}</span>
        </div>
        <div class="conversation-stat-card">
          <span class="conversation-stat-label">Tool Execution:</span>
          <span class="conversation-stat-value">
            ${displayStats.toolExecution.count > 0
              ? `${formatMetricDuration(displayStats.toolExecution.totalMs)} (${displayStats.toolExecution.count} tools, avg ${formatMetricDuration(displayStats.toolExecution.averageMs)})`
              : 'No tools used'}
          </span>
        </div>
        <div class="conversation-stat-card">
          <span class="conversation-stat-label">Time to Reply:</span>
          <span class="conversation-stat-value">
            ${displayStats.userReply.count > 0
              ? `${formatMetricDuration(displayStats.userReply.totalMs)} (avg ${formatMetricDuration(displayStats.userReply.averageMs)})`
              : 'No replies'}
          </span>
        </div>
        <div class="conversation-stat-card">
          <span class="conversation-stat-label">User Interactions:</span>
          <span class="conversation-stat-value">${displayStats.userInteractions.count}</span>
        </div>
      </div>

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
        </div>
      </div>

      <!-- Main Content -->
      <div class="conversation-content">
        <!-- Graph Visualization -->
        <div
          id="tree-panel"
          class="conversation-graph"
          style="display: ${view === 'tree' ? 'block' : 'none'}; width: 100%;"
        >
          ${raw(svgGraph)}
        </div>

        <!-- Timeline -->
        <div
          id="timeline-panel"
          class="conversation-timeline"
          style="display: ${view === 'timeline' ? 'block' : 'none'};"
        >
          ${raw(renderConversationMessages(filteredRequests, conversation.branches, subtasksMap))}
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

          // Update tab styles
          const treeTab = document.getElementById('tree-tab')
          const timelineTab = document.getElementById('timeline-tab')

          if (tabName === 'tree') {
            treeTab.style.borderBottomColor = '#3b82f6'
            treeTab.style.color = '#3b82f6'
            treeTab.classList.add('tab-active')
            treeTab.classList.remove('tab-inactive')

            timelineTab.style.borderBottomColor = 'transparent'
            timelineTab.style.color = '#6b7280'
            timelineTab.classList.remove('tab-active')
            timelineTab.classList.add('tab-inactive')
          } else {
            timelineTab.style.borderBottomColor = '#3b82f6'
            timelineTab.style.color = '#3b82f6'
            timelineTab.classList.add('tab-active')
            timelineTab.classList.remove('tab-inactive')

            treeTab.style.borderBottomColor = 'transparent'
            treeTab.style.color = '#6b7280'
            treeTab.classList.remove('tab-active')
            treeTab.classList.add('tab-inactive')
          }

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
        })
      </script>
    `

    // Use the shared layout
    const { layout } = await import('../layout/index.js')
    return c.html(layout('Conversation Detail', content))
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
        `
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
    if (req.body && req.body.last_message) {
      const lastMessage = req.body.last_message

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
