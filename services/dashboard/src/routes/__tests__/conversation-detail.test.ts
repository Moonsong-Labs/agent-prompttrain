import { describe, it, expect, mock } from 'bun:test'
import { Hono } from 'hono'

const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333'
const BRANCH = 'branch_a&b"c'
const R1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const R2 = 'aaaaaaaa-0000-4000-8000-000000000002'
const R3 = 'aaaaaaaa-0000-4000-8000-000000000003'

const requests = [
  {
    request_id: R1,
    projectId: 'project-test',
    timestamp: '2026-09-24T10:00:00.000Z',
    model: 'claude-test',
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    duration_ms: 1000,
    tool_call_count: 1,
    conversation_id: CONVERSATION_ID,
    branch_id: 'main',
    message_count: 1,
    current_message_hash: 'h1',
    last_message: { role: 'user', content: 'Please refactor the parser' },
    response_body: {
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Task', input: { prompt: 'Explore the parser' } },
      ],
      usage: { input_tokens: 10 },
    },
    task_tool_invocation: [{ name: 'Task', input: { prompt: 'Explore the parser' } }],
    user_text_message_count: null,
  },
  {
    request_id: R2,
    projectId: 'project-test',
    timestamp: '2026-09-24T10:01:00.000Z',
    model: 'claude-test',
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    duration_ms: 1000,
    tool_call_count: 0,
    conversation_id: CONVERSATION_ID,
    branch_id: 'main',
    message_count: 3,
    current_message_hash: 'h2',
    parent_message_hash: 'h1',
    parent_request_id: R1,
    last_message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Parser explored' }],
    },
    response_body: {
      content: [{ type: 'text', text: 'Refactored.' }],
      usage: { input_tokens: 12 },
    },
    user_text_message_count: 1,
  },
  {
    request_id: R3,
    projectId: 'project-test',
    timestamp: '2026-09-24T10:02:00.000Z',
    model: 'claude-test',
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    duration_ms: 1000,
    tool_call_count: 0,
    conversation_id: CONVERSATION_ID,
    branch_id: BRANCH,
    message_count: 3,
    current_message_hash: 'h3',
    parent_message_hash: 'h1',
    parent_request_id: R1,
    last_message: { role: 'user', content: 'Try another approach' },
    response_body: {
      content: [{ type: 'text', text: 'Alternative.' }],
      usage: { input_tokens: 11 },
    },
    user_text_message_count: 2,
  },
]

const conversation = {
  conversation_id: CONVERSATION_ID,
  message_count: 3,
  first_message: new Date('2026-09-24T10:00:00.000Z'),
  last_message: new Date('2026-09-24T10:02:00.000Z'),
  total_tokens: 45,
  branches: ['main', BRANCH],
  requests,
}

const storage = {
  getConversationById: mock(async () => conversation),
  checkUserProjectAccess: mock(async () => true),
  getSubtasksForRequests: mock(
    async (ids: string[]) =>
      new Map(
        ids.map(id => [
          id,
          [
            {
              request_id: 'bbbbbbbb-0000-4000-8000-000000000001',
              conversation_id: '44444444-4444-4444-8444-444444444444',
              is_subtask: true,
              parent_task_request_id: id,
              timestamp: '2026-09-24T10:00:30.000Z',
            },
          ],
        ])
      )
  ),
  getSubtasksForRequest: mock(async () => {
    throw new Error('per-request sub-task lookup must not be used')
  }),
  countSubtasksForRequests: mock(async (ids: string[]) => ids.length),
}

mock.module('../../container.js', () => ({ container: { getStorageService: () => storage } }))
const { conversationDetailRoutes } = await import('../conversation-detail.js')

const app = new Hono()
app.route('/dashboard', conversationDetailRoutes)

const get = async (path: string) => {
  const res = await app.request(path)
  return { status: res.status, body: await res.text() }
}

const lazyTimelineUrl = (body: string) =>
  body.match(/id="timeline-lazy"[\s\S]*?hx-get="([^"]*)"/)?.[1]

describe('conversation detail route', () => {
  it('lazy-loads the timeline when the tree view is active', async () => {
    const { status, body } = await get(`/dashboard/conversation/${CONVERSATION_ID}`)
    expect(status).toBe(200)
    expect(body).toContain('data-testid="timeline-lazy"')
    expect(lazyTimelineUrl(body)).toBe(`/dashboard/conversation/${CONVERSATION_ID}/messages`)
    expect(body).toContain('hx-trigger="timeline-open once"')
    expect(body).not.toContain('data-testid="timeline-content"')
  })

  it('renders the timeline server-side when it is the active view', async () => {
    const { body } = await get(`/dashboard/conversation/${CONVERSATION_ID}?view=timeline`)
    expect(body).toContain('data-testid="timeline-content"')
    expect(body).not.toContain('data-testid="timeline-lazy"')
  })

  it('serves the same timeline HTML lazily as server-side', async () => {
    const page = await get(`/dashboard/conversation/${CONVERSATION_ID}?view=timeline&branch=main`)
    const lazy = await get(`/dashboard/conversation/${CONVERSATION_ID}/messages?branch=main`)
    expect(lazy.body).toContain('data-testid="timeline-content"')
    expect(page.body).toContain(lazy.body)
  })

  it('encodes the selected branch in the lazy timeline URL', async () => {
    const { body } = await get(
      `/dashboard/conversation/${CONVERSATION_ID}?branch=${encodeURIComponent(BRANCH)}`
    )
    expect(lazyTimelineUrl(body)).toBe(
      `/dashboard/conversation/${CONVERSATION_ID}/messages?branch=${encodeURIComponent(BRANCH)}`
    )
  })

  it('looks up sub-tasks in one batched query', async () => {
    storage.getSubtasksForRequests.mockClear()
    storage.getSubtasksForRequest.mockClear()

    await get(`/dashboard/conversation/${CONVERSATION_ID}`)

    expect(storage.getSubtasksForRequests).toHaveBeenCalledTimes(1)
    expect(storage.getSubtasksForRequests.mock.calls[0][0]).toEqual([R1])
    expect(storage.getSubtasksForRequest).not.toHaveBeenCalled()
  })
})
