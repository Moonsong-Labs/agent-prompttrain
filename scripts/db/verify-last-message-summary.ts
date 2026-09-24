#!/usr/bin/env bun

/**
 * Read-only parity check for ADR-037 summaries against a real database.
 * Samples recent requests and verifies that the dashboard derives the same node
 * classification and timeline preview from the summary as from the full last message,
 * that PostgreSQL accepts every computed summary as JSONB, and that the SQL user-text
 * count matches the JS count.
 *
 * Usage: bun scripts/db/verify-last-message-summary.ts [--sample 2000] [--count-sample 50]
 */

import { Pool, type PoolClient } from 'pg'
import {
  countUserTextMessages,
  summarizeLastMessage,
  userTextMessageCountSql,
} from '../../packages/shared/src/utils/message-summary.js'
import {
  classifyLastMessage,
  getLastMessageContent,
} from '../../services/dashboard/src/utils/last-message.js'

function readOption(name: string, fallback: number): number {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return fallback
  }
  const value = Number(process.argv[index + 1])
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

/** Ids whose summary PostgreSQL rejects as JSONB (JS JSON.parse accepts more, e.g. lone surrogates). */
async function findJsonbRejects(
  client: PoolClient,
  summaries: Array<{ requestId: string; json: string }>
): Promise<string[]> {
  const isDataException = (error: unknown) =>
    String((error as { code?: unknown } | null)?.code ?? '').startsWith('22')
  try {
    await client.query('SELECT cardinality($1::text[]::jsonb[])', [summaries.map(s => s.json)])
    return []
  } catch (error) {
    if (!isDataException(error)) {
      throw error
    }
  }

  // The batch was rejected: cast one by one to name the offending rows
  const rejected: string[] = []
  for (const summary of summaries) {
    try {
      await client.query('SELECT $1::jsonb', [summary.json])
    } catch (error) {
      if (!isDataException(error)) {
        throw error
      }
      rejected.push(summary.requestId)
    }
  }
  return rejected
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const sample = readOption('--sample', 2000)
  const countSample = readOption('--count-sample', 50)
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  const client = await pool.connect()
  const mismatches: string[] = []

  try {
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
    await client.query("SET statement_timeout = '60s'")

    // Parity of derived fields, in batches of 100 newest-first
    let checked = 0
    let cursor: { timestamp: Date; requestId: string } | undefined
    while (checked < sample) {
      const params: unknown[] = [Math.min(100, sample - checked)]
      const bound = cursor ? 'AND (timestamp, request_id) < ($2::timestamptz, $3::uuid)' : ''
      if (cursor) {
        params.push(cursor.timestamp, cursor.requestId)
      }
      const { rows } = await client.query(
        `SELECT request_id, timestamp, body -> 'messages' -> -1 AS last_message
         FROM api_requests
         WHERE timestamp >= now() - interval '7 days' ${bound}
         ORDER BY timestamp DESC, request_id DESC
         LIMIT $1`,
        params
      )
      if (rows.length === 0) {
        break
      }
      const computed: Array<{ requestId: string; json: string }> = []
      for (const row of rows) {
        if (!row.last_message) {
          continue
        }
        const json = JSON.stringify(summarizeLastMessage(row.last_message))
        computed.push({ requestId: row.request_id, json })
        const summary = JSON.parse(json)
        const sameClass =
          JSON.stringify(classifyLastMessage(summary)) ===
          JSON.stringify(classifyLastMessage(row.last_message))
        const samePreview =
          getLastMessageContent({ request_id: row.request_id, last_message: summary } as any) ===
          getLastMessageContent({
            request_id: row.request_id,
            last_message: row.last_message,
          } as any)
        if (!sameClass || !samePreview) {
          mismatches.push(`derived:${row.request_id}`)
        }
        checked++
      }
      if (computed.length > 0) {
        for (const requestId of await findJsonbRejects(client, computed)) {
          mismatches.push(`jsonb:${requestId}`)
        }
      }
      const last = rows[rows.length - 1]
      cursor = { timestamp: last.timestamp, requestId: last.request_id }
    }
    console.log(`Derived-field parity: ${checked} rows checked`)

    // SQL vs JS user-text count on smaller bodies (full message arrays cross the network)
    const { rows: countRows } = await client.query(
      `SELECT request_id, body -> 'messages' AS messages, ${userTextMessageCountSql('body')} AS sql_count
       FROM api_requests
       WHERE timestamp >= now() - interval '7 days' AND pg_column_size(body) < 1000000
       ORDER BY timestamp DESC
       LIMIT $1`,
      [countSample]
    )
    for (const row of countRows) {
      if (row.sql_count !== countUserTextMessages(row.messages)) {
        mismatches.push(`count:${row.request_id}`)
      }
    }
    console.log(`Count parity: ${countRows.length} rows checked`)
  } finally {
    client.release()
    await pool.end()
  }

  if (mismatches.length > 0) {
    console.error(
      `❌ ${mismatches.length} mismatches (first 5): ${mismatches.slice(0, 5).join(', ')}`
    )
    process.exit(1)
  }
  console.log('✅ All sampled rows match')
}

if (import.meta.main) {
  main()
}
