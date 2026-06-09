import { describe, expect, it } from 'bun:test'
import { getModelPricing, calculateRequestCost, DEFAULT_MODEL_PRICING } from '../model-pricing'

describe('Model Pricing', () => {
  describe('getModelPricing', () => {
    it('should return Fable 5 pricing', () => {
      const result = getModelPricing('claude-fable-5')
      expect(result.isEstimate).toBe(false)
      expect(result.pricing).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 })
    })

    it('should return Opus 4.8 pricing', () => {
      const result = getModelPricing('claude-opus-4-8')
      expect(result.isEstimate).toBe(false)
      expect(result.pricing).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
    })

    it('should return the same pricing for Opus 4.5 through 4.8', () => {
      const expected = getModelPricing('claude-opus-4-8').pricing
      for (const model of ['claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-7']) {
        expect(getModelPricing(model).pricing).toEqual(expected)
      }
    })

    it('should return legacy premium pricing for Opus 4.1 and Claude 3 Opus', () => {
      for (const model of ['claude-opus-4-1-20250805', 'claude-3-opus-20240229']) {
        const result = getModelPricing(model)
        expect(result.isEstimate).toBe(false)
        expect(result.pricing.input).toBe(15)
        expect(result.pricing.output).toBe(75)
      }
    })

    it('should return Sonnet pricing for Sonnet 4.6', () => {
      const result = getModelPricing('claude-sonnet-4-6')
      expect(result.isEstimate).toBe(false)
      expect(result.pricing.input).toBe(3)
      expect(result.pricing.output).toBe(15)
    })

    it('should return Haiku 4.5 pricing', () => {
      const result = getModelPricing('claude-haiku-4-5-20251001')
      expect(result.isEstimate).toBe(false)
      expect(result.pricing.input).toBe(1)
      expect(result.pricing.output).toBe(5)
    })

    it('should return Claude 3.5 Haiku pricing distinct from Claude 3 Haiku', () => {
      expect(getModelPricing('claude-3-5-haiku-20241022').pricing.input).toBe(0.8)
      expect(getModelPricing('claude-3-haiku-20240307').pricing.input).toBe(0.25)
    })

    it('should match models case-insensitively', () => {
      const result = getModelPricing('CLAUDE-OPUS-4-8')
      expect(result.isEstimate).toBe(false)
      expect(result.pricing.input).toBe(5)
    })

    it('should return default pricing with estimate flag for unknown models', () => {
      const result = getModelPricing('gpt-4')
      expect(result.isEstimate).toBe(true)
      expect(result.pricing).toEqual(DEFAULT_MODEL_PRICING)
    })
  })

  describe('calculateRequestCost', () => {
    it('should calculate input/output cost for Opus 4.8', () => {
      const cost = calculateRequestCost('claude-opus-4-8', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      })
      expect(cost).toBe(30) // $5 input + $25 output
    })

    it('should include cache token costs', () => {
      const cost = calculateRequestCost('claude-opus-4-8', {
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
      })
      expect(cost).toBe(6.75) // $0.50 read + $6.25 write
    })

    it('should treat missing usage fields as zero', () => {
      expect(calculateRequestCost('claude-opus-4-8', {})).toBe(0)
    })
  })
})
