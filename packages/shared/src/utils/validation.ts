import { z } from 'zod'

/**
 * Common validation utilities and patterns used across the application
 *
 * SECURITY NOTES:
 * - JWT regex only validates format, NOT security. Use a proper JWT library for verification.
 * - Database URL patterns contain credentials - handle with extreme care.
 * - All regex patterns have been reviewed for ReDoS vulnerability.
 */

// ============================================================================
// Regular Expression Patterns
// ============================================================================

/**
 * UUID validation pattern (any version)
 * Matches: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx where x is hex
 */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Anthropic API key pattern
 * Matches: sk-ant-xxxxx
 */
export const ANTHROPIC_API_KEY_REGEX = /^sk-ant-[a-zA-Z0-9-_]+$/

/**
 * Agent Prompt Train API key pattern
 * Matches: cnp_live_xxxxx or cnp_test_xxxxx
 */
export const CNP_API_KEY_REGEX = /^cnp_(live|test)_[a-zA-Z0-9_]+$/

/**
 * JWT token pattern
 * Matches: header.payload.signature format
 */
export const JWT_TOKEN_REGEX = /^eyJ[a-zA-Z0-9-_]+\.eyJ[a-zA-Z0-9-_]+\.[a-zA-Z0-9-_]+$/

/**
 * Email address pattern (simplified but effective)
 */
export const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/

/**
 * Train identifier pattern
 * Matches: letters, numbers, dots, dashes, underscores, and colons
 */
export const TRAIN_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/

/**
 * Database URL patterns
 */
export const DATABASE_URL_PATTERNS = {
  postgresql: /^postgresql:\/\/[^@]+@[^/]+\/\w+/,
  mysql: /^mysql:\/\/[^@]+@[^/]+\/\w+/,
  mongodb: /^mongodb(\+srv)?:\/\/[^@]+@[^/]+\/\w+/,
}

/**
 * Bearer token Authorization header pattern
 * Matches: Bearer <jwt>
 */
export const BEARER_TOKEN_REGEX =
  /^Bearer\s+(eyJ[a-zA-Z0-9-_]+\.eyJ[a-zA-Z0-9-_]+\.[a-zA-Z0-9-_]+)$/

/**
 * URL-friendly slug pattern
 * Matches: my-resource-name-123
 */
export const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Common Content-Type patterns
 */
export const CONTENT_TYPE_PATTERNS = {
  json: /^application\/json(?:;.*)?$/,
  text: /^text\/plain(?:;.*)?$/,
  formUrlEncoded: /^application\/x-www-form-urlencoded(?:;.*)?$/,
  multipart: /^multipart\/form-data(?:;.*)?$/,
}

/**
 * Semantic Versioning (SemVer) 2.0.0 pattern
 * See: https://semver.org/
 */
export const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validates if a string is a valid UUID
 */
export function isValidUUID(value: string): boolean {
  return UUID_REGEX.test(value)
}

/**
 * Validates if a string is a valid Anthropic API key
 */
export function isValidAnthropicApiKey(value: string): boolean {
  return ANTHROPIC_API_KEY_REGEX.test(value)
}

/**
 * Validates if a string is a valid CNP API key
 */
export function isValidCNPApiKey(value: string): boolean {
  return CNP_API_KEY_REGEX.test(value)
}

/**
 * Validates if a string is a valid JWT token format
 */
export function isValidJWT(value: string): boolean {
  return JWT_TOKEN_REGEX.test(value)
}

/**
 * Validates if a string is a valid email address
 */
export function isValidEmail(value: string): boolean {
  return EMAIL_REGEX.test(value)
}

/**
 * Validates if a string is a valid train identifier
 */
export function isValidTrainId(value: string): boolean {
  return TRAIN_ID_REGEX.test(value)
}

/**
 * Validates if a string is a valid database URL
 */
export function isValidDatabaseUrl(
  value: string,
  type?: keyof typeof DATABASE_URL_PATTERNS
): boolean {
  if (type) {
    return DATABASE_URL_PATTERNS[type].test(value)
  }
  // Check against all patterns
  return Object.values(DATABASE_URL_PATTERNS).some(pattern => pattern.test(value))
}

/**
 * Validates if a string is a valid Bearer token header
 */
export function isValidBearerToken(value: string): boolean {
  return BEARER_TOKEN_REGEX.test(value)
}

/**
 * Validates if a string is a valid URL slug
 */
export function isValidSlug(value: string): boolean {
  return SLUG_REGEX.test(value)
}

/**
 * Validates if a string is a valid Content-Type header
 */
export function isValidContentType(
  value: string,
  type?: keyof typeof CONTENT_TYPE_PATTERNS
): boolean {
  if (type) {
    return CONTENT_TYPE_PATTERNS[type].test(value)
  }
  return Object.values(CONTENT_TYPE_PATTERNS).some(pattern => pattern.test(value))
}

/**
 * Validates if a string is a valid semantic version
 */
export function isValidSemver(value: string): boolean {
  return SEMVER_REGEX.test(value)
}

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * UUID string schema
 */
export const uuidSchema = z.string().uuid()

