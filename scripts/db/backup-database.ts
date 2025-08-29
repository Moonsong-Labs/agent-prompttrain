#!/usr/bin/env bun
import { execSync } from 'child_process'
import { parseArgs } from 'util'

/**
 * Database backup script - creates a backup of the Agent Prompt Train database
 * Refactored version with improved structure and type safety
 *
 * Supports filtering by timestamp to backup complete conversations with recent activity
 * When using --since, backs up entire conversations (not just recent messages) to maintain
 * foreign key integrity with self-referential fields like parent_task_request_id
 */

// ============================================================================
// Type Definitions
// ============================================================================

interface BackupConfig {
  mode: 'database' | 'file'
  sourceDatabaseUrl: string
  sourceDatabaseName: string
  targetName: string
  sinceTimestamp?: string
}

interface ParsedArguments {
  file?: string
  name?: string
  since?: string
  help?: boolean
}

// ============================================================================
// Constants
// ============================================================================

const DATABASE_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const MAX_DATABASE_NAME_LENGTH = 63

const HELP_TEXT = `
Database Backup Script

Usage:
  bun run scripts/backup-database.ts              # Creates a new backup database with timestamp
  bun run scripts/backup-database.ts --name=mybackup  # Creates backup with custom name
  bun run scripts/backup-database.ts --file       # Exports to a .sql file with timestamp
  bun run scripts/backup-database.ts --file=backup.sql  # Exports to specific file
  bun run scripts/backup-database.ts --since="1 day"  # Backup only last day's data
  bun run scripts/backup-database.ts --since="2 hours" --file  # Export last 2 hours to file
  bun run scripts/backup-database.ts --help       # Show this help

Options:
  -n, --name <dbname>    Custom name for the backup database (default: includes timestamp)
  -f, --file [filename]  Export to file instead of creating a backup database
  -s, --since <time>     Backup complete conversations with activity after this time (e.g., '1 hour', '2 days', '2024-01-01')
                         Note: Backs up entire conversations to maintain foreign key integrity
  -h, --help            Show help information

Note: --name and --file options are mutually exclusive
`

// ============================================================================
// Utility Functions
// ============================================================================

function formatTimestamp(): string {
  const now = new Date()
  return now.toISOString().replace(/T/, '_').replace(/:/g, '-').replace(/\..+/, '')
}

function getDatabaseName(connectionString: string): string {
  const url = new URL(connectionString)
  return url.pathname.substring(1)
}

function validateDatabaseName(name: string): void {
  if (!DATABASE_NAME_REGEX.test(name)) {
    throw new Error(
      'Invalid database name. Database names must:\n' +
        '- Start with a letter or underscore\n' +
        '- Contain only letters, numbers, and underscores'
    )
  }

  if (name.length > MAX_DATABASE_NAME_LENGTH) {
    throw new Error(`Database name too long (max ${MAX_DATABASE_NAME_LENGTH} characters)`)
  }
}

function parseSinceParameter(since: string): string {
  // Support various formats:
  // - Relative: "1 hour", "2 days", "3 weeks", "1 month"
  // - Absolute: "2024-01-01", "2024-01-01 12:00:00"

  // Check if it's an absolute date
  const absoluteDateRegex = /^\d{4}-\d{2}-\d{2}(\s+\d{2}:\d{2}:\d{2})?$/
  if (absoluteDateRegex.test(since)) {
    return since
  }

  // Parse relative time
  const relativeRegex = /^(\d+)\s+(hour|day|week|month)s?$/i
  const match = since.match(relativeRegex)

  if (!match) {
    throw new Error(
      `Invalid --since format: "${since}". Use formats like "1 hour", "2 days", or "2024-01-01"`
    )
  }

  const [, amount, unit] = match
  const now = new Date()
  const num = parseInt(amount, 10)

  switch (unit.toLowerCase()) {
    case 'hour':
      now.setHours(now.getHours() - num)
      break
    case 'day':
      now.setDate(now.getDate() - num)
      break
    case 'week':
      now.setDate(now.getDate() - num * 7)
      break
    case 'month':
      now.setMonth(now.getMonth() - num)
      break
  }

  return now.toISOString()
}

// ============================================================================
// Argument Parsing
// ============================================================================

function parseArguments(): ParsedArguments {
  const { values } = parseArgs({
    args: Bun.argv,
    options: {
      file: {
        type: 'string',
        short: 'f',
      },
      name: {
        type: 'string',
        short: 'n',
      },
      since: {
        type: 'string',
        short: 's',
      },
      help: {
        type: 'boolean',
        short: 'h',
      },
    },
    strict: true,
    allowPositionals: true,
  })

  return values as ParsedArguments
}

function validateArguments(args: ParsedArguments): void {
  if (args.file !== undefined && args.name !== undefined) {
    throw new Error(
      '--file and --name options cannot be used together\n' +
        'Use --file to export to a file, or --name to create a backup database'
    )
  }
}

// ============================================================================
// Configuration
// ============================================================================

