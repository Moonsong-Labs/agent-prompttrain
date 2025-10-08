# ADR-007: Sub-task Detection and Tracking

## Status

Accepted

## Context

Claude's Task tool (agent spawning) allows AI assistants to create sub-agents for complex tasks. These sub-tasks appear as separate conversations, making it difficult to:

- Understand the relationship between parent and child tasks
- Track token usage across an entire task hierarchy
- Visualize complex multi-agent workflows
- Debug issues in nested task execution

We needed a way to automatically detect and link these sub-tasks to provide better visibility into agent-based workflows.

## Decision Drivers

- **Automatic Detection**: No changes to client code required
- **Accurate Linking**: Reliably connect sub-tasks to parents
- **Performance**: Minimal overhead on request processing
- **Visualization**: Enable dashboard to show task hierarchies
- **Flexibility**: Support various agent patterns

## Considered Options

1. **Client-Side Annotation**
   - Description: Clients explicitly mark sub-tasks
   - Pros: 100% accurate, explicit relationships
   - Cons: Requires client changes, breaks existing code

2. **Response Analysis**
   - Description: Parse responses for Task tool invocations
   - Pros: Works with existing clients, automatic
   - Cons: Parsing overhead, potential false positives

3. **Message Content Matching**
   - Description: Match task prompts to new conversations
   - Pros: No client changes, works retroactively
   - Cons: Timing windows, potential mismatches

4. **Correlation Headers**
   - Description: Use custom headers for task relationships
   - Pros: Explicit, no parsing needed
   - Cons: Requires client support

## Decision

We implemented **single-phase subtask detection** entirely within the ConversationLinker component:

- In-memory caching of Task tool invocations via TaskInvocationCache
- Complete subtask detection during conversation linking
- Subtasks inherit parent conversation ID with unique branch naming

### Implementation Details

1. **Phase 1 - Potential Subtask Detection (ConversationLinker)**:

   ```typescript
   // Detect potential subtasks in ConversationLinker
   private detectPotentialSubtask(messages: Message[]): boolean {
     // Single user message conversations are potential subtasks
     if (messages.length !== 1) return false
     if (messages[0].role !== 'user') return false

     const textContent = this.extractTextContent(messages[0])

     // This is a broad, first-pass filter. We intentionally flag ANY non-empty
     // single user message as a potential sub-task. The downstream proxy service
     // is responsible for the precise matching against actual Task tool invocations.
     return textContent !== null && textContent.trim().length > 0
   }
   ```

2. **Phase 2 - Task Invocation Extraction and Matching**:

   ```typescript
   // Extract Task tool invocations from response
   function extractTaskInvocations(response: any): TaskInvocation[] {
     const invocations = []

     // Check content blocks for tool_use
     if (response.content) {
       for (const block of response.content) {
         if (block.type === 'tool_use' && block.name === 'Task') {
           invocations.push({
             tool_use_id: block.id,
             prompt: block.input.prompt,
             description: block.input.description,
           })
         }
       }
     }

     return invocations
   }

   // Match potential subtask against stored invocations
   const TASK_MATCH_WINDOW = 30000 // 30-second window

   async function linkSubtask(request: ProcessedRequest) {
     // Only process if ConversationLinker flagged as potential subtask
     if (!request.isPotentialSubtask) return

     const userMessage = extractTextContent(request.messages[0])

     // Find recent Task invocations
     const recentTasks = await findTaskInvocations({
       since: new Date(request.timestamp - TASK_MATCH_WINDOW),
       matchingPrompt: userMessage,
     })

     if (recentTasks.length > 0) {
       // Link to most recent matching task
       request.is_subtask = true
       request.parent_task_request_id = recentTasks[0].request_id
     }
   }
   ```

3. **Database Schema**:

   ```sql
   ALTER TABLE api_requests ADD COLUMN is_subtask BOOLEAN DEFAULT FALSE;
   ALTER TABLE api_requests ADD COLUMN parent_task_request_id UUID;
   ALTER TABLE api_requests ADD COLUMN task_tool_invocation JSONB;

   CREATE INDEX idx_subtask_parent ON api_requests(parent_task_request_id);
   CREATE INDEX idx_task_invocations ON api_requests USING gin(task_tool_invocation);
   ```

4. **Visualization Data**:

   ```typescript
   // Enhance conversation data with sub-task info
   interface ConversationNode {
     id: string
     messages: Message[]
     subtasks: SubTask[]
   }

   interface SubTask {
     request_id: string
     task_number: number
     description: string
     message_count: number
     status: 'running' | 'completed'
   }
   ```

## Why Two-Phase Detection?

The two-phase approach separates concerns:

1. **ConversationLinker** (Phase 1) focuses on conversation structure and linking
   - Identifies potential subtasks based on message patterns
   - Doesn't need database access for Task invocations
   - Can run efficiently as part of conversation processing

2. **Proxy Service** (Phase 2) handles the actual Task tool matching
   - Has access to response data with Task invocations
   - Can store and query Task invocations in the database
   - Performs precise matching with time windows

