#!/usr/bin/env bun

/**
 * Read-only parity check for conversation_summaries (ADR-039) against a real database.
 *
 * In one REPEATABLE READ snapshot of a session it makes read-only, checks that
 * - every (conversation_id, project_id) group of api_requests has a summary row with the same
 *   first and last activity and accounts, and that no summary row lacks requests;
 * - pages 1-3 and the total served from the table equal the request-level listing for anonymous
 *   callers, sampled principals, the busiest project and the busiest account.
 * Conversations with a request stored within --settle-seconds before the snapshot are skipped:
 * their upsert may still be in flight. Prints conversation ids and counts only; exits 1 on any
 * mismatch.
 *
 * Usage: bun scripts/db/verify-conversation-summaries.ts [--principals 3] [--page-size 50]
 *   [--settle-seconds 60]
 */

import { Pool } from 'pg'
import {
  listConversations,
  type ConversationListPool,
} from '../../services/proxy/src/services/conversation-list.js'

export interface VerifyOptions {
  principals: number
  pageSize: number
  settleSeconds: number
}

interface VerifyCase {
  label: string
  principal?: string
  projectId?: string
  accountId?: string
}

/** Pages compared per case */
const PAGES = 3

function parseIntegerOption(
  name: string,
  raw: string | undefined,
  min: number,
  max: number
): number {
  const value = Number(raw)
  if (raw === undefined || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

export function parseVerifyArgs(argv: string[]): VerifyOptions {
  const options: VerifyOptions = { principals: 3, pageSize: 50, settleSeconds: 60 }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--principals':
        options.principals = parseIntegerOption('--principals', argv[++i], 0, 100)
        break
      case '--page-size':
        options.pageSize = parseIntegerOption('--page-size', argv[++i], 1, 500)
        break
      case '--settle-seconds':
        options.settleSeconds = parseIntegerOption('--settle-seconds', argv[++i], 0, 3600)
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  return options
}

/** Groups whose summary row is missing, stale (no requests) or different; $1 snapshot, $2 settle seconds */
const GROUP_MISMATCHES_SQL = `
  WITH grouped AS (
    SELECT conversation_id, project_id,
           MIN(timestamp) AS first_activity_at,
           MAX(timestamp) AS last_activity_at,
           COALESCE(ARRAY_AGG(DISTINCT account_id::text) FILTER (WHERE account_id IS NOT NULL), '{}')
             AS account_ids,
           MAX(created_at) AS stored_at
    FROM api_requests
    WHERE conversation_id IS NOT NULL
    GROUP BY conversation_id, project_id
  )
  SELECT COALESCE(g.conversation_id, cs.conversation_id) AS conversation_id,
         CASE WHEN cs.conversation_id IS NULL THEN 'missing'
              WHEN g.conversation_id IS NULL THEN 'stale'
              ELSE 'different' END AS kind
  FROM grouped g
  FULL JOIN conversation_summaries cs
    ON cs.conversation_id = g.conversation_id AND cs.project_id = g.project_id
  WHERE (g.stored_at IS NULL OR g.stored_at < $1::timestamptz - make_interval(secs => $2::float8))
    AND (cs.conversation_id IS NULL
         OR g.conversation_id IS NULL
         OR cs.first_activity_at <> g.first_activity_at
         OR cs.last_activity_at <> g.last_activity_at
         OR NOT (cs.account_ids @> g.account_ids AND cs.account_ids <@ g.account_ids))
  ORDER BY kind, conversation_id`

/** Conversations with a request stored within the settle margin before the snapshot */
const RECENT_CONVERSATIONS_SQL = `
  SELECT DISTINCT conversation_id
  FROM api_requests
  WHERE conversation_id IS NOT NULL
    AND timestamp >= $1::timestamptz - interval '1 day'
    AND created_at >= $1::timestamptz - make_interval(secs => $2::float8)`

/** Request-level visibility: $1 principal (lower case) or NULL, $2 projectId, $3 accountId */
const REFERENCE_FILTER = `
  ar.conversation_id IS NOT NULL
  AND ($1::text IS NULL OR ar.project_id IN (
    SELECT p.project_id FROM projects p
    WHERE NOT p.is_private
       OR EXISTS (
         SELECT 1 FROM project_members pm
         WHERE pm.project_id = p.id AND LOWER(pm.user_email) = $1
       )
  ))
  AND ($2::text IS NULL OR ar.project_id = $2)
  AND ($3::text IS NULL OR ar.account_id = $3)`

const REFERENCE_IDS_SQL = `
  SELECT ar.conversation_id
  FROM api_requests ar
  WHERE ${REFERENCE_FILTER}
  GROUP BY ar.conversation_id
  ORDER BY MAX(ar.timestamp) DESC, ar.conversation_id DESC
  LIMIT $4`

const REFERENCE_TOTAL_SQL = `
  SELECT COUNT(DISTINCT ar.conversation_id)::int AS total
  FROM api_requests ar
  WHERE ${REFERENCE_FILTER}`

function maskHost(databaseUrl: string): string {
  const host = new URL(databaseUrl).hostname
  return host.length <= 12 ? host : `${host.slice(0, 6)}…${host.slice(-6)}`
}

/** First position where two newest-first ID lists disagree, ignoring in-flight conversations */
function firstDifference(expected: string[], served: string[], recent: Set<string>) {
  const settledExpected = expected.filter(id => !recent.has(id))
  const settledServed = served.filter(id => !recent.has(id))
  const length = Math.min(settledExpected.length, settledServed.length)
  for (let i = 0; i < length; i++) {
    if (settledExpected[i] !== settledServed[i]) {
      return { position: i + 1, expected: settledExpected[i], served: settledServed[i] }
    }
  }
  return undefined
}

export async function verifyConversationSummaries(
  pool: Pool,
  options: VerifyOptions,
  log: (line: string) => void = console.log
): Promise<string[]> {
  const client = await pool.connect()
  const mismatches: string[] = []

  try {
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
    await client.query("SET statement_timeout = '120s'")
    await client.query("SET application_name = 'verify-conversation-summaries'")
    // One snapshot for both tables: only writes committed before it are compared
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    const snapshot: Date = (await client.query('SELECT now() AS snapshot')).rows[0].snapshot
    log(`Snapshot ${snapshot.toISOString()}, settle margin ${options.settleSeconds}s`)

    const counts = (
      await client.query(`
        SELECT (SELECT COUNT(*) FROM conversation_summaries)::int AS summary_rows,
               (SELECT COUNT(DISTINCT conversation_id) FROM conversation_summaries)::int
                 AS summary_conversations,
               (SELECT COUNT(DISTINCT conversation_id) FROM api_requests
                 WHERE conversation_id IS NOT NULL)::int AS request_conversations`)
    ).rows[0]
    log(
      `conversation_summaries: ${counts.summary_rows} rows, ${counts.summary_conversations} conversations; api_requests: ${counts.request_conversations} conversations`
    )

    const groups = await client.query(GROUP_MISMATCHES_SQL, [snapshot, options.settleSeconds])
    for (const row of groups.rows) {
      mismatches.push(`${row.kind}:${row.conversation_id}`)
    }
    const kindCount = (kind: string) => groups.rows.filter(row => row.kind === kind).length
    log(
      `Groups: ${kindCount('missing')} missing, ${kindCount('stale')} stale, ${kindCount('different')} different`
    )

    const recent = new Set<string>(
      (await client.query(RECENT_CONVERSATIONS_SQL, [snapshot, options.settleSeconds])).rows.map(
        (row: { conversation_id: string }) => row.conversation_id
      )
    )

    const principals: string[] = (
      await client.query(
        `SELECT email
         FROM (SELECT DISTINCT LOWER(user_email) AS email FROM project_members) members
         ORDER BY md5(email)
         LIMIT $1`,
        [options.principals]
      )
    ).rows.map((row: { email: string }) => row.email)
    const busiestProject: string | undefined = (
      await client.query(
        `SELECT project_id FROM conversation_summaries
         GROUP BY project_id ORDER BY COUNT(*) DESC, project_id LIMIT 1`
      )
    ).rows[0]?.project_id
    const busiestAccount: string | undefined = (
      await client.query(
        `SELECT account_id
         FROM conversation_summaries CROSS JOIN LATERAL unnest(account_ids) AS account_id
         GROUP BY account_id ORDER BY COUNT(*) DESC, account_id LIMIT 1`
      )
    ).rows[0]?.account_id

    const cases: VerifyCase[] = [
      { label: 'anonymous' },
      ...principals.map((principal, index) => ({ label: `principal-${index + 1}`, principal })),
      ...(busiestProject ? [{ label: 'busiest-project', projectId: busiestProject }] : []),
      ...(busiestAccount ? [{ label: 'busiest-account', accountId: busiestAccount }] : []),
    ]

    for (const testCase of cases) {
      const values = [
        testCase.principal ?? null,
        testCase.projectId ?? null,
        testCase.accountId ?? null,
      ]
      const expected: string[] = (
        await client.query(REFERENCE_IDS_SQL, [...values, PAGES * options.pageSize])
      ).rows.map((row: { conversation_id: string }) => row.conversation_id)
      const expectedTotal: number = (await client.query(REFERENCE_TOTAL_SQL, values)).rows[0].total

      const served: string[] = []
      let servedTotal = 0
      for (let page = 0; page < PAGES; page++) {
        const result = await listConversations(
          client as unknown as ConversationListPool,
          {
            projectId: testCase.projectId,
            accountId: testCase.accountId,
            limit: options.pageSize,
            offset: page * options.pageSize,
          },
          testCase.principal,
          { summaries: true }
        )
        served.push(...result.conversations.map(item => item.conversationId))
        servedTotal = result.pagination.total
      }

      const difference = firstDifference(expected, served, recent)
      if (difference) {
        mismatches.push(
          `pages:${testCase.label}:${difference.position}:${difference.expected}:${difference.served}`
        )
      }
      if (Math.abs(served.length - expected.length) > recent.size) {
        mismatches.push(`length:${testCase.label}:${expected.length}:${served.length}`)
      }
      if (Math.abs(servedTotal - expectedTotal) > recent.size) {
        mismatches.push(`total:${testCase.label}:${expectedTotal}:${servedTotal}`)
      }
      log(
        `${testCase.label}: ${served.length} ids on ${PAGES} pages, total ${servedTotal} (reference ${expectedTotal})`
      )
    }

    await client.query('COMMIT')
  } finally {
    // The session is read-only: never hand it back to a pool
    client.release(true)
  }

  return mismatches
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is required')
    process.exit(1)
  }

  let options: VerifyOptions
  try {
    options = parseVerifyArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`❌ ${(error as Error).message}`)
    process.exit(1)
  }

  console.log(`Target database host: ${maskHost(databaseUrl)}`)
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  let mismatches: string[]
  try {
    mismatches = await verifyConversationSummaries(pool, options)
  } catch (error) {
    console.error('❌ Verification failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }

  if (mismatches.length > 0) {
    console.error(
      `❌ ${mismatches.length} mismatches (first 10): ${mismatches.slice(0, 10).join(', ')}`
    )
    process.exit(1)
  }
  console.log('✅ conversation_summaries matches api_requests')
}

if (import.meta.main) {
  main()
}
