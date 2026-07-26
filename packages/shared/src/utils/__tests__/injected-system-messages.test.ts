/**
 * Regression tests for the Claude Code 2.1 wire format.
 *
 * Claude Code injects `role: 'system'` messages into the `messages` array to carry
 * ephemeral context (system-reminders, hook output, tool nudges) and prepends an
 * `x-anthropic-billing-header:` block to the system prompt. Both are volatile and used
 * to break conversation linking, fragmenting a single session into many one-request
 * conversations.
 *
 * @see ../conversation-linker.ts (ConversationLinker.filterConversationMessages)
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  ConversationLinker,
  type QueryExecutor,
  type LinkingRequest,
  type ParentQueryCriteria,
  type SubtaskQueryExecutor,
  type RequestByIdExecutor,
} from '../conversation-linker'
import { extractMessageHashes, hashMessagesOnly, hashSystemPrompt } from '../conversation-hash.js'
import type { ClaudeMessage } from '../../types/index.js'

const SKILLS_REMINDER =
  '<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n- review\n</system-reminder>'

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any

describe('Claude Code injected system messages', () => {
  let linker: ConversationLinker

  beforeEach(() => {
    linker = new ConversationLinker(async () => [], noopLogger)
  })

  describe('filterConversationMessages', () => {
    test('keeps only user and assistant messages, in order', () => {
      const messages: ClaudeMessage[] = [
        { role: 'user', content: 'Do the thing' },
        { role: 'system', content: SKILLS_REMINDER },
        { role: 'assistant', content: 'On it' },
      ]

      expect(ConversationLinker.filterConversationMessages(messages)).toEqual([
        { role: 'user', content: 'Do the thing' },
        { role: 'assistant', content: 'On it' },
      ])
    })
  })

  describe('computeMessageHash', () => {
    test('ignores injected system messages', () => {
      const withInjection: ClaudeMessage[] = [
        { role: 'user', content: 'Do the thing' },
        { role: 'system', content: SKILLS_REMINDER },
        { role: 'assistant', content: 'On it' },
      ]
      const withoutInjection: ClaudeMessage[] = [
        { role: 'user', content: 'Do the thing' },
        { role: 'assistant', content: 'On it' },
      ]

      expect(linker.computeMessageHash(withInjection)).toBe(
        linker.computeMessageHash(withoutInjection)
      )
    })

    test('ignores how many system messages were injected', () => {
      const base: ClaudeMessage[] = [
        { role: 'user', content: 'Do the thing' },
        { role: 'assistant', content: 'On it' },
      ]
      const oneInjection: ClaudeMessage[] = [
        base[0],
        { role: 'system', content: SKILLS_REMINDER },
        base[1],
      ]
      const twoInjections: ClaudeMessage[] = [
        base[0],
        { role: 'system', content: SKILLS_REMINDER },
        base[1],
        { role: 'system', content: '<system-reminder>Use your todo list</system-reminder>' },
      ]

      expect(linker.computeMessageHash(oneInjection)).toBe(linker.computeMessageHash(twoInjections))
    })

    test('hashes string and content-block reminders identically', () => {
      // Claude Code sends the same reminder as a plain string in one request and as a
      // content block array (carrying cache_control) in the next.
      const asString: ClaudeMessage[] = [{ role: 'user', content: SKILLS_REMINDER }]
      const asBlocks: ClaudeMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: SKILLS_REMINDER, cache_control: { type: 'ephemeral' } } as any,
          ],
        },
      ]

      expect(linker.computeMessageHash(asString)).toBe(linker.computeMessageHash(asBlocks))
    })

    test('refuses to hash a request with no user or assistant messages', () => {
      // Guards against every all-system request sharing the hash of an empty input
      expect(() =>
        linker.computeMessageHash([{ role: 'system', content: SKILLS_REMINDER }])
      ).toThrow('no user or assistant messages')
    })

    test('strips system-reminders from string content', () => {
      const withReminder: ClaudeMessage[] = [
        { role: 'user', content: `Real question\n${SKILLS_REMINDER}` },
      ]
      const withoutReminder: ClaudeMessage[] = [{ role: 'user', content: 'Real question' }]

      expect(linker.computeMessageHash(withReminder)).toBe(
        linker.computeMessageHash(withoutReminder)
      )
    })
  })

  describe('extractMessageHashes', () => {
    test('computes the parent offset over conversation messages only', () => {
      const messages: ClaudeMessage[] = [
        { role: 'user', content: 'First' },
        { role: 'system', content: SKILLS_REMINDER },
        { role: 'assistant', content: 'Second' },
        { role: 'user', content: 'Third' },
        { role: 'system', content: SKILLS_REMINDER },
      ]

      const { currentMessageHash, parentMessageHash } = extractMessageHashes(messages)

      // Parent is the first user message alone - the injected messages must not
      // shift the "all but the last two" offset.
      expect(parentMessageHash).toBe(hashMessagesOnly([{ role: 'user', content: 'First' }]))
      expect(currentMessageHash).toBe(
        hashMessagesOnly([
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Second' },
          { role: 'user', content: 'Third' },
        ])
      )
    })

    test('throws when there are no conversation messages', () => {
      expect(() => extractMessageHashes([{ role: 'system', content: SKILLS_REMINDER }])).toThrow(
        'Cannot extract hashes from empty messages array'
      )
    })
  })

  describe('linkConversation', () => {
    test('links a request whose turn also appended a system message', async () => {
      // Turn N:   [user, system]                    -> new conversation
      // Turn N+1: [user, system, assistant, user, system]
      // The turn grew by three messages, so the raw "last two" offset misses the parent.
      const parentMessages: ClaudeMessage[] = [
        { role: 'user', content: 'First' },
        { role: 'system', content: SKILLS_REMINDER },
      ]
      const parentHash = linker.computeMessageHash(parentMessages)

      const queryExecutor: QueryExecutor = async (criteria: ParentQueryCriteria) => {
        if (criteria.currentMessageHash === parentHash) {
          return [
            {
              request_id: 'parent-request',
              conversation_id: 'conv-1',
              branch_id: 'main',
              current_message_hash: parentHash,
              system_hash: null,
            },
          ]
        }
        return []
      }

      linker = new ConversationLinker(queryExecutor, noopLogger)

      const request: LinkingRequest = {
        projectId: 'test-project',
        messages: [
          { role: 'user', content: 'First' },
          { role: 'system', content: SKILLS_REMINDER },
          { role: 'assistant', content: 'Second' },
          { role: 'user', content: 'Third' },
          { role: 'system', content: '<system-reminder>Use your todo list</system-reminder>' },
        ],
        systemPrompt: 'Test system prompt',
        requestId: 'child-request',
        messageCount: 5,
      }

      const result = await linker.linkConversation(request)

      expect(result.conversationId).toBe('conv-1')
      expect(result.parentRequestId).toBe('parent-request')
      expect(result.branchId).toBe('main')
    })

    test('still detects a subtask when a system message trails the prompt', async () => {
      const subtaskPrompt = 'Analyze the authentication module'

      const subtaskQueryExecutor: SubtaskQueryExecutor = async () => [
        {
          requestId: 'parent-task-request',
          toolUseId: 'toolu_1',
          prompt: subtaskPrompt,
          timestamp: new Date('2026-07-25T10:00:00Z'),
        },
      ]

      const requestByIdExecutor: RequestByIdExecutor = async requestId => ({
        request_id: requestId,
        conversation_id: 'parent-conv',
        branch_id: 'main',
        current_message_hash: 'parent-hash',
        system_hash: null,
      })

      linker = new ConversationLinker(
        async () => [],
        noopLogger,
        undefined,
        requestByIdExecutor,
        subtaskQueryExecutor,
        async () => 0
      )

      const request: LinkingRequest = {
        projectId: 'test-project',
        messages: [
          { role: 'user', content: subtaskPrompt },
          { role: 'system', content: SKILLS_REMINDER },
        ],
        systemPrompt: 'Test system prompt',
        requestId: 'subtask-request',
        messageCount: 2,
        timestamp: new Date('2026-07-25T10:00:05Z'),
      }

      const result = await linker.linkConversation(request)

      expect(result.isSubtask).toBe(true)
      expect(result.conversationId).toBe('parent-conv')
      expect(result.parentTaskRequestId).toBe('parent-task-request')
      expect(result.branchId).toBe('subtask_1')
    })
  })
})

/**
 * Excluding injected `system` messages makes hashing more permissive, so these tests pin
 * the opposite property: unrelated transcripts must not end up in one conversation.
 *
 * The one case where discrimination is genuinely reduced is two sessions whose transcript
 * is byte-identical up to a divergence point (e.g. the same subagent prompt launched
 * twice). Hash-based tracking cannot tell those apart by design (ADR-003); what matters is
 * that the divergence surfaces as a branch rather than a silently interleaved chain.
 */
