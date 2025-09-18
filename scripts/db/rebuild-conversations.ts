#!/usr/bin/env bun
/**
 * IMPORTANT: This script should NOT implement any business logic.
 * All it should do is fetch requests and use StorageAdapter to process them,
 * just like the proxy does when it receives an HTTP request.
 *
 * The StorageAdapter is the single source of truth for conversation linking logic.
 */

import { Pool } from 'pg'
import { config } from 'dotenv'
import { createLoggingPool } from './utils/create-logging-pool.js'
import { enableSqlLogging } from '../../services/proxy/src/utils/sql-logger.js'
import { StorageAdapter } from '../../services/proxy/src/storage/StorageAdapter.js'
import { generateConversationId } from '@agent-prompttrain/shared'

// Load environment variables
config()

// Batch size for processing requests (default 1000 ~= 1GB memory)
const BATCH_SIZE = 1000

// Memory monitoring utilities
const formatMemoryUsage = () => {
  const used = process.memoryUsage()
  return {
    heap: `${Math.round(used.heapUsed / 1024 / 1024)}MB / ${Math.round(used.heapTotal / 1024 / 1024)}MB`,
    heapUsed: used.heapUsed,
    external: Math.round(used.external / 1024 / 1024),
    rss: Math.round(used.rss / 1024 / 1024),
  }
}

interface DbRequest {
  request_id: string
  train_id: string
  timestamp: Date
  conversation_id: string | null
  branch_id: string | null
  current_message_hash: string | null
  parent_message_hash: string | null
  system_hash: string | null
  parent_request_id: string | null
  body: any
  message_count: number | null
  created_at: Date
  is_subtask: boolean | null
  parent_task_request_id: string | null
}

/**
 * Rebuilds conversation and branch IDs for all requests
 * This script recalculates conversation grouping based on message parent hashes
 * and includes subtask detection.
 */
class ConversationRebuilderFinal {
  private pool: Pool
  private storageAdapter: StorageAdapter
  private dryRun: boolean
  private trainIdFilter: string | null
  private limit: number | null
  private debugMode: boolean
  private requestIds: string[] | null

  constructor(
    pool: Pool,
    dryRun: boolean,
    trainIdFilter: string | null,
    limit: number | null,
    debugMode: boolean,
    requestIds: string[] | null
  ) {
    this.pool = pool
    this.dryRun = dryRun
    this.trainIdFilter = trainIdFilter
    this.limit = limit
    this.debugMode = debugMode
    this.requestIds = requestIds

    // Enable SQL logging on the pool if debug mode is enabled
    const loggingPool = enableSqlLogging(this.pool, {
      logQueries: this.debugMode,
      logSlowQueries: true,
      slowQueryThreshold: 5000,
      logStackTrace: false,
    })

    // Create StorageAdapter which handles all conversation linking logic
    this.storageAdapter = new StorageAdapter(loggingPool)
  }

