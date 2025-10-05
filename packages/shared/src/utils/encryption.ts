/**
 * Encryption utilities for credential storage
 *
 * Uses AES-256-GCM authenticated encryption with PBKDF2 key derivation
 * Format: salt:iv:authTag:ciphertext (all base64-encoded)
 */

import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const SALT_LENGTH = 32
const KEY_ITERATIONS = 100000

/**
 * Encrypt plaintext using AES-256-GCM
 *
 * @param plaintext - The text to encrypt
 * @param key - The encryption key (should be at least 32 characters)
 * @returns Base64-encoded encrypted string with format: salt:iv:authTag:ciphertext
 */
export function encrypt(plaintext: string, key: string): string {
  if (!key || key.length < 32) {
    throw new Error('Encryption key must be at least 32 characters')
  }

  const salt = crypto.randomBytes(SALT_LENGTH)
  const derivedKey = crypto.pbkdf2Sync(key, salt, KEY_ITERATIONS, 32, 'sha256')
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, derivedKey, iv)

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  // Format: salt:iv:authTag:ciphertext (all base64)
  return [salt, iv, authTag, encrypted].map(b => b.toString('base64')).join(':')
}

/**
 * Decrypt ciphertext using AES-256-GCM
 *
 * @param ciphertext - The encrypted string (format: salt:iv:authTag:ciphertext)
 * @param key - The encryption key used to encrypt
 * @returns Decrypted plaintext
 */
export function decrypt(ciphertext: string, key: string): string {
  if (!key || key.length < 32) {
    throw new Error('Encryption key must be at least 32 characters')
  }

  const parts = ciphertext.split(':')
  if (parts.length !== 4) {
    throw new Error('Invalid ciphertext format')
  }

  const [saltB64, ivB64, authTagB64, encryptedB64] = parts

  const salt = Buffer.from(saltB64, 'base64')
  const iv = Buffer.from(ivB64, 'base64')
  const authTag = Buffer.from(authTagB64, 'base64')
  const encrypted = Buffer.from(encryptedB64, 'base64')

  const derivedKey = crypto.pbkdf2Sync(key, salt, KEY_ITERATIONS, 32, 'sha256')
  const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, iv)
  decipher.setAuthTag(authTag)

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

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
