import { describe, test, expect, beforeEach, mock } from 'bun:test'
import type {
  ClaudeMessagesRequest,
  SystemContentBlock,
  SystemPromptMode,
} from '@agent-prompttrain/shared'

// ── Mock functions ──────────────────────────────────────────────────────────

const mockGetProjectSystemPrompt = mock<
  (
    pool: any,
    projectId: string
  ) => Promise<{
    enabled: boolean
    system_prompt: SystemContentBlock[] | null
    mode: SystemPromptMode
  } | null>
>(() => Promise.resolve(null))

// ── Module mocks (must run before importing the service) ────────────────────

mock.module('@agent-prompttrain/shared/database/queries', () => ({
  getProjectSystemPrompt: mockGetProjectSystemPrompt,
}))

mock.module('../../middleware/logger', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  },
}))

// ── Import service under test (after mocks) ─────────────────────────────────

import { applySystemPromptOverride } from '../system-prompt-override'

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(system?: ClaudeMessagesRequest['system']): ClaudeMessagesRequest {
  const req: ClaudeMessagesRequest = {
    model: 'claude-3-5-sonnet-20241022',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 1024,
  }
  if (system !== undefined) {
    req.system = system
  }
  return req
}

function makeSystemBlocks(text = 'Override system prompt'): SystemContentBlock[] {
  return [{ type: 'text', text }]
}

const fakePool = null as any

// ── Tests ───────────────────────────────────────────────────────────────────

describe('applySystemPromptOverride', () => {
  beforeEach(() => {
    mockGetProjectSystemPrompt.mockReset()
    mockGetProjectSystemPrompt.mockImplementation(() => Promise.resolve(null))
  })

  // ── Replace mode tests ───────────────────────────────────────────────────

  test('replaces system field when override is enabled with non-empty array', async () => {
    const blocks = makeSystemBlocks('Project system prompt')
    mockGetProjectSystemPrompt.mockImplementation(() =>
      Promise.resolve({ enabled: true, system_prompt: blocks, mode: 'replace' })
    )

    const request = makeRequest('Original system prompt')
    await applySystemPromptOverride(request, 'project-1', fakePool)

    expect(request.system).toEqual(blocks)
  })

  test('adds system field when request has none and override is enabled', async () => {
    const blocks = makeSystemBlocks('Injected system prompt')
    mockGetProjectSystemPrompt.mockImplementation(() =>
      Promise.resolve({ enabled: true, system_prompt: blocks, mode: 'replace' })
    )

    const request = makeRequest()
    expect(request.system).toBeUndefined()

    await applySystemPromptOverride(request, 'project-1', fakePool)

    expect(request.system).toEqual(blocks)
  })

  test('does not modify request when override is disabled', async () => {
    const blocks = makeSystemBlocks()
    mockGetProjectSystemPrompt.mockImplementation(() =>
      Promise.resolve({ enabled: false, system_prompt: blocks, mode: 'replace' })
    )

    const request = makeRequest('Original system')
    await applySystemPromptOverride(request, 'project-1', fakePool)

    expect(request.system).toBe('Original system')
  })

  test('does not modify request when system_prompt is null', async () => {
    mockGetProjectSystemPrompt.mockImplementation(() =>
      Promise.resolve({ enabled: true, system_prompt: null, mode: 'replace' })
    )

    const request = makeRequest('Original system')
    await applySystemPromptOverride(request, 'project-1', fakePool)

    expect(request.system).toBe('Original system')
  })

  test('does not modify request when system_prompt is empty array', async () => {
    mockGetProjectSystemPrompt.mockImplementation(() =>
      Promise.resolve({ enabled: true, system_prompt: [], mode: 'replace' })
    )

    const request = makeRequest('Original system')
    await applySystemPromptOverride(request, 'project-1', fakePool)

    expect(request.system).toBe('Original system')
  })

  test('does not modify request when project not found', async () => {
    mockGetProjectSystemPrompt.mockImplementation(() => Promise.resolve(null))

    const request = makeRequest('Original system')
    await applySystemPromptOverride(request, 'unknown-project', fakePool)

    expect(request.system).toBe('Original system')
  })

  test('replaces array system field with override', async () => {
    const originalBlocks: SystemContentBlock[] = [{ type: 'text', text: 'Original blocks' }]
    const overrideBlocks: SystemContentBlock[] = [
      { type: 'text', text: 'Override A' },
      { type: 'text', text: 'Override B' },
    ]
    mockGetProjectSystemPrompt.mockImplementation(() =>
      Promise.resolve({ enabled: true, system_prompt: overrideBlocks, mode: 'replace' })
    )

    const request = makeRequest(originalBlocks)
    await applySystemPromptOverride(request, 'project-1', fakePool)

    expect(request.system).toEqual(overrideBlocks)
    expect(request.system).not.toEqual(originalBlocks)
  })

  // ── Prepend mode tests ──────────────────────────────────────────────────

  test('prepends project blocks before original string system prompt', async () => {
    const projectBlocks = makeSystemBlocks('Project context')
    mockGetProjectSystemPrompt.mockImplementation(() =>
      Promise.resolve({ enabled: true, system_prompt: projectBlocks, mode: 'prepend' })
    )

    const request = makeRequest('Original system prompt')
    await applySystemPromptOverride(request, 'project-1', fakePool)

    expect(request.system).toEqual([
      { type: 'text', text: 'Project context' },
      { type: 'text', text: 'Original system prompt' },
    ])
  })

  test('prepends project blocks before original array system prompt', async () => {
    const projectBlocks: SystemContentBlock[] = [{ type: 'text', text: 'Project context' }]
    const originalBlocks: SystemContentBlock[] = [
      { type: 'text', text: 'Original A' },
      { type: 'text', text: 'Original B' },
    ]
    mockGetProjectSystemPrompt.mockImplementation(() =>
      Promise.resolve({ enabled: true, system_prompt: projectBlocks, mode: 'prepend' })
    )

    const request = makeRequest(originalBlocks)
    await applySystemPromptOverride(request, 'project-1', fakePool)

    expect(request.system).toEqual([
      { type: 'text', text: 'Project context' },
      { type: 'text', text: 'Original A' },
      { type: 'text', text: 'Original B' },
    ])
  })

  test('prepend applies project blocks when request has no system prompt', async () => {
    const projectBlocks = makeSystemBlocks('Injected via prepend')
    mockGetProjectSystemPrompt.mockImplementation(() =>
      Promise.resolve({ enabled: true, system_prompt: projectBlocks, mode: 'prepend' })
    )

    const request = makeRequest()
    expect(request.system).toBeUndefined()

    await applySystemPromptOverride(request, 'project-1', fakePool)

    expect(request.system).toEqual([{ type: 'text', text: 'Injected via prepend' }])
  })

  test('prepend does not modify when override is disabled', async () => {
    const projectBlocks = makeSystemBlocks('Project context')
    mockGetProjectSystemPrompt.mockImplementation(() =>
      Promise.resolve({ enabled: false, system_prompt: projectBlocks, mode: 'prepend' })
    )

    const request = makeRequest('Original system')
    await applySystemPromptOverride(request, 'project-1', fakePool)

    expect(request.system).toBe('Original system')
  })

  test('prepend does not modify when system_prompt is empty', async () => {
    mockGetProjectSystemPrompt.mockImplementation(() =>
      Promise.resolve({ enabled: true, system_prompt: [], mode: 'prepend' })
    )

    const request = makeRequest('Original system')
    await applySystemPromptOverride(request, 'project-1', fakePool)

    expect(request.system).toBe('Original system')
  })
})
