#!/usr/bin/env bun

/**
 * Backfill and reconcile conversation_summaries from api_requests (ADR-039).
 *
 * Dry-run by default: counts the (conversation, project) groups of each chunk and writes
 * nothing. Pass --execute to upsert them with the proxy's merge rules (earliest first activity,
 * latest last activity, union of accounts): safe while the proxy is writing and safe to re-run;
 * rows that would not change are not rewritten. Walks the whole history newest first, in chunks
 * of --chunk-days, or only the activity since --since.
 *
 * Usage:
 *   bun run db:backfill:conversation-summaries [--since <ISO timestamp>] [--chunk-days 7]
 *     [--execute]
 */

import { Pool, type PoolClient } from 'pg'
import { CONVERSATION_SUMMARY_MERGE_SQL } from '../../services/proxy/src/storage/conversation-summaries.js'

export interface SummariesBackfillOptions {
  since?: string
  chunkDays: number
  execute: boolean
}

export interface BackfillChunk {
  from: Date
  to: Date
}

export interface SummariesBackfillResult {
  chunks: number
  groups: number
  changed: number
}

const DAY_MS = 24 * 60 * 60 * 1000

export function parseSummariesBackfillArgs(argv: string[]): SummariesBackfillOptions {
  const options: SummariesBackfillOptions = { since: undefined, chunkDays: 7, execute: false }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--since': {
        const value = argv[++i]
        if (!value || Number.isNaN(Date.parse(value))) {
          throw new Error('--since must be an ISO timestamp')
        }
        options.since = new Date(value).toISOString()
        break
      }
      case '--chunk-days': {
        const value = Number(argv[++i])
        if (!Number.isInteger(value) || value < 1 || value > 366) {
          throw new Error('--chunk-days must be an integer between 1 and 366')
        }
        options.chunkDays = value
        break
      }
      case '--execute':
        options.execute = true
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  return options
}

/** Contiguous [from, to) chunks of at most chunkDays covering [start, end), newest first */
export function planBackfillChunks(start: Date, end: Date, chunkDays: number): BackfillChunk[] {
  const chunks: BackfillChunk[] = []
  const step = chunkDays * DAY_MS
  for (let to = end.getTime(); to > start.getTime(); to -= step) {
    chunks.push({ from: new Date(Math.max(to - step, start.getTime())), to: new Date(to) })
  }
  return chunks
}

/**
 * Shared SELECT/GROUP BY grouping api_requests exactly as conversation_summaries stores them.
 * The caller supplies the WHERE clause that selects which requests to group.
 */
const GROUP_SELECT_SQL = `
  SELECT conversation_id, project_id,
         MIN(timestamp) AS first_activity_at,
         MAX(timestamp) AS last_activity_at,
         COALESCE(ARRAY_AGG(DISTINCT account_id) FILTER (WHERE account_id IS NOT NULL), '{}')
           AS account_ids
  FROM api_requests`
const GROUP_BY_SQL = `GROUP BY conversation_id, project_id`

/** One chunk of api_requests grouped as the table stores it; $1/$2 bound [from, to) */
const CHUNK_GROUPS_SQL = `${GROUP_SELECT_SQL}
  WHERE conversation_id IS NOT NULL
    AND timestamp >= $1
    AND timestamp < $2
  ${GROUP_BY_SQL}`

const COUNT_CHUNK_SQL = `SELECT COUNT(*)::int AS groups FROM (${CHUNK_GROUPS_SQL}) chunk_groups`

const UPSERT_CHUNK_SQL = `
  WITH grouped AS (${CHUNK_GROUPS_SQL}),
  upserted AS (
    INSERT INTO conversation_summaries AS cs
      (conversation_id, project_id, first_activity_at, last_activity_at, account_ids)
    SELECT conversation_id, project_id, first_activity_at, last_activity_at, account_ids
    FROM grouped
    ${CONVERSATION_SUMMARY_MERGE_SQL}
    RETURNING 1
  )
  SELECT (SELECT COUNT(*) FROM grouped)::int AS groups,
         (SELECT COUNT(*) FROM upserted)::int AS changed`

/** The given conversations grouped as the table stores them; $1 is the conversation id array */
const REFRESH_GROUPS_SQL = `${GROUP_SELECT_SQL}
  WHERE conversation_id = ANY($1::uuid[])
  ${GROUP_BY_SQL}`

const REFRESH_DELETE_SQL = `DELETE FROM conversation_summaries WHERE conversation_id = ANY($1::uuid[])`

const REFRESH_INSERT_SQL = `
  WITH grouped AS (${REFRESH_GROUPS_SQL})
  INSERT INTO conversation_summaries AS cs
    (conversation_id, project_id, first_activity_at, last_activity_at, account_ids)
  SELECT conversation_id, project_id, first_activity_at, last_activity_at, account_ids
  FROM grouped
  ${CONVERSATION_SUMMARY_MERGE_SQL}`

const REFRESH_BATCH_SIZE = 1000

