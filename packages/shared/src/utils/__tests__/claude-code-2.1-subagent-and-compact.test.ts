/**
 * Regression tests for two Claude Code 2.1 changes that fragmented a single session
 * into many separate conversations on the dashboard.
 *
 * 1. The subagent tool was renamed `Task` -> `Agent`, so subtask detection matched
 *    nothing and every subagent became its own root conversation.
 * 2. Auto-compact now carries the tail of the previous transcript over alongside the
 *    summary, so the first request after a compaction arrives with several conversation
 *    messages. Compact detection only ran on single-message requests, and the reworded
 *    summary markers no longer matched, so each compaction started a new conversation.
 *
 * Measured on production traffic for one project: 51 stored conversations over 6 hours
 * collapsed to 2 (one of them a single unrelated request) once both were fixed.
 *
 * @see ../conversation-linker.ts
 * @see ../../../../../docs/04-Architecture/ADRs/adr-003-conversation-tracking.md
 */
import { describe, test, expect } from 'bun:test'
import {
  ConversationLinker,
  SUBAGENT_TOOL_NAMES,
  type ParentRequest,
  type CompactSearchExecutor,
  type RequestByIdExecutor,
  type SubtaskQueryExecutor,
  type SubtaskSequenceQueryExecutor,
  type TaskInvocation,
} from '../conversation-linker.js'
import type { ClaudeMessage } from '../../types/index.js'

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any

const PROJECT = 'test-project'
const NOW = new Date('2026-08-08T13:05:17.000Z')

/** A `role: 'system'` message of the kind Claude Code injects between turns. */
const INJECTED_SYSTEM: ClaudeMessage = {
  role: 'system',
  content: '<system-reminder>\nEphemeral nudge\n</system-reminder>',
}

const PARENT_RECORD: ParentRequest = {
  request_id: 'parent-request-id',
  conversation_id: 'parent-conversation-id',
  branch_id: 'main',
  current_message_hash: 'parent-current-hash',
  system_hash: null,
}

describe('Claude Code 2.1 subagent tool rename', () => {
  test('SUBAGENT_TOOL_NAMES covers both the 2.1 name and the legacy name', () => {
    // Callers interpolate these into SQL predicates; both must stay supported so
    // historical rebuilds of pre-2.1 data keep linking.
    expect(SUBAGENT_TOOL_NAMES).toContain('Agent')
    expect(SUBAGENT_TOOL_NAMES).toContain('Task')
  })

  test.each(['Agent', 'Task'])(
    'links a single-message subagent request launched via the %s tool',
    async toolName => {
      const prompt = 'You are a code reviewer. Review the diff on branch m3-spells.'

      const subtaskQueryExecutor: SubtaskQueryExecutor = async () =>
        [
          {
            requestId: PARENT_RECORD.request_id,
            toolUseId: `toolu_${toolName}`,
            prompt,
            timestamp: new Date(NOW.getTime() - 20_000),
          },
        ] satisfies TaskInvocation[]

      const requestByIdExecutor: RequestByIdExecutor = async () => PARENT_RECORD
      const subtaskSequenceQueryExecutor: SubtaskSequenceQueryExecutor = async () => 0

      const linker = new ConversationLinker(
        async () => [],
        noopLogger,
        undefined,
        requestByIdExecutor,
        subtaskQueryExecutor,
        subtaskSequenceQueryExecutor
      )

      const result = await linker.linkConversation({
        projectId: PROJECT,
        // Claude Code 2.1 sends the subagent's opening turn as [user, system]
        messages: [{ role: 'user', content: prompt }, INJECTED_SYSTEM],
        requestId: 'subagent-request-id',
        messageCount: 2,
        timestamp: NOW,
      })

      expect(result.isSubtask).toBe(true)
      expect(result.conversationId).toBe(PARENT_RECORD.conversation_id)
      expect(result.parentTaskRequestId).toBe(PARENT_RECORD.request_id)
      expect(result.branchId).toBe('subtask_1')
    }
  )

  test('a subagent prompt with no matching invocation still starts its own conversation', async () => {
    const linker = new ConversationLinker(
      async () => [],
      noopLogger,
      undefined,
      async () => PARENT_RECORD,
      async () => [],
      async () => 0
    )

    const result = await linker.linkConversation({
      projectId: PROJECT,
      messages: [{ role: 'user', content: 'An unrelated standalone prompt' }, INJECTED_SYSTEM],
      requestId: 'orphan-request-id',
      messageCount: 2,
      timestamp: NOW,
    })

    expect(result.isSubtask).toBeUndefined()
    expect(result.conversationId).toBeNull()
    expect(result.branchId).toBe('main')
  })
})

