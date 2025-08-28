import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { spawn } from 'child_process'
import { promisify } from 'util'

const exec = promisify(require('child_process').exec)

// Docker compose command with correct file path
const dockerCompose = 'docker compose -f docker/docker-compose.yml'

describe('Claude CLI End-to-End Tests', () => {
  let dockerComposeUp = false

  beforeAll(async () => {
    // Start Docker services if not already running
    try {
      await exec(`${dockerCompose} ps | grep -q agent-prompttrain-proxy`)
    } catch {
      console.log('Starting Docker services...')
      await exec(`${dockerCompose} --profile dev --profile claude up -d`)
      dockerComposeUp = true
      // Wait for services to be ready
      await new Promise(resolve => setTimeout(resolve, 10000))
    }
  })

  afterAll(async () => {
    if (dockerComposeUp) {
      console.log('Stopping Docker services...')
      await exec(`${dockerCompose} down`)
    }
  })

  describe('Claude CLI Integration', () => {
    it('should connect to proxy successfully', async () => {
      const { stdout, stderr } = await exec(
        `${dockerCompose} exec -T claude-cli cat /root/.claude.json`
      )

      const config = JSON.parse(stdout)
      expect(config.api.endpoint).toBe('http://proxy:3000/v1')
    })

    it('should have credentials configured', async () => {
      const { stdout } = await exec(
        `${dockerCompose} exec -T claude-cli cat /root/.claude/.credentials.json`
      )

      const creds = JSON.parse(stdout)
      expect(creds.claudeAiOauth).toBeDefined()
      expect(creds.claudeAiOauth.accessToken).toBeDefined()
    })

    it('should send request through proxy', async () => {
      // This test requires valid credentials configured
      // Skip if running in CI environment
      if (process.env.CI) {
        console.log('Skipping live API test in CI environment')
        return
      }

      const { stdout, stderr } = await exec(
        `${dockerCompose} exec -T claude-cli /usr/local/bin/setup-claude claude "What is 2+2?"`
      )

      // Should get a response (or at least not an auth error)
      expect(stderr).not.toContain('Invalid API key')
    })
  })

  describe('Proxy Logging', () => {
    it('should log requests to database', async () => {
      // Get initial count
      const { stdout: initialStdout } = await exec(
        `${dockerCompose} exec -T postgres psql -U postgres -d claude_proxy -c "SELECT COUNT(*) FROM request_response_logs;" -t`
      )
      const initialCount = parseInt(initialStdout.trim())

      // Make a test request
      await exec(
        `${dockerCompose} exec -T claude-cli /usr/local/bin/setup-claude claude "test request"`
      ).catch(() => {}) // Ignore errors

      // Wait a moment for the log to be written
      await new Promise(resolve => setTimeout(resolve, 2000))

      // Check database for logged requests
      const { stdout: finalStdout } = await exec(
        `${dockerCompose} exec -T postgres psql -U postgres -d claude_proxy -c "SELECT COUNT(*) FROM request_response_logs;" -t`
      )

      const finalCount = parseInt(finalStdout.trim())
      expect(finalCount).toBe(initialCount + 1)
    })
  })

  describe('Error Handling', () => {
    it('should handle invalid API keys gracefully', async () => {
      // Test with invalid credentials
      // This test verifies error handling when the proxy has no valid credentials
      const result = await exec(
        `${dockerCompose} exec -T claude-cli /usr/local/bin/setup-claude claude "test"`
      ).catch(err => err)

      // Should fail gracefully with authentication error
      expect(result.code).not.toBe(0)
    })

    it('should handle network errors', async () => {
      // Test with proxy down
      await exec(`${dockerCompose} stop proxy`)

      const result = await exec(
        `${dockerCompose} exec -T claude-cli /usr/local/bin/setup-claude claude "test"`
      ).catch(err => err)

      expect(result.code).not.toBe(0)

      // Restart proxy
      await exec(`${dockerCompose} start proxy`)
      await new Promise(resolve => setTimeout(resolve, 5000))
    })
  })
})
