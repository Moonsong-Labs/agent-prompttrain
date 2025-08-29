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

---

Date: 2024-02-01 (Updated: 2025-06-28, 2025-07-02)
Authors: Development Team