describe('Conversation isolation', () => {
  /** Minimal in-memory stand-in for writer.findParentRequests. */
  function createStore() {
    const rows: Array<{
      request_id: string
      conversation_id: string
      branch_id: string
      current_message_hash: string
      parent_message_hash: string | null
      system_hash: string | null
    }> = []

    const queryExecutor: QueryExecutor = async (criteria: ParentQueryCriteria) =>
      rows
        .filter(r => {
          if (
            criteria.currentMessageHash &&
            r.current_message_hash !== criteria.currentMessageHash
          ) {
            return false
          }
          if (criteria.parentMessageHash && r.parent_message_hash !== criteria.parentMessageHash) {
            return false
          }
          if (criteria.systemHash && r.system_hash !== criteria.systemHash) {
            return false
          }
          if (criteria.excludeRequestId && r.request_id === criteria.excludeRequestId) {
            return false
          }
          if (criteria.conversationId && r.conversation_id !== criteria.conversationId) {
            return false
          }
          return true
        })
        .map(r => ({
          request_id: r.request_id,
          conversation_id: r.conversation_id,
          branch_id: r.branch_id,
          current_message_hash: r.current_message_hash,
          system_hash: r.system_hash,
        }))

    return { rows, queryExecutor }
  }

  test('does not link a request whose prefix matches nothing', async () => {
    const { rows, queryExecutor } = createStore()
    const isolated = new ConversationLinker(queryExecutor, noopLogger)

    // An unrelated conversation already exists
    rows.push({
      request_id: 'other-request',
      conversation_id: 'other-conv',
      branch_id: 'main',
      current_message_hash: isolated.computeMessageHash([
        { role: 'user', content: 'Unrelated topic' },
      ]),
      parent_message_hash: null,
      system_hash: null,
    })

    const result = await isolated.linkConversation({
      projectId: 'test-project',
      messages: [
        { role: 'user', content: 'A different topic entirely' },
        { role: 'system', content: SKILLS_REMINDER },
        { role: 'assistant', content: 'Sure' },
        { role: 'user', content: 'Continue' },
      ],
      systemPrompt: 'Test system prompt',
      requestId: 'new-request',
      messageCount: 4,
    })

    expect(result.conversationId).toBeNull()
    expect(result.parentRequestId).toBeNull()
  })

  test('keeps transcripts that differ only in user content apart', () => {
    const hasher = new ConversationLinker(async () => [], noopLogger)
    const withSameInjection = (question: string): ClaudeMessage[] => [
      { role: 'user', content: question },
      { role: 'system', content: SKILLS_REMINDER },
    ]

    expect(hasher.computeMessageHash(withSameInjection('Question A'))).not.toBe(
      hasher.computeMessageHash(withSameInjection('Question B'))
    )
  })

  test('keeps transcripts that differ only in assistant content apart', () => {
    const hasher = new ConversationLinker(async () => [], noopLogger)
    const withReply = (reply: string): ClaudeMessage[] => [
      { role: 'user', content: 'Same question' },
      { role: 'assistant', content: reply },
      { role: 'user', content: 'Same follow-up' },
    ]

    expect(hasher.computeMessageHash(withReply('Answer A'))).not.toBe(
      hasher.computeMessageHash(withReply('Answer B'))
    )
  })

  test('surfaces a divergent continuation of a shared prefix as a branch', async () => {
    const { rows, queryExecutor } = createStore()
    const isolated = new ConversationLinker(queryExecutor, noopLogger)

    // Two sessions opening with a byte-identical prompt: the root request is stored once,
    // because both sessions hash to it.
    const rootHash = isolated.computeMessageHash([{ role: 'user', content: 'Identical prompt' }])
    rows.push({
      request_id: 'root-request',
      conversation_id: 'shared-conv',
      branch_id: 'main',
      current_message_hash: rootHash,
      parent_message_hash: null,
      system_hash: null,
    })

    const continueWith = (reply: string, followUp: string): LinkingRequest => ({
      projectId: 'test-project',
      messages: [
        { role: 'user', content: 'Identical prompt' },
        { role: 'system', content: SKILLS_REMINDER },
        { role: 'assistant', content: reply },
        { role: 'user', content: followUp },
      ],
      systemPrompt: 'Test system prompt',
      requestId: `child-${reply}`,
      messageCount: 4,
    })

    const first = await isolated.linkConversation(continueWith('Answer A', 'Follow-up A'))
    expect(first.conversationId).toBe('shared-conv')
    expect(first.branchId).toBe('main')

    rows.push({
      request_id: 'child-a',
      conversation_id: first.conversationId!,
      branch_id: first.branchId,
      current_message_hash: first.currentMessageHash,
      parent_message_hash: first.parentMessageHash,
      system_hash: first.systemHash,
    })

    // The second session diverges from the same root - it must not be appended to the
    // first session's chain, it must open a branch.
    const second = await isolated.linkConversation(continueWith('Answer B', 'Follow-up B'))
    expect(second.conversationId).toBe('shared-conv')
    expect(second.branchId).not.toBe('main')
    expect(second.branchId).toStartWith('branch_')
    expect(second.currentMessageHash).not.toBe(first.currentMessageHash)
  })
})

