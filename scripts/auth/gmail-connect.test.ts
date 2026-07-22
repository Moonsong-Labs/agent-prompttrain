import { expect, test } from 'bun:test'
import { startGoogleOAuthCallbackServer } from './gmail-connect.ts'

test('local Google OAuth callback captures code and state without displaying them', async () => {
  const server = await startGoogleOAuthCallbackServer(5_000)

  try {
    const response = await fetch(`${server.redirectUri}?code=authorization-code&state=oauth-state`)
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain('authorization-code')
    expect(await server.result).toEqual({
      code: 'authorization-code',
      state: 'oauth-state',
    })
  } finally {
    await server.close()
  }
})
