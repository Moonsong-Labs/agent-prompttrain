# Validation Utilities

This module provides comprehensive validation utilities for the Agent Prompt Train project, eliminating code duplication and ensuring consistent validation across all services.

## Overview

The validation utilities include:

- Regular expression patterns for common validation scenarios
- Validation functions for runtime checks
- Zod schemas for type-safe validation
- Sanitization functions for security
- Type guards for type narrowing
- Helper functions for common validation tasks

## Usage

### Import from Shared Package

```typescript
import {
  isValidUUID,
  uuidSchema,
  maskSensitiveData,
} from '@agent-prompttrain/shared/utils/validation'

// Or import everything
import * as validation from '@agent-prompttrain/shared/utils/validation'
```

### Regular Expression Patterns

```typescript
import { UUID_REGEX, ANTHROPIC_API_KEY_REGEX } from '@agent-prompttrain/shared/utils/validation'

// Use directly
if (UUID_REGEX.test(someString)) {
  // Valid UUID
}

// Use in your own regex
const pattern = new RegExp(`^user-${UUID_REGEX.source}$`)
```

### Validation Functions

```typescript
import {
  isValidUUID,
  isValidEmail,
  isValidAnthropicApiKey,
} from '@agent-prompttrain/shared/utils/validation'

// Simple boolean checks
if (isValidUUID(conversationId)) {
  // Process valid UUID
}

if (isValidAnthropicApiKey(apiKey)) {
  // Valid Anthropic API key
}
```

### Zod Schemas

```typescript
import {
  uuidSchema,
  emailSchema,
  paginationSchema,
} from '@agent-prompttrain/shared/utils/validation'

// Use in API endpoints
const params = paginationSchema.parse(req.query)

// Use in your own schemas
const userSchema = z.object({
  id: uuidSchema,
  email: emailSchema,
  name: z.string(),
})
```

### Sanitization Functions

```typescript
import { maskSensitiveData, truncateString } from '@agent-prompttrain/shared/utils/validation'

// Mask sensitive data for logging
const safeMessage = maskSensitiveData('API key: sk-ant-abc123')
console.log(safeMessage) // "API key: sk-ant-****"

// Truncate long strings
const shortMessage = truncateString(longErrorMessage, 500)
```

### Type Guards

```typescript
import { isUUID, isNonEmptyString } from '@agent-prompttrain/shared/utils/validation'

function processId(value: unknown) {
  if (isUUID(value)) {
    // TypeScript knows value is string here
    return value.toLowerCase()
  }
  throw new Error('Invalid UUID')
}
```

## Available Utilities

### Regex Patterns

- `UUID_REGEX` - Validates any version UUID
- `ANTHROPIC_API_KEY_REGEX` - Validates sk-ant-\* keys
- `CNP_API_KEY_REGEX` - Validates cnp*live*_ or cnp*test*_ keys
- `JWT_TOKEN_REGEX` - Validates JWT token format (WARNING: format only, not security)
- `EMAIL_REGEX` - Validates email addresses
- `TRAIN_ID_REGEX` - Validates train identifiers (ReDoS-safe)
- `DATABASE_URL_PATTERNS` - Object with postgresql, mysql, mongodb patterns
- `BEARER_TOKEN_REGEX` - Validates Bearer token Authorization headers
- `SLUG_REGEX` - Validates URL-friendly slugs
- `CONTENT_TYPE_PATTERNS` - Common Content-Type header patterns
- `SEMVER_REGEX` - Semantic versioning validation

### Validation Functions

- `isValidUUID(value: string): boolean`
- `isValidAnthropicApiKey(value: string): boolean`
- `isValidCNPApiKey(value: string): boolean`
- `isValidJWT(value: string): boolean`
- `isValidEmail(value: string): boolean`
- `isValidTrainId(value: string): boolean`
- `isValidDatabaseUrl(value: string, type?: 'postgresql' | 'mysql' | 'mongodb'): boolean`
- `isValidBearerToken(value: string): boolean`
- `isValidSlug(value: string): boolean`
- `isValidContentType(value: string, type?: 'json' | 'text' | 'formUrlEncoded' | 'multipart'): boolean`
- `isValidSemver(value: string): boolean`

### Zod Schemas

- `uuidSchema` - UUID string validation
- `anthropicApiKeySchema` - Anthropic API key validation (with length constraints)
- `cnpApiKeySchema` - CNP API key validation (with length constraints)
- `jwtTokenSchema` - JWT token format validation (WARNING: format only)
- `emailSchema` - Email validation
- `trainIdSchema` - Train ID validation
- `databaseUrlSchema` - Database URL validation
- `paginationSchema` - Pagination parameters with defaults
- `dateRangeSchema` - Date range validation
- `conversationBranchParamsSchema` - Conversation ID and branch validation
- `bearerTokenSchema` - Bearer token with auto-extraction
- `slugSchema` - URL slug validation with length limits
- `contentTypeSchema` - Content-Type header validation
- `semverSchema` - Semantic version validation

