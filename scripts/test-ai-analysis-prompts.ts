#!/usr/bin/env bun
/**
 * Test script for AI Analysis prompt engineering functionality
 *
 * This script tests:
 * - Message truncation with various conversation sizes
 * - Token counting accuracy
 * - Prompt assembly
 * - Response parsing
 */

import {
  truncateConversation,
  buildAnalysisPrompt,
  parseAnalysisResponse,
  type Message,
} from '@agent-prompttrain/shared'
import { fromPreTrained } from '@lenml/tokenizer-gemini'

const tokenizer = fromPreTrained()

// Test data
const generateTestMessages = (count: number): Message[] => {
  const messages: Message[] = []
  for (let i = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'model',
      content: `This is test message ${i + 1}. It contains some content to simulate a real conversation with enough text to make token counting meaningful. ${
        i === 0 ? 'The user is asking about implementing a new feature.' : ''
      }${i === count - 1 ? 'This is the final message with the resolution.' : ''}`,
    })
  }
  return messages
}

async function testTruncation() {
  console.log('🧪 Testing conversation truncation...\n')

  // Test 1: Small conversation (should not truncate)
  console.log('Test 1: Small conversation (10 messages)')
  const smallConv = generateTestMessages(10)
  const smallResult = truncateConversation(smallConv)
  console.log(`  Input: ${smallConv.length} messages`)
  console.log(`  Output: ${smallResult.length} messages`)
  console.log(`  Truncated: ${smallResult.length < smallConv.length}\n`)

  // Test 2: Large conversation (should truncate)
  console.log('Test 2: Large conversation (100 messages)')
  const largeConv = generateTestMessages(100)
  const largeResult = truncateConversation(largeConv)
  console.log(`  Input: ${largeConv.length} messages`)
  console.log(`  Output: ${largeResult.length} messages`)
  console.log(`  Truncated: ${largeResult.length < largeConv.length}`)

  // Check for truncation marker
  const hasTruncationMarker = largeResult.some(msg =>
    msg.content.includes('[...conversation truncated...]')
  )
  console.log(`  Has truncation marker: ${hasTruncationMarker}\n`)

  // Test 3: Edge case - single huge message
  console.log('Test 3: Single oversized message')
  const hugeMessage: Message = {
    role: 'user',
    content: 'x'.repeat(1000000), // 1M characters
  }
  const hugeResult = truncateConversation([hugeMessage])
  console.log(`  Input length: ${hugeMessage.content.length} chars`)
  console.log(`  Output length: ${hugeResult[0].content.length} chars`)
  console.log(`  Truncated: ${hugeResult[0].content.includes('[CONTENT TRUNCATED]')}\n`)
}

async function testTokenCounting() {
  console.log('🧪 Testing token counting...\n')

  const testStrings = [
    'Hello world',
    'This is a longer message with multiple words and some complexity.',
    JSON.stringify({ role: 'user', content: 'Test message' }),
  ]

  for (const str of testStrings) {
    const tokens = tokenizer.encode(str)
    console.log(`String: "${str.substring(0, 50)}${str.length > 50 ? '...' : ''}"`)
    console.log(`  Length: ${str.length} chars`)
    console.log(`  Tokens: ${tokens.length}`)
    console.log(`  Chars/token: ${(str.length / tokens.length).toFixed(2)}\n`)
  }
}

async function testPromptAssembly() {
  console.log('🧪 Testing prompt assembly...\n')

  const messages = generateTestMessages(5)
  const prompt = buildAnalysisPrompt(messages)

  console.log('Prompt structure:')
  console.log(`  Total length: ${prompt.length} chars`)
  console.log(`  Messages count: ${prompt.messages.length}`)
  console.log(`  First message role: ${prompt.messages[0].role}`)
  console.log(
    `  Has system prompt: ${prompt.messages[0].content.includes('expert conversation analyst')}`
  )
  console.log(`  Has examples: ${prompt.messages.length > 1}\n`)
}

async function testResponseParsing() {
  console.log('🧪 Testing response parsing...\n')

  // Test 1: Raw JSON response
  const rawJson = `{
    "analysis": {
      "summary": "Test summary",
      "keyTopics": ["topic1", "topic2"],
      "sentiment": "positive",
      "userIntent": "Test intent",
      "outcomes": ["outcome1"],
      "actionItems": [],
      "technicalDetails": {
        "toolsUsed": ["tool1"],
        "frameworks": [],
        "issues": [],
        "solutions": []
      },
      "conversationQuality": {
        "clarity": "high",
        "completeness": "complete",
        "effectiveness": "effective"
      }
    }
  }`

  try {
    const parsed1 = parseAnalysisResponse(rawJson)
    console.log('Test 1: Raw JSON - ✅ Parsed successfully')
  } catch (error) {
    console.log('Test 1: Raw JSON - ❌ Failed:', error)
  }

  // Test 2: Code block wrapped response
  const codeBlockJson = `Here's the analysis:

\`\`\`json
${rawJson}
\`\`\`

That's the complete analysis.`

  try {
    const parsed2 = parseAnalysisResponse(codeBlockJson)
    console.log('Test 2: Code block wrapped - ✅ Parsed successfully')
  } catch (error) {
    console.log('Test 2: Code block wrapped - ❌ Failed:', error)
  }

  // Test 3: Invalid response
  const invalidJson = `This is not valid JSON`

  try {
    const parsed3 = parseAnalysisResponse(invalidJson)
    console.log('Test 3: Invalid JSON - ❌ Should have failed')
  } catch (error) {
    console.log('Test 3: Invalid JSON - ✅ Correctly rejected')
  }

  console.log()
}

async function main() {
  console.log('AI Analysis Prompt Engineering Test Suite')
  console.log('========================================\n')

  await testTruncation()
  await testTokenCounting()
  await testPromptAssembly()
  await testResponseParsing()

  console.log('✨ All tests completed!')
}

main().catch(console.error)
