# ADR-004: Proxy-Level Authentication with Domain-Specific API Keys

## Status

Accepted

## Context

The Agent Prompt Train initially operated as an open relay, forwarding any request to the Claude API as long as the train (inferred from the Host header) had valid Claude credentials. This created security risks:

- Anyone knowing the proxy endpoint could use it
- No way to revoke access without changing Claude API keys
- No audit trail of who is using the proxy
- Potential for abuse and unexpected costs

We needed a way to authenticate clients at the proxy level while maintaining backward compatibility and not requiring changes to existing Claude API client libraries.

## Decision Drivers

- **Security**: Prevent unauthorized proxy usage
- **Backward Compatibility**: Don't break existing deployments
- **Simplicity**: Easy to implement and understand
- **Standards Compliance**: Use established authentication patterns
- **Performance**: Minimal overhead on request processing
- **Flexibility**: Support different authentication needs per project

## Considered Options

1. **IP Whitelisting**
   - Description: Allow only specific IP addresses
   - Pros: Simple, no client changes needed
   - Cons: Inflexible, breaks with dynamic IPs, hard to manage

2. **OAuth/JWT Tokens**
   - Description: Full OAuth flow with JWT tokens
   - Pros: Industry standard, supports rotation, fine-grained permissions
   - Cons: Complex implementation, requires client changes, overkill for proxy auth

3. **HTTP Basic Authentication**
   - Description: Username/password in Authorization header
   - Pros: Simple, widely supported
   - Cons: Credentials visible in logs, less secure than Bearer tokens

4. **Custom Header Authentication**
   - Description: Custom header like `X-Proxy-Key`
   - Pros: Simple implementation
   - Cons: Non-standard, harder to integrate with existing tools

5. **Bearer Token Authentication**
   - Description: Standard Bearer token in Authorization header
   - Pros: OAuth 2.0 standard, secure, widely supported
   - Cons: Requires key management

## Decision

We will implement **Bearer Token Authentication** with train-specific API keys stored in credential files.

### Implementation Details

1. **Authentication Flow**:

   ```
   Client → Proxy: Authorization: Bearer cnp_live_xxx...
   Proxy: Extract train ID and optional account headers
   Proxy: Load credentials/project-client-keys/<train>.client-keys.json
   Proxy: Compare tokens using timing-safe SHA-256
   Proxy: Select account credential (header or deterministic hash of train)
   Proxy → Claude: Forward if authenticated
   ```

2. **Credential Structure**:

   ```json
   {
     "type": "api_key",
     "accountId": "acc_unique_id",
     "api_key": "sk-ant-..." // Claude API key
   }
   ```

3. **Security Measures**:
   - SHA-256 hashing before comparison (timing-safe)
   - Account credential files guarded against path traversal
   - No fallback credentials when no account files exist
   - WWW-Authenticate header on 401 responses

4. **Key Format**:
   - Prefix: `cnp_live_` for production, `cnp_test_` for testing
   - Body: 32 bytes of cryptographically secure random data
   - Encoding: Base64URL (URL-safe, no padding)

## Consequences

### Positive

- **Enhanced Security**: Only authorized clients can use the proxy
- **Per-Train Control**: Each train has independent authentication
- **Standards Compliance**: Uses OAuth 2.0 Bearer token standard
- **Audit Trail**: All authentication attempts are logged
- **Backward Compatible**: Can be disabled via `ENABLE_CLIENT_AUTH=false`
- **No Client Library Changes**: Works with standard HTTP Authorization header

### Negative

- **Key Management**: Additional keys to generate and distribute
- **No Built-in Rotation**: Manual process to rotate keys
- **Single Key per Train**: No support for multiple keys per project
- **No Rate Limiting**: Authentication doesn't include rate limiting

### Risks and Mitigations

- **Risk**: Leaked client API keys
  - **Mitigation**: Keys can be revoked by updating credential files
  - **Mitigation**: Keys are train-specific, limiting blast radius

- **Risk**: Timing attacks on key comparison
  - **Mitigation**: SHA-256 hashing ensures constant-time comparison

- **Risk**: Path traversal attacks
  - **Mitigation**: Domain validation and path sanitization

## Implementation Notes

- Introduced in PR #2
- Two new middleware components: `trainIdExtractorMiddleware` and `clientAuthMiddleware`
- 11 test cases with 91.53% code coverage
- Script provided for key generation: `scripts/generate-api-key.ts`

## Future Enhancements

1. **Key Rotation**: Automated key rotation with grace period
2. **Multiple Keys**: Support multiple valid keys per project
3. **Key Expiration**: Time-limited keys
4. **Rate Limiting**: Per-key rate limiting
5. **API Key Management**: API endpoints for key management

## Links

- [PR #2: Proxy-level authentication](https://github.com/Moonsong-Labs/agent-prompttrain/pull/2)
- [Security Guide](../../03-Operations/security.md)
- [Authentication Guide](../../02-User-Guide/authentication.md)

---

Date: 2024-06-25
Authors: Development Team