### Sanitization Functions

- `maskSensitiveData(text: string): string` - Masks API keys, emails, database URLs
- `truncateString(str: string, maxLength?: number): string` - Truncates with ellipsis

### Type Guards

- `isUUID(value: unknown): value is string` - Type guard for UUID strings
- `isNonEmptyString(value: unknown): value is string` - Type guard for non-empty strings

### Helper Functions

- `validateRequestSize(sizeInBytes: number, maxSizeInMB?: number): boolean`
- `createEnumSchema<T>(values: T, options?): z.ZodEnum<T>` - Create enum schemas

## Examples

### API Endpoint Validation

```typescript
import { conversationBranchParamsSchema } from '@agent-prompttrain/shared/utils/validation'

app.get('/api/analyses/:conversationId/:branchId', async c => {
  try {
    const params = conversationBranchParamsSchema.parse(c.req.param())
    // params.conversationId is guaranteed to be a valid UUID
    // params.branchId is guaranteed to be a non-empty string
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Invalid parameters', details: error.errors }, 400)
    }
  }
})
```

### Secure Logging

```typescript
import { maskSensitiveData, truncateString } from '@agent-prompttrain/shared/utils/validation'

function logError(error: Error) {
  const safeMessage = maskSensitiveData(error.message)
  const truncatedStack = truncateString(error.stack || '', 2000)

  logger.error('Error occurred', {
    message: safeMessage,
    stack: maskSensitiveData(truncatedStack),
  })
}
```

### Custom Validation Schemas

```typescript
import { z, uuidSchema, emailSchema } from '@agent-prompttrain/shared/utils/validation'

const createUserSchema = z.object({
  email: emailSchema,
  password: z.string().min(8),
  organizationId: uuidSchema.optional(),
  role: z.enum(['admin', 'user', 'guest']),
})

const updateUserSchema = createUserSchema.partial()
```

## Migration Guide

If you're updating existing code to use these utilities:

1. Replace manual UUID regex patterns:

   ```typescript
   // Before
   const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
   if (!uuidRegex.test(id)) { ... }

   // After
   import { isValidUUID } from '@agent-prompttrain/shared/utils/validation'
   if (!isValidUUID(id)) { ... }
   ```

2. Replace Zod UUID validation:

   ```typescript
   // Before
   const schema = z.object({
     id: z.string().uuid(),
   })

   // After
   import { uuidSchema } from '@agent-prompttrain/shared/utils/validation'
   const schema = z.object({
     id: uuidSchema,
   })
   ```

3. Replace manual sanitization:

   ```typescript
   // Before
   message.replace(/sk-ant-[\w-]+/g, 'sk-ant-****')

   // After
   import { maskSensitiveData } from '@agent-prompttrain/shared/utils/validation'
   const safe = maskSensitiveData(message)
   ```

## Security Considerations

### JWT Token Validation

**CRITICAL**: The `JWT_TOKEN_REGEX` and `jwtTokenSchema` only validate the _format_ of a JWT token. They do NOT perform security validation. For actual JWT validation, you MUST:

1. Verify the signature using the correct secret/public key
2. Check expiration (`exp` claim)
3. Validate issuer (`iss`) and audience (`aud`) claims
4. Check the `nbf` (not before) claim

Use a proper JWT library like `jose` or `jsonwebtoken`:

```typescript
import { jwtTokenSchema } from '@agent-prompttrain/shared/utils/validation'
import { jwtVerify } from 'jose'

// First check format
const token = jwtTokenSchema.parse(authHeader.replace('Bearer ', ''))

// Then perform actual security validation
try {
  const { payload } = await jwtVerify(token, secret)
  // Check claims...
} catch (error) {
  // Token is invalid or expired
}
```

### Database URL Handling

Database URLs contain credentials and should be handled with extreme care:

- Only use for server-side configuration validation
- Never log or expose in error messages
- Never send to client-side code
- Store securely (environment variables, secret management)

### ReDoS Prevention

All regex patterns have been reviewed for ReDoS vulnerabilities. The train identifier regex was specifically simplified to prevent potential attacks. When adding new patterns:

1. Avoid nested quantifiers (e.g., `(a+)+`)
2. Be careful with alternation and optional groups
3. Test with very long inputs
4. Consider using library functions instead of complex regex

## Testing

All validation utilities are thoroughly tested. See `__tests__/validation.test.ts` for examples of how to test code using these utilities.