function createBackupConfig(args: ParsedArguments): BackupConfig {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required')
  }

  const sourceDatabaseName = getDatabaseName(databaseUrl)
  const timestamp = formatTimestamp()
  const sinceTimestamp = args.since ? parseSinceParameter(args.since) : undefined

  if (args.file !== undefined) {
    const targetName =
      typeof args.file === 'string' && args.file
        ? args.file
        : `claude_nexus_backup_${timestamp}.sql`

    return {
      mode: 'file',
      sourceDatabaseUrl: databaseUrl,
      sourceDatabaseName,
      targetName,
      sinceTimestamp,
    }
  } else {
    const targetName = args.name || `${sourceDatabaseName}_backup_${timestamp}`

    if (args.name) {
      validateDatabaseName(args.name)
    }

    return {
      mode: 'database',
      sourceDatabaseUrl: databaseUrl,
      sourceDatabaseName,
      targetName,
      sinceTimestamp,
    }
  }
}

// ============================================================================
// Database Operations
// ============================================================================

async function checkDatabaseExists(connectionUrl: string, databaseName: string): Promise<boolean> {
  const postgresUrl = new URL(connectionUrl)
  postgresUrl.pathname = '/postgres'

  try {
    const checkCommand = `psql "${postgresUrl.toString()}" -t -c "SELECT 1 FROM pg_database WHERE datname = '${databaseName}'" | grep -q 1`
    execSync(checkCommand, { stdio: 'pipe', shell: true })
    return true
  } catch {
    return false
  }
}

function createDatabase(connectionUrl: string, databaseName: string): void {
  const postgresUrl = new URL(connectionUrl)
  postgresUrl.pathname = '/postgres'

  const createCommand = `psql "${postgresUrl.toString()}" -c "CREATE DATABASE \\"${databaseName}\\""`
  execSync(createCommand, { stdio: 'inherit' })
}

function copyDatabaseContent(sourceUrl: string, targetDatabaseName: string): void {
  const targetUrl = new URL(sourceUrl)
  targetUrl.pathname = `/${targetDatabaseName}`

  const copyCommand = `pg_dump "${sourceUrl}" --verbose --no-owner --no-privileges | psql "${targetUrl.toString()}"`
  execSync(copyCommand, { stdio: 'inherit', shell: true })
}

// ============================================================================
// Backup Functions
// ============================================================================

async function performFileBackup(config: BackupConfig): Promise<void> {
  console.log(`Starting database backup to file: ${config.targetName}`)
  console.log(`Source database: ${config.sourceDatabaseName}`)
  if (config.sinceTimestamp) {
    console.log(`Filtering data since: ${config.sinceTimestamp}`)
  }

  if (config.sinceTimestamp) {
    // For filtered backups, we need to use a custom approach
    console.log(`\nNote: Creating filtered backup with data since ${config.sinceTimestamp}`)
    console.log(`This will only include table structure and filtered data.\n`)

    // First dump the schema only
    const schemaDumpCommand = [
      'pg_dump',
      `"${config.sourceDatabaseUrl}"`,
      '--verbose',
      '--schema-only',
      '--no-owner',
      '--no-privileges',
      '--if-exists',
      '--clean',
      `-f ${config.targetName}.schema`,
    ].join(' ')

    execSync(schemaDumpCommand, { stdio: 'inherit' })

    // First, get all conversation IDs that have activity since the given timestamp
    console.log(`Finding conversations with activity since ${config.sinceTimestamp}...`)
    const getConversationIdsCommand = `psql "${config.sourceDatabaseUrl}" -t -c "SELECT DISTINCT conversation_id FROM api_requests WHERE timestamp >= '${config.sinceTimestamp}'" > ${config.targetName}.conversations`
    execSync(getConversationIdsCommand, { stdio: 'inherit', shell: true })

    // Then use COPY commands to export all requests for those conversations
    // This ensures we maintain foreign key integrity by including complete conversations
    const dataDumpCommand = `psql "${config.sourceDatabaseUrl}" -c "\\copy (SELECT * FROM api_requests WHERE conversation_id IN (SELECT DISTINCT conversation_id FROM api_requests WHERE timestamp >= '${config.sinceTimestamp}')) TO '${config.targetName}.data' WITH (FORMAT csv, HEADER true)"`
    execSync(dataDumpCommand, { stdio: 'inherit', shell: true })

    // Clean up temporary file
    execSync(`rm -f ${config.targetName}.conversations`, { stdio: 'inherit', shell: true })

    // Combine schema and data
    const combineCommand = `cat ${config.targetName}.schema > ${config.targetName} && echo "\\\\copy api_requests FROM '${config.targetName}.data' WITH (FORMAT csv, HEADER true);" >> ${config.targetName} && rm ${config.targetName}.schema ${config.targetName}.data`
    execSync(combineCommand, { stdio: 'inherit', shell: true })

    console.log(`\n✅ Filtered database backup completed!`)
  } else {
    // Full backup
    const dumpCommand = [
      'pg_dump',
      `"${config.sourceDatabaseUrl}"`,
      '--verbose',
      '--no-owner',
      '--no-privileges',
      '--if-exists',
      '--clean',
      `-f ${config.targetName}`,
    ].join(' ')

    execSync(dumpCommand, { stdio: 'inherit' })
  }

  console.log(`✅ Database backup completed successfully!`)
  console.log(`📁 Backup file: ${config.targetName}`)

  // Get file size
  const stats = await Bun.file(config.targetName).size
  console.log(`📊 File size: ${(stats / 1024 / 1024).toFixed(2)} MB`)
}

