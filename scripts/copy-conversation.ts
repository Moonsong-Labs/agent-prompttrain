#!/usr/bin/env bun
/**
 * Copy Conversation Script - Refactored Version
 *
 * This script copies all requests of a given conversation between databases.
 * Refactored for better organization, type safety, and maintainability.
 */

import { parseArgs } from 'util'
import pg from 'pg'

const { Client } = pg

// ============================================================================
// Type Definitions
// ============================================================================

interface Config {
  conversationId: string
  sourceTable: string
  destTable: string
  destDbUrl: string
  dryRun: boolean
  includeChunks: boolean
  verbose: boolean
}

interface ApiRequest {
  request_id: string
  conversation_id: string
  timestamp: Date
  model?: string
  projectId?: string
  [key: string]: any
}

interface DatabaseClients {
  source: pg.Client
  destination: pg.Client
}

interface TableAnalysis {
  sourceColumns: string[]
  destColumns: string[]
  commonColumns: string[]
  missingColumns: string[]
}

// ============================================================================
// Constants
// ============================================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ERROR_CODES = {
  UNDEFINED_TABLE: '42P01',
  UNDEFINED_COLUMN: '42703',
} as const

const QUERIES = {
  TABLE_EXISTS: `
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = $1
    );
  `,

  GET_COLUMNS: `
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = $1
    ORDER BY ordinal_position;
  `,

  GET_STREAMING_CHUNKS: `
    SELECT request_id, chunk_index, timestamp, data, token_count, created_at
    FROM streaming_chunks
    WHERE request_id = ANY($1)
    ORDER BY request_id, chunk_index;
  `,

  INSERT_STREAMING_CHUNK: `
    INSERT INTO streaming_chunks (request_id, chunk_index, timestamp, data, token_count, created_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (request_id, chunk_index) DO NOTHING;
  `,
} as const

const HELP_TEXT = `Copy Conversation Script

This script copies all requests of a given conversation between databases.

Usage:
  bun run scripts/copy-conversation.ts --conversation-id <uuid> --dest-db <url> [options]

Options:
  --conversation-id <uuid>  Required. The conversation ID to copy
  --dest-db <url>           Required. Destination database URL
  --source-table <name>     Source table name (default: api_requests)
  --dest-table <name>       Destination table name (default: api_requests)
  --dry-run                 Show what would be copied without executing
  --include-chunks          Also copy related streaming_chunks data
  --verbose                 Enable verbose logging
  --help                    Show this help message

Environment:
  DATABASE_URL              Source database connection (from environment)

Examples:
  # Copy to staging database (same table names)
  bun run scripts/copy-conversation.ts --conversation-id 123e4567-e89b-12d3-a456-426614174000 \\
    --dest-db "postgresql://user:pass@staging-host:5432/staging_db"

  # Copy between different table names
  bun run scripts/copy-conversation.ts --conversation-id 123e4567-e89b-12d3-a456-426614174000 \\
    --dest-db "postgresql://user:pass@staging-host:5432/staging_db" \\
    --source-table api_requests --dest-table api_requests_backup

  # Dry run to see what would be copied
  bun run scripts/copy-conversation.ts --conversation-id 123e4567-e89b-12d3-a456-426614174000 \\
    --dest-db "postgresql://user:pass@staging-host:5432/staging_db" --dry-run

  # Copy with streaming chunks
  bun run scripts/copy-conversation.ts --conversation-id 123e4567-e89b-12d3-a456-426614174000 \\
    --dest-db "postgresql://user:pass@staging-host:5432/staging_db" --include-chunks
`

// ============================================================================
// CLI Handling
// ============================================================================