  async rebuild() {
    const initialMemory = formatMemoryUsage().heapUsed

    try {
      console.log(`\nStarting conversation rebuild (final version)...`)
      console.log(`Using ConversationLinker with request-specific timestamps`)
      console.log(`Processing in batches of ${BATCH_SIZE} requests to optimize memory usage`)
      console.log(
        `\nInitial memory: Heap ${formatMemoryUsage().heap}, RSS ${formatMemoryUsage().rss}MB\n`
      )

      // Track overall progress
      let totalProcessed = 0
      let totalUpdates = 0
      let totalSubtasksDetected = 0
      let batchNumber = 0
      const overallChangeTypes = new Map<string, number>()

      while (true) {
        batchNumber++
        const batchStartTime = Date.now()

        // Load batch of requests
        console.log(`\n[Batch ${batchNumber}] Loading requests...`)
        const requests = await this.loadRequestsBatch(totalProcessed)

        if (requests.length === 0) {
          break
        }

        console.log(`[Batch ${batchNumber}] Found ${requests.length} requests to process`)

        let batchUpdates = 0
        let batchSubtasks = 0
        const changeTypes = new Map<string, number>()

        for (const request of requests) {
          try {
            if (this.debugMode && totalProcessed % 100 === 0) {
              console.log(
                `\n   Processing request ${request.request_id} from ${request.timestamp.toISOString()}`
              )
            }

            // Use StorageAdapter to determine conversation linkage
            // Pass the request's timestamp for historical processing
            const linkingResult = await this.storageAdapter.linkConversation(
              request.train_id,
              request.body.messages,
              request.body.system,
              request.request_id,
              request.timestamp // Historical timestamp from the request
            )

            // Log debug info if subtask detected
            if (linkingResult.isSubtask && this.debugMode) {
              console.log(
                `   ✓ Detected subtask: parent=${linkingResult.parentTaskRequestId}, sequence=${linkingResult.subtaskSequence}`
              )
              batchSubtasks++
            }

            // If no conversation ID was found, keep the existing one or generate a new one if none exists
            const conversationId =
              linkingResult.conversationId || request.conversation_id || generateConversationId()

            // Build list of changes
            const changes: string[] = []

            if (request.conversation_id !== conversationId) {
              changes.push(
                `conversation_id: ${request.conversation_id || 'null'} → ${conversationId}`
              )
              changeTypes.set('conversation_id', (changeTypes.get('conversation_id') || 0) + 1)
            }
            if (request.branch_id !== linkingResult.branchId) {
              changes.push(`branch_id: ${request.branch_id || 'null'} → ${linkingResult.branchId}`)
              changeTypes.set('branch_id', (changeTypes.get('branch_id') || 0) + 1)
            }
            if (request.current_message_hash !== linkingResult.currentMessageHash) {
              const oldHash = request.current_message_hash
                ? `${request.current_message_hash.substring(0, 8)}...`
                : 'null'
              const newHash = linkingResult.currentMessageHash
                ? `${linkingResult.currentMessageHash.substring(0, 8)}...`
                : 'null'
              changes.push(`current_message_hash: ${oldHash} → ${newHash}`)
              changeTypes.set(
                'current_message_hash',
                (changeTypes.get('current_message_hash') || 0) + 1
              )
            }
            if (request.parent_message_hash !== linkingResult.parentMessageHash) {
              const oldHash = request.parent_message_hash
                ? `${request.parent_message_hash.substring(0, 8)}...`
                : 'null'
              const newHash = linkingResult.parentMessageHash
                ? `${linkingResult.parentMessageHash.substring(0, 8)}...`
                : 'null'
              changes.push(`parent_message_hash: ${oldHash} → ${newHash}`)
              changeTypes.set(
                'parent_message_hash',
                (changeTypes.get('parent_message_hash') || 0) + 1
              )
            }
            if (request.system_hash !== linkingResult.systemHash) {
              const oldHash = request.system_hash
                ? `${request.system_hash.substring(0, 8)}...`
                : 'null'
              const newHash = linkingResult.systemHash
                ? `${linkingResult.systemHash.substring(0, 8)}...`
                : 'null'
              changes.push(`system_hash: ${oldHash} → ${newHash}`)
              changeTypes.set('system_hash', (changeTypes.get('system_hash') || 0) + 1)
            }
            if (request.parent_request_id !== linkingResult.parentRequestId) {
              changes.push(
                `parent_request_id: ${request.parent_request_id || 'null'} → ${linkingResult.parentRequestId || 'null'}`
              )
              changeTypes.set('parent_request_id', (changeTypes.get('parent_request_id') || 0) + 1)
            }
            if ((request.is_subtask || false) !== (linkingResult.isSubtask || false)) {
              changes.push(
                `is_subtask: ${request.is_subtask || false} → ${linkingResult.isSubtask || false}`
              )
              changeTypes.set('is_subtask', (changeTypes.get('is_subtask') || 0) + 1)
              if (linkingResult.isSubtask) {
                batchSubtasks++
              }
            }
            if (
              (request.parent_task_request_id || 'null') !==
              (linkingResult.parentTaskRequestId || 'null')
            ) {
              changes.push(
                `parent_task_request_id: ${request.parent_task_request_id || 'null'} → ${linkingResult.parentTaskRequestId || 'null'}`
              )
              changeTypes.set(
                'parent_task_request_id',
                (changeTypes.get('parent_task_request_id') || 0) + 1
              )
            }

            const needsUpdate = changes.length > 0

            if (needsUpdate) {
              // Log the changes
              console.log(`   [${request.request_id}] Changes:`)
              changes.forEach(change => console.log(`     - ${change}`))

              // Apply update immediately to ensure next requests can find this one as parent
              if (!this.dryRun) {
                await this.applySingleUpdate({
                  requestId: request.request_id,
                  conversationId: conversationId,
                  branchId: linkingResult.branchId,
                  parentMessageHash: linkingResult.parentMessageHash,
                  currentMessageHash: linkingResult.currentMessageHash,
                  systemHash: linkingResult.systemHash,
                  parentRequestId: linkingResult.parentRequestId,
                  isSubtask: linkingResult.isSubtask,
                  parentTaskRequestId: linkingResult.parentTaskRequestId || null,
                })
              }
              batchUpdates++
            }
          } catch (error) {
            console.error(`   ❌ Failed to process request ${request.request_id}:`, error)
          }
        }

        // Update overall counters
        totalProcessed += requests.length
        totalUpdates += batchUpdates
        totalSubtasksDetected += batchSubtasks

        // Accumulate overall change types
        for (const [type, count] of changeTypes) {
          overallChangeTypes.set(type, (overallChangeTypes.get(type) || 0) + count)
        }

        // Report batch completion
        const batchDuration = Date.now() - batchStartTime
        const currentMemory = formatMemoryUsage()
        const memoryDelta = Math.round((currentMemory.heapUsed - initialMemory) / 1024 / 1024)

        console.log(`[Batch ${batchNumber}] Complete:`)
        console.log(`   Processed: ${requests.length} requests`)
        console.log(`   Updates applied: ${batchUpdates}`)
        console.log(`   Subtasks detected: ${batchSubtasks}`)

        // Show change type breakdown if there were updates
        if (batchUpdates > 0 && changeTypes.size > 0) {
          console.log(`   Changes by type:`)
          const sortedTypes = Array.from(changeTypes.entries()).sort((a, b) => b[1] - a[1])
          for (const [type, count] of sortedTypes) {
            console.log(`     - ${type}: ${count}`)
          }
        }

        console.log(`   Memory: Heap ${currentMemory.heap} (Δ+${memoryDelta}MB from baseline)`)
        console.log(`   Duration: ${(batchDuration / 1000).toFixed(2)}s`)
        console.log(`Overall progress: ${totalProcessed} requests processed`)

        // Stop if we've hit the limit
        if (this.limit && totalProcessed >= this.limit) {
          break
        }
      }

      console.log('\n=== Final Summary ===')
      console.log(`Total batches processed: ${batchNumber}`)
      console.log(`Total requests processed: ${totalProcessed}`)
      console.log(`Total updates applied: ${this.dryRun ? 0 : totalUpdates}`)
      console.log(`Total subtasks detected: ${totalSubtasksDetected}`)

      // Show overall change type breakdown
      if (totalUpdates > 0 && overallChangeTypes.size > 0) {
        console.log(`\nOverall changes by type:`)
        const sortedTypes = Array.from(overallChangeTypes.entries()).sort((a, b) => b[1] - a[1])
        for (const [type, count] of sortedTypes) {
          const percentage = ((count / totalUpdates) * 100).toFixed(1)
          console.log(`  - ${type}: ${count} (${percentage}% of updates)`)
        }
      }

      const finalMemory = formatMemoryUsage()
      const totalMemoryDelta = Math.round((finalMemory.heapUsed - initialMemory) / 1024 / 1024)
      console.log(
        `\nFinal memory: Heap ${finalMemory.heap} (Δ+${totalMemoryDelta}MB from baseline)`
      )

      // Show final statistics
      await this.showFinalStats()
    } catch (error) {
      console.error('Rebuild failed:', error)
      throw error
    } finally {
      await this.storageAdapter.close()
    }
  }

