#!/usr/bin/env bun

import { Pool } from 'pg'
import { randomUUID } from 'crypto'
import { StorageWriter } from '../services/proxy/src/storage/writer.js'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

async function simulateSubtaskCreation() {
  try {
    console.log('Simulating sub-task creation to test linking...\n')

    const writer = new StorageWriter(pool)

    // Create a new sub-task request that should match the existing Task
    const newSubtaskId = randomUUID()
    const newConversationId = randomUUID()
    const subtaskTimestamp = new Date()

    const subtaskPrompt =
      'Count the total lines of code in the agent-prompttrain-proxy repository. \n\nPlease:\n1. Use tools like `find`, `wc`, and `rg` to get accurate counts'

    console.log('Creating new sub-task request...')
    console.log(`Request ID: ${newSubtaskId}`)
    console.log(`Timestamp: ${subtaskTimestamp.toISOString()}`)
    console.log(`Prompt: ${subtaskPrompt.substring(0, 60)}...`)

    await writer.storeRequest({
      requestId: newSubtaskId,
      trainId: 'test.localhost',
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
              { type: 'text', text: subtaskPrompt },
            ],
          },
        ],
      },
      apiKey: 'test-key',
      model: 'claude-3-opus',
      requestType: 'inference',
      conversationId: newConversationId,
      currentMessageHash: 'test-hash',
      parentMessageHash: null, // New conversation = potential sub-task
    })

    console.log('\nChecking if sub-task was linked...')

    const result = await pool.query(
      'SELECT parent_task_request_id, is_subtask FROM api_requests WHERE request_id = $1',
      [newSubtaskId]
    )

    if (result.rows.length > 0) {
      const row = result.rows[0]
      if (row.parent_task_request_id) {
        console.log(`✅ SUCCESS! Sub-task linked to parent: ${row.parent_task_request_id}`)
        console.log(`   is_subtask: ${row.is_subtask}`)
      } else {
        console.log('❌ FAILED! Sub-task was not linked')
        console.log(`   parent_task_request_id: ${row.parent_task_request_id}`)
        console.log(`   is_subtask: ${row.is_subtask}`)
      }
    }

    // Cleanup
    console.log('\nCleaning up test data...')
    await pool.query('DELETE FROM api_requests WHERE request_id = $1', [newSubtaskId])
  } catch (error) {
    console.error('Error:', error)
  } finally {
    await pool.end()
  }
}

simulateSubtaskCreation().catch(console.error)