describe('System prompt hash stability', () => {
  const claudeCodePrompt = [
    "You are Claude Code, Anthropic's official CLI for Claude.",
    'You are an interactive agent that helps users with software engineering tasks.',
    '',
    '# Environment',
    ' - Primary working directory: /home/dev/project',
  ].join('\n')

  test('ignores the volatile x-anthropic-billing-header block', () => {
    const withVersionA = `x-anthropic-billing-header: cc_version=2.1.218.e2a; cc_entrypoint=cli;\n${claudeCodePrompt}`
    const withVersionB = `x-anthropic-billing-header: cc_version=2.1.220.3fc; cc_entrypoint=cli;\n${claudeCodePrompt}`

    expect(hashSystemPrompt(withVersionA)).toBe(hashSystemPrompt(withVersionB))
  })

  test('ignores the billing header in array form', () => {
    const asArray = (version: string) => [
      { type: 'text' as const, text: `x-anthropic-billing-header: cc_version=${version};` },
      { type: 'text' as const, text: claudeCodePrompt },
    ]

    expect(hashSystemPrompt(asArray('2.1.218.e2a'))).toBe(hashSystemPrompt(asArray('2.1.220.3fc')))
  })

  test('ignores the git status section that changes on every commit', () => {
    const withStatus = (commit: string) =>
      `${claudeCodePrompt}\n\ngitStatus: This is the git status at the start of the conversation.\n\nCurrent branch: main\n\nRecent commits:\n${commit} some work\n`

    expect(hashSystemPrompt(withStatus('aaaaaaa'))).toBe(hashSystemPrompt(withStatus('bbbbbbb')))
  })

  test('recognises the Claude Code subagent prompt', () => {
    const subagentPrompt = `x-anthropic-billing-header: cc_version=2.1.219.d53; cc_is_subagent=true;\nYou are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, you should use the tools available.`

    expect(hashSystemPrompt(subagentPrompt)).toBeTruthy()
    // Collapses to the stable marker, so unrelated tail changes do not churn the hash
    expect(hashSystemPrompt(`${subagentPrompt}\n\nExtra environment details`)).toBe(
      hashSystemPrompt(subagentPrompt)
    )
  })

  test('still distinguishes unrelated system prompts', () => {
    expect(hashSystemPrompt('You are a helpful assistant')).not.toBe(
      hashSystemPrompt('You are a coding assistant')
    )
  })

  test('returns null when the prompt is only a billing header', () => {
    expect(hashSystemPrompt('x-anthropic-billing-header: cc_version=2.1.220.3fc;')).toBeNull()
  })
})
