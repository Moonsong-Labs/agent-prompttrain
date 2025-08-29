#!/usr/bin/env bun
import { randomBytes } from 'crypto'

/**
 * Generate a secure API key for proxy authentication
 */
function generateApiKey(prefix: string = 'cnp_live'): string {
  // 32 bytes of cryptographically secure random data
  const buffer = randomBytes(32)
  // Convert to URL-safe base64 string
  const key = buffer.toString('base64url')
  return `${prefix}_${key}`
}

/**
 * Generate multiple keys at once
 */
function generateKeys(count: number = 1, prefix?: string): string[] {
  const keys: string[] = []
  for (let i = 0; i < count; i++) {
    keys.push(generateApiKey(prefix))
  }
  return keys
}

// CLI interface
if (import.meta.main) {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Agent Prompt Train API Key Generator

Usage:
  bun run generate-api-key.ts [options]

Options:
  -n, --count <number>    Generate multiple keys (default: 1)
  -p, --prefix <string>   Key prefix (default: cnp_live)
  --test                  Generate test key with cnp_test prefix
  -h, --help             Show this help message

Examples:
  # Generate a single production key
  bun run generate-api-key.ts

  # Generate 5 keys
  bun run generate-api-key.ts -n 5

  # Generate test key
  bun run generate-api-key.ts --test

  # Custom prefix
  bun run generate-api-key.ts -p myapp_prod
`)
    process.exit(0)
  }

  // Parse arguments
  let count = 1
  let prefix = 'cnp_live'

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-n' || args[i] === '--count') && args[i + 1]) {
      count = parseInt(args[i + 1], 10)
      if (isNaN(count) || count < 1) {
        console.error('Error: Count must be a positive number')
        process.exit(1)
      }
      i++
    } else if ((args[i] === '-p' || args[i] === '--prefix') && args[i + 1]) {
      prefix = args[i + 1]
      i++
    } else if (args[i] === '--test') {
      prefix = 'cnp_test'
    }
  }

  // Generate and display keys
  const keys = generateKeys(count, prefix)

  if (count === 1) {
    console.log('\nGenerated API Key:')
    console.log(keys[0])
    console.log('\nAdd this to your domain credential file as:')
    console.log('"client_api_key": "' + keys[0] + '"')
  } else {
    console.log(`\nGenerated ${count} API Keys:`)
    keys.forEach((key, index) => {
      console.log(`${index + 1}. ${key}`)
    })
  }

  console.log('\n⚠️  Keep these keys secure and do not share them publicly!')
}

export { generateApiKey, generateKeys }
