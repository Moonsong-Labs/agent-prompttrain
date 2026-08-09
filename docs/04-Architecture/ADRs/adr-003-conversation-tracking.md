# ADR-003: Conversation Tracking with Message Hashing

## Status

Accepted

## Context

Claude API conversations consist of a series of messages between users and the assistant. To provide meaningful analytics and visualization in our dashboard, we need to track which messages belong to the same conversation and detect when conversations branch (similar to git branches). The challenge is that the Claude API doesn't provide conversation IDs, and requests can be resumed from any point in the message history.

## Decision Drivers

- **Automatic Tracking**: No client-side changes required
- **Branch Detection**: Support conversation branching like git
- **Performance**: Minimal overhead on request processing
- **Reliability**: Consistent tracking despite message format variations
- **Compatibility**: Work with all Claude API features

## Considered Options

1. **Client-Provided IDs**
   - Description: Require clients to send conversation IDs
   - Pros: Simple implementation, explicit tracking
   - Cons: Requires client changes, breaks API compatibility

2. **Session-Based Tracking**
   - Description: Use session cookies or tokens
   - Pros: Works with existing HTTP mechanisms
   - Cons: Doesn't work with API clients, loses context on session end

3. **Message Content Hashing**
   - Description: Generate hashes of messages to create parent-child relationships
   - Pros: Automatic, supports branching, no client changes
   - Cons: Requires message normalization, hash computation overhead

## Decision

We will use **message content hashing** to automatically track conversations and detect branches.

### Implementation Details

1. **Message Normalization**:

```typescript
function normalizeContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content
  }
  return content
    .filter(block => !block.text?.startsWith('<system-reminder>'))
    .map(block => block.text || '')
    .join('\n')
}
```

2. **Hash Generation**:

```typescript
function generateMessageHash(message: Message): string {
  const normalized = normalizeContent(message.content)
  return crypto.createHash('sha256').update(`${message.role}:${normalized}`).digest('hex')
}
```

3. **Conversation Linking**:

```typescript
// For each request:
const messages = request.messages
const currentHash = generateMessageHash(messages[messages.length - 1])
const parentHash = messages.length > 1 ? generateMessageHash(messages[messages.length - 2]) : null

// Find or create conversation
const conversation =
  (await findConversationByParentHash(parentHash)) || (await createNewConversation())

// Detect branching
if (parentHash && conversationHasMultipleChildren(parentHash)) {
  // This is a branch point
  markAsBranch(parentHash)
}
```

4. **Database Schema**:

```sql
ALTER TABLE api_requests ADD COLUMN conversation_id UUID;
ALTER TABLE api_requests ADD COLUMN current_message_hash VARCHAR(64);
ALTER TABLE api_requests ADD COLUMN parent_message_hash VARCHAR(64);
ALTER TABLE api_requests ADD COLUMN branch_id VARCHAR(50) DEFAULT 'main';

CREATE INDEX idx_message_hashes ON api_requests(parent_message_hash, current_message_hash);
```

## Consequences

### Positive

- **Zero Client Changes**: Works with existing Claude API clients
- **Automatic Branch Detection**: Identifies when conversations diverge
- **Consistent Tracking**: Handles both string and array message formats
- **System Message Filtering**: Ignores system reminders for consistent hashing
- **Visual Representation**: Enables tree-like conversation visualization

### Negative

- **Hash Computation**: Small performance overhead per request
- **Storage Requirements**: Additional 128+ bytes per request
- **Normalization Complexity**: Must handle all content format variations

### Risks and Mitigations

- **Risk**: Hash collisions could link unrelated conversations
  - **Mitigation**: Use SHA-256 for extremely low collision probability

- **Risk**: Message format changes could break hashing
  - **Mitigation**: Comprehensive normalization and format detection

- **Risk**: Performance impact on high-volume systems
  - **Mitigation**: Hash computation is fast, can be made async if needed

## Links

