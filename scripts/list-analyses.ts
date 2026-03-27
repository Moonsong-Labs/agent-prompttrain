#!/usr/bin/env bun

/**
 * List recent AI analyses as a formatted table.
 *
 * Usage:
 *   bun run scripts/list-analyses.ts [count]
 *
 * Arguments:
 *   count  Number of analyses to display (default: 20)
 *
 * Environment:
 *   DATABASE_URL  PostgreSQL connection string (loaded from .env)
 */

import { Pool } from 'pg'
import { config } from 'dotenv'

config()

interface AnalysisRow {
  id: string
  conversation_id: string
  branch_id: string
  status: string
  model_used: string
  retry_count: number
  prompt_tokens: number | null
  completion_tokens: number | null
  processing_duration_ms: number | null
  error_message: string | null
  created_at: Date
  completed_at: Date | null
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max - 1) + '…'
}

function pad(str: string, len: number): string {
  return str.padEnd(len).slice(0, len)
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTokens(prompt: number | null, completion: number | null): string {
  if (prompt === null && completion === null) return '-'
  return `${prompt ?? 0}/${completion ?? 0}`
}

function formatDate(date: Date | null): string {
  if (!date) return '-'
  const d = new Date(date)
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

function statusIcon(status: string): string {
  switch (status) {
    case 'completed':
      return 'OK'
    case 'failed':
      return 'FAIL'
    case 'pending':
      return 'PEND'
    case 'processing':
      return 'PROC'
    default:
      return status.toUpperCase().slice(0, 4)
  }
}

async function main() {
  const limit = Math.max(1, parseInt(process.argv[2] || '20', 10))

  if (!process.env.DATABASE_URL) {
    console.error('Error: DATABASE_URL is not set. Ensure .env is configured.')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    const { rows } = await pool.query<AnalysisRow>(
      `
      SELECT
        id,
        conversation_id,
        branch_id,
        status,
        model_used,
        retry_count,
        prompt_tokens,
        completion_tokens,
        processing_duration_ms,
        error_message,
        created_at,
        completed_at
      FROM conversation_analyses
      ORDER BY created_at DESC
      LIMIT $1
    `,
      [limit]
    )

    if (rows.length === 0) {
      console.log('No analyses found.')
      return
    }

    // Column widths
    const cols = {
      id: 5,
      status: 4,
      conversation: 12,
      branch: 8,
      model: 20,
      retries: 3,
      tokens: 13,
      duration: 7,
      created: 19,
    }

    const header = [
      pad('ID', cols.id),
      pad('STAT', cols.status),
      pad('CONVERSATION', cols.conversation),
      pad('BRANCH', cols.branch),
      pad('MODEL', cols.model),
      pad('RTY', cols.retries),
      pad('TOKENS (P/C)', cols.tokens),
      pad('DURATIO', cols.duration),
      pad('CREATED', cols.created),
    ].join(' | ')

    const separator = header.replace(/[^|]/g, '-').replace(/\|/g, '+')

    console.log(`\nLast ${rows.length} AI Analyses:\n`)
    console.log(header)
    console.log(separator)

    const failedRows: AnalysisRow[] = []

    for (const row of rows) {
      const line = [
        pad(String(row.id), cols.id),
        pad(statusIcon(row.status), cols.status),
        pad(truncate(row.conversation_id, cols.conversation), cols.conversation),
        pad(truncate(row.branch_id, cols.branch), cols.branch),
        pad(truncate(row.model_used || '-', cols.model), cols.model),
        pad(String(row.retry_count), cols.retries),
        pad(formatTokens(row.prompt_tokens, row.completion_tokens), cols.tokens),
        pad(formatDuration(row.processing_duration_ms), cols.duration),
        pad(formatDate(row.created_at), cols.created),
      ].join(' | ')
      console.log(line)

      if (row.status === 'failed' && row.error_message) {
        failedRows.push(row)
      }
    }

    // Summary
    const counts = rows.reduce(
      (acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1
        return acc
      },
      {} as Record<string, number>
    )

    console.log(
      `\nSummary: ${rows.length} total — ` +
        Object.entries(counts)
          .map(([s, c]) => `${c} ${s}`)
          .join(', ')
    )

    // Failed analyses detail
    if (failedRows.length > 0) {
      console.log(`\n=== Failed Analyses (${failedRows.length}) ===\n`)
      for (const row of failedRows) {
        console.log(`ID ${row.id} | Conversation: ${row.conversation_id}`)
        console.log(`  Branch: ${row.branch_id} | Retries: ${row.retry_count}`)
        console.log(`  Created: ${formatDate(row.created_at)}`)
        const error =
          typeof row.error_message === 'string'
            ? row.error_message
            : JSON.stringify(row.error_message)
        console.log(`  Error: ${error}`)
        console.log()
      }
    }
  } catch (error) {
    console.error('Error querying analyses:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
