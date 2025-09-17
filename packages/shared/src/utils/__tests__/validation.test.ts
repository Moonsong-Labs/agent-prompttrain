import { describe, it, expect } from 'bun:test'
import {
  // Regex patterns
  UUID_REGEX,

  // Validation functions
  isValidUUID,
  isValidAnthropicApiKey,
  isValidCNPApiKey,
  isValidJWT,
  isValidEmail,
  isValidTrainId,
  isValidDatabaseUrl,

  // Zod schemas
  uuidSchema,
  anthropicApiKeySchema,
  cnpApiKeySchema,
  jwtTokenSchema,
  emailSchema,
  trainIdSchema,
  databaseUrlSchema,
  paginationSchema,
  dateRangeSchema,
  conversationBranchParamsSchema,

  // Sanitization functions
  maskSensitiveData,
  truncateString,

  // Type guards
  isUUID,
  isNonEmptyString,

  // Helpers
  validateRequestSize,
} from '../validation'

describe('Validation Utilities', () => {
  describe('UUID Validation', () => {
    it('should validate correct UUIDs', () => {
      const validUUIDs = [
        '123e4567-e89b-12d3-a456-426614174000',
        '550e8400-e29b-41d4-a716-446655440000',
        'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      ]

      validUUIDs.forEach(uuid => {
        expect(isValidUUID(uuid)).toBe(true)
        expect(UUID_REGEX.test(uuid)).toBe(true)
        expect(() => uuidSchema.parse(uuid)).not.toThrow()
      })
    })

    it('should reject invalid UUIDs', () => {
      const invalidUUIDs = [
        '123e4567-e89b-12d3-a456',
        'not-a-uuid',
        '123e456-e89b-12d3-a456-426614174000', // too few digits in first segment
        '',
      ]

      invalidUUIDs.forEach(uuid => {
        expect(isValidUUID(uuid)).toBe(false)
        expect(UUID_REGEX.test(uuid)).toBe(false)
        expect(() => uuidSchema.parse(uuid)).toThrow()
      })
    })
  })

  describe('API Key Validation', () => {
    it('should validate Anthropic API keys', () => {
      const validKeys = [
        'sk-ant-api03-abc123def456ghi789',
        'sk-ant-test-key-123456789abcdef',
        'sk-ant-prod_key_456789abcdefghi',
      ]

      validKeys.forEach(key => {
        expect(isValidAnthropicApiKey(key)).toBe(true)
        expect(() => anthropicApiKeySchema.parse(key)).not.toThrow()
      })
    })

    it('should validate CNP API keys', () => {
      const validKeys = ['cnp_live_abc123', 'cnp_test_xyz789', 'cnp_live_production_key_123']

      validKeys.forEach(key => {
        expect(isValidCNPApiKey(key)).toBe(true)
        expect(() => cnpApiKeySchema.parse(key)).not.toThrow()
      })
    })

    it('should reject invalid API keys', () => {
      expect(isValidAnthropicApiKey('invalid-key')).toBe(false)
      expect(isValidCNPApiKey('cnp_invalid_key')).toBe(false)
      expect(isValidCNPApiKey('cnp_staging_key')).toBe(false) // only live/test allowed
    })
  })

  describe('JWT Validation', () => {
    it('should validate JWT tokens', () => {
      const validJWT =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'

      expect(isValidJWT(validJWT)).toBe(true)
      expect(() => jwtTokenSchema.parse(validJWT)).not.toThrow()
    })

    it('should reject invalid JWT tokens', () => {
      const invalidJWTs = [
        'not.a.jwt',
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', // missing parts
        'invalid-jwt-token',
      ]

      invalidJWTs.forEach(jwt => {
        expect(isValidJWT(jwt)).toBe(false)
      })
    })
  })

  describe('Email Validation', () => {
    it('should validate email addresses', () => {
      const validEmails = ['test@example.com', 'user.name@domain.co.uk', 'admin+tag@company.org']

      validEmails.forEach(email => {
        expect(isValidEmail(email)).toBe(true)
        expect(() => emailSchema.parse(email)).not.toThrow()
      })
    })

    it('should reject invalid emails', () => {
      const invalidEmails = ['not-an-email', '@example.com', 'user@', 'user@.com']

      invalidEmails.forEach(email => {
        expect(isValidEmail(email)).toBe(false)
      })
    })
  })

  describe('Train ID Validation', () => {
    it('should validate train identifiers', () => {
      const validTrainIds = ['train-alpha', 'train.alpha', 'train_alpha', 'train-beta:preview', 'alpha123']

      validTrainIds.forEach(trainId => {
        expect(isValidTrainId(trainId)).toBe(true)
        expect(() => trainIdSchema.parse(trainId)).not.toThrow()
      })
    })

    it('should reject invalid train identifiers', () => {
      const invalidTrainIds = ['../secrets', 'train/alpha', 'train alpha', '', 'alpha@beta', '-leadingdash']

      invalidTrainIds.forEach(trainId => {
        expect(isValidTrainId(trainId)).toBe(false)
      })
    })
  })

  describe('Database URL Validation', () => {
    it('should validate database URLs', () => {
      const validUrls = [
        'postgresql://user:pass@localhost:5432/mydb',
        'mysql://root:password@mysql.example.com/database',
        'mongodb://admin:secret@mongo.example.com/testdb',
        'mongodb+srv://user:pass@cluster.mongodb.net/mydb',
      ]

      validUrls.forEach(url => {
        expect(isValidDatabaseUrl(url)).toBe(true)
        expect(() => databaseUrlSchema.parse(url)).not.toThrow()
      })
    })

    it('should validate specific database URL types', () => {
      expect(isValidDatabaseUrl('postgresql://user:pass@localhost/db', 'postgresql')).toBe(true)
      expect(isValidDatabaseUrl('mysql://user:pass@localhost/db', 'mysql')).toBe(true)
      expect(isValidDatabaseUrl('mongodb://user:pass@localhost/db', 'mongodb')).toBe(true)

      // Wrong type should fail
      expect(isValidDatabaseUrl('postgresql://user:pass@localhost/db', 'mysql')).toBe(false)
    })
  })

  describe('Sanitization Functions', () => {
    it('should mask sensitive data', () => {
      const input = 'API key: sk-ant-abc123, email: test@example.com, Bearer eyJhbGc.eyJzdWI.SflKxw'
      const masked = maskSensitiveData(input)

      expect(masked).toContain('sk-ant-****')
      expect(masked).toContain('****@****.com')
      expect(masked).toContain('Bearer ****')
      expect(masked).not.toContain('sk-ant-abc123')
      expect(masked).not.toContain('test@example.com')
    })

    it('should mask database URLs', () => {
      const input = 'Database: postgresql://user:password@localhost:5432/mydb'
      const masked = maskSensitiveData(input)

      expect(masked).toContain('postgresql://****:****@****/****')
      expect(masked).not.toContain('user:password')
    })

    it('should truncate long strings', () => {
      const longString = 'a'.repeat(2000)
      const truncated = truncateString(longString, 100)

      expect(truncated).toHaveLength(103) // 100 + '...'
      expect(truncated).toEndWith('...')
    })
  })

  describe('Type Guards', () => {
    it('should correctly identify UUIDs', () => {
      expect(isUUID('123e4567-e89b-12d3-a456-426614174000')).toBe(true)
      expect(isUUID('not-a-uuid')).toBe(false)
      expect(isUUID(123)).toBe(false)
      expect(isUUID(null)).toBe(false)
    })

    it('should correctly identify non-empty strings', () => {
      expect(isNonEmptyString('hello')).toBe(true)
      expect(isNonEmptyString('  hello  ')).toBe(true)
      expect(isNonEmptyString('')).toBe(false)
      expect(isNonEmptyString('   ')).toBe(false)
      expect(isNonEmptyString(123)).toBe(false)
    })
  })

  describe('Validation Helpers', () => {
    it('should validate request size', () => {
      const oneMB = 1024 * 1024

      expect(validateRequestSize(5 * oneMB, 10)).toBe(true)
      expect(validateRequestSize(15 * oneMB, 10)).toBe(false)
      expect(validateRequestSize(10 * oneMB, 10)).toBe(true) // exactly at limit
    })
  })

  describe('Zod Schema Integration', () => {
    it('should validate pagination params', () => {
      const valid = { page: 1, limit: 20 }
      const parsed = paginationSchema.parse(valid)

      expect(parsed.page).toBe(1)
      expect(parsed.limit).toBe(20)
      expect(parsed.sortOrder).toBe('desc')
    })

    it('should coerce pagination string values', () => {
      const stringParams = { page: '2', limit: '50' }
      const parsed = paginationSchema.parse(stringParams)

      expect(parsed.page).toBe(2)
      expect(parsed.limit).toBe(50)
    })

    it('should validate date range params', () => {
      const valid = {
        startDate: '2024-01-01T00:00:00Z',
        endDate: '2024-12-31T23:59:59Z',
      }

      expect(() => dateRangeSchema.parse(valid)).not.toThrow()
    })

    it('should validate conversation branch params', () => {
      const valid = {
        conversationId: '123e4567-e89b-12d3-a456-426614174000',
        branchId: 'main',
      }

      const parsed = conversationBranchParamsSchema.parse(valid)
      expect(parsed.conversationId).toBe(valid.conversationId)
      expect(parsed.branchId).toBe('main')
    })
  })
})
