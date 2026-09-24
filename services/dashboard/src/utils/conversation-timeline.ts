import type { SubtaskSummary } from '../types/conversation.js'

interface BranchScopedRequest {
  branch_id?: string
  timestamp: string | Date
}

export function hasTaskInvocation(req: { task_tool_invocation?: any }): boolean {
  return Array.isArray(req.task_tool_invocation) && req.task_tool_invocation.length > 0
}

/**
 * Requests shown for a branch: main-branch history before the branch diverged plus the branch itself.
 */
export function filterRequestsByBranch<T extends BranchScopedRequest>(
  requests: T[],
  selectedBranch?: string
): T[] {
  if (selectedBranch && selectedBranch !== 'main') {
    // Find the first request in the selected branch
    const branchRequests = requests.filter(r => r.branch_id === selectedBranch)
    if (branchRequests.length === 0) {
      return branchRequests
    }

    // Sort by timestamp to get the first request in the branch
    branchRequests.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    const firstBranchRequest = branchRequests[0]

    // Get all requests from main branch that happened before the branch diverged
    const mainRequestsBeforeBranch = requests.filter(
      r =>
        (r.branch_id === 'main' || !r.branch_id) &&
        new Date(r.timestamp) < new Date(firstBranchRequest.timestamp)
    )

    return [...mainRequestsBeforeBranch, ...branchRequests]
  }

  if (selectedBranch === 'main') {
    return requests.filter(r => r.branch_id === 'main' || !r.branch_id)
  }

  return requests
}

/**
 * Link each task invocation to the sub-task conversation it spawned.
 */
export function buildSubtasksMap(
  requests: Array<{ request_id: string; task_tool_invocation?: any }>,
  subtasksByRequest: Map<string, SubtaskSummary[]>
): Map<string, any[]> {
  const subtasksMap = new Map<string, any[]>()

  for (const req of requests) {
    if (!hasTaskInvocation(req)) {
      continue
    }

    const subtasks = subtasksByRequest.get(req.request_id) ?? []
    if (subtasks.length === 0) {
      continue
    }

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
      {} as Record<string, SubtaskSummary[]>
    )

    // Link sub-task conversations to task invocations
    const enrichedInvocations = req.task_tool_invocation.map((invocation: any) => {
      for (const [convId, convSubtasks] of Object.entries(subtasksByConversation)) {
        const matches = convSubtasks.some(
          st => st.is_subtask && st.parent_task_request_id === req.request_id
        )
        if (matches) {
          return { ...invocation, linked_conversation_id: convId }
        }
      }
      return invocation
    })

    subtasksMap.set(req.request_id, enrichedInvocations)
  }

  return subtasksMap
}
