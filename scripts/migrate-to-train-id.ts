#!/usr/bin/env bun

/**
 * Complete migration script from domain-based to train-id system
 *
 * This script performs the full migration process:
 * 1. Database schema migration
 * 2. Credential files migration
 * 3. Verification and testing
 * 4. Provides rollback instructions
 *
 * Usage:
 *   bun run scripts/migrate-to-train-id.ts [--dry-run] [--skip-db] [--skip-credentials]
 */

import { existsSync } from 'fs'
import { join } from 'path'

// Parse command line arguments
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const skipDb = args.includes('--skip-db')
const skipCredentials = args.includes('--skip-credentials')

async function main() {
  console.log('🚀 Agent Prompt Train Migration to Train-ID System')
  console.log('==================================================')
  console.log()

  if (dryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made')
    console.log()
  }

  // Check prerequisites
  console.log('📋 Checking prerequisites...')

  // Check if codebase migration has been completed by running typecheck
  if (!dryRun) {
    console.log('🔍 Checking if codebase migration is complete...')
    try {
      const { spawn } = require('child_process')
      const typecheck = spawn('bun', ['run', 'typecheck'], {
        stdio: 'pipe',
        cwd: process.cwd(),
      })

      let output = ''
      typecheck.stderr.on('data', (data: Buffer) => {
        output += data.toString()
      })

      await new Promise((resolve, reject) => {
        typecheck.on('close', (code: number) => {
          if (code !== 0) {
            console.error('❌ TypeScript errors detected. Codebase migration appears incomplete.')
            console.error('')
            if (output.includes('domain') || output.includes("'domain' does not exist")) {
              console.error('🔍 Detected domain-related TypeScript errors.')
              console.error(
                '   This indicates the codebase migration from domain to train-id is incomplete.'
              )
              console.error('')
              console.error('Next steps:')
              console.error('1. Run the codebase migration script:')
              console.error('   bun run scripts/replace-domain-with-trainid.sh')
              console.error('2. Review and test the changes carefully')
              console.error('3. Fix any remaining TypeScript errors manually')
              console.error('4. Run this migration script again')
              console.error('')
              console.error('⚠️  WARNING: The automated script makes extensive changes.')
              console.error('   Review all changes before committing.')
            } else {
              console.error('TypeScript errors:')
              console.error(output)
            }
            reject(new Error('TypeScript compilation failed'))
          } else {
            console.log(
              '✅ TypeScript compilation successful - codebase migration appears complete'
            )
            resolve(void 0)
          }
        })
      })
    } catch (error) {
      console.error('❌ Failed to check TypeScript compilation:', error)
      console.error('   Please ensure the codebase migration is complete before proceeding.')
      process.exit(1)
    }
  }

  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl && !skipDb) {
    console.error('❌ DATABASE_URL environment variable is required')
    console.log('   Set DATABASE_URL or use --skip-db flag')
    process.exit(1)
  }

  const credentialsDir = process.env.CREDENTIALS_DIR || 'credentials'
  if (!existsSync(credentialsDir) && !skipCredentials) {
    console.error(`❌ Credentials directory not found: ${credentialsDir}`)
    console.log('   Create the directory or use --skip-credentials flag')
    process.exit(1)
  }

  console.log('✅ Prerequisites check passed')
  console.log()

  // Step 1: Database Migration
  if (!skipDb) {
    console.log('📊 Step 1: Database Migration')
    console.log('-----------------------------')

    if (dryRun) {
      console.log('🔍 DRY RUN: Would run database migration')
      console.log('   Command: bun run scripts/db/migrations/012-migrate-to-train-id.ts')
    } else {
      try {
        console.log('🔄 Running database migration...')
        const dbMigrationScript = join(
          process.cwd(),
          'scripts/db/migrations/012-migrate-to-train-id.ts'
        )

        if (!existsSync(dbMigrationScript)) {
          console.error('❌ Database migration script not found')
          console.log('   Expected: scripts/db/migrations/012-migrate-to-train-id.ts')
          process.exit(1)
        }

        const { spawn } = require('child_process')
        const migration = spawn('bun', ['run', dbMigrationScript], {
          stdio: 'pipe',
          cwd: process.cwd(),
        })

        let output = ''
        migration.stdout.on('data', (data: Buffer) => {
          output += data.toString()
        })

        migration.stderr.on('data', (data: Buffer) => {
          output += data.toString()
        })

        await new Promise((resolve, reject) => {
          migration.on('close', (code: number) => {
            if (code === 0) {
              console.log('✅ Database migration completed successfully')
              console.log(output)
              resolve(void 0)
            } else {
              console.error('❌ Database migration failed')
              console.error(output)
              reject(new Error(`Migration failed with code ${code}`))
            }
          })
        })
      } catch (error) {
        console.error('❌ Database migration error:', error)
        process.exit(1)
      }
    }
    console.log()
  }

  // Step 2: Credential Files Migration
  if (!skipCredentials) {
    console.log('🔐 Step 2: Credential Files Migration')
    console.log('-------------------------------------')

    if (dryRun) {
      console.log('🔍 DRY RUN: Would run credential migration')
      console.log('   Command: bun run scripts/migrate-credentials.ts --dry-run')
    } else {
      try {
        console.log('🔄 Running credential files migration...')
        const credMigrationScript = join(process.cwd(), 'scripts/migrate-credentials.ts')

        if (!existsSync(credMigrationScript)) {
          console.error('❌ Credential migration script not found')
          console.log('   Expected: scripts/migrate-credentials.ts')
          process.exit(1)
        }

        const { spawn } = require('child_process')
        const credMigration = spawn('bun', ['run', credMigrationScript], {
          stdio: 'pipe',
          cwd: process.cwd(),
        })

        let output = ''
        credMigration.stdout.on('data', (data: Buffer) => {
          output += data.toString()
        })

        credMigration.stderr.on('data', (data: Buffer) => {
          output += data.toString()
        })

        await new Promise((resolve, reject) => {
          credMigration.on('close', (code: number) => {
            if (code === 0) {
              console.log('✅ Credential files migration completed successfully')
              console.log(output)
              resolve(void 0)
            } else {
              console.error('❌ Credential files migration failed')
              console.error(output)
              reject(new Error(`Credential migration failed with code ${code}`))
            }
          })
        })
      } catch (error) {
        console.error('❌ Credential migration error:', error)
        process.exit(1)
      }
    }
    console.log()
  }

  // Step 3: Verification
  console.log('✅ Step 3: Migration Verification')
  console.log('----------------------------------')

  if (!dryRun) {
    console.log('📋 Please verify the following:')
    console.log()

    if (!skipDb) {
      console.log('Database:')
      console.log(
        '  - Run: psql $DATABASE_URL -c "SELECT COUNT(*) FROM api_requests WHERE train_id IS NOT NULL;"'
      )
      console.log('  - Should show the number of migrated requests')
      console.log()
    }

    if (!skipCredentials) {
      console.log('Credentials:')
      console.log('  - Check that account*.credentials.json files exist')
      console.log('  - Review domain-to-account-mapping.json for the mapping')
      console.log()
    }

    console.log('Testing:')
    console.log('  - Start the proxy service')
    console.log('  - Test with X-TRAIN-ID header:')
    console.log('    curl -X POST http://localhost:3000/v1/messages \\')
    console.log('      -H "X-TRAIN-ID: test-project" \\')
    console.log('      -H "Authorization: Bearer YOUR_CLIENT_KEY" \\')
    console.log('      -H "Content-Type: application/json" \\')
    console.log('      -d \'{"messages": [{"role": "user", "content": "Test"}]}\'')
    console.log()
  }

  // Step 4: Next Steps
  console.log('🎯 Step 4: Next Steps')
  console.log('---------------------')
  console.log()
  console.log('Client Migration:')
  console.log('1. Update your clients to use X-TRAIN-ID header instead of Host header')
  console.log('2. For Claude CLI, set: export ANTHROPIC_CUSTOM_HEADERS="train-id:your-project"')
  console.log(
    '3. Enable backward compatibility during transition: ENABLE_HOST_HEADER_FALLBACK=true'
  )
  console.log()
  console.log('Documentation:')
  console.log('📖 Complete migration guide: docs/02-User-Guide/migration-guide.md')
  console.log('📖 API reference updated: docs/02-User-Guide/api-reference.md')
  console.log('📖 Train-ID authentication: docs/02-User-Guide/train-id-authentication.md')
  console.log()

  if (!dryRun) {
    console.log('✅ Migration completed successfully!')
    console.log()
    console.log('⚠️  Important: Test thoroughly before disabling backward compatibility')
    console.log('   Once verified, set ENABLE_HOST_HEADER_FALLBACK=false')
  } else {
    console.log('🔍 This was a DRY RUN. No changes were made.')
    console.log('   Remove --dry-run flag to perform the actual migration.')
  }

  // Rollback Instructions
  console.log()
  console.log('🔄 Rollback Instructions (if needed)')
  console.log('------------------------------------')
  console.log('If you need to rollback this migration:')
  console.log()
  console.log('Database Rollback:')
  console.log('  psql $DATABASE_URL -c "ALTER TABLE api_requests DROP COLUMN train_id;"')
  console.log('  psql $DATABASE_URL -c "DROP INDEX IF EXISTS idx_api_requests_train_id;"')
  console.log()
  console.log('Credentials Rollback:')
  console.log('  - Restore from .migration-backup/credentials/')
  console.log('  - Or manually rename account files back to domain files')
  console.log()
  console.log('⚠️  WARNING: Rollback will lose any new data created after migration')
}

if (import.meta.main) {
  main().catch(error => {
    console.error('❌ Migration failed:', error)
    process.exit(1)
  })
}
