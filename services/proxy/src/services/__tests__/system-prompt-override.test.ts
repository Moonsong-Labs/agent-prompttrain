import { describe, test, expect, beforeEach, mock } from 'bun:test'
import type { ClaudeMessagesRequest, SystemContentBlock } from '@agent-prompttrain/shared'

// ── Mock functions ──────────────────────────────────────────────────────────

const mockGetProjectSystemPrompt = mock<
  (
    pool: any,
    projectId: string
  ) => Promise<{ enabled: boolean; system_prompt: SystemContentBlock[] | null } | null>
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

  test('replaces system field when override is enabled with non-empty array', async () => {
    const blocks = makeSystemBlocks('Project system prompt')
    mockGetProjectSystemPrompt.mockImplementation(() =>
      Promise.resolve({ enabled: true, system_prompt: blocks })
    )

    const request = makeRequest('Original system prompt')
    await applySystemPromptOverride(request, 'project-1', fakePool)

    expect(request.system).toEqual(blocks)
  })

  test('adds system field when request has none and override is enabled', async () => {
    const blocks = makeSystemBlocks('Injected system prompt')
    mockGetProjectSystemPrompt.mockImplementation(() =>
      Promise.resolve({ enabled: true, system_prompt: blocks })
    )

    const request = makeRequest()
    expect(request.system).toBeUndefined()

    await applySystemPromptOverride(request, 'project-1', fakePool)

    expect(request.system).toEqual(blocks)
  })

  test('does not modify request when override is disabled', async () => {
    const blocks = makeSystemBlocks()
    mockGetProjectSystemPrompt.mockImplementation(() =>
      Promise.resolve({ enabled: false, system_prompt: blocks })
    )

    const request = makeRequest('Original system')
    await applySystemPromptOverride(request, 'project-1', fakePool)

    expect(request.system).toBe('Original system')
  })

  test('does not modify request when system_prompt is null', async () => {
    mockGetProjectSystemPrompt.mockImplementation(() =>
      Promise.resolve({ enabled: true, system_prompt: null })
    )

    const request = makeRequest('Original system')
    await applySystemPromptOverride(request, 'project-1', fakePool)

    expect(request.system).toBe('Original system')
  })

  test('does not modify request when system_prompt is empty array', async () => {
    mockGetProjectSystemPrompt.mockImplementation(() =>
      Promise.resolve({ enabled: true, system_prompt: [] })
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
      Promise.resolve({ enabled: true, system_prompt: overrideBlocks })
    )

    const request = makeRequest(originalBlocks)
    await applySystemPromptOverride(request, 'project-1', fakePool)

    expect(request.system).toEqual(overrideBlocks)
    expect(request.system).not.toEqual(originalBlocks)
  })
})