async function performDatabaseBackup(config: BackupConfig): Promise<void> {
  console.log(`Starting database backup...`)
  console.log(`Source database: ${config.sourceDatabaseName}`)
  console.log(`Backup database: ${config.targetName}`)
  if (config.sinceTimestamp) {
    console.log(`Filtering data since: ${config.sinceTimestamp}`)
  }

  // Check if database already exists (only for custom names)
  if (config.targetName.includes('_backup_')) {
    // Auto-generated name, proceed without checking
  } else {
    const exists = await checkDatabaseExists(config.sourceDatabaseUrl, config.targetName)
    if (exists) {
      const postgresUrl = new URL(config.sourceDatabaseUrl)
      postgresUrl.pathname = '/postgres'

      throw new Error(
        `Database '${config.targetName}' already exists!\n` +
          'The backup will fail. Please choose a different name or delete the existing database.\n' +
          `To delete: psql "${postgresUrl.toString()}" -c "DROP DATABASE \\"${config.targetName}\\""`
      )
    }
  }

  console.log(`Creating backup database...`)
  createDatabase(config.sourceDatabaseUrl, config.targetName)

  console.log(`Copying database content...`)

  if (config.sinceTimestamp) {
    // For filtered backups, copy schema then filtered data
    console.log(`\nNote: Creating filtered backup with data since ${config.sinceTimestamp}`)

    const backupUrl = new URL(config.sourceDatabaseUrl)
    backupUrl.pathname = `/${config.targetName}`

    // First, dump and restore the schema only
    console.log(`Copying database schema...`)
    const schemaCommand = `pg_dump "${config.sourceDatabaseUrl}" --schema-only --verbose --no-owner --no-privileges | psql "${backupUrl.toString()}"`
    execSync(schemaCommand, { stdio: 'inherit', shell: true })

    // Then copy filtered data for each table that has a timestamp column
    console.log(`Copying filtered data...`)

    // First find all conversation IDs that have activity since the given timestamp
    console.log(`Finding conversations with activity since ${config.sinceTimestamp}...`)

    // Copy all api_requests for conversations that have any activity since the timestamp
    // This ensures we maintain foreign key integrity by including complete conversations
    const copyApiRequestsCommand = `psql "${config.sourceDatabaseUrl}" -c "\\copy (SELECT * FROM api_requests WHERE conversation_id IN (SELECT DISTINCT conversation_id FROM api_requests WHERE timestamp >= '${config.sinceTimestamp}')) TO STDOUT" | psql "${backupUrl.toString()}" -c "\\copy api_requests FROM STDIN"`
    execSync(copyApiRequestsCommand, { stdio: 'inherit', shell: true })

    // Copy streaming_chunks for all the backed up requests
    const copyStreamingChunksCommand = `psql "${config.sourceDatabaseUrl}" -c "\\copy (SELECT sc.* FROM streaming_chunks sc WHERE sc.request_id IN (SELECT request_id FROM api_requests WHERE conversation_id IN (SELECT DISTINCT conversation_id FROM api_requests WHERE timestamp >= '${config.sinceTimestamp}'))) TO STDOUT" | psql "${backupUrl.toString()}" -c "\\copy streaming_chunks FROM STDIN"`
    try {
      execSync(copyStreamingChunksCommand, { stdio: 'inherit', shell: true })
    } catch (e) {
      console.log(`Note: streaming_chunks table might not exist or be empty`)
    }
  } else {
    // Full backup
    copyDatabaseContent(config.sourceDatabaseUrl, config.targetName)
  }

  console.log(`✅ Database backup completed successfully!`)
  console.log(`🗄️  Backup database: ${config.targetName}`)

  // Show connection string for the backup
  const backupUrl = new URL(config.sourceDatabaseUrl)
  backupUrl.pathname = `/${config.targetName}`
  console.log(`🔗 Connection string: ${backupUrl.toString()}`)
}

// ============================================================================
// Main Function
// ============================================================================

async function main(): Promise<void> {
  try {
    // Parse arguments
    const args = parseArguments()

    // Show help if requested
    if (args.help) {
      console.log(HELP_TEXT)
      return
    }

    // Validate arguments
    validateArguments(args)

    // Create configuration
    const config = createBackupConfig(args)

    // Perform backup
    if (config.mode === 'file') {
      await performFileBackup(config)
    } else {
      await performDatabaseBackup(config)
    }
  } catch (error) {
    console.error('❌ Backup failed:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

// Run the script
main().catch(console.error)