This separation allows subtasks to be separate conversations (different conversation_id) while still being tracked as subtasks through the `is_subtask` and `parent_task_request_id` fields.

## Consequences

### Positive

- **Zero Client Changes**: Works with all existing Claude clients
- **Complete Visibility**: Full task hierarchy tracking
- **Accurate Token Attribution**: Aggregate usage across task trees
- **Rich Visualizations**: Dashboard shows task relationships
- **Debugging Support**: Trace execution through sub-tasks
- **Clean Architecture**: Separation of concerns between components

### Negative

- **Processing Overhead**: Must parse all responses
- **Timing Sensitivity**: 30-second window may miss slow tasks
- **Storage Increase**: Additional JSONB data per request
- **Potential Mismatches**: Similar prompts could link incorrectly
- **Two-Phase Complexity**: Requires coordination between components

### Risks and Mitigations

- **Risk**: False positive task linking
  - **Mitigation**: Exact prompt matching required
  - **Mitigation**: Time window limits false matches

- **Risk**: Missed sub-tasks due to timing
  - **Mitigation**: Configurable time window
  - **Mitigation**: Manual linking API for corrections

- **Risk**: Performance impact from JSON parsing
  - **Mitigation**: Parse only tool_use blocks
  - **Mitigation**: GIN index for efficient queries

## Implementation Notes

- Re-implemented in November 2024 after initial removal
- Two-phase detection allows clean separation of concerns
- ConversationLinker returns `isPotentialSubtask` flag for single-message user conversations
- Proxy service performs actual Task tool matching and sets `is_subtask` field
- 30-second window chosen based on typical Task execution time
- Dashboard shows sub-tasks as gray boxes with tooltips
- Supports multiple sub-tasks per parent request
- Subtasks maintain separate conversation_ids but link via parent_task_request_id

## Dashboard Visualization

1. **Tree View**:
   - Parent tasks show sub-task count
   - Sub-tasks appear as connected nodes
   - Tooltips show task descriptions

2. **Metrics**:
   - Total sub-tasks in conversation
   - Aggregate token usage
   - Task completion status

3. **Navigation**:
   - Click sub-task to view conversation
   - Hover for task prompt preview

## Architecture Evolution (2025-01)

### Single-Phase Subtask Detection in ConversationLinker

In January 2025, we completed a major architectural evolution to consolidate all subtask detection logic into the ConversationLinker component:

**Previous Architecture (Two-Phase)**:

- ConversationLinker detected potential subtasks (Phase 1)
- StorageAdapter/Writer performed Task matching (Phase 2)
- Subtasks got separate conversation IDs
- Required database queries during write operations

**Current Architecture (Single-Phase)**:

- SQL queries retrieve Task invocations from database (24-hour window)
- ConversationLinker performs complete subtask detection in one phase
- Subtasks inherit parent's conversation_id with unique branch_id
- Optimized indexes for efficient Task tool queries
- StorageAdapter passes TaskContext to ConversationLinker

**Implementation Details**:

1. **SQL-based Task Retrieval** (StorageAdapter.loadTaskContext):
   - Queries last 24 hours of Task invocations per project_id
   - Filters to 30-second window for actual matching
   - Optimized with GIN indexes on JSONB response_body
   - No memory overhead from caching

2. **ConversationLinker Updates**:
   - Added `detectSubtask()` method for complete detection
   - Accepts optional `TaskContext` with recent invocations
   - Uses `RequestByIdExecutor` to fetch parent task details
   - Assigns sequential `subtask_N` branch IDs

3. **Database Migration** (008-update-subtask-conversation-ids.ts):
   - Updates existing subtasks to inherit parent conversation IDs
   - Fixes branch numbering for consistency
   - Creates optimized indexes for Task invocation queries
   - Maintains backward compatibility

**Benefits Achieved**:

1. **Single Responsibility**: All linking logic in one component
2. **Persistence**: Survives proxy restarts, no cache warming needed
3. **Unified Conversations**: Related messages stay together
4. **Cleaner Dashboard**: Single conversation tree for task hierarchies
5. **Simpler Testing**: All logic testable in isolation
6. **Extended Window**: 24-hour lookback for better subtask detection

## Future Enhancements

1. **Configurable Time Window**: Per-project_id task matching windows
2. **Task Status Tracking**: Monitor running/completed/failed states
3. **Recursive Task Trees**: Support sub-tasks spawning sub-tasks
4. **Task Templates**: Recognize common task patterns
5. **Performance Metrics**: Task execution time analysis

## Links

- [PR #13: Conversation and sub-task tracking](https://github.com/Moonsong-Labs/agent-prompttrain/pull/13)
- [Dashboard Guide](../../02-User-Guide/dashboard-guide.md#sub-task-visualization)
- [API Reference](../../02-User-Guide/api-reference.md#subtasks)

---

Date: 2024-06-25 (Initial)
Updated: 2025-01-07 (Single-phase architecture)
Authors: Development Team
