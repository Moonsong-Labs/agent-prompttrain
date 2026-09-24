import { describe, it, expect } from 'bun:test'
import {
  buildSubtasksMap,
  filterRequestsByBranch,
  hasTaskInvocation,
} from '../conversation-timeline'
import type { SubtaskSummary } from '../../types/conversation'

const requests = [
  { request_id: 'm1', branch_id: 'main', timestamp: '2026-09-24T10:00:00Z' },
  { request_id: 'm2', branch_id: undefined, timestamp: '2026-09-24T10:01:00Z' },
  { request_id: 'b1', branch_id: 'branch_2', timestamp: '2026-09-24T10:02:00Z' },
  { request_id: 'm3', branch_id: 'main', timestamp: '2026-09-24T10:03:00Z' },
  { request_id: 'b2', branch_id: 'branch_2', timestamp: '2026-09-24T10:04:00Z' },
]

describe('filterRequestsByBranch', () => {
  it('returns every request without a selected branch', () => {
    expect(filterRequestsByBranch(requests).map(r => r.request_id)).toEqual([
      'm1',
      'm2',
      'b1',
      'm3',
      'b2',
    ])
  })

  it('returns only main-branch requests for main', () => {
    expect(filterRequestsByBranch(requests, 'main').map(r => r.request_id)).toEqual([
      'm1',
      'm2',
      'm3',
    ])
  })

  it('returns main history before the fork plus the branch', () => {
    expect(filterRequestsByBranch(requests, 'branch_2').map(r => r.request_id)).toEqual([
      'm1',
      'm2',
      'b1',
      'b2',
    ])
  })

  it('returns nothing for an unknown branch', () => {
    expect(filterRequestsByBranch(requests, 'nope')).toEqual([])
  })
})

describe('buildSubtasksMap', () => {
  it('links task invocations to the sub-task conversation they spawned', () => {
    const invocation = { name: 'Task', input: { prompt: 'Explore' } }
    const subtasks: SubtaskSummary[] = [
      {
        request_id: 's1',
        conversation_id: 'conv-sub',
        is_subtask: true,
        parent_task_request_id: 'p1',
        timestamp: 't',
      },
    ]
    const map = buildSubtasksMap(
      [
        { request_id: 'p1', task_tool_invocation: [invocation] },
        { request_id: 'p2', task_tool_invocation: [invocation] },
        { request_id: 'p3' },
      ],
      new Map([['p1', subtasks]])
    )

    expect(map.get('p1')).toEqual([{ ...invocation, linked_conversation_id: 'conv-sub' }])
    expect(map.has('p2')).toBe(false)
    expect(map.has('p3')).toBe(false)
  })

  it('detects task invocations', () => {
    expect(hasTaskInvocation({ task_tool_invocation: [{}] })).toBe(true)
    expect(hasTaskInvocation({ task_tool_invocation: [] })).toBe(false)
    expect(hasTaskInvocation({})).toBe(false)
  })
})
