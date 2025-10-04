#!/usr/bin/env bun
import { performOAuthLogin } from '../../services/proxy/src/credentials'
import { resolve, dirname } from 'path'
import { mkdirSync } from 'fs'

async function main() {
  const credentialPath = process.argv[2]

  if (!credentialPath) {
    console.error('Usage: bun run scripts/auth/oauth-login.ts <credential-path>')
    console.error(
      'Example: bun run scripts/auth/oauth-login.ts credentials/example.com.credentials.json'
    )
    process.exit(1)
  }

  try {
    // Ensure the directory exists
    const fullPath = resolve(credentialPath)
    mkdirSync(dirname(fullPath), { recursive: true })

    console.log(`Starting OAuth login for: ${credentialPath}`)
    console.log('You will need to:')
    console.log('1. Visit the authorization URL in your browser')
    console.log('2. Log in to Claude and authorize the application')
    console.log('3. Copy the authorization code (contains a # character)')
    console.log('4. Paste the code here when prompted\n')

    // Perform OAuth login
    await performOAuthLogin(credentialPath, false) // false = don't create separate API key file

    console.log('\nOAuth login successful!')
    console.log(`Credentials have been saved to: ${credentialPath}`)
    console.log('\nThe proxy will now use these OAuth credentials for authentication.')
  } catch (error) {
    console.error('OAuth login failed:', error)
    process.exit(1)
  }
}

main()
