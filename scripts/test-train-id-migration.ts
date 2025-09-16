#!/usr/bin/env bun

import { Pool } from 'pg'
import * as dotenv from 'dotenv'
import * as path from 'path'

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env') })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

/**
 * Test script to validate the train_id migration
 * This script performs non-destructive tests to verify the migration works correctly
 */
async function testMigration() {
  const client = await pool.connect()

  try {
    console.log('🧪 Testing train_id migration...')

    // Test 1: Check if train_id column exists
    console.log('\n1️⃣ Checking if train_id column exists...')
    const columnCheck = await client.query(`
      SELECT column_name, is_nullable, column_default, data_type
      FROM information_schema.columns 
      WHERE table_name = 'api_requests' 
      AND column_name = 'train_id'
    `)

    if (columnCheck.rows.length === 0) {
      console.log('❌ train_id column does not exist - migration not yet applied')
      return false
    }

    const column = columnCheck.rows[0]
    console.log(
      `✅ train_id column exists: ${column.data_type}, nullable: ${column.is_nullable}, default: ${column.column_default}`
    )

    // Test 2: Check for NULL train_id values
    console.log('\n2️⃣ Checking for NULL train_id values...')
    const nullCheck = await client.query(`
      SELECT COUNT(*) as null_count FROM api_requests WHERE train_id IS NULL
    `)
    const nullCount = parseInt(nullCheck.rows[0].null_count)
    if (nullCount > 0) {
      console.log(`⚠️  Found ${nullCount} rows with NULL train_id - migration may be incomplete`)
    } else {
      console.log(`✅ All rows have train_id values (0 NULL values)`)
    }

    // Test 3: Check train_id indexes
    console.log('\n3️⃣ Checking train_id indexes...')
    const indexCheck = await client.query(`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename = 'api_requests' 
      AND indexname LIKE '%train_id%'
    `)

    if (indexCheck.rows.length === 0) {
      console.log('⚠️  No train_id indexes found')
    } else {
      console.log(`✅ Found ${indexCheck.rows.length} train_id indexes:`)
      indexCheck.rows.forEach(idx => {
        console.log(`   - ${idx.indexname}`)
      })
    }

    // Test 4: Check old domain indexes (should be dropped)
    console.log('\n4️⃣ Checking old domain indexes...')
    const oldIndexCheck = await client.query(`
      SELECT indexname 
      FROM pg_indexes 
      WHERE tablename = 'api_requests' 
      AND indexname IN ('idx_requests_domain', 'idx_api_requests_domain_timestamp_response')
    `)

    if (oldIndexCheck.rows.length > 0) {
      console.log(
        `⚠️  Found ${oldIndexCheck.rows.length} old domain indexes that should have been dropped:`
      )
      oldIndexCheck.rows.forEach(idx => {
        console.log(`   - ${idx.indexname}`)
      })
    } else {
      console.log(`✅ Old domain indexes have been properly removed`)
    }

    // Test 5: Check domain column constraints
    console.log('\n5️⃣ Checking domain column nullability...')
    const domainCheck = await client.query(`
      SELECT is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'api_requests' 
      AND column_name = 'domain'
    `)

    if (domainCheck.rows.length > 0) {
      const isNullable = domainCheck.rows[0].is_nullable
      if (isNullable === 'YES') {
        console.log(`✅ Domain column is now nullable (${isNullable})`)
      } else {
        console.log(`⚠️  Domain column is still NOT NULL (${isNullable})`)
      }
    }

    // Test 6: Check conversation_analyses table
    console.log('\n6️⃣ Checking conversation_analyses table...')
    const analysesTableCheck = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'conversation_analyses'
      ) as exists
    `)

    if (analysesTableCheck.rows[0].exists) {
      const analysesColumnCheck = await client.query(`
        SELECT column_name, is_nullable, data_type
        FROM information_schema.columns 
        WHERE table_name = 'conversation_analyses' 
        AND column_name = 'train_id'
      `)

      if (analysesColumnCheck.rows.length > 0) {
        const analysesColumn = analysesColumnCheck.rows[0]
        console.log(
          `✅ conversation_analyses.train_id exists: ${analysesColumn.data_type}, nullable: ${analysesColumn.is_nullable}`
        )
      } else {
        console.log(`⚠️  conversation_analyses.train_id column missing`)
      }
    } else {
      console.log(`ℹ️  conversation_analyses table does not exist`)
    }

    // Test 7: Sample data validation
    console.log('\n7️⃣ Validating sample data...')
    const sampleCheck = await client.query(`
      SELECT 
        COUNT(*) as total_rows,
        COUNT(DISTINCT train_id) as unique_train_ids,
        COUNT(*) FILTER (WHERE train_id = 'default') as default_count
      FROM api_requests 
      LIMIT 1000
    `)

    if (sampleCheck.rows.length > 0) {
      const stats = sampleCheck.rows[0]
      console.log(`✅ Data validation:`)
      console.log(`   - Total rows sampled: ${stats.total_rows}`)
      console.log(`   - Unique train_ids: ${stats.unique_train_ids}`)
      console.log(`   - Rows with 'default' train_id: ${stats.default_count}`)
    }

    console.log('\n🎉 Migration test completed successfully!')
    return true
  } catch (error) {
    console.error(
      '❌ Migration test failed:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  } finally {
    client.release()
  }
}

// Main execution
async function main() {
  try {
    const success = await testMigration()
    process.exit(success ? 0 : 1)
  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
