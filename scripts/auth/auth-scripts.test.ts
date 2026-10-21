import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'

// Several of these scripts once failed on import for months: nothing ever loaded them
const SCRIPTS = [
  ['check-oauth-status.ts', 'Usage: bun run auth:oauth-status'],
  ['oauth-refresh.ts', 'Usage: bun run scripts/auth/oauth-refresh.ts'],
  ['oauth-refresh-all.ts', 'Usage: bun run auth:oauth-refresh'],
  ['oauth-login.ts', 'Usage: bun run auth:oauth-login'],
  ['oauth-relogin-all.ts', 'Usage: bun run auth:oauth-relogin'],
] as const

describe('auth scripts', () => {
  for (const [script, usage] of SCRIPTS) {
    it(`${script} loads and prints its usage with --help`, async () => {
      // --help must exit before any database access; never let the repo .env reach it
      const child = Bun.spawn(['bun', '--no-env-file', join(import.meta.dir, script), '--help'], {
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])

      expect(`${stdout}${stderr}`).toContain(usage)
      expect(exitCode).toBe(0)
    })
  }
})
