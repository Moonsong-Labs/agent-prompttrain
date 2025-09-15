import { AuthenticationService } from './services/proxy/src/services/AuthenticationService'
import { loadCredentials } from './services/proxy/src/credentials'

async function testWildcardAccountId() {
  console.log('=== Testing Wildcard AccountId Issue ===\n')
  
  // Enable wildcard feature
  process.env.CNP_WILDCARD_CREDENTIALS = 'true'
  
  const authService = new AuthenticationService('default-key', 'credentials')
  
  // Test 1: Load the wildcard credential file directly
  console.log('1. Loading wildcard credential file directly:')
  const wildcardCreds = loadCredentials('credentials/_wildcard.test.local.credentials.json')
  console.log('   AccountId from file:', wildcardCreds?.accountId)
  console.log('   Expected: "test-wildcard-account"\n')
  
  // Test 2: Resolve credential path for subdomain
  const testHost = 'subdomain.test.local'
  console.log('2. Resolving credentials for:', testHost)
  
  const resolvedPath = await (authService as any).resolveCredentialPath(testHost)
  console.log('   Resolved path:', resolvedPath)
  
  if (resolvedPath) {
    const resolvedCreds = loadCredentials(resolvedPath)
    console.log('   AccountId from resolved:', resolvedCreds?.accountId)
    console.log('   Expected: "test-wildcard-account" (from wildcard file)')
    
    // Test 3: What the fallback derives
    const derived = (authService as any).deriveAccountIdFromPath(resolvedPath)
    console.log('\n3. Fallback derivation from path:')
    console.log('   Derived accountId:', derived)
    console.log('   This would be: "test.local" (incorrect!)')
    
    console.log('\n=== Issue Summary ===')
    console.log('The wildcard file HAS accountId: "test-wildcard-account"')
    console.log('But if the system thinks it\'s null, it derives: "test.local"')
    console.log('This is why you see wrong account in dashboard!')
  }
  
  // Cleanup
  delete process.env.CNP_WILDCARD_CREDENTIALS
}

testWildcardAccountId().catch(console.error)