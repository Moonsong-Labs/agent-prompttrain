#!/usr/bin/env bun

// Test script to verify fixture generation without database

import { ConversationLinker } from '../packages/shared/src/utils/conversation-linker'
import { hashSystemPrompt } from '../packages/shared/src/utils/conversation-hash'

// Create test data
const parentMessages = [{ role: 'user', content: 'Hello' }]

const childMessages = [
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi there! How can I help?' },
  { role: 'user', content: 'What is the weather?' },
]

const system = 'You are a helpful assistant'

// Create a no-op logger for the script
const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

// Create linker
const linker = new ConversationLinker(
  async () => [],
  mockLogger,
  async () => null,
  undefined, // requestByIdExecutor
  undefined, // subtaskQueryExecutor
  undefined // subtaskSequenceQueryExecutor
)

// Compute hashes
const parentHash = linker.computeMessageHash(parentMessages)
const childParentHash = linker.computeMessageHash(childMessages.slice(0, -2))
const systemHash = hashSystemPrompt(system)

console.log('Parent hash:', parentHash)
console.log('Child parent hash:', childParentHash)
console.log('Match:', parentHash === childParentHash)
console.log('System hash:', systemHash)

// Create fixture
const fixture = {
  description: 'Test fixture',
  type: 'standard',
  expectedLink: true,
  parent: {
    request_id: 'parent-test',
    projectId: 'train-test',
    conversation_id: 'conv-test',
    branch_id: 'main',
    current_message_hash: parentHash,
    parent_message_hash: null,
    system_hash: systemHash,
    body: {
      messages: parentMessages,
      system: system,
    },
    response_body: {
      content: [{ text: 'Hi there! How can I help?', type: 'text' }],
    },
  },
  child: {
    request_id: 'child-test',
    projectId: 'train-test',
    body: {
      messages: childMessages,
      system: system,
    },
  },
}

console.log('\nFixture:')
console.log(JSON.stringify(fixture, null, 2))
