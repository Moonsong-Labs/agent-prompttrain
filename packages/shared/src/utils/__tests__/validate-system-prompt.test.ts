import { describe, test, expect } from 'bun:test'
import { validateSystemPrompt } from '../validate-system-prompt'
import type { SystemContentBlock } from '../../types/claude'

describe('validateSystemPrompt', () => {
  describe('valid inputs', () => {
    test('accepts null', () => {
      expect(validateSystemPrompt(null)).toEqual({ valid: true })
    })

    test('accepts undefined', () => {
      expect(validateSystemPrompt(undefined)).toEqual({ valid: true })
    })

    test('accepts empty array', () => {
      expect(validateSystemPrompt([])).toEqual({ valid: true })
    })

    test('accepts valid array with single text block', () => {
      const prompt: SystemContentBlock[] = [{ type: 'text', text: 'You are a helpful assistant.' }]
      expect(validateSystemPrompt(prompt)).toEqual({ valid: true })
    })

    test('accepts valid array with multiple text blocks', () => {
      const prompt: SystemContentBlock[] = [
        { type: 'text', text: 'You are a helpful assistant.' },
        { type: 'text', text: 'Always respond in English.' },
      ]
      expect(validateSystemPrompt(prompt)).toEqual({ valid: true })
    })

    test('accepts block with cache_control ephemeral', () => {
      const prompt: SystemContentBlock[] = [
        {
          type: 'text',
          text: 'System instructions here.',
          cache_control: { type: 'ephemeral' },
        },
      ]
      expect(validateSystemPrompt(prompt)).toEqual({ valid: true })
    })

    test('accepts mixed blocks with and without cache_control', () => {
      const prompt: SystemContentBlock[] = [
        { type: 'text', text: 'First block.' },
        {
          type: 'text',
          text: 'Second block with cache.',
          cache_control: { type: 'ephemeral' },
        },
      ]
      expect(validateSystemPrompt(prompt)).toEqual({ valid: true })
    })
  })

  describe('invalid inputs', () => {
    test('rejects non-array (string)', () => {
      const result = validateSystemPrompt('not an array' as unknown as SystemContentBlock[])
      expect(result.valid).toBe(false)
      expect(result.error).toBe('System prompt must be an array')
    })

    test('rejects non-array (object)', () => {
      const result = validateSystemPrompt({} as unknown as SystemContentBlock[])
      expect(result.valid).toBe(false)
      expect(result.error).toBe('System prompt must be an array')
    })

    test('rejects non-array (number)', () => {
      const result = validateSystemPrompt(42 as unknown as SystemContentBlock[])
      expect(result.valid).toBe(false)
      expect(result.error).toBe('System prompt must be an array')
    })

    test('rejects block with missing type field', () => {
      const prompt = [{ text: 'Hello' }] as unknown as SystemContentBlock[]
      const result = validateSystemPrompt(prompt)
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Block 0: type must be "text"')
    })

    test('rejects block with wrong type value', () => {
      const prompt = [{ type: 'image', text: 'Hello' }] as unknown as SystemContentBlock[]
      const result = validateSystemPrompt(prompt)
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Block 0: type must be "text"')
    })

    test('rejects block with missing text field', () => {
      const prompt = [{ type: 'text' }] as unknown as SystemContentBlock[]
      const result = validateSystemPrompt(prompt)
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Block 0: text must be a string')
    })

    test('rejects block with non-string text', () => {
      const prompt = [{ type: 'text', text: 123 }] as unknown as SystemContentBlock[]
      const result = validateSystemPrompt(prompt)
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Block 0: text must be a string')
    })

    test('rejects block with null cache_control', () => {
      const prompt = [
        { type: 'text', text: 'Hello', cache_control: null },
      ] as unknown as SystemContentBlock[]
      const result = validateSystemPrompt(prompt)
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Block 0: cache_control must be { type: "ephemeral" }')
    })

    test('rejects block with invalid cache_control type', () => {
      const prompt = [
        { type: 'text', text: 'Hello', cache_control: { type: 'persistent' } },
      ] as unknown as SystemContentBlock[]
      const result = validateSystemPrompt(prompt)
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Block 0: cache_control must be { type: "ephemeral" }')
    })

    test('rejects block with cache_control as string', () => {
      const prompt = [
        { type: 'text', text: 'Hello', cache_control: 'ephemeral' },
      ] as unknown as SystemContentBlock[]
      const result = validateSystemPrompt(prompt)
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Block 0: cache_control must be { type: "ephemeral" }')
    })

    test('reports correct block index for error in second block', () => {
      const prompt = [
        { type: 'text', text: 'Valid block.' },
        { type: 'image', text: 'Invalid block.' },
      ] as unknown as SystemContentBlock[]
      const result = validateSystemPrompt(prompt)
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Block 1: type must be "text"')
    })

    test('rejects payload exceeding 1MB', () => {
      // Generate a large text that exceeds 1MB when JSON-serialized
      const largeText = 'x'.repeat(1024 * 1024 + 100)
      const prompt: SystemContentBlock[] = [{ type: 'text', text: largeText }]
      const result = validateSystemPrompt(prompt)
      expect(result.valid).toBe(false)
      expect(result.error).toContain('System prompt exceeds 1MB limit')
      expect(result.error).toContain('bytes')
    })
  })
})