  private async loadRequestsBatch(offset: number): Promise<DbRequest[]> {
    let query = `
      SELECT 
        r.request_id,
        r.train_id,
        r.timestamp,
        r.conversation_id,
        r.branch_id,
        r.current_message_hash,
        r.parent_message_hash,
        r.system_hash,
        r.parent_request_id,
        r.body,
        r.message_count,
        r.created_at,
        r.is_subtask,
        r.parent_task_request_id
      FROM api_requests r
      WHERE r.method = 'POST'
        AND r.request_type = 'inference'
    `

    const params: any[] = []

    // Apply request ID filter if specified
    if (this.requestIds && this.requestIds.length > 0) {
      query += ` AND r.request_id = ANY($${params.length + 1})`
      params.push(this.requestIds)
    } else {
      // Apply domain filter only if not filtering by request IDs
      if (this.trainIdFilter) {
        query += ` AND r.train_id = $${params.length + 1}`
        params.push(this.trainIdFilter)
      }
    }

    // Order and pagination
    query += ` ORDER BY r.timestamp, r.request_id`
    query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
    params.push(Math.min(BATCH_SIZE, this.limit ? this.limit - offset : BATCH_SIZE))
    params.push(offset)

    const result = await this.pool.query(query, params)
    return result.rows
  }

