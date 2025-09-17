# Conversation Linking Test Fixtures

This directory contains JSON files that represent parent-child request pairs for testing the conversation linking logic.

## File Format

Each JSON file should contain:

```json
{
  "description": "Brief description of the test case",
  "type": "normal|compact|branch|summarization",
  "expectedLink": true|false,
  "expectedParentHash": "hash-value",
  "expectedBranchPattern": "regex-pattern (optional)",
  "expectedSummaryContent": "content to match in compact search (optional)",
  "parent": {
    "request_id": "uuid",
    "trainId": "trainId.com",
    "conversation_id": "uuid",
    "branch_id": "main|branch_*",
    "current_message_hash": "hash",
    "parent_message_hash": "hash|null",
    "system_hash": "hash|null",
    "body": {
      "messages": [...],
      "system": "..."
    },
    "response_body": {
      // Optional - used for compact conversation detection
    }
  },
  "child": {
    "request_id": "uuid",
    "trainId": "trainId.com",
    "body": {
      "messages": [...],
      "system": "..."
    }
  },
  "existingChild": {
    // Optional - used for branch detection tests
  }
}
```

## Test Types

1. **normal**: Standard conversation continuation
2. **compact**: Context overflow continuation with summary
3. **branch**: Creating a new branch when returning to an earlier point
4. **summarization**: Summarization requests that ignore system hash

## Adding New Test Cases

1. Create a new JSON file following the naming pattern: `NN-description.json`
2. Include realistic message content from actual Claude conversations
3. Ensure the expected hashes match what the ConversationLinker would generate
4. Test both successful linking and cases where linking should fail