describe('Claude Code 2.1 auto-compact continuation', () => {
  /**
   * Builds the compact continuation message Claude Code 2.1 sends. The summary body is
   * preceded by a `Summary:` heading (2.0 used "The conversation is summarized below:")
   * and followed by trailing resume instructions that are not part of the summary.
   */
  const compactMessage = (summaryBody: string): ClaudeMessage => ({
    role: 'user',
    content: [
      { type: 'text', text: '<system-reminder>\nEphemeral context\n</system-reminder>' },
      {
        type: 'text',
        text:
          'This session is being continued from a previous conversation that ran out of context. ' +
          'The summary below covers the earlier portion of the conversation.\n\n' +
          `Summary:\n${summaryBody}\n` +
          'If you need specific details from before compaction, read the full transcript at: /tmp/x.jsonl\n' +
          'Continue the conversation from where it left off without asking the user any further questions.',
      },
    ],
  })

  // No trailing period: extractSummaryContent deliberately strips trailing punctuation,
  // so a fixture ending in '.' would not round-trip.
  const SUMMARY_BODY = '1. Primary Request and Intent:\n   Implement Task 6 of the M3 milestone'

  /** Records what the linker asked the compact search for. */
  const trackingCompactSearch = (
    seen: { summary?: string },
    result: ParentRequest | null
  ): CompactSearchExecutor => {
    return async (_projectId, summaryContent) => {
      seen.summary = summaryContent
      return result
    }
  }

  test('extracts the summary without the heading or the trailing resume instructions', async () => {
    const seen: { summary?: string } = {}
    const linker = new ConversationLinker(
      async () => [],
      noopLogger,
      trackingCompactSearch(seen, PARENT_RECORD)
    )

    await linker.linkConversation({
      projectId: PROJECT,
      messages: [compactMessage(SUMMARY_BODY), INJECTED_SYSTEM],
      requestId: 'compact-request-id',
      messageCount: 2,
      timestamp: NOW,
    })

    expect(seen.summary).toBe(SUMMARY_BODY)
    expect(seen.summary).not.toContain('Summary:')
    expect(seen.summary).not.toContain('If you need specific details')
    expect(seen.summary).not.toContain('Continue the conversation from where it left off')
  })

  test('still extracts the summary from the pre-2.1 wording', async () => {
    const seen: { summary?: string } = {}
    const linker = new ConversationLinker(
      async () => [],
      noopLogger,
      trackingCompactSearch(seen, PARENT_RECORD)
    )

    const legacyMessage: ClaudeMessage = {
      role: 'user',
      content:
        'This session is being continued from a previous conversation that ran out of context. ' +
        `The conversation is summarized below:\n${SUMMARY_BODY}\n` +
        'Please continue the conversation from where we left it off.',
    }

    await linker.linkConversation({
      projectId: PROJECT,
      messages: [legacyMessage],
      requestId: 'legacy-compact-request-id',
      messageCount: 1,
      timestamp: NOW,
    })

    expect(seen.summary).toBe(SUMMARY_BODY)
  })

  test('links a compact continuation that carries the previous transcript tail', async () => {
    // The regression: 2.1 auto-compact keeps the interrupted turn after the summary, so
    // this first post-compact request has three conversation messages. Its computed
    // parent hash covers only the summary message, which was never sent on its own, so
    // prefix matching finds nothing and compact detection must still run.
    const seen: { summary?: string } = {}
    const linker = new ConversationLinker(
      async () => [], // no prefix match is possible
      noopLogger,
      trackingCompactSearch(seen, PARENT_RECORD)
    )

    const messages: ClaudeMessage[] = [
      compactMessage(SUMMARY_BODY),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      INJECTED_SYSTEM,
    ]

    const result = await linker.linkConversation({
      projectId: PROJECT,
      messages,
      requestId: 'compact-tail-request-id',
      messageCount: messages.length,
      timestamp: NOW,
    })

    expect(seen.summary).toBe(SUMMARY_BODY)
    expect(result.conversationId).toBe(PARENT_RECORD.conversation_id)
    expect(result.parentRequestId).toBe(PARENT_RECORD.request_id)
    // Points at the real parent request, since the transcript-derived parent hash has no
    // corresponding stored request.
    expect(result.parentMessageHash).toBe(PARENT_RECORD.current_message_hash)
    expect(result.branchId).toMatch(/^compact_/)
  })

  test('a genuine prefix match wins over the compact fallback', async () => {
    // Later requests in a compacted session still contain the summary as message 0. They
    // must link by prefix hash and stay on their branch rather than opening a new
    // compact branch on every turn.
    let compactSearchCalls = 0
    const prefixParent: ParentRequest = {
      ...PARENT_RECORD,
      request_id: 'prefix-parent-id',
      branch_id: 'compact_130517',
      current_message_hash: 'prefix-parent-hash',
    }

    const linker = new ConversationLinker(
      async criteria => (criteria.currentMessageHash ? [prefixParent] : []),
      noopLogger,
      async () => {
        compactSearchCalls++
        return PARENT_RECORD
      }
    )

    const messages: ClaudeMessage[] = [
      compactMessage(SUMMARY_BODY),
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'next question' },
      { role: 'assistant', content: 'second reply' },
      { role: 'user', content: 'third question' },
    ]

    const result = await linker.linkConversation({
      projectId: PROJECT,
      messages,
      requestId: 'compact-followup-request-id',
      messageCount: messages.length,
      timestamp: NOW,
    })

    expect(compactSearchCalls).toBe(0)
    expect(result.parentRequestId).toBe(prefixParent.request_id)
    // Parent is on a compact branch, so the child stays on it.
    expect(result.branchId).toBe('compact_130517')
  })

  test('an unmatched compact continuation still starts a new conversation', async () => {
    const linker = new ConversationLinker(
      async () => [],
      noopLogger,
      async () => null // no summarizing response found
    )

    const messages: ClaudeMessage[] = [
      compactMessage(SUMMARY_BODY),
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'follow-up' },
    ]

    const result = await linker.linkConversation({
      projectId: PROJECT,
      messages,
      requestId: 'unmatched-compact-id',
      messageCount: messages.length,
      timestamp: NOW,
    })

    expect(result.conversationId).toBeNull()
    expect(result.branchId).toBe('main')
  })

  test('a multi-message request that is not a compact continuation never triggers the search', async () => {
    let compactSearchCalls = 0
    const linker = new ConversationLinker(
      async () => [],
      noopLogger,
      async () => {
        compactSearchCalls++
        return PARENT_RECORD
      }
    )

    const messages: ClaudeMessage[] = [
      { role: 'user', content: 'An ordinary opening message' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'follow-up' },
    ]

    const result = await linker.linkConversation({
      projectId: PROJECT,
      messages,
      requestId: 'ordinary-request-id',
      messageCount: messages.length,
      timestamp: NOW,
    })

    expect(compactSearchCalls).toBe(0)
    expect(result.conversationId).toBeNull()
  })
})
