import { describe, expect, it } from 'bun:test'
import {
  getModelPricing,
  calculateRequestCost,
  getBilledUsageByModel,
  calculateUsageCost,
  DEFAULT_MODEL_PRICING,
  type RawUsage,
} from '../model-pricing'

describe('Model Pricing', () => {
  describe('getModelPricing', () => {
    it('prices Claude Fable 5 at $10 / $50 per MTok', () => {
      const { pricing, isEstimate } = getModelPricing('claude-fable-5')
      expect(isEstimate).toBe(false)
      expect(pricing).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 })
    })

    it('prices Claude Mythos 5 the same as Fable 5', () => {
      expect(getModelPricing('claude-mythos-5').pricing).toEqual(
        getModelPricing('claude-fable-5').pricing
      )
    })

    it('prices Claude Mythos Preview the same as Fable 5', () => {
      expect(getModelPricing('claude-mythos-preview').isEstimate).toBe(false)
      expect(getModelPricing('claude-mythos-preview').pricing).toEqual(
        getModelPricing('claude-fable-5').pricing
      )
    })

    // Regression: without an explicit rule, Opus 5 fell through to the Sonnet-tier
    // default, understating dashboard costs by ~40%.
    it('prices Claude Opus 5 at $5 / $25 per MTok', () => {
      const { pricing, isEstimate } = getModelPricing('claude-opus-5')
      expect(isEstimate).toBe(false)
      expect(pricing).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
    })

    it('prices Opus 4.8 at $5 / $25 per MTok', () => {
      const { pricing } = getModelPricing('claude-opus-4-8')
      expect(pricing).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
    })

    it('keeps legacy Opus (4.1 / 3) at $15 / $75 per MTok', () => {
      expect(getModelPricing('claude-opus-4-1').pricing.input).toBe(15)
      expect(getModelPricing('claude-3-opus-20240229').pricing.output).toBe(75)
    })

    it('prices Sonnet 5 and Sonnet 4.x at $3 / $15 per MTok', () => {
      expect(getModelPricing('claude-sonnet-5').pricing.input).toBe(3)
      expect(getModelPricing('claude-sonnet-4-6').pricing.output).toBe(15)
    })

    it('returns default pricing (flagged as estimate) for unknown models', () => {
      const { pricing, isEstimate } = getModelPricing('some-future-model')
      expect(isEstimate).toBe(true)
      expect(pricing).toEqual(DEFAULT_MODEL_PRICING)
    })
  })

  describe('calculateRequestCost', () => {
    it('computes cost across input, output, and cache tokens', () => {
      const cost = calculateRequestCost('claude-fable-5', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
      })
      // 10 + 50 + 1 + 12.5
      expect(cost).toBeCloseTo(73.5, 6)
    })

    it('treats missing token fields as zero', () => {
      expect(calculateRequestCost('claude-opus-4-8', { inputTokens: 1_000_000 })).toBeCloseTo(5, 6)
    })
  })

  describe('getBilledUsageByModel — fallback attribution', () => {
    it('attributes tokens/cost to the top-level model when there are no iterations', () => {
      const usage: RawUsage = { input_tokens: 1_000_000, output_tokens: 1_000_000 }
      const entries = getBilledUsageByModel('claude-fable-5', usage)
      expect(entries).toHaveLength(1)
      expect(entries[0].model).toBe('claude-fable-5')
      expect(entries[0].cost).toBeCloseTo(60, 6) // 10 input + 50 output
    })

    it('bills only the serving model when Fable 5 declines before output', () => {
      // Real shape from the refusals-and-fallback docs: Fable 5 declines with
      // output_tokens: 0, Opus 4.8 serves the turn.
      const usage: RawUsage = {
        input_tokens: 412,
        output_tokens: 264,
        iterations: [
          {
            type: 'message',
            model: 'claude-fable-5',
            input_tokens: 535,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          {
            type: 'fallback_message',
            model: 'claude-opus-4-8',
            input_tokens: 412,
            output_tokens: 264,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        ],
      }
      const entries = getBilledUsageByModel('claude-fable-5', usage)
      // The declined Fable 5 attempt (0 output) is not billed and is dropped.
      expect(entries).toHaveLength(1)
      expect(entries[0].model).toBe('claude-opus-4-8')
      expect(entries[0].inputTokens).toBe(412)
      expect(entries[0].outputTokens).toBe(264)

      // Cost is billed at Opus 4.8 rates, not Fable 5 rates.
      const expected = (412 / 1_000_000) * 5 + (264 / 1_000_000) * 25
      expect(calculateUsageCost('claude-fable-5', usage)).toBeCloseTo(expected, 9)
    })

    it('returns no billed entries when every attempt declines before output', () => {
      const usage: RawUsage = {
        input_tokens: 500,
        output_tokens: 0,
        iterations: [
          { type: 'message', model: 'claude-fable-5', input_tokens: 500, output_tokens: 0 },
          {
            type: 'fallback_message',
            model: 'claude-opus-4-8',
            input_tokens: 500,
            output_tokens: 0,
          },
        ],
      }
      expect(getBilledUsageByModel('claude-fable-5', usage)).toHaveLength(0)
      expect(calculateUsageCost('claude-fable-5', usage)).toBe(0)
    })

    it('returns no entries for undefined usage', () => {
      expect(getBilledUsageByModel('claude-fable-5', undefined)).toHaveLength(0)
      expect(calculateUsageCost('claude-fable-5', undefined)).toBe(0)
    })
  })
})
