import { existsSync } from 'fs'

export interface CommandSpec {
  executable: string
  args: string[]
}

type Which = (command: string) => string | null
type PathExists = (path: string) => boolean

const linuxBrowserCandidates = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'microsoft-edge-stable',
]

const windowsBrowserCandidates = ['chrome.exe', 'msedge.exe', 'chromium.exe', 'chrome', 'msedge']

const macBrowserCandidates = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
]

function findExecutable(candidates: string[], which: Which): string | null {
  for (const candidate of candidates) {
    const executable = which(candidate)
    if (executable) {
      return executable
    }
  }
  return null
}

export function resolvePrivateBrowserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  which: Which = command => Bun.which(command),
  pathExists: PathExists = existsSync
): CommandSpec | null {
  if (platform === 'darwin') {
    const executable = macBrowserCandidates.find(pathExists)
    return executable ? { executable, args: ['--incognito', '--new-window', url] } : null
  }

  const candidates = platform === 'win32' ? windowsBrowserCandidates : linuxBrowserCandidates
  const executable = findExecutable(candidates, which)
  return executable ? { executable, args: ['--incognito', '--new-window', url] } : null
}

export function resolveClipboardWriteCommand(
  platform: NodeJS.Platform = process.platform,
  which: Which = command => Bun.which(command)
): CommandSpec | null {
  const candidates: Array<{ command: string; args: string[] }> =
    platform === 'darwin'
      ? [{ command: 'pbcopy', args: [] }]
      : platform === 'win32'
        ? [{ command: 'clip.exe', args: [] }]
        : [
            { command: 'wl-copy', args: [] },
            { command: 'xclip', args: ['-selection', 'clipboard'] },
            { command: 'xsel', args: ['--clipboard', '--input'] },
          ]

  for (const candidate of candidates) {
    const executable = which(candidate.command)
    if (executable) {
      return { executable, args: candidate.args }
    }
  }
  return null
}

export function resolveClipboardReadCommand(
  platform: NodeJS.Platform = process.platform,
  which: Which = command => Bun.which(command)
): CommandSpec | null {
  const candidates: Array<{ command: string; args: string[] }> =
    platform === 'darwin'
      ? [{ command: 'pbpaste', args: [] }]
      : platform === 'win32'
        ? [
            {
              command: 'powershell.exe',
              args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
            },
          ]
        : [
            { command: 'wl-paste', args: ['--no-newline'] },
            { command: 'xclip', args: ['-selection', 'clipboard', '-out'] },
            { command: 'xsel', args: ['--clipboard', '--output'] },
          ]

  for (const candidate of candidates) {
    const executable = which(candidate.command)
    if (executable) {
      return { executable, args: candidate.args }
    }
  }
  return null
}

export async function openPrivateBrowser(url: string): Promise<boolean> {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return false
  }

  const command = resolvePrivateBrowserCommand(url)
  if (!command) {
    return false
  }

  try {
    const subprocess = Bun.spawn([command.executable, ...command.args], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    subprocess.unref()
    return true
  } catch {
    return false
  }
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  const command = resolveClipboardWriteCommand()
  if (!command) {
    return false
  }

  try {
    const subprocess = Bun.spawn([command.executable, ...command.args], {
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    subprocess.stdin.write(text)
    subprocess.stdin.end()
    return (await subprocess.exited) === 0
  } catch {
    return false
  }
}

export function readTextFromClipboard(): string | null {
  const command = resolveClipboardReadCommand()
  if (!command) {
    return null
  }

  try {
    const result = Bun.spawnSync([command.executable, ...command.args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (result.exitCode !== 0) {
      return null
    }
    const value = new TextDecoder().decode(result.stdout).trim()
    return value || null
  } catch {
    return null
  }
}

export function validateAuthorizationCode(value: string): string {
  const code = value.trim()
  const [authorizationCode, state, ...extra] = code.split('#')
  if (!authorizationCode || !state || extra.length > 0) {
    throw new Error('Invalid authorization code format. Expected the complete code#state value.')
  }
  return code
}
