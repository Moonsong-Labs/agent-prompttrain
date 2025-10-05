#!/usr/bin/env bun
import { Pool } from 'pg'

/**
 * Migration 015: Drop train_name column from trains table
 *
 * The train_name field is redundant since train_id is the canonical identifier.
 * This migration removes the train_name column to simplify the data model.
 *
 * WARNING: This migration will permanently delete all existing train_name data.
 * There is no rollback for the data - only the schema can be restored.
 *
 * This migration is idempotent and can be run multiple times safely.
 */
async function dropTrainNameColumn() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    await pool.query('BEGIN')

    console.log('Checking if train_name column exists...')

    // Check if column exists before dropping
    const columnCheck = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = 'trains'
      AND column_name = 'train_name'
    `)

    if (columnCheck.rowCount === 0) {
      console.log('  train_name column does not exist, skipping drop')
    } else {
      console.log('  train_name column exists, dropping...')
      await pool.query(`
        ALTER TABLE trains
        DROP COLUMN IF EXISTS train_name
      `)
      console.log('  ✓ Dropped train_name column')
    }

    // Verify the column has been removed
    const verifyCheck = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = 'trains'
      AND column_name = 'train_name'
    `)

    if (verifyCheck.rowCount > 0) {
      throw new Error('Failed to drop train_name column')
    }

    console.log('✓ Migration 015 completed successfully!')

    await pool.query('COMMIT')
  } catch (error) {
    await pool.query('ROLLBACK')
    console.error('Migration 015 failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

dropTrainNameColumn().catch(console.error)
