import { promises as fsp } from 'fs'
import * as path from 'path'
import { ITrainRepository, SlackConfig } from './ITrainRepository'
import { DecryptedAccount } from '@agent-prompttrain/shared'
import { logger } from '../middleware/logger'

const CLIENT_KEY_FILENAME_SUFFIX = '.client-keys.json'
const IDENTIFIER_REGEX = /^[a-zA-Z0-9._\-:]+$/

/**
 * Filesystem-based implementation of ITrainRepository.
 *
 * This implementation reads train client keys from the filesystem.
 * Note: Filesystem mode does NOT support train-account mappings or Slack config.
 * These features are only available in database mode.
 */
export class FilesystemTrainRepository implements ITrainRepository {
  constructor(private readonly clientKeysDir: string) {}

  async getAccountNamesForTrain(_trainId: string): Promise<string[]> {
    // Filesystem mode doesn't have train-account mappings
    // Return empty array - AuthenticationService will use all available accounts
    return []
  }

  async getAccountsForTrain(_trainId: string): Promise<DecryptedAccount[]> {
    // Filesystem mode doesn't have train-account mappings
    // Return empty array - AuthenticationService will use all available accounts
    return []
  }

  async getClientApiKeysHashed(trainId: string): Promise<string[]> {
    const filePath = this.resolveClientKeysPath(trainId)
    if (!filePath) {
      return []
    }

    try {
      const content = await fsp.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(content)

      const rawKeys = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.keys)
          ? parsed.keys
          : Array.isArray(parsed?.client_api_keys)
            ? parsed.client_api_keys
            : []

      // In filesystem mode, keys are stored in plaintext
      // Return them as-is (not hashed)
      return rawKeys
        .filter((key: unknown) => typeof key === 'string' && key.trim().length > 0)
        .map((key: string) => key.trim())
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') {
        logger.error('Failed to read client API keys file', {
          trainId,
          error: err.message,
        })
      }
      return []
    }
  }

  async validateClientKey(trainId: string, clientKey: string): Promise<boolean> {
    const filePath = this.resolveClientKeysPath(trainId)
    if (!filePath) {
      return false
    }

    try {
      const content = await fsp.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(content)

      const rawKeys = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.keys)
          ? parsed.keys
          : Array.isArray(parsed?.client_api_keys)
            ? parsed.client_api_keys
            : []

      const validKeys = rawKeys
        .filter((key: unknown) => typeof key === 'string' && key.trim().length > 0)
        .map((key: string) => key.trim())

      // In filesystem mode, keys are stored in plaintext
      // Just check if the provided key is in the list
      return validKeys.includes(clientKey)
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') {
        logger.error('Failed to read client API keys file', {
          trainId,
          error: err.message,
        })
      }
      return false
    }
  }

  async getSlackConfig(_trainId: string): Promise<SlackConfig | null> {
    // Filesystem mode doesn't support Slack config at train level
    // Slack config is stored at account level in ClaudeCredentials
    // Return null - caller should get Slack config from account credentials
    return null
  }

  private resolveClientKeysPath(trainId: string): string | null {
    const sanitized = this.sanitizeIdentifier(trainId)
    if (!sanitized) {
      return null
    }

    const filePath = path.resolve(this.clientKeysDir, `${sanitized}${CLIENT_KEY_FILENAME_SUFFIX}`)

    // Basic path traversal check
    const normalizedBase = path.resolve(this.clientKeysDir) + path.sep
    const normalizedCandidate = path.resolve(filePath)

    if (!normalizedCandidate.startsWith(normalizedBase)) {
      logger.error('Path traversal attempt detected', {
        metadata: {
          baseDir: normalizedBase,
          candidate: normalizedCandidate,
        },
      })
      return null
    }

    return filePath
  }

  private sanitizeIdentifier(value?: string | null): string | null {
    if (!value) {
      return null
    }

    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }

    if (!IDENTIFIER_REGEX.test(trimmed)) {
      return null
    }

    return trimmed
  }
}