/**
 * UUID string schema with custom error message
 */
export const uuidSchemaWithMessage = (fieldName: string) =>
  z.string().uuid({ message: `${fieldName} must be a valid UUID` })

/**
 * Anthropic API key schema with length validation
 */
export const anthropicApiKeySchema = z
  .string()
  .regex(ANTHROPIC_API_KEY_REGEX, 'Must be a valid Anthropic API key (sk-ant-...)')
  .min(20, 'API key too short')
  .max(200, 'API key too long')

/**
 * CNP API key schema with length validation
 */
export const cnpApiKeySchema = z
  .string()
  .regex(CNP_API_KEY_REGEX, 'Must be a valid CNP API key (cnp_live_... or cnp_test_...)')
  .min(10, 'API key too short')
  .max(100, 'API key too long')

/**
 * JWT token schema (format only - does NOT validate signature/claims)
 * WARNING: This only checks format. Use a proper JWT library for security validation.
 */
export const jwtTokenSchema = z.string().regex(JWT_TOKEN_REGEX, 'Must be a valid JWT token format')

/**
 * Email schema
 */
export const emailSchema = z.string().email()

/**
 * Domain schema
 */
export const trainIdSchema = z.string().regex(TRAIN_ID_REGEX, 'Must be a valid train identifier')

/**
 * Database URL schema
 */
export const databaseUrlSchema = z
  .string()
  .refine(
    value => isValidDatabaseUrl(value),
    'Must be a valid database URL (postgresql://, mysql://, or mongodb://)'
  )

/**
 * Paginated request query params schema
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
})

/**
 * Date range query params schema
 */
export const dateRangeSchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
})

/**
 * Common ID parameter schema
 */
export const idParamSchema = z.object({
  id: uuidSchema,
})

/**
 * Conversation and branch ID params schema
 */
export const conversationBranchParamsSchema = z.object({
  conversationId: uuidSchema,
  branchId: z.string().min(1),
})

/**
 * Bearer token Authorization header schema
 */
export const bearerTokenSchema = z
  .string()
  .regex(BEARER_TOKEN_REGEX, 'Must be a valid Bearer token')
  .transform(match => {
    // Extract just the token part
    const matches = match.match(BEARER_TOKEN_REGEX)
    return matches ? matches[1] : match
  })

/**
 * URL slug schema
 */
export const slugSchema = z
  .string()
  .regex(SLUG_REGEX, 'Must be a valid URL slug (lowercase letters, numbers, and hyphens)')
  .min(1, 'Slug cannot be empty')
  .max(100, 'Slug too long')

/**
 * Content-Type header schema
 */
export const contentTypeSchema = z
  .string()
  .refine(value => isValidContentType(value), 'Invalid Content-Type header')

/**
 * Semantic version schema
 */
export const semverSchema = z
  .string()
  .regex(SEMVER_REGEX, 'Must be a valid semantic version (e.g., 1.0.0, 2.1.0-beta.1)')

// ============================================================================
// Sanitization Functions
// ============================================================================

/**
 * Masks sensitive data in strings for logging
 */
export function maskSensitiveData(text: string): string {
  return (
    text
      // Mask Anthropic API keys
      .replace(/sk-ant-[a-zA-Z0-9-_]+/g, 'sk-ant-****')
      // Mask CNP API keys
      .replace(/cnp_(live|test)_[a-zA-Z0-9_]+/g, 'cnp_$1_****')
      // Mask Bearer tokens
      .replace(/Bearer\s+[\w\-._~+/]+/g, 'Bearer ****')
      // Mask emails
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '****@****.com')
      // Mask database URLs
      .replace(/postgresql:\/\/[^@]+@[^/]+\/\w+/g, 'postgresql://****:****@****/****')
      .replace(/mysql:\/\/[^@]+@[^/]+\/\w+/g, 'mysql://****:****@****/****')
      .replace(/mongodb(\+srv)?:\/\/[^@]+@[^/]+\/\w+/g, 'mongodb$1://****:****@****/****')
  )
}

/**
 * Truncates long strings for display
 */
export function truncateString(str: string, maxLength: number = 1000): string {
  if (str.length <= maxLength) {
    return str
  }
  return str.substring(0, maxLength) + '...'
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if value is a valid UUID
 */
export function isUUID(value: unknown): value is string {
  return typeof value === 'string' && isValidUUID(value)
}

/**
 * Type guard to check if value is a non-empty string
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validates request size
 */
export function validateRequestSize(sizeInBytes: number, maxSizeInMB: number = 10): boolean {
  const maxSizeInBytes = maxSizeInMB * 1024 * 1024
  return sizeInBytes <= maxSizeInBytes
}

/**
 * Creates a Zod schema for enum-like string unions
 * Note: Due to TypeScript limitations with const assertions and Zod's enum type,
 * you may need to use z.enum directly for complex cases
 */
export function createEnumSchema<T extends [string, ...string[]]>(
  values: T,
  options?: { message?: string }
): z.ZodEnum<T> {
  return z.enum(values, options)
}

// Export commonly used Zod utilities for convenience
export { z } from 'zod'
