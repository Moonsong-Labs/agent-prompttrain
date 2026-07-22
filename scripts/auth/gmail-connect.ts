#!/usr/bin/env bun
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  createGoogleAuthorizationRequest,
  exchangeGoogleAuthorizationCode,
  getGmailTokenFilePath,
  loadGoogleOAuthClient,
  saveGmailOAuthToken,
} from './gmail-auth.ts'
import { openSystemBrowser } from './oauth-browser.ts'

const CALLBACK_PATH = '/oauth2/callback'
const CALLBACK_TIMEOUT_MS = 300_000

interface GoogleOAuthCallback {
  code: string
  state: string
}

export interface GoogleOAuthCallbackServer {
  redirectUri: string
  result: Promise<GoogleOAuthCallback>
  close(): Promise<void>
}

export async function startGoogleOAuthCallbackServer(
  timeoutMs = CALLBACK_TIMEOUT_MS
): Promise<GoogleOAuthCallbackServer> {
  let resolveResult: (result: GoogleOAuthCallback) => void
  let rejectResult: (error: Error) => void
  let settled = false

  const result = new Promise<GoogleOAuthCallback>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const server: Server = createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')
    if (requestUrl.pathname !== CALLBACK_PATH) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }

    const error = requestUrl.searchParams.get('error')
    const code = requestUrl.searchParams.get('code')
    const state = requestUrl.searchParams.get('state')

    if (error || !code || !state) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Gmail authorization failed. Return to the terminal for details.')
      if (!settled) {
        settled = true
        rejectResult(
          new Error(`Google OAuth authorization failed: ${error || 'missing callback data'}`)
        )
      }
      return
    }

    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Gmail connected. You can close this tab and return to the terminal.')
    if (!settled) {
      settled = true
      resolveResult({ code, state })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true
      rejectResult(new Error('Timed out waiting for Google OAuth authorization.'))
    }
  }, timeoutMs)
  timeout.unref()

  return {
    redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    result,
    close: async () => {
      clearTimeout(timeout)
      if (!server.listening) {
        return
      }
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
      })
    },
  }
}

export async function connectGmail(): Promise<number> {
  let callbackServer: GoogleOAuthCallbackServer | null = null

  try {
    const client = await loadGoogleOAuthClient()
    callbackServer = await startGoogleOAuthCallbackServer()
    const authorization = createGoogleAuthorizationRequest(client, callbackServer.redirectUri)
    const opened = await openSystemBrowser(authorization.url)

    console.log('Gmail read-only authorization')
    console.log('=============================\n')
    console.log(
      opened
        ? 'Opened Google authorization in your browser.'
        : 'Browser launch unavailable. Open this URL manually:'
    )
    if (!opened) {
      console.log(authorization.url)
    }
    console.log('\nApprove read-only Gmail access. Waiting for the local callback...')

    const callback = await callbackServer.result
    if (callback.state !== authorization.state) {
      throw new Error('Google OAuth state mismatch. Authorization was not saved.')
    }

    const token = await exchangeGoogleAuthorizationCode(
      client,
      callback.code,
      authorization.codeVerifier,
      callbackServer.redirectUri
    )
    await saveGmailOAuthToken(token)

    console.log(`\nGmail connected. Token saved securely at ${getGmailTokenFilePath()}.`)
    console.log('Run bun run auth:oauth-relogin --gmail to use assisted relogin.')
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    await callbackServer?.close()
  }
}

if (import.meta.main) {
  if (process.argv.slice(2).some(argument => argument === '--help' || argument === '-h')) {
    console.log('Usage: bun run auth:gmail-connect')
  } else {
    process.exitCode = await connectGmail()
  }
}
