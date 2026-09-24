#!/usr/bin/env bun

/**
 * Backfill api_requests.last_message_summary and user_text_message_count (ADR-037).
 *
 * Dry-run by default: reads and reports, writes nothing. Pass --execute to write.
 * Walks newest rows first, only touches rows whose summary is still NULL (idempotent,
 * resumable, never overwrites rows the proxy already filled). Bodies are decompressed
 * server-side; only the last message and an integer cross the network.
 *
 * Usage:
 *   bun run db:backfill:last-message-summary [--days 90] [--batch-size 200] [--sleep-ms 250]
 *     [--max-batches N] [--before <ISO timestamp>] [--execute]
 */

import { Pool, type PoolClient } from 'pg'
import {
  summarizeLastMessage,
  userTextMessageCountSql,
} from '../../packages/shared/src/utils/message-summary.js'

export interface BackfillOptions {
  days: number
  batchSize: number
  sleepMs: number
  maxBatches?: number
  before?: string
  execute: boolean
}

export interface BackfillResult {
  batches: number
  scanned: number
  updated: number
  skipped: number
  resumeBefore?: string
}

function parseIntegerOption(
  name: string,
  raw: string | undefined,
  min: number,
  max: number
): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

export function parseBackfillArgs(argv: string[]): BackfillOptions {
  const options: BackfillOptions = {
    days: 90,
    batchSize: 200,
    sleepMs: 250,
    maxBatches: undefined,
    before: undefined,
    execute: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--days':
        options.days = parseIntegerOption('--days', argv[++i], 1, 3650)
        break
      case '--batch-size':
        options.batchSize = parseIntegerOption('--batch-size', argv[++i], 1, 1000)
        break
      case '--sleep-ms':
        options.sleepMs = parseIntegerOption('--sleep-ms', argv[++i], 0, 60000)
        break
      case '--max-batches':
        options.maxBatches = parseIntegerOption('--max-batches', argv[++i], 1, 1_000_000)
        break
      case '--before': {
        const value = argv[++i]
        if (!value || Number.isNaN(Date.parse(value))) {
          throw new Error('--before must be an ISO timestamp')
        }
        options.before = new Date(value).toISOString()
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

function maskHost(databaseUrl: string): string {
  const host = new URL(databaseUrl).hostname
  return host.length <= 12 ? host : `${host.slice(0, 6)}…${host.slice(-6)}`
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function configureSession(client: PoolClient, execute: boolean): Promise<void> {
  await client.query("SET statement_timeout = '120s'")
  await client.query("SET lock_timeout = '5s'")
  await client.query("SET application_name = 'backfill-last-message-summary'")

  if (execute) {
    const { rows } = await client.query('SHOW transaction_read_only')
    if (rows[0]?.transaction_read_only === 'on') {
      throw new Error('Refusing --execute: this session is read-only')
    }
  }
}

export async function runBackfill(
  pool: Pool,
  options: BackfillOptions,
  log: (line: string) => void = console.log
): Promise<BackfillResult> {
  const client = await pool.connect()
  const result: BackfillResult = { batches: 0, scanned: 0, updated: 0, skipped: 0 }
  let stopRequested = false
  const onSignal = () => {
    stopRequested = true
    log('Stop requested - finishing the current batch...')
  }
  process.once('SIGINT', onSignal)

  try {
    await configureSession(client, options.execute)

    const { rows: estimateRows } = await client.query(
      `SELECT count(*)::int AS count
       FROM api_requests
       WHERE timestamp >= now() - make_interval(days => $1)
         AND last_message_summary IS NULL
         AND ($2::timestamptz IS NULL OR timestamp <= $2::timestamptz)`,
      [options.days, options.before ?? null]
    )
    const estimate: number = estimateRows[0].count
    log(
      `${options.execute ? 'EXECUTE' : 'DRY RUN'}: ~${estimate} rows without a summary in the last ${options.days} days`
    )

    let cursor: { timestamp: Date; requestId: string } | undefined
    const startedAt = Date.now()

    while (
      !stopRequested &&
      (options.maxBatches === undefined || result.batches < options.maxBatches)
    ) {
      const params: unknown[] = [options.days, options.batchSize]
      let bound = ''
      if (cursor) {
        params.push(cursor.timestamp, cursor.requestId)
        bound = `AND (timestamp, request_id) < ($3::timestamptz, $4::uuid)`
      } else if (options.before) {
        params.push(options.before)
        bound = `AND timestamp <= $3::timestamptz`
      }

      const { rows } = await client.query(
        `SELECT request_id, timestamp,
                body -> 'messages' -> -1 AS last_message,
                ${userTextMessageCountSql('body')} AS user_text_message_count
         FROM api_requests
         WHERE timestamp >= now() - make_interval(days => $1)
           AND last_message_summary IS NULL
           ${bound}
         ORDER BY timestamp DESC, request_id DESC
         LIMIT $2`,
        params
      )

      if (rows.length === 0) {
        break
      }

      const ids: string[] = []
      const summaries: string[] = []
      const counts: Array<number | null> = []

      for (const row of rows) {
        const summary = summarizeLastMessage(row.last_message)
        if (!summary) {
          result.skipped++
          continue
        }
        ids.push(row.request_id)
        summaries.push(JSON.stringify(summary))
        counts.push(row.user_text_message_count)
      }

      if (options.execute && ids.length > 0) {
        const update = await client.query(
          `UPDATE api_requests AS a
           SET last_message_summary = v.summary::jsonb,
               user_text_message_count = v.user_text_count
           FROM unnest($1::uuid[], $2::text[], $3::int[]) AS v(request_id, summary, user_text_count)
           WHERE a.request_id = v.request_id
             AND a.last_message_summary IS NULL`,
          [ids, summaries, counts]
        )
        result.updated += update.rowCount ?? 0
      }

      const last = rows[rows.length - 1]
      cursor = { timestamp: last.timestamp, requestId: last.request_id }
      result.resumeBefore = new Date(last.timestamp).toISOString()
      result.batches++
      result.scanned += rows.length

      const elapsedSeconds = (Date.now() - startedAt) / 1000
      const rate = result.scanned / Math.max(elapsedSeconds, 0.001)
      const etaMinutes = Math.max(estimate - result.scanned, 0) / Math.max(rate, 0.001) / 60
      log(
        `batch ${result.batches}: scanned ${result.scanned}, ${options.execute ? `updated ${result.updated}` : 'would update ' + (result.scanned - result.skipped)}, skipped ${result.skipped}, ${rate.toFixed(1)} rows/s, ETA ${etaMinutes.toFixed(1)} min, resume --before ${result.resumeBefore}`
      )

      if (options.sleepMs > 0) {
        await sleep(options.sleepMs)
      }
    }

    log(`Done: ${JSON.stringify(result)}`)
    return result
  } finally {
    process.off('SIGINT', onSignal)
    client.release()
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is required')
    process.exit(1)
  }

  let options: BackfillOptions
  try {
    options = parseBackfillArgs(process.argv.slice(2))
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
    await runBackfill(pool, options)
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
