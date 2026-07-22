import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
export const DEFAULT_GMAIL_CLIENT_FILE = 'credentials/gmail-oauth-client.json'
export const DEFAULT_GMAIL_TOKEN_FILE = 'credentials/gmail-oauth-token.json'
export const DEFAULT_GMAIL_POLL_TIMEOUT_MS = 180_000

const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_API_URL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const DEFAULT_POLL_INTERVAL_MS = 2_000

type FetchLike = typeof fetch

export interface GoogleOAuthClient {
  clientId: string
  clientSecret: string
}

interface GoogleOAuthClientFile {
  installed?: {
    client_id?: string
    client_secret?: string
  }
}

export interface GmailOAuthToken {
  access_token: string
  refresh_token: string
  expires_at: number
  scope: string
  token_type: string
}

interface GoogleTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
  error?: string
  error_description?: string
}

export interface GoogleAuthorizationRequest {
  url: string
  state: string
  codeVerifier: string
}

interface GmailHeader {
  name?: string
  value?: string
}

interface GmailMessagePart {
  mimeType?: string
  headers?: GmailHeader[]
  body?: {
    data?: string
  }
  parts?: GmailMessagePart[]
}

export interface GmailMessage {
  id?: string
  internalDate?: string
  payload?: GmailMessagePart
}

interface GmailMessageList {
  messages?: Array<{ id?: string }>
}

export interface GmailMessageReader {
  listMessages(query: string): Promise<string[]>
  getMessageMetadata(id: string): Promise<GmailMessage>
  getMessage(id: string): Promise<GmailMessage>
}

