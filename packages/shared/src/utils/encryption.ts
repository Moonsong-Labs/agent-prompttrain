/**
 * API key utilities for credential management
 *
 * Provides hashing and generation functions for API keys
 */

import crypto from 'crypto'

/**
 * Hash an API key using SHA-256
 *
 * Used for storing client API keys in a non-reversible format
 *
 * @param apiKey - The API key to hash
 * @returns Hex-encoded SHA-256 hash
 */
export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex')
}

/**
 * Verify an API key against a hash using constant-time comparison
 *
 * @param apiKey - The API key to verify
 * @param hash - The hash to compare against
 * @returns True if the API key matches the hash
 */
export function verifyApiKeyHash(apiKey: string, hash: string): boolean {
  const hashedKeyBuffer = Buffer.from(hashApiKey(apiKey))
  const hashBuffer = Buffer.from(hash)

  // Ensure buffers are the same length to prevent timingSafeEqual from throwing
  if (hashedKeyBuffer.length !== hashBuffer.length) {
    return false
  }

  return crypto.timingSafeEqual(hashedKeyBuffer, hashBuffer)
}

/**
 * Generate a new API key with format: ptk_<random_string>
 *
 * Uses cryptographically secure random bytes for the secret portion
 *
 * @returns A newly generated API key
 */
export function generateApiKey(): string {
  const prefix = 'ptk_'
  const randomBytes = crypto.randomBytes(24)
  const secret = randomBytes.toString('base64url').replace(/[^a-zA-Z0-9]/g, '')
  return `${prefix}${secret}`
}
