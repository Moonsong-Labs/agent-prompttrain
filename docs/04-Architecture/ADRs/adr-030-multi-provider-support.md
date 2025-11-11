# ADR-030: Multi-Provider Support for Claude API Access

## Status

Accepted

## Context

The proxy service was initially designed to work exclusively with Anthropic's direct API using OAuth2 authentication. However, users may want to access Claude models through alternative providers like AWS Bedrock, which offers different pricing, regional availability, and integration options within AWS infrastructure.

Adding multi-provider support requires:

- Supporting multiple authentication methods (OAuth2 vs API keys)
- Handling different API endpoint formats and parameters
- Mapping model identifiers between providers
- Maintaining a unified interface for credential management
- Ensuring backward compatibility with existing Anthropic credentials

## Decision Drivers

- **Flexibility**: Enable users to choose their preferred provider based on pricing, region, or infrastructure requirements
- **AWS Integration**: Many organizations already use AWS and prefer consolidated billing and IAM integration
- **Model Availability**: Different providers may have different model availability or regional restrictions
- **Type Safety**: Maintain strong TypeScript type safety across different credential types
- **Backward Compatibility**: Existing Anthropic OAuth credentials must continue working without migration
- **Simplicity**: Avoid over-engineering with complex provider abstraction layers

## Considered Options

1. **Separate Credential Tables Per Provider**
   - Description: Create separate tables for each provider (anthropic_credentials, bedrock_credentials)
   - Pros: Clear separation, easy to query provider-specific fields
   - Cons: Requires JOIN operations, complicates project-credential relationships, harder to add new providers

2. **Unified Credentials Table with Provider Discriminator**
   - Description: Single credentials table with provider column and nullable provider-specific fields
   - Pros: Simple project relationships, easy to add providers, single source of truth
   - Cons: Nullable columns, requires validation constraints

3. **Abstract Provider Plugin System**
   - Description: Create a plugin architecture with provider-specific implementations
   - Pros: Highly extensible, clean separation
   - Cons: Over-engineered for current needs, complex to maintain, harder to debug

## Decision

We will implement **Option 2: Unified Credentials Table with Provider Discriminator**.

### Implementation Details

**Database Schema:**

```sql
CREATE TABLE credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id TEXT NOT NULL UNIQUE,
  account_name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'bedrock')),

  -- Anthropic OAuth fields (nullable)
  oauth_access_token TEXT,
  oauth_refresh_token TEXT,
  oauth_expires_at TIMESTAMPTZ,
  oauth_scopes TEXT[],
  oauth_is_max BOOLEAN,
  last_refresh_at TIMESTAMPTZ,

  -- AWS Bedrock fields (nullable)
  aws_api_key TEXT,
  aws_region TEXT DEFAULT 'us-east-1',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Ensure provider-specific fields are populated
  CONSTRAINT credentials_provider_check CHECK (
    (provider = 'anthropic' AND oauth_access_token IS NOT NULL) OR
    (provider = 'bedrock' AND aws_api_key IS NOT NULL)
  )
);
```

**TypeScript Types (Discriminated Union):**

```typescript
export type ProviderType = 'anthropic' | 'bedrock'

export interface AnthropicCredential extends BaseCredential {
  provider: 'anthropic'
  oauth_access_token: string
  oauth_refresh_token: string
  oauth_expires_at: Date
  oauth_scopes: string[]
  oauth_is_max: boolean
  last_refresh_at: Date | null
  aws_api_key?: never
  aws_region?: never
}

export interface BedrockCredential extends BaseCredential {
  provider: 'bedrock'
  aws_api_key: string
  aws_region: string
  oauth_access_token?: never
  oauth_refresh_token?: never
  oauth_expires_at?: never
  oauth_scopes?: never
  oauth_is_max?: never
  last_refresh_at?: never
}

export type Credential = AnthropicCredential | BedrockCredential
```

**Model Mapping:**

```typescript
// Map Anthropic model IDs to Bedrock equivalents
export const MODEL_MAPPING: Record<string, string> = {
  'claude-sonnet-4-5': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'claude-haiku-4-5': 'us.anthropic.claude-haiku-4-5-20251015-v1:0',
  // ... more mappings
}
```

**Request Routing:**

```typescript
// Proxy service routes based on credential provider
if (auth.provider === 'bedrock') {
  const bedrockClient = new BedrockApiClient({
    region: auth.region || 'us-east-1',
    timeout: 600000,
  })
  claudeResponse = await bedrockClient.forward(request, auth.headers)
} else {
  claudeResponse = await this.apiClient.forward(request, auth)
}
```

**Scripts:**

- `scripts/auth/oauth-login.ts` - Add Anthropic OAuth credentials
- `scripts/auth/bedrock-login.ts` - Add AWS Bedrock credentials (API key)

**Dashboard UI:**

- Provider badges: 🔵 Anthropic (blue) / 🟠 Bedrock (orange)
- Provider-specific details (OAuth expiry vs AWS region)

## Consequences

### Positive

- **Flexibility**: Users can choose between Anthropic direct API or AWS Bedrock
- **Type Safety**: Discriminated unions provide compile-time type safety for provider-specific operations
- **Simple Architecture**: No complex plugin system or multiple tables to maintain
- **Backward Compatible**: Existing Anthropic credentials continue working with zero changes
- **Easy to Extend**: Adding new providers requires minimal changes to existing code
- **Cost Optimization**: Users can leverage AWS Bedrock pricing or Anthropic direct pricing based on their needs

### Negative

- **Nullable Columns**: Database has provider-specific nullable columns
- **Validation Complexity**: Must enforce provider-specific field requirements via constraints
- **Model Mapping Maintenance**: Must keep model ID mappings updated as new models are released

### Risks and Mitigations

- **Risk**: Model ID mappings become outdated as providers release new models
  - **Mitigation**: Allow pass-through of provider-specific model IDs if no mapping found; document mapping update process

- **Risk**: Provider-specific API changes break compatibility
  - **Mitigation**: Encapsulate provider logic in separate client classes (BedrockApiClient, ClaudeApiClient); version API clients

- **Risk**: Database constraints become complex with more providers
  - **Mitigation**: Keep validation in database layer; if complexity grows significantly, consider separate tables

## Links

- [ADR-026: Database Credential Management](./adr-026-database-credential-management.md) - Original credential management design
- [ADR-004: Proxy Authentication](./adr-004-proxy-authentication.md) - Authentication flow
- [Migration 017: Multi-Provider Support](../../scripts/db/migrations/017-multi-provider-support.ts)
- [PR #159: Add AWS Bedrock Provider Support](https://github.com/Moonsong-Labs/agent-prompttrain/pull/159)
- [AWS Bedrock API Documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/)

## Notes

- Projects continue to have a single default credential (no provider-based fail-over)
- Model mapping uses `us.anthropic` prefix for US region Bedrock models
- Bedrock requests require `anthropic_version: 'bedrock-2023-05-31'` in request body
- Bedrock API does not accept `stream` or `model` fields in request body (model is in URL path, streaming mode is in endpoint suffix)
- Dashboard UI uses emojis for quick visual provider identification
- Future providers (e.g., Azure, GCP) can follow the same pattern

---

Date: 2025-11-05
Authors: Claude Code (AI Agent)
