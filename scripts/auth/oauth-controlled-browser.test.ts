import { describe, expect, test } from 'bun:test'
import { extractAuthorizationCode } from './oauth-controlled-browser.ts'

describe('controlled OAuth browser code extraction', () => {
  test('extracts the exact code and expected state from page text', () => {
    expect(
      extractAuthorizationCode(
        ['Authorization complete\ncopy-this-code#expected-state\nYou may close this page.'],
        'expected-state'
      )
    ).toBe('copy-this-code#expected-state')
  })

  test('extracts code and state from callback URL parameters', () => {
    expect(
      extractAuthorizationCode(
        ['https://console.anthropic.com/oauth/code/callback?code=callback-code&state=expected'],
        'expected'
      )
    ).toBe('callback-code#expected')
  })

  test('rejects codes from a different OAuth flow', () => {
    expect(extractAuthorizationCode(['secret-code#wrong-state'], 'expected-state')).toBeNull()
    expect(
      extractAuthorizationCode(
        ['https://console.anthropic.com/oauth/code/callback?code=secret&state=wrong'],
        'expected'
      )
    ).toBeNull()
  })
})