async function summaryTableExists(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = 'conversation_summaries'`
  )
  return rows.length > 0
}

export interface SummariesRefreshResult {
  conversations: number // distinct IDs given
  deleted: number // summary rows removed
  inserted: number // summary rows written back
}

/**
 * Rebuild the conversation_summaries rows of the given conversations exactly from api_requests,
 * removing rows whose requests were re-keyed or deleted outside the proxy (ADR-039). Safe while
 * the proxy writes: a live upsert of a refreshed conversation waits for the batch and merges.
 */
export async function refreshConversationSummaries(
  pool: Pool,
  conversationIds: string[],
  log: (line: string) => void = console.log
): Promise<SummariesRefreshResult> {
  const zero: SummariesRefreshResult = { conversations: 0, deleted: 0, inserted: 0 }
  const uniqueIds = [...new Set(conversationIds)]
  if (uniqueIds.length === 0) {
    return zero
  }

  const client = await pool.connect()
  try {
    if (!(await summaryTableExists(client))) {
      log('conversation_summaries does not exist: nothing to refresh')
      return zero
    }

    const result: SummariesRefreshResult = {
      conversations: uniqueIds.length,
      deleted: 0,
      inserted: 0,
    }
    const batchCount = Math.ceil(uniqueIds.length / REFRESH_BATCH_SIZE)

    for (let i = 0; i < uniqueIds.length; i += REFRESH_BATCH_SIZE) {
      const batch = uniqueIds.slice(i, i + REFRESH_BATCH_SIZE)
      try {
        await client.query('BEGIN')
        await client.query("SET LOCAL statement_timeout = '120s'")
        await client.query("SET LOCAL lock_timeout = '5s'")
        const deleted = await client.query(REFRESH_DELETE_SQL, [batch])
        const inserted = await client.query(REFRESH_INSERT_SQL, [batch])
        await client.query('COMMIT')
        result.deleted += deleted.rowCount ?? 0
        result.inserted += inserted.rowCount ?? 0
        log(
          `refresh batch ${i / REFRESH_BATCH_SIZE + 1}/${batchCount}: ${deleted.rowCount ?? 0} deleted, ${inserted.rowCount ?? 0} inserted`
        )
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }

    return result
  } finally {
    client.release(true)
  }
}

function maskHost(databaseUrl: string): string {
  const host = new URL(databaseUrl).hostname
  return host.length <= 12 ? host : `${host.slice(0, 6)}…${host.slice(-6)}`
}

async function configureSession(client: PoolClient, execute: boolean): Promise<void> {
  await client.query("SET statement_timeout = '120s'")
  await client.query("SET lock_timeout = '5s'")
  await client.query("SET application_name = 'backfill-conversation-summaries'")

  if (execute) {
    const { rows } = await client.query('SHOW transaction_read_only')
    if (rows[0]?.transaction_read_only === 'on') {
      throw new Error('Refusing --execute: this session is read-only')
    }
  }
}

export async function backfillConversationSummaries(
  pool: Pool,
  options: SummariesBackfillOptions,
  log: (line: string) => void = console.log
): Promise<SummariesBackfillResult> {
  const client = await pool.connect()
  const result: SummariesBackfillResult = { chunks: 0, groups: 0, changed: 0 }

  try {
    await configureSession(client, options.execute)

    const { rows } = await client.query(
      `SELECT MIN(timestamp) AS history_start, MAX(timestamp) AS history_end
       FROM api_requests
       WHERE conversation_id IS NOT NULL`
    )
    const historyStart: Date | null = rows[0]?.history_start ?? null
    const historyEnd: Date | null = rows[0]?.history_end ?? null
    if (!historyStart || !historyEnd) {
      log('No requests with a conversation: nothing to backfill')
      return result
    }

    const since = options.since ? new Date(options.since).getTime() : historyStart.getTime()
    const start = new Date(Math.max(since, historyStart.getTime()))
    // Up to the newest request stored now; later ones are upserted by the proxy itself
    const end = new Date(historyEnd.getTime() + 1)
    const chunks = planBackfillChunks(start, end, options.chunkDays)
    log(
      `${options.execute ? 'EXECUTE' : 'DRY RUN'}: ${chunks.length} chunks of up to ${options.chunkDays} days from ${start.toISOString()} to ${end.toISOString()}, newest first`
    )

    for (const chunk of chunks) {
      const range = `[${chunk.from.toISOString()}, ${chunk.to.toISOString()})`
      if (options.execute) {
        const { rows: upserted } = await client.query(UPSERT_CHUNK_SQL, [chunk.from, chunk.to])
        result.groups += upserted[0].groups
        result.changed += upserted[0].changed
        log(
          `chunk ${result.chunks + 1}/${chunks.length} ${range}: ${upserted[0].groups} groups, ${upserted[0].changed} inserted or changed`
        )
      } else {
        const { rows: counted } = await client.query(COUNT_CHUNK_SQL, [chunk.from, chunk.to])
        result.groups += counted[0].groups
        log(`chunk ${result.chunks + 1}/${chunks.length} ${range}: ${counted[0].groups} groups`)
      }
      result.chunks++
    }

    log(`Done: ${JSON.stringify(result)}`)
    return result
  } finally {
    // configureSession set statement_timeout/lock_timeout/application_name at session level:
    // never hand that connection back to the caller's pool (M3)
    client.release(true)
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is required')
    process.exit(1)
  }

  let options: SummariesBackfillOptions
  try {
    options = parseSummariesBackfillArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`)
    process.exit(1)
  }

  console.log(`Target database host: ${maskHost(databaseUrl)}`)
  if (!options.execute) {
    console.log('Dry run - no rows will be written. Re-run with --execute to write.')
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  try {
    await backfillConversationSummaries(pool, options)
  } catch (error) {
    console.error('❌ Backfill failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

// Run if executed directly
if (import.meta.main) {
  main()
}
