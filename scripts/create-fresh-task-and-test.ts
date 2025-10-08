#!/usr/bin/env bun

import { Pool } from 'pg'
import { randomUUID } from 'crypto'
import { StorageWriter } from '../services/proxy/src/storage/writer.js'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

async function createFreshTaskAndTest() {
  try {
    console.log('Creating fresh Task invocation and testing sub-task linking...\n')

    const writer = new StorageWriter(pool)

    // Step 1: Create a fresh parent request with Task invocation
    const parentRequestId = randomUUID()
    const parentTimestamp = new Date()
    const taskPrompt = 'Analyze the codebase structure and count lines by file type'

    console.log('1. Creating parent request with Task invocation...')
    await pool.query(
      `
      INSERT INTO api_requests (
        request_id, project_id, timestamp, method, path, headers, body,
        api_key_hash, model, request_type, conversation_id,
        task_tool_invocation, response_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `,
      [
        parentRequestId,
        'test.localhost',
        parentTimestamp,
        'POST',
        '/v1/messages',
        JSON.stringify({}),
        JSON.stringify({ messages: [{ role: 'user', content: 'spawn task' }] }),
        'test-hash',
        'claude-3-opus',
        'inference',
        randomUUID(),
        JSON.stringify([
          {
            id: 'toolu_test_fresh',
            name: 'Task',
            input: {
              prompt: taskPrompt,
              description: 'Analyze code',
            },
          },
        ]),
        200,
      ]
    )
    console.log(`✅ Parent created: ${parentRequestId}`)
    console.log(`   Timestamp: ${parentTimestamp.toISOString()}`)
    console.log(`   Task prompt: "${taskPrompt}"`)

    // Step 2: Wait 2 seconds
    console.log('\n2. Waiting 2 seconds...')
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Step 3: Create a sub-task request with matching prompt
    const subtaskRequestId = randomUUID()
    const subtaskConversationId = randomUUID()
    const subtaskTimestamp = new Date()

    console.log('\n3. Creating sub-task request with matching prompt...')
    console.log(`   Request ID: ${subtaskRequestId}`)
    console.log(`   Timestamp: ${subtaskTimestamp.toISOString()}`)

    await writer.storeRequest({
      requestId: subtaskRequestId,
      projectId: 'test.localhost',
      timestamp: subtaskTimestamp,
      method: 'POST',
      path: '/v1/messages',
      headers: {},
      body: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '<system-reminder>System context</system-reminder>' },
              { type: 'text', text: taskPrompt }, // Same prompt as Task
            ],
          },
        ],
      },
      apiKey: 'test-key',
      model: 'claude-3-opus',
      requestType: 'inference',
      conversationId: subtaskConversationId,
      currentMessageHash: 'test-hash-2',
      parentMessageHash: null, // New conversation
    })

    // Step 4: Check if sub-task was linked
    console.log('\n4. Checking if sub-task was linked...')
    const result = await pool.query(
      'SELECT parent_task_request_id, is_subtask FROM api_requests WHERE request_id = $1',
      [subtaskRequestId]
    )

    if (result.rows.length > 0) {
      const row = result.rows[0]
      if (row.parent_task_request_id === parentRequestId) {
        console.log(`✅ SUCCESS! Sub-task correctly linked to parent!`)
        console.log(`   parent_task_request_id: ${row.parent_task_request_id}`)
        console.log(`   is_subtask: ${row.is_subtask}`)
      } else if (row.parent_task_request_id) {
        console.log(`⚠️  Sub-task linked to different parent: ${row.parent_task_request_id}`)
      } else {
        console.log('❌ FAILED! Sub-task was not linked')
        console.log(`   parent_task_request_id: ${row.parent_task_request_id}`)
        console.log(`   is_subtask: ${row.is_subtask}`)
      }
    }

    // Step 5: Cleanup
    console.log('\n5. Cleaning up test data...')
    await pool.query('DELETE FROM api_requests WHERE request_id IN ($1, $2)', [
      parentRequestId,
      subtaskRequestId,
    ])
    console.log('✅ Cleanup complete')
  } catch (error) {
    console.error('Error:', error)
  } finally {
    await pool.end()
  }
}

createFreshTaskAndTest().catch(console.error)
