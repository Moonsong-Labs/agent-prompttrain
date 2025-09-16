#!/usr/bin/env bun

/**
 * Migration script for credential files
 * Converts domain-based credential files to account-based structure
 *
 * Usage:
 *   bun run scripts/migrate-credentials.ts [--dry-run] [--backup-dir=path]
 *
 * This script:
 * 1. Scans for domain-based credential files (*.domain.credentials.json)
 * 2. Creates account-based equivalents (account1.credentials.json, etc.)
 * 3. Updates accountId fields to match new filenames
 * 4. Creates a mapping file showing domain -> account relationships
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs'
import { join, basename } from 'path'

interface CredentialFile {
  type: 'api_key' | 'oauth'
  accountId: string
  api_key?: string
  client_api_key?: string
  oauth?: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    scopes: string[]
    isMax: boolean
  }
  betaHeader?: string
}

interface DomainMapping {
  domain: string
  accountId: string
  originalFile: string
  newFile: string
}

// Parse command line arguments
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const backupDirArg = args.find(arg => arg.startsWith('--backup-dir='))
const backupDir = backupDirArg ? backupDirArg.split('=')[1] : '.migration-backup/credentials'

const CREDENTIALS_DIR = process.env.CREDENTIALS_DIR || 'credentials'

async function main() {
  console.log('🚀 Starting credential files migration...')
  console.log(`Credentials directory: ${CREDENTIALS_DIR}`)
  console.log(`Dry run: ${dryRun ? 'YES' : 'NO'}`)
  console.log(`Backup directory: ${backupDir}`)
  console.log()

  // Check if credentials directory exists
  if (!existsSync(CREDENTIALS_DIR)) {
    console.error(`❌ Credentials directory not found: ${CREDENTIALS_DIR}`)
    process.exit(1)
  }

  // Create backup directory
  if (!dryRun) {
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { recursive: true })
      console.log(`📁 Created backup directory: ${backupDir}`)
    }
  }

  // Find domain-based credential files
  const files = readdirSync(CREDENTIALS_DIR)
  const domainCredentialFiles = files.filter(
    file =>
      file.includes('.') &&
      file.endsWith('.credentials.json') &&
      !file.startsWith('account') && // Skip already migrated files
      !file.startsWith('_wildcard') // Skip wildcard files
  )

  if (domainCredentialFiles.length === 0) {
    console.log('✅ No domain-based credential files found. Migration not needed.')
    return
  }

  console.log(`Found ${domainCredentialFiles.length} domain-based credential files:`)
  domainCredentialFiles.forEach(file => console.log(`  - ${file}`))
  console.log()

  const mappings: DomainMapping[] = []
  let accountCounter = 1

  // Process each domain credential file
  for (const file of domainCredentialFiles) {
    const filePath = join(CREDENTIALS_DIR, file)
    const domain = file.replace('.credentials.json', '')
    const accountId = `account${accountCounter}`
    const newFileName = `${accountId}.credentials.json`
    const newFilePath = join(CREDENTIALS_DIR, newFileName)

    console.log(`📄 Processing: ${file}`)
    console.log(`   Domain: ${domain}`)
    console.log(`   New account ID: ${accountId}`)

    // Read existing credential file
    let credentialData: CredentialFile
    try {
      const content = readFileSync(filePath, 'utf8')
      credentialData = JSON.parse(content)
    } catch (error) {
      console.error(`   ❌ Error reading ${file}: ${error}`)
      continue
    }

    // Update accountId field
    const updatedData = {
      ...credentialData,
      accountId: accountId,
    }

    // Create mapping
    mappings.push({
      domain: domain,
      accountId: accountId,
      originalFile: file,
      newFile: newFileName,
    })

    if (dryRun) {
      console.log(`   🔍 DRY RUN: Would create ${newFileName}`)
      console.log(`   🔍 DRY RUN: Would update accountId to "${accountId}"`)
    } else {
      // Backup original file
      const backupPath = join(backupDir, file)
      copyFileSync(filePath, backupPath)
      console.log(`   💾 Backed up to: ${backupPath}`)

      // Write new credential file
      writeFileSync(newFilePath, JSON.stringify(updatedData, null, 2))
      console.log(`   ✅ Created: ${newFileName}`)
    }

    accountCounter++
    console.log()
  }

  // Create domain mapping file
  const mappingFilePath = join(CREDENTIALS_DIR, 'domain-to-account-mapping.json')
  const mappingData = {
    migration_date: new Date().toISOString(),
    note: 'This file maps old domain-based credentials to new account-based credentials. Keep for reference.',
    mappings: mappings,
  }

  if (dryRun) {
    console.log(`🔍 DRY RUN: Would create mapping file: ${mappingFilePath}`)
    console.log('Mapping data:', JSON.stringify(mappingData, null, 2))
  } else {
    writeFileSync(mappingFilePath, JSON.stringify(mappingData, null, 2))
    console.log(`📋 Created mapping file: ${mappingFilePath}`)
  }

  console.log()
  console.log('📊 Migration Summary:')
  console.log(`   Files processed: ${domainCredentialFiles.length}`)
  console.log(`   Account files created: ${mappings.length}`)
  console.log(`   Backup location: ${backupDir}`)

  if (dryRun) {
    console.log()
    console.log('🔍 This was a DRY RUN. No files were changed.')
    console.log('   Remove --dry-run flag to perform the actual migration.')
  } else {
    console.log()
    console.log('✅ Migration completed successfully!')
    console.log()
    console.log('Next steps:')
    console.log('1. Test that your proxy still works with the new credential files')
    console.log('2. Update your train-id usage to map to the new account structure')
    console.log('3. Check the dashboard to verify everything is working')
    console.log('4. Once confirmed working, you can remove the old domain credential files')
    console.log()
    console.log('Train-ID to Account Mapping:')
    mappings.forEach(mapping => {
      console.log(`   ${mapping.domain} → ${mapping.accountId}`)
    })
  }

  // Show account assignment preview
  console.log()
  console.log('🔄 Train-ID Account Assignment Preview:')
  console.log('   (Train-IDs will be assigned to accounts using consistent hashing)')
  mappings.forEach(mapping => {
    console.log(`   Train-ID "${mapping.domain}" will likely map to → ${mapping.accountId}`)
  })

  console.log()
  console.log('For more information, see the migration guide:')
  console.log('   docs/02-User-Guide/migration-guide.md')
}

if (import.meta.main) {
  main().catch(error => {
    console.error('❌ Migration failed:', error)
    process.exit(1)
  })
}