  private async applySingleUpdate(update: {
    requestId: string
    conversationId: string
    branchId: string
    parentMessageHash: string | null
    currentMessageHash: string
    systemHash: string | null
    parentRequestId: string | null
    isSubtask: boolean
    parentTaskRequestId: string | null
  }) {
    const query = `
      UPDATE api_requests
      SET 
        conversation_id = $2,
        branch_id = $3,
        parent_message_hash = $4,
        current_message_hash = $5,
        system_hash = $6,
        parent_request_id = $7,
        is_subtask = $8,
        parent_task_request_id = $9
      WHERE request_id = $1
    `

    await this.pool.query(query, [
      update.requestId,
      update.conversationId,
      update.branchId,
      update.parentMessageHash,
      update.currentMessageHash,
      update.systemHash,
      update.parentRequestId,
      update.isSubtask,
      update.parentTaskRequestId,
    ])
  }

  private async showFinalStats() {
    console.log('\n3. Final statistics:')

    const statsQuery = `
      SELECT 
        COUNT(DISTINCT conversation_id) as total_conversations,
        COUNT(DISTINCT CONCAT(conversation_id, ':', branch_id)) as total_branches,
        COUNT(*) as total_requests,
        COUNT(*) FILTER (WHERE branch_id != 'main') as branch_requests,
        COUNT(*) FILTER (WHERE parent_message_hash IS NOT NULL) as requests_with_parent,
        COUNT(*) FILTER (WHERE is_subtask = true) as subtask_requests
      FROM api_requests
      WHERE method = 'POST' 
        AND request_type = 'inference'
        AND conversation_id IS NOT NULL
    `

    const stats = await this.pool.query(statsQuery)
    const row = stats.rows[0]

    console.log(`   Total conversations: ${row.total_conversations}`)
    console.log(`   Total branches: ${row.total_branches}`)
    console.log(`   Total requests with conversations: ${row.total_requests}`)
    console.log(`   Requests on non-main branches: ${row.branch_requests}`)
    console.log(`   Requests with parent links: ${row.requests_with_parent}`)
    console.log(`   Subtask requests: ${row.subtask_requests}`)
  }

  async close() {
    await this.storageAdapter.close()
  }
}

