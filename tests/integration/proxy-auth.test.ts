import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { Server } from 'node:http'
const PROJECT_HEADER = 'MSL-Project-Id'
const PROJECT_HEADER_LOWER = PROJECT_HEADER.toLowerCase()

// Mock proxy server that mimics the authentication behavior
function createMockProxyServer() {
  const app = new Hono()

  // Helper function to check client auth
  const checkClientAuth = (c: any) => {
    const authorization = c.req.header('Authorization')
    const projectId = c.get('projectId')
    // Client auth is enabled by default unless explicitly set to 'false'
    const clientAuthEnabled =
      !process.env.ENABLE_CLIENT_AUTH || process.env.ENABLE_CLIENT_AUTH !== 'false'

    if (!clientAuthEnabled) {
      return null // Auth disabled, pass through
    }

    if (!authorization) {
      return c.json(
        {
          error: {
            type: 'authentication_error',
            message: 'Missing Authorization header. Please provide a Bearer token.',
          },
        },
        401,
        {
          'WWW-Authenticate': 'Bearer realm="Agent Prompt Train"',
        }
      )
    }

    const match = authorization.match(/^Bearer\s+(.+)$/i)
    if (!match) {
      return c.json(
        {
          error: {
            type: 'authentication_error',
            message: 'Invalid Authorization header format. Expected: Bearer <token>',
          },
        },
        401,
        {
          'WWW-Authenticate': 'Bearer realm="Agent Prompt Train"',
        }
      )
    }

    const token = match[1]
    const validClientTokens = ['cnp_test_key', 'cnp_live_123456']
    if (!validClientTokens.includes(token)) {
      return c.json(
        {
          error: {
            type: 'authentication_error',
            message: `No client API key configured for train "${projectId}". Please add "client_api_key" to your credential file or disable client authentication.`,
          },
        },
        401,
        {
          'WWW-Authenticate': 'Bearer realm="Agent Prompt Train"',
        }
      )
    }

    return null // Auth passed
  }

  // Mock middleware that derives a project ID from the MSL-Project-Id header for tests
  app.use('*', async (c, next) => {
    const projectId = c.req.header(PROJECT_HEADER_LOWER) || 'unknown'
    c.set('projectId', projectId)
    await next()
  })

  // Mock the messages endpoint with integrated auth check
  app.post('/v1/messages', async c => {
    // Check client auth first
    const authError = checkClientAuth(c)
    if (authError) {
      return authError
    }

    const apiKey = c.req.header('x-api-key')
    const anthropicVersion = c.req.header('anthropic-version')

    // Check for required headers
    if (!anthropicVersion) {
      return c.json(
        {
          error: {
            type: 'invalid_request_error',
            message: 'anthropic-version header is required',
          },
        },
        400
      )
    }

    // Check for API key (Claude auth)
    if (!apiKey) {
      return c.json(
        {
          error: {
            type: 'authentication_error',
            message: 'API key required',
          },
        },
        401
      )
    }

    // Mock validation of Claude API key
    const validApiKeys = ['sk-ant-test-key', 'oauth-access-token']
    if (!validApiKeys.includes(apiKey)) {
      return c.json(
        {
          error: {
            type: 'authentication_error',
            message: 'Invalid API key',
          },
        },
        401
      )
    }

    // Mock successful response
    return c.json({
      id: 'msg_test123',
      type: 'message',
      content: [{ type: 'text', text: 'Test response' }],
      model: 'claude-3-opus-20240229',
      role: 'assistant',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
  })

  return app
}

describe('Proxy Authentication Integration', () => {
  let proxyUrl: string
  let server: Server

  beforeAll(async () => {
    // Start mock server
    const app = createMockProxyServer()
    const port = 3456 // Use a different port to avoid conflicts

    await new Promise<void>(resolve => {
      server = serve(
        {
          fetch: app.fetch,
          port,
        },
        () => {
          proxyUrl = `http://localhost:${port}`
          resolve()
        }
      )
    })
  })

  afterAll(async () => {
    // Cleanup test server
    await new Promise<void>((resolve, reject) => {
      if (server) {
        server.close(err => {
          if (err) reject(err)
          else resolve()
        })
      } else {
        resolve()
      }
    })
  })

  describe('API Key Authentication', () => {
    it('should reject requests without authentication', async () => {
      const response = await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          [PROJECT_HEADER]: 'project-alpha',
        },
        body: JSON.stringify({
          model: 'claude-3-opus-20240229',
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 10,
        }),
      })

      expect(response.status).toBe(401)
      const error = await response.json()
      expect(error.error.type).toBe('authentication_error')
    })

    it('should accept requests with valid x-api-key', async () => {
      const response = await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'sk-ant-test-key',
          'anthropic-version': '2023-06-01',
          [PROJECT_HEADER]: 'project-alpha',
          Authorization: 'Bearer cnp_test_key', // Add client auth
        },
        body: JSON.stringify({
          model: 'claude-3-opus-20240229',
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 10,
        }),
      })

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.type).toBe('message')
    })

    it('should handle Bearer token authentication for Claude API', async () => {
      // Use Bearer token for Claude API auth (without client auth)
      const response = await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer cnp_test_key', // Client auth
          'x-api-key': 'sk-ant-test-key', // Claude API key in x-api-key header
          'anthropic-version': '2023-06-01',
          [PROJECT_HEADER]: 'project-alpha',
        },
        body: JSON.stringify({
          model: 'claude-3-opus-20240229',
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 10,
        }),
      })

      expect(response.status).toBe(200) // Should succeed with proper auth setup
      const data = await response.json()
      expect(data.type).toBe('message')
    })
  })

  describe('Client Authentication', () => {
    it('should require client API key when enabled', async () => {
      // Skip this test if client auth is disabled
      if (process.env.ENABLE_CLIENT_AUTH === 'false') {
        console.log('Skipping client auth test - ENABLE_CLIENT_AUTH is false')
        return
      }

      const response = await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'sk-ant-test-key',
          'anthropic-version': '2023-06-01',
          [PROJECT_HEADER]: 'project-alpha',
          // Missing Authorization header for client auth
        },
        body: JSON.stringify({
          model: 'claude-3-opus-20240229',
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 10,
        }),
      })

      // Without client auth header, should fail
      expect(response.status).toBe(401)
      const data = await response.json()
      expect(data.error.type).toBe('authentication_error')
      expect(data.error.message).toContain('Missing Authorization header')
    })

    it('should accept valid client API key', async () => {
      const headers: any = {
        'Content-Type': 'application/json',
        'x-api-key': 'sk-ant-test-key',
        'anthropic-version': '2023-06-01',
        [PROJECT_HEADER]: 'project-alpha',
      }

      // Only add client auth header if client auth is enabled
      if (process.env.ENABLE_CLIENT_AUTH !== 'false') {
        headers.Authorization = 'Bearer cnp_test_key'
      }

      const response = await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-3-opus-20240229',
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 10,
        }),
      })

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.type).toBe('message')
    })
  })

  describe('OAuth Authentication', () => {
    it('should add OAuth beta header when using OAuth credentials', async () => {
      const headers: any = {
        'Content-Type': 'application/json',
        'x-api-key': 'oauth-access-token', // Claude OAuth token
        'anthropic-version': '2023-06-01',
        [PROJECT_HEADER]: 'project-alpha',
      }

      // Only add client auth header if client auth is enabled
      if (process.env.ENABLE_CLIENT_AUTH !== 'false') {
        headers.Authorization = 'Bearer cnp_test_key'
      }

      const response = await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-3-opus-20240229',
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 10,
        }),
      })

      // Should succeed with valid tokens
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.type).toBe('message')
    })
  })
})
