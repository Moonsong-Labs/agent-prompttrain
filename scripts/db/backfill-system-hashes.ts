#!/usr/bin/env bun

import { Pool } from 'pg'
import dotenv from 'dotenv'
import path from 'path'
import { hashSystemPrompt } from '@agent-prompttrain/shared'

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env') })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

async function backfillSystemHashes() {
  const client = await pool.connect()

  try {
    console.log('Starting backfill of system hashes...')

    // Get all requests that have a body with system prompt but no system_hash
    const result = await client.query(`
      SELECT request_id, body
      FROM api_requests
      WHERE body IS NOT NULL
        AND body::jsonb ? 'system'
      ORDER BY timestamp DESC
      LIMIT 1000
    `)

    console.log(`Found ${result.rows.length} requests to process`)

    let updated = 0
    let skipped = 0

    for (const row of result.rows) {
      try {
        const body = row.body
        if (body.system) {
          const systemHash = hashSystemPrompt(body.system)

          if (systemHash) {
            await client.query('UPDATE api_requests SET system_hash = $1 WHERE request_id = $2', [
              systemHash,
              row.request_id,
            ])
            updated++

            if (updated % 100 === 0) {
              console.log(`Updated ${updated} records...`)
            }
          } else {
            skipped++
          }
        } else {
          skipped++
        }
      } catch (error) {
        console.error(`Error processing request ${row.request_id}:`, error)
      }
    }

    console.log(`\nBackfill completed!`)
    console.log(`Updated: ${updated} records`)
    console.log(`Skipped: ${skipped} records`)
  } catch (error) {
    console.error('Backfill failed:', error)
    throw error
  } finally {
    client.release()
  }
}

// Main execution
async function main() {
  try {
    await backfillSystemHashes()
  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