// Show help information
function showHelp() {
  console.log(`
Usage: bun run scripts/db/rebuild-conversations.ts [options]

Rebuilds conversation and branch IDs for all requests by reprocessing them through
the same StorageAdapter pipeline used by the proxy. This script does NOT implement
any business logic - it simply fetches requests and processes them through the
standard conversation linking logic.

Options:
  --help              Show this help message
  --execute           Actually apply changes (default is dry run)
  --train-id <id>     Filter by specific train identifier (deprecated: --domain)
  --limit <number>    Limit number of requests to process
  --requests <ids>    Process specific request IDs (comma-separated)
  --debug             Enable debug logging and SQL query logging
  --yes               Skip confirmation prompt (auto-accept)

Examples:
  # Dry run on all requests (shows what would change)
  bun run scripts/db/rebuild-conversations.ts

  # Actually apply changes to all requests
  bun run scripts/db/rebuild-conversations.ts --execute --yes

  # Process specific train ID with debug output
  bun run scripts/db/rebuild-conversations.ts --train-id example --debug

  # Process specific requests
  bun run scripts/db/rebuild-conversations.ts --requests "id1,id2,id3" --execute

  # Limit processing to first 100 requests
  bun run scripts/db/rebuild-conversations.ts --limit 100 --execute

Note: This script uses the StorageAdapter to ensure consistency with the proxy's
conversation linking logic, including subtask detection and branch management.
  `)
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2)

  // Check for help flag first
  if (args.includes('--help') || args.includes('-h')) {
    showHelp()
    process.exit(0)
  }

  const flags = {
    dryRun: !args.includes('--execute'),
    trainId: null as string | null,
    limit: null as number | null,
    debug: args.includes('--debug'),
    yes: args.includes('--yes'),
    requests: null as string[] | null,
  }

  // Parse train-id flag (preferred)
  const trainIdIndex = args.indexOf('--train-id')
  if (trainIdIndex !== -1 && args[trainIdIndex + 1]) {
    flags.trainId = args[trainIdIndex + 1]
  }

  // Backward compatibility: parse legacy --domain flag
  const domainIndex = args.indexOf('--domain')
  if (!flags.trainId && domainIndex !== -1 && args[domainIndex + 1]) {
    console.warn('⚠️  --domain is deprecated. Please use --train-id instead.')
    flags.trainId = args[domainIndex + 1]
  }

  // Parse limit flag
  const limitIndex = args.indexOf('--limit')
  if (limitIndex !== -1 && args[limitIndex + 1]) {
    flags.limit = parseInt(args[limitIndex + 1], 10)
    if (isNaN(flags.limit) || flags.limit <= 0) {
      console.error('❌ Invalid limit value. Must be a positive number.')
      process.exit(1)
    }
  }

  // Parse requests flag (comma-separated list)
  const requestsIndex = args.indexOf('--requests')
  if (requestsIndex !== -1 && args[requestsIndex + 1]) {
    flags.requests = args[requestsIndex + 1]
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0)
    if (flags.requests.length === 0) {
      console.error('❌ No valid request IDs provided.')
      process.exit(1)
    }
  }

  return flags
}

// Main function
async function main() {
  console.log('===========================================')
  console.log('Conversation Rebuild Script (Final Version)')
  console.log('===========================================')
  console.log('This version properly handles historical timestamps')

  const flags = parseArgs()

  // Show warnings
  console.log('\n⚠️  WARNING: This will update existing records in the database')
  console.log('It is recommended to backup your database before proceeding')

  // Show current settings
  if (flags.dryRun) {
    console.log('\n🔍 DRY RUN MODE - No changes will be made')
  } else {
    console.log('\n✏️  EXECUTE MODE - Changes WILL be applied')
  }

  if (flags.requests) {
    console.log(`🎯 Processing specific requests: ${flags.requests.join(', ')}`)
  } else if (flags.trainId) {
    console.log(`🌐 Filtering by train ID: ${flags.trainId}`)
  }

  if (flags.limit) {
    console.log(`📊 Limiting to ${flags.limit} requests`)
  }

  if (flags.debug) {
    console.log('🐛 Debug mode enabled')
  }

  if (flags.yes) {
    console.log('✅ Auto-accepting warning prompt (--yes flag provided)')
  }

  // Show database info
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error('\n❌ DATABASE_URL environment variable is not set')
    process.exit(1)
  }

  // Parse database name from URL
  const dbName = dbUrl.split('/').pop()?.split('?')[0] || 'unknown'
  console.log(`🗄️  Database: ${dbName}`)

  // Confirm with user unless --yes flag is provided
  if (!flags.yes && !flags.dryRun) {
    console.log('\nDo you want to continue? (yes/no)')
    const answer = await new Promise<string>(resolve => {
      process.stdin.once('data', data => {
        resolve(data.toString().trim().toLowerCase())
      })
    })

    if (answer !== 'yes' && answer !== 'y') {
      console.log('❌ Operation cancelled')
      process.exit(0)
    }
  }

  // Create database pool
  const pool = createLoggingPool(dbUrl, { max: 10 })

  try {
    const rebuilder = new ConversationRebuilderFinal(
      pool,
      flags.dryRun,
      flags.trainId,
      flags.limit,
      flags.debug,
      flags.requests
    )
    await rebuilder.rebuild()
    console.log('\n✅ Rebuild completed successfully!')
  } catch (error) {
    console.error('\n❌ Rebuild failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
    // Ensure the process exits cleanly after pool is closed
    process.exit(0)
  }
}

// Run the script
main().catch(error => {
  console.error('Unexpected error:', error)
  process.exit(1)
})
