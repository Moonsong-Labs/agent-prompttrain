import { describe, expect, test } from 'bun:test'
import {
  GMAIL_READONLY_SCOPE,
  createGoogleAuthorizationRequest,
  exchangeGoogleAuthorizationCode,
  extractAnthropicLoginLink,
  isAllowedAnthropicLink,
  isExpectedAnthropicSender,
  isExpectedRecipient,
  waitForAnthropicLoginLink,
  type GmailMessage,
  type GmailMessageReader,
} from './gmail-auth.ts'

function encodeBody(value: string): string {
  return Buffer.from(value).toString('base64url')
}

function message(options: {
  id?: string
  receivedAt?: number
  from?: string
  to?: string
  body?: string
}): GmailMessage {
  return {
    id: options.id || 'message-1',
    internalDate: String(options.receivedAt || 10_000),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: options.from || 'Claude <login@mail.anthropic.com>' },
        { name: 'To', value: options.to || 'Account <alpha@example.com>' },
      ],
      parts: [
        {
          mimeType: 'text/html',
          body: {
            data: encodeBody(
              options.body ||
                '<a href="https://claude.ai/login?token=one-time">Sign in with Claude.ai</a>'
            ),
          },
        },
      ],
    },
  }
}

describe('Gmail OAuth setup', () => {
  test('builds a read-only offline Google authorization request with PKCE', () => {
    const request = createGoogleAuthorizationRequest(
      { clientId: 'client-id', clientSecret: 'client-secret' },
      'http://127.0.0.1:12345/oauth2/callback'
    )
    const url = new URL(request.url)

    expect(url.origin).toBe('https://accounts.google.com')
    expect(url.searchParams.get('scope')).toBe(GMAIL_READONLY_SCOPE)
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe(request.state)
    expect(request.codeVerifier.length).toBeGreaterThan(40)
  })

  test('exchanges the desktop callback using PKCE and retains the refresh token', async () => {
    let requestBody = ''
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body || '')
      return new Response(
        JSON.stringify({
          access_token: 'gmail-access-token',
          refresh_token: 'gmail-refresh-token',
          expires_in: 3600,
          scope: GMAIL_READONLY_SCOPE,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as typeof fetch

    const token = await exchangeGoogleAuthorizationCode(
      { clientId: 'client-id', clientSecret: 'client-secret' },
      'authorization-code',
      'pkce-verifier',
      'http://127.0.0.1:12345/oauth2/callback',
      fetchImpl
    )

    const parameters = new URLSearchParams(requestBody)
    expect(parameters.get('grant_type')).toBe('authorization_code')
    expect(parameters.get('code_verifier')).toBe('pkce-verifier')
    expect(token.refresh_token).toBe('gmail-refresh-token')
    expect(token.expires_at).toBeGreaterThan(Date.now())
  })
})

describe('Anthropic login email validation', () => {
  test('requires the expected sender and forwarded recipient', () => {
    const valid = message({})
    expect(isExpectedAnthropicSender(valid)).toBeTrue()
    expect(isExpectedRecipient(valid, 'alpha@example.com')).toBeTrue()

    expect(
      isExpectedAnthropicSender(message({ from: 'Claude <login@anthropic.example>' }))
    ).toBeFalse()
    expect(isExpectedRecipient(valid, 'other@example.com')).toBeFalse()
    expect(
      isExpectedRecipient(message({ to: 'alpha@example.com.evil.example' }), 'alpha@example.com')
    ).toBeFalse()
  })

  test('prefers the sign-in anchor and rejects non-Anthropic hosts', () => {
    const candidate = message({
      body: `
        <a href="https://support.anthropic.com/help">Help</a>
        <a href="https://claude.ai/login?token=secret&amp;source=email">Sign in with Claude.ai</a>
        <a href="https://evil.example/login?token=secret">Sign in elsewhere</a>
      `,
    })

    expect(extractAnthropicLoginLink(candidate)).toBe(
      'https://claude.ai/login?token=secret&source=email'
    )
    expect(isAllowedAnthropicLink('https://links.mail.anthropic.com/click/abc')).toBeTrue()
    expect(isAllowedAnthropicLink('http://claude.ai/login')).toBeFalse()
    expect(isAllowedAnthropicLink('https://claude.ai.evil.example/login')).toBeFalse()
    expect(
      extractAnthropicLoginLink(
        message({ body: '<a href="https://support.anthropic.com/help">Help center</a>' })
      )
    ).toBeNull()
  })

  test('extracts a plain-text tracking link using its sign-in context', () => {
    expect(
      extractAnthropicLoginLink(
        message({
          body: 'Sign in with Claude.ai: https://links.mail.anthropic.com/c/random-token',
        })
      )
    ).toBe('https://links.mail.anthropic.com/c/random-token')
  })

  test('polls until a fresh message for the expected account arrives', async () => {
    let currentTime = 20_000
    let polls = 0
    let fullMessageReads = 0
    const messages = new Map<string, GmailMessage>([
      ['stale', message({ id: 'stale', receivedAt: 15_000 })],
      [
        'wrong-account',
        message({ id: 'wrong-account', receivedAt: 21_000, to: 'other@example.com' }),
      ],
      ['fresh', message({ id: 'fresh', receivedAt: 22_000 })],
    ])
    const reader: GmailMessageReader = {
      listMessages: async query => {
        expect(query).toContain('from:(mail.anthropic.com)')
        polls += 1
        return polls === 1 ? ['stale', 'wrong-account'] : ['fresh']
      },
      getMessageMetadata: async id => messages.get(id)!,
      getMessage: async id => {
        fullMessageReads += 1
        return messages.get(id)!
      },
    }

    const result = await waitForAnthropicLoginLink(reader, {
      accountEmail: 'alpha@example.com',
      requestedAfter: 20_000,
      timeoutMs: 5_000,
      pollIntervalMs: 1_000,
      now: () => currentTime,
      sleep: async milliseconds => {
        currentTime += milliseconds
      },
    })

    expect(result.messageId).toBe('fresh')
    expect(result.url).toContain('https://claude.ai/login')
    expect(polls).toBe(2)
    expect(fullMessageReads).toBe(1)
  })
})