- [Implementation PR #13](https://github.com/Moonsong-Labs/agent-prompttrain/pull/13)
- [Conversation Visualization](../../02-User-Guide/dashboard-guide.md#conversation-tracking)
- [Database Schema](../../03-Operations/database.md)

## Notes

This approach has proven effective in production, enabling powerful conversation analytics without requiring any changes to client applications. The branch detection feature has been particularly valuable for understanding how users explore different conversation paths.

### Enhancement: Dual Hash System (2025-06-28)

The original implementation included system prompts in the conversation hash, which caused issues when system prompts changed between sessions (e.g., git status in Claude Code, context compaction). This was resolved by implementing a dual hash system:

**Changes:**

1. **Separate Message Hash**: `hashMessagesOnly()` - Hashes only the message content for conversation linking
2. **Separate System Hash**: `hashSystemPrompt()` - Hashes only the system prompt for tracking context changes
3. **Updated `extractMessageHashes()`**: Now returns three values:
   - `currentMessageHash` - Message-only hash for linking
   - `parentMessageHash` - Parent message hash for branching
   - `systemHash` - System prompt hash for context tracking

**Benefits:**

- Conversations maintain links even when system prompts change
- System context changes can be tracked independently
- Backward compatible with existing data

**Migration:**

- Added `system_hash` column to `api_requests` table
- Existing data can be backfilled using `scripts/db/backfill-system-hashes.ts`

Future enhancements could include:

- Conversation merging detection
- Semantic similarity for fuzzy matching
- Conversation templates and patterns
- System prompt change visualization in dashboard

### Enhancement: Temporal Awareness for Historical Rebuilds (2025-07-02)

To support accurate historical rebuilds and prevent future data from affecting past conversation linking, we've made timestamps mandatory for key query methods:

**Changes:**

1. **`getMaxSubtaskSequence(conversationId, beforeTimestamp)`**: Now requires a timestamp to only consider subtasks that existed before that time
2. **`findConversationByParentHash(parentHash, beforeTimestamp)`**: Now requires a timestamp to only consider conversations that existed before that time
3. **Updated `SubtaskSequenceQueryExecutor` type**: Made the `beforeTimestamp` parameter mandatory
4. **Cache key updates**: ConversationLinker now includes timestamp in cache keys to prevent cross-temporal cache pollution

**Benefits:**

- Historical rebuilds accurately reflect the state at that point in time
- Prevents future subtasks from being incorrectly included in past conversations
- Ensures temporal integrity when rebuilding conversation links
- Maintains data consistency across different time queries

**Implementation Details:**

- All queries now include `AND timestamp < $N` clauses
- Cache keys incorporate timestamp: `${conversationId}_${timestamp.toISOString()}`
- When timestamp is not provided at the API level, the system defaults to current time
- Type system enforces timestamp awareness throughout the codebase

This enhancement is particularly important for systems that need to rebuild or analyze historical conversation data, ensuring that the reconstructed state accurately reflects what existed at any given point in time.

### Enhancement: Injected `system` Messages Excluded from Hashing (2026-07-25)

Claude Code 2.1 changed the wire format in ways that broke parent matching: a single session
fragmented into many one- or two-request conversations. Measured over 10 hours of production
traffic, only 72% of requests found a parent; after the fix, 93%.

**What changed on the client side:**

1. **`role: 'system'` messages inside the `messages` array.** Claude Code injects ephemeral
   context (system-reminders, `SessionStart` hook output, tool nudges) as extra messages rather
   than only inside `user` messages. These are volatile in three ways:
   - they appear and disappear between turns, so a turn can grow the array by **3** messages
     instead of the 2 that `parentMessageHash = messages.slice(0, -2)` assumes;
   - the **same** reminder is sent as a plain string in one request and as a content block array
     (carrying `cache_control`) in the next;
   - their text changes even when the conversation does not.
2. **`x-anthropic-billing-header:` prepended to the system prompt**, carrying `cc_version`. It
   changes on every Claude Code release, so `system_hash` churned mid-session and the
   priority-i (message + system) parent match almost always missed.
3. **New system prompt openings** — `You are Claude Code, Anthropic's official CLI for Claude`
   and `You are an agent for Claude Code, ...` — replacing the
   `You are an interactive CLI tool...` prefix that the stable-prompt special case matched.

**Changes:**

1. **`ConversationLinker.filterConversationMessages()`**: keeps only `user`/`assistant` messages.
   Applied before hashing, before the parent/grandparent offset arithmetic, and before
   compact/subtask detection — so subtask detection works again for subagent requests, whose
   first request is now `[user, system]` rather than `[user]`.
2. **`normalizeStringContent()`** now strips `<system-reminder>` blocks (and collapses to an
   empty string when nothing remains), matching what the content-block path already did. String
   and array representations of the same message now hash identically.
3. **`getStableSystemPrompt()`** drops `x-anthropic-billing-header:` lines, recognises the new
   Claude Code prompt markers, and truncates everything from `gitStatus:` onwards (previously a
   non-greedy regex removed only the first paragraph).

**Consequences:**

- Hashes for requests containing injected `system` messages differ from those stored before this
  change. Conversations already recorded keep their existing (fragmented) `conversation_id`;
  run `bun run scripts/db/rebuild-conversations.ts` to re-link historical data.
- Two requests differing only in injected `system` messages now hash identically and are treated
  as siblings by the existing branch-detection logic.
- `message_count` semantics are unchanged: it still counts every message in the request,
  including injected `system` messages.

---

### Enhancement: Subagent Rename and Auto-Compact Continuations (2026-08-08)

Two further Claude Code 2.1 changes kept fragmenting sessions even after the injected-`system`
fix. Measured on one project's production traffic, 53 stored conversations over 6 hours were
really **2**: one long session plus one unrelated single request.

**What changed on the client side:**

1. **The subagent tool was renamed `Task` → `Agent`.** Subtask detection matched the literal name
   `Task`, so it found nothing: every subagent became its own root conversation instead of a
   `subtask_N` branch of the session that launched it.
2. **Auto-compact now carries the tail of the previous transcript over** alongside the summary.
   The first request after a compaction therefore arrives as
   `[summary, assistant(tool_use), user(tool_result), …]` rather than a lone summary message.
   Compact detection only ran on single-message requests, so it never fired — and the request's
   computed parent hash covers only the summary message, which was never sent as a request on its
   own, so prefix matching could not link it either.
3. **The compact preamble was reworded.** 2.1 emits `The summary below covers the earlier portion
of the conversation.` followed by a bare `Summary:` heading, then trailing resume instructions
   (`If you need specific details from before compaction…`, `Continue the conversation from where
it left off…`). The previous marker `The conversation is summarized below:` and suffix
   `Please continue the conversation` no longer appear.
4. **The summarizing response is wrapped.** It now begins `<analysis>…</analysis>` before
   `<summary>`, so the summary is _contained in_ the response rather than starting it.

**Changes:**

1. **`SUBAGENT_TOOL_NAMES`** (exported from `conversation-linker.ts`) lists `Agent` and `Task`.
   Both are matched by `StorageAdapter.loadTaskInvocations` and by
   `StorageWriter.findTaskToolInvocations` (which populates `task_tool_invocation`), so current
   traffic links and historical rebuilds of pre-2.1 data keep working.
2. **`SUMMARY_MARKERS` / `SUMMARY_SUFFIX_MARKERS`** replace the single marker constants. Markers
   are tried in order with the legacy wording first; the summary is cut at the _earliest_ trailing
   marker present, since the markers are not in text order.
3. **Compact detection now also runs for multi-message requests**, as a fallback after exact,
   summarization, fallback and grandparent matching have all failed. Ordering matters: later
   requests in a compacted session still carry the summary as message 0 and must link by prefix
   hash, keeping their branch, rather than opening a new `compact_` branch every turn.
4. **`StorageWriter.findParentByResponseContent`** matches a bounded prefix of the summary as a
   substring (`strpos`) instead of requiring the response to start with it. The prefix is capped
   at 2000 characters: measured across 17 concurrent compact chains, a 200-character probe
   collided in 7 cases (they share a boilerplate opening) while 2000 collided in none. Summaries
   shorter than 100 characters are rejected outright, because an empty needle makes `strpos`
   match every row. The legacy `starts_with` comparison is kept as an alternative so pre-2.1 data
   still matches.

**Consequences:**

- A compact continuation is linked with `parentMessageHash` set to the parent request's
  `current_message_hash` rather than the transcript-derived hash, which has no corresponding
  stored request. This matches what the single-message compact path already did.
- Existing rows keep their fragmented `conversation_id`; run
  `bun run scripts/db/rebuild-conversations.ts` to re-link historical data.
- Hash-based tracking still cannot separate two sessions whose transcripts are byte-identical up
  to a divergence point (see the isolation tests) — that limitation is unchanged.

---

Date: 2024-02-01 (Updated: 2025-06-28, 2025-07-02, 2026-07-25, 2026-08-08)
Authors: Development Team