export interface WaitForAnthropicLoginLinkOptions {
  accountEmail: string
  requestedAfter: number
  timeoutMs?: number
  pollIntervalMs?: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

export interface AnthropicLoginLink {
  url: string
  messageId: string
  receivedAt: number
}

function resolveLocalPath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

export function getGmailClientFilePath(): string {
  return resolveLocalPath(process.env.GMAIL_OAUTH_CLIENT_FILE || DEFAULT_GMAIL_CLIENT_FILE)
}

export function getGmailTokenFilePath(): string {
  return resolveLocalPath(process.env.GMAIL_OAUTH_TOKEN_FILE || DEFAULT_GMAIL_TOKEN_FILE)
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to read OAuth configuration at ${path}: ${message}`)
  }
}

export async function loadGoogleOAuthClient(
  path = getGmailClientFilePath()
): Promise<GoogleOAuthClient> {
  const value = (await readJsonFile(path)) as GoogleOAuthClientFile
  const clientId = value.installed?.client_id?.trim()
  const clientSecret = value.installed?.client_secret?.trim()

  if (!clientId || !clientSecret) {
    throw new Error(
      `Invalid Google OAuth client file at ${path}. Create and download a Desktop app client.`
    )
  }

  await chmod(path, 0o600)
  return { clientId, clientSecret }
}

export async function loadGmailOAuthToken(
  path = getGmailTokenFilePath()
): Promise<GmailOAuthToken> {
  const value = (await readJsonFile(path)) as Partial<GmailOAuthToken>
  if (
    !value.access_token ||
    !value.refresh_token ||
    typeof value.expires_at !== 'number' ||
    !value.scope ||
    !value.token_type
  ) {
    throw new Error(`Invalid Gmail OAuth token file at ${path}. Run bun run auth:gmail-connect.`)
  }

  await chmod(path, 0o600)
  return value as GmailOAuthToken
}

export async function saveGmailOAuthToken(
  token: GmailOAuthToken,
  path = getGmailTokenFilePath()
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(token, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(path, 0o600)
}

function base64UrlEncode(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function createGoogleAuthorizationRequest(
  client: GoogleOAuthClient,
  redirectUri: string
): GoogleAuthorizationRequest {
  const state = base64UrlEncode(randomBytes(24))
  const codeVerifier = base64UrlEncode(randomBytes(48))
  const codeChallenge = base64UrlEncode(createHash('sha256').update(codeVerifier).digest())
  const url = new URL(GOOGLE_AUTHORIZATION_URL)

  url.searchParams.set('client_id', client.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', GMAIL_READONLY_SCOPE)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')

  return { url: url.toString(), state, codeVerifier }
}

async function readGoogleTokenResponse(response: Response): Promise<GoogleTokenResponse> {
  const data = (await response.json().catch(() => ({}))) as GoogleTokenResponse
  if (!response.ok) {
    const reason = data.error_description || data.error || response.statusText
    throw new Error(`Google OAuth token request failed (${response.status}): ${reason}`)
  }
  return data
}

export async function exchangeGoogleAuthorizationCode(
  client: GoogleOAuthClient,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  fetchImpl: FetchLike = fetch
): Promise<GmailOAuthToken> {
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  })
  const data = await readGoogleTokenResponse(response)

  if (!data.access_token || !data.refresh_token || !data.expires_in) {
    throw new Error('Google OAuth response did not include access and refresh tokens.')
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    scope: data.scope || GMAIL_READONLY_SCOPE,
    token_type: data.token_type || 'Bearer',
  }
}

async function refreshGmailOAuthToken(
  client: GoogleOAuthClient,
  token: GmailOAuthToken,
  tokenPath: string,
  fetchImpl: FetchLike
): Promise<GmailOAuthToken> {
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    }),
  })
  const data = await readGoogleTokenResponse(response)

  if (!data.access_token || !data.expires_in) {
    throw new Error('Google OAuth refresh response did not include an access token.')
  }

  const refreshed: GmailOAuthToken = {
    access_token: data.access_token,
    refresh_token: token.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    scope: data.scope || token.scope,
    token_type: data.token_type || token.token_type,
  }
  await saveGmailOAuthToken(refreshed, tokenPath)
  return refreshed
}

export class GmailClient implements GmailMessageReader {
  private token: GmailOAuthToken

  constructor(
    private readonly oauthClient: GoogleOAuthClient,
    token: GmailOAuthToken,
    private readonly tokenPath = getGmailTokenFilePath(),
    private readonly fetchImpl: FetchLike = fetch
  ) {
    this.token = token
  }

  private async accessToken(forceRefresh = false): Promise<string> {
    if (forceRefresh || this.token.expires_at <= Date.now() + 60_000) {
      this.token = await refreshGmailOAuthToken(
        this.oauthClient,
        this.token,
        this.tokenPath,
        this.fetchImpl
      )
    }
    return this.token.access_token
  }

  private async request<T>(path: string): Promise<T> {
    const execute = async (forceRefresh: boolean): Promise<Response> =>
      this.fetchImpl(`${GMAIL_API_URL}${path}`, {
        headers: { Authorization: `Bearer ${await this.accessToken(forceRefresh)}` },
      })

    let response = await execute(false)
    if (response.status === 401) {
      response = await execute(true)
    }
    if (!response.ok) {
      throw new Error(`Gmail API request failed (${response.status} ${response.statusText}).`)
    }
    return (await response.json()) as T
  }

  async listMessages(query: string): Promise<string[]> {
    const parameters = new URLSearchParams({ q: query, maxResults: '10' })
    const data = await this.request<GmailMessageList>(`/messages?${parameters}`)
    return (data.messages || []).flatMap(message => (message.id ? [message.id] : []))
  }

  getMessageMetadata(id: string): Promise<GmailMessage> {
    const parameters = new URLSearchParams({ format: 'metadata' })
    for (const header of [
      'From',
      'To',
      'Delivered-To',
      'X-Original-To',
      'Envelope-To',
      'X-Forwarded-To',
    ]) {
      parameters.append('metadataHeaders', header)
    }
    return this.request<GmailMessage>(
      `/messages/${encodeURIComponent(id)}?${parameters.toString()}`
    )
  }

  getMessage(id: string): Promise<GmailMessage> {
    return this.request<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`)
  }
}

export async function createGmailClient(): Promise<GmailClient> {
  const [client, token] = await Promise.all([loadGoogleOAuthClient(), loadGmailOAuthToken()])
  return new GmailClient(client, token)
}

function getHeader(message: GmailMessage, name: string): string {
  const header = message.payload?.headers?.find(
    candidate => candidate.name?.toLowerCase() === name.toLowerCase()
  )
  return header?.value || ''
}

function extractEmailAddress(value: string): string | null {
  return extractEmailAddresses(value)[0] || null
}

function extractEmailAddresses(value: string): string[] {
  return Array.from(value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi), match =>
    match[0].toLowerCase()
  )
}

export function isExpectedAnthropicSender(message: GmailMessage): boolean {
  const sender = extractEmailAddress(getHeader(message, 'From'))
  return sender?.endsWith('@mail.anthropic.com') ?? false
}

export function isExpectedRecipient(message: GmailMessage, accountEmail: string): boolean {
  const expected = accountEmail.trim().toLowerCase()
  if (!expected) {
    return false
  }

  const recipientHeaders = ['To', 'Delivered-To', 'X-Original-To', 'Envelope-To', 'X-Forwarded-To']
  return recipientHeaders.some(name =>
    extractEmailAddresses(getHeader(message, name)).includes(expected)
  )
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(normalized, 'base64').toString('utf8')
}

function decodeQuotedPrintable(value: string): string {
  return value
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
}