function parseCliArguments(): Config | null {
  const { values } = parseArgs({
    args: Bun.argv,
    options: {
      'conversation-id': { type: 'string' },
      'dest-db': { type: 'string' },
      'source-table': { type: 'string', default: 'api_requests' },
      'dest-table': { type: 'string', default: 'api_requests' },
      'dry-run': { type: 'boolean', default: false },
      'include-chunks': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: true,
  })

  if (values['help']) {
    console.log(HELP_TEXT)
    return null
  }

  const errors: string[] = []

  if (!values['conversation-id']) {
    errors.push('Error: --conversation-id is required')
  } else if (!UUID_REGEX.test(values['conversation-id'])) {
    errors.push('Error: Invalid conversation ID format. Must be a valid UUID.')
  }

  if (!values['dest-db']) {
    errors.push('Error: --dest-db is required')
  }

  if (errors.length > 0) {
    errors.forEach(error => console.error(error))
    console.error(
      'Usage: bun run scripts/copy-conversation.ts --conversation-id <uuid> --dest-db <url> [options]'
    )
    console.error('Run with --help for more information')
    process.exit(1)
  }

  return {
    conversationId: values['conversation-id']!,
    sourceTable: values['source-table']!,
    destTable: values['dest-table']!,
    destDbUrl: values['dest-db']!,
    dryRun: values['dry-run']!,
    includeChunks: values['include-chunks']!,
    verbose: values['verbose']!,
  }
}

// ============================================================================
// Environment Validation
// ============================================================================

function validateEnvironment(): string {
  const sourceDbUrl = process.env.DATABASE_URL
  if (!sourceDbUrl) {
    console.error('Error: DATABASE_URL environment variable is not set')
    process.exit(1)
  }
  return sourceDbUrl
}

// ============================================================================
// Database Operations
// ============================================================================

async function createDatabaseClients(sourceUrl: string, destUrl: string): Promise<DatabaseClients> {
  return {
    source: new Client({ connectionString: sourceUrl }),
    destination: new Client({ connectionString: destUrl }),
  }
}

async function connectDatabases(clients: DatabaseClients): Promise<void> {
  await clients.source.connect()
  console.log('Connected to source database')

  await clients.destination.connect()
  console.log('Connected to destination database')
}

async function startTransactions(clients: DatabaseClients): Promise<void> {
  await clients.source.query('BEGIN')
  await clients.destination.query('BEGIN')
}

async function commitTransactions(clients: DatabaseClients): Promise<void> {
  await clients.source.query('COMMIT')
  await clients.destination.query('COMMIT')
}

async function rollbackTransactions(clients: DatabaseClients): Promise<void> {
  try {
    await clients.source.query('ROLLBACK')
    await clients.destination.query('ROLLBACK')
  } catch (rollbackError) {
    console.error('Error during rollback:', rollbackError)
  }
}

async function closeDatabaseConnections(clients: DatabaseClients): Promise<void> {
  await clients.source.end()
  await clients.destination.end()
}

async function tableExists(client: pg.Client, tableName: string): Promise<boolean> {
  const result = await client.query(QUERIES.TABLE_EXISTS, [tableName])
  return result.rows[0].exists
}

async function getTableColumns(client: pg.Client, tableName: string): Promise<string[]> {
  const result = await client.query(QUERIES.GET_COLUMNS, [tableName])
  return result.rows.map(row => row.column_name)
}

// ============================================================================
// Validation Functions
// ============================================================================

async function validateTables(clients: DatabaseClients, config: Config): Promise<void> {
  console.log(`\nChecking tables...`)

  const sourceExists = await tableExists(clients.source, config.sourceTable)
  const destExists = await tableExists(clients.destination, config.destTable)

  if (!sourceExists) {
    throw new Error(`Source table "${config.sourceTable}" does not exist in source database`)
  }

  if (!destExists) {
    throw new Error(
      `Destination table "${config.destTable}" does not exist in destination database`
    )
  }

  console.log('✓ Both tables exist')
}

async function analyzeTableStructures(
  clients: DatabaseClients,
  config: Config
): Promise<TableAnalysis> {
  console.log(`\nAnalyzing table structures...`)

  const sourceColumns = await getTableColumns(clients.source, config.sourceTable)
  const destColumns = await getTableColumns(clients.destination, config.destTable)

  const commonColumns = sourceColumns.filter(col => destColumns.includes(col))
  const missingColumns = sourceColumns.filter(col => !destColumns.includes(col))

  console.log(`✓ Source table has ${sourceColumns.length} columns`)
  console.log(`✓ Destination table has ${destColumns.length} columns`)
  console.log(`✓ ${commonColumns.length} columns will be copied`)

  if (missingColumns.length > 0) {
    console.warn(
      `⚠ Warning: ${missingColumns.length} columns exist in source but not in destination:`
    )
    console.warn(`  ${missingColumns.join(', ')}`)
  }

  return { sourceColumns, destColumns, commonColumns, missingColumns }
}

// ============================================================================
// Data Operations
// ============================================================================

async function getConversationRequests(client: pg.Client, config: Config): Promise<ApiRequest[]> {
  const query = `
    SELECT * FROM ${config.sourceTable}
    WHERE conversation_id = $1
    ORDER BY timestamp ASC;
  `

  try {
    const result = await client.query(query, [config.conversationId])
    return result.rows
  } catch (error: any) {
    if (error.code === ERROR_CODES.UNDEFINED_TABLE) {
      throw new Error(`Table "${config.sourceTable}" does not exist in source database`)
    }
    if (error.code === ERROR_CODES.UNDEFINED_COLUMN) {
      throw new Error(`Column "conversation_id" does not exist in table "${config.sourceTable}"`)
    }
    throw error
  }
}

async function copyRequests(
  destClient: pg.Client,
  requests: ApiRequest[],
  commonColumns: string[],
  config: Config
): Promise<number> {
  if (requests.length === 0) {
    return 0
  }

  const columnsList = commonColumns.join(', ')
  const placeholders = commonColumns.map((_, index) => `$${index + 1}`).join(', ')

  const insertQuery = `
    INSERT INTO ${config.destTable} (${columnsList})
    VALUES (${placeholders})
    ON CONFLICT (request_id) DO NOTHING;
  `

  let copiedCount = 0

  for (const request of requests) {
    const values = commonColumns.map(col => request[col])

    if (config.verbose) {
      console.log(`Copying request ${request.request_id}...`)
    }

    if (!config.dryRun) {
      try {
        const result = await destClient.query(insertQuery, values)
        if (result.rowCount && result.rowCount > 0) {
          copiedCount++
        }
      } catch (error: any) {
        console.error(`Error copying request ${request.request_id}:`, error.message)
        throw error
      }
    } else {
      copiedCount++
    }
  }

  return copiedCount
}

async function copyStreamingChunks(
  clients: DatabaseClients,
  requestIds: string[],
  config: Config
): Promise<number> {
  if (requestIds.length === 0 || !config.includeChunks) {
    return 0
  }

  const chunks = await clients.source.query(QUERIES.GET_STREAMING_CHUNKS, [requestIds])

  if (chunks.rows.length === 0) {
    return 0
  }

  let copiedCount = 0

  if (!config.dryRun) {
    for (const chunk of chunks.rows) {
      try {
        const result = await clients.destination.query(QUERIES.INSERT_STREAMING_CHUNK, [
          chunk.request_id,
          chunk.chunk_index,
          chunk.timestamp,
          chunk.data,
          chunk.token_count,
          chunk.created_at,
        ])
        if (result.rowCount && result.rowCount > 0) {
          copiedCount++
        }
      } catch (error: any) {
        console.error(
          `Error copying chunk ${chunk.request_id}[${chunk.chunk_index}]:`,
          error.message
        )
        throw error
      }
    }
  } else {
    copiedCount = chunks.rows.length
  }

  return copiedCount
}

// ============================================================================
// Execution Functions
// ============================================================================

async function executeInDryRunMode(
  clients: DatabaseClients,
  requests: ApiRequest[],
  config: Config
): Promise<void> {
  console.log('\n=== DRY RUN MODE ===')
  console.log('The following operations would be performed:')
  console.log(
    `- Copy ${requests.length} requests from ${config.sourceTable} to ${config.destTable}`
  )

  if (config.includeChunks) {
    const requestIds = requests.map(r => r.request_id)
    const chunksCount = await copyStreamingChunks(clients, requestIds, config)
    console.log(`- Copy ${chunksCount} streaming chunks`)
  }

  console.log('\nSample request data:')
  const sample = requests[0]
  console.log(`  Request ID: ${sample.request_id}`)
  console.log(`  Timestamp: ${sample.timestamp}`)
  console.log(`  Model: ${sample.model || 'N/A'}`)
  console.log(`  Project ID: ${sample.projectId || 'N/A'}`)
}

async function executeCopy(
  clients: DatabaseClients,
  requests: ApiRequest[],
  commonColumns: string[],
  config: Config
): Promise<void> {
  console.log(`\nCopying requests...`)
  const copiedCount = await copyRequests(clients.destination, requests, commonColumns, config)
  console.log(`✓ Copied ${copiedCount} requests`)

  if (config.includeChunks) {
    console.log(`\nCopying streaming chunks...`)
    const requestIds = requests.map(r => r.request_id)
    const chunksCount = await copyStreamingChunks(clients, requestIds, config)
    console.log(`✓ Copied ${chunksCount} streaming chunks`)
  }
}

// ============================================================================
// Main Function (Refactored)
// ============================================================================

async function main() {
  // Parse CLI arguments
  const config = parseCliArguments()
  if (!config) {
    return // Help was shown
  }

  // Validate environment
  const sourceDbUrl = validateEnvironment()

  // Create database clients
  const clients = await createDatabaseClients(sourceDbUrl, config.destDbUrl)

  try {
    // Establish connections
    await connectDatabases(clients)

    // Start transactions
    await startTransactions(clients)

    // Validate tables exist
    await validateTables(clients, config)

    // Analyze table structures
    const { commonColumns } = await analyzeTableStructures(clients, config)

    // Fetch conversation data
    console.log(`\nFetching conversation ${config.conversationId}...`)
    const requests = await getConversationRequests(clients.source, config)

    if (requests.length === 0) {
      console.log('No requests found for this conversation ID')
      await rollbackTransactions(clients)
      return
    }

    console.log(`✓ Found ${requests.length} requests to copy`)

    // Execute copy operation
    if (config.dryRun) {
      await executeInDryRunMode(clients, requests, config)
    } else {
      await executeCopy(clients, requests, commonColumns, config)
    }

    // Finalize transaction
    if (!config.dryRun) {
      await commitTransactions(clients)
      console.log('\n✓ Transactions committed successfully')
    } else {
      await rollbackTransactions(clients)
      console.log('\n✓ Dry run completed (no changes made)')
    }
  } catch (error) {
    console.error('\nError:', error)
    await rollbackTransactions(clients)
    process.exit(1)
  } finally {
    await closeDatabaseConnections(clients)
  }
}

// Run the script
main().catch(console.error)
