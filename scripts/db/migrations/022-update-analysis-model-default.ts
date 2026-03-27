#!/usr/bin/env bun

/**
 * Migration 022: Update conversation_analyses model_used default
 *
 * The original default was 'gemini-2.5-pro' from when the feature used Gemini.
 * Now that analysis routes through the local proxy with ANTHROPIC_ANALYSIS_MODEL,
 * the column default should reflect the current code default: 'claude-opus-4-6'.
 *
 * Also updates any existing pending rows that still have the stale default.
 */

import { Pool } from 'pg'
import { config } from 'dotenv'

config()

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  })

  try {
    console.log('Migration 022: Update analysis model_used default\n')

    // Update the column default
    console.log("1. Updating column default from 'gemini-2.5-pro' to 'claude-opus-4-6'...")
    await pool.query(`
      ALTER TABLE conversation_analyses
      ALTER COLUMN model_used SET DEFAULT 'claude-opus-4-6'
    `)
    console.log('   Done.')

    // Fix existing pending/processing rows that have the stale default
    console.log('2. Updating pending/processing rows with stale model_used...')
    const result = await pool.query(`
      UPDATE conversation_analyses
      SET model_used = 'claude-opus-4-6'
      WHERE status IN ('pending', 'processing')
        AND model_used = 'gemini-2.5-pro'
    `)
    console.log(`   Updated ${result.rowCount} rows.`)

    console.log('\nMigration 022 complete.')
  } catch (error) {
    console.error('Migration failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