function collectMessageBodies(part: GmailMessagePart | undefined, result: string[]): void {
  if (!part) {
    return
  }
  if (part.body?.data && (!part.mimeType || part.mimeType.startsWith('text/'))) {
    result.push(decodeQuotedPrintable(decodeBase64Url(part.body.data)))
  }
  for (const child of part.parts || []) {
    collectMessageBodies(child, result)
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#([0-9]+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    )
}

export function isAllowedAnthropicLink(value: string): boolean {
  try {
    const url = new URL(decodeHtmlEntities(value))
    if (url.protocol !== 'https:') {
      return false
    }
    const hostname = url.hostname.toLowerCase()
    return (
      hostname === 'claude.ai' ||
      hostname.endsWith('.claude.ai') ||
      hostname === 'anthropic.com' ||
      hostname.endsWith('.anthropic.com')
    )
  } catch {
    return false
  }
}

interface LinkCandidate {
  url: string
  context: string
  order: number
}

function collectLinkCandidates(body: string): LinkCandidate[] {
  const candidates: LinkCandidate[] = []
  const anchorPattern = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi
  let anchor: RegExpExecArray | null

  while ((anchor = anchorPattern.exec(body))) {
    candidates.push({
      url: decodeHtmlEntities(anchor[2] || ''),
      context: (anchor[3] || '').replace(/<[^>]+>/g, ' '),
      order: candidates.length,
    })
  }

  const rawUrlPattern = /https:\/\/[^\s<>"']+/gi
  for (const match of body.matchAll(rawUrlPattern)) {
    const url = decodeHtmlEntities(match[0]).replace(/[),.;]+$/, '')
    if (!candidates.some(candidate => candidate.url === url)) {
      const matchIndex = match.index || 0
      const lineStart = body.lastIndexOf('\n', matchIndex - 1) + 1
      const nextLineBreak = body.indexOf('\n', matchIndex + match[0].length)
      const lineEnd = nextLineBreak === -1 ? body.length : nextLineBreak
      candidates.push({
        url,
        context: body.slice(lineStart, lineEnd).replace(/<[^>]+>/g, ' '),
        order: candidates.length,
      })
    }
  }
  return candidates
}

function scoreLink(candidate: LinkCandidate): number {
  const searchable = `${candidate.context} ${candidate.url}`.toLowerCase()
  let score = 0
  if (/sign\s*in|log\s*in|continue|verify/.test(candidate.context.toLowerCase())) {
    score += 100
  }
  if (/login|signin|verify|magic|auth/.test(candidate.url.toLowerCase())) {
    score += 25
  }
  if (/unsubscribe|privacy|terms|support|help/.test(searchable)) {
    score -= 100
  }
  return score
}

export function extractAnthropicLoginLink(message: GmailMessage): string | null {
  const bodies: string[] = []
  collectMessageBodies(message.payload, bodies)
  const candidates = bodies
    .flatMap(collectLinkCandidates)
    .filter(candidate => isAllowedAnthropicLink(candidate.url))
    .filter(candidate => scoreLink(candidate) > 0)
    .sort((left, right) => scoreLink(right) - scoreLink(left) || left.order - right.order)
  return candidates[0]?.url || null
}

export async function waitForAnthropicLoginLink(
  reader: GmailMessageReader,
  options: WaitForAnthropicLoginLinkOptions
): Promise<AnthropicLoginLink> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GMAIL_POLL_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (milliseconds => Bun.sleep(milliseconds))
  const deadline = now() + timeoutMs
  const queryStart = Math.floor((options.requestedAfter - 1_000) / 1_000)
  const query = `from:(mail.anthropic.com) after:${queryStart}`
  const inspectedMessageIds = new Set<string>()

  do {
    const ids = await reader.listMessages(query)
    for (const id of ids) {
      if (inspectedMessageIds.has(id)) {
        continue
      }
      inspectedMessageIds.add(id)
      const metadata = await reader.getMessageMetadata(id)
      const receivedAt = Number(metadata.internalDate || 0)
      if (!Number.isFinite(receivedAt) || receivedAt < options.requestedAfter - 1_000) {
        continue
      }
      if (
        !isExpectedAnthropicSender(metadata) ||
        !isExpectedRecipient(metadata, options.accountEmail)
      ) {
        continue
      }
      const message = await reader.getMessage(id)
      const url = extractAnthropicLoginLink(message)
      if (url) {
        return { url, messageId: message.id || id, receivedAt }
      }
    }

    if (now() < deadline) {
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())))
    }
  } while (now() < deadline)

  throw new Error(
    `Timed out waiting for a fresh Anthropic login email addressed to ${options.accountEmail}.`
  )
}
