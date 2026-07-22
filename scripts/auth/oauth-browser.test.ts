import { describe, expect, test } from 'bun:test'
import {
  resolveClipboardReadCommand,
  resolveClipboardWriteCommand,
  resolvePrivateBrowserCommand,
  resolveSystemBrowserCommand,
  validateAuthorizationCode,
} from './oauth-browser.ts'

function fakeWhich(commands: Record<string, string>): (command: string) => string | null {
  return command => commands[command] ?? null
}

describe('OAuth browser assistance', () => {
  test('prefers Chrome and opens a private window on Linux', () => {
    const command = resolvePrivateBrowserCommand(
      'https://example.com/oauth',
      'linux',
      fakeWhich({ 'google-chrome': '/usr/bin/google-chrome' })
    )

    expect(command).toEqual({
      executable: '/usr/bin/google-chrome',
      args: ['--incognito', '--new-window', 'https://example.com/oauth'],
    })
  })

  test('uses an installed macOS browser application', () => {
    const command = resolvePrivateBrowserCommand(
      'https://example.com/oauth',
      'darwin',
      fakeWhich({}),
      path => path.includes('Google Chrome.app')
    )

    expect(command?.executable).toContain('Google Chrome.app')
    expect(command?.args[0]).toBe('--incognito')
  })

  test('returns null when no private-capable browser is available', () => {
    expect(
      resolvePrivateBrowserCommand('https://example.com/oauth', 'linux', fakeWhich({}))
    ).toBeNull()
  })

  test('uses the platform URL opener for normal browser sessions', () => {
    expect(
      resolveSystemBrowserCommand(
        'https://accounts.google.com/o/oauth2/v2/auth',
        'linux',
        fakeWhich({ 'xdg-open': '/usr/bin/xdg-open' })
      )
    ).toEqual({
      executable: '/usr/bin/xdg-open',
      args: ['https://accounts.google.com/o/oauth2/v2/auth'],
    })
  })

  test('selects supported clipboard commands', () => {
    const write = resolveClipboardWriteCommand('linux', fakeWhich({ xclip: '/usr/bin/xclip' }))
    const read = resolveClipboardReadCommand('linux', fakeWhich({ xclip: '/usr/bin/xclip' }))

    expect(write).toEqual({
      executable: '/usr/bin/xclip',
      args: ['-selection', 'clipboard'],
    })
    expect(read).toEqual({
      executable: '/usr/bin/xclip',
      args: ['-selection', 'clipboard', '-out'],
    })
  })

  test('validates complete authorization codes', () => {
    expect(validateAuthorizationCode(' code-value#state-value ')).toBe('code-value#state-value')
    expect(() => validateAuthorizationCode('code-without-state')).toThrow(
      'Expected the complete code#state value'
    )
    expect(() => validateAuthorizationCode('code#state#extra')).toThrow(
      'Expected the complete code#state value'
    )
    expect(() => validateAuthorizationCode('code#other-state', 'expected-state')).toThrow(
      'code belongs to a different OAuth flow'
    )
  })
})
