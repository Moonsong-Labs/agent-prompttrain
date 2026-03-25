import { describe, expect, it } from 'bun:test'
import {
  getModelContextLimit,
  getBatteryColor,
  getBatteryLevel,
  BATTERY_THRESHOLDS,
} from '../model-limits'

describe('Model Context Limits', () => {
  describe('getModelContextLimit', () => {
    // Test 1M context models - Claude 4.6 (Opus & Sonnet)
    it('should return 1M for Claude Opus 4.6', () => {
      const result = getModelContextLimit('claude-opus-4-6')
      expect(result).toEqual({ limit: 1000000, isEstimate: false })
    })

    it('should return 1M for Claude Sonnet 4.6', () => {
      const result = getModelContextLimit('claude-sonnet-4-6')
      expect(result).toEqual({ limit: 1000000, isEstimate: false })
    })

    it('should return 1M for Claude Opus 4.6 with [1m] display suffix', () => {
      const result = getModelContextLimit('claude-opus-4-6[1m]')
      expect(result).toEqual({ limit: 1000000, isEstimate: false })
    })

    // Test 200k for earlier Claude 4.x models
    it('should return 200k for Claude Opus 4.5', () => {
      const result = getModelContextLimit('claude-opus-4-5-20251101')
      expect(result).toEqual({ limit: 200000, isEstimate: false })
    })

    it('should return 200k for Claude Opus 4.1', () => {
      const result = getModelContextLimit('claude-opus-4-1-20250805')
      expect(result).toEqual({ limit: 200000, isEstimate: false })
    })

    it('should return 200k for Claude Haiku 4.5', () => {
      const result = getModelContextLimit('claude-haiku-4-5-20251001')
      expect(result).toEqual({ limit: 200000, isEstimate: false })
    })

    // Test exact model matches
    it('should return 200k for Claude 3.5 Sonnet', () => {
      const result = getModelContextLimit('claude-3-5-sonnet-20241022')
      expect(result).toEqual({ limit: 200000, isEstimate: false })
    })

    it('should return 200k for Claude 3.5 Haiku', () => {
      const result = getModelContextLimit('claude-3-5-haiku-20241022')
      expect(result).toEqual({ limit: 200000, isEstimate: false })
    })

    it('should return 200k for Claude 3 Opus', () => {
      const result = getModelContextLimit('claude-3-opus-20240229')
      expect(result).toEqual({ limit: 200000, isEstimate: false })
    })

    // Test specificity - Claude 2.1 vs Claude 2
    it('should return 200k for Claude 2.1 (not 100k from Claude 2 rule)', () => {
      const result = getModelContextLimit('claude-2.1')
      expect(result).toEqual({ limit: 200000, isEstimate: false })
    })

    it('should return 100k for Claude 2.0', () => {
      const result = getModelContextLimit('claude-2.0')
      expect(result).toEqual({ limit: 100000, isEstimate: false })
    })

    // Test future-proofing with dates
    it('should match future-dated Claude 3 Opus model', () => {
      const result = getModelContextLimit('claude-3-opus-20250101')
      expect(result).toEqual({ limit: 200000, isEstimate: false })
    })

    it('should match future-dated Claude 4 Sonnet model (legacy naming)', () => {
      const result = getModelContextLimit('claude-4-sonnet-20250515')
      expect(result).toEqual({ limit: 200000, isEstimate: false })
    })

    // Test case insensitivity
    it('should match models case-insensitively', () => {
      const result1 = getModelContextLimit('CLAUDE-3-OPUS-20240229')
      expect(result1).toEqual({ limit: 200000, isEstimate: false })

      const result2 = getModelContextLimit('Claude-3-Opus-20240229')
      expect(result2).toEqual({ limit: 200000, isEstimate: false })
    })

    // Test unknown models
    it('should return default with estimate flag for unknown model', () => {
      const result = getModelContextLimit('claude-x-experimental')
      expect(result).toEqual({ limit: 200000, isEstimate: true })
    })

    it('should return default with estimate flag for gpt-4', () => {
      const result = getModelContextLimit('gpt-4')
      expect(result).toEqual({ limit: 200000, isEstimate: true })
    })

    // Test Claude Instant
    it('should return 100k for Claude Instant', () => {
      const result = getModelContextLimit('claude-instant-1.2')
      expect(result).toEqual({ limit: 100000, isEstimate: false })
    })

    // Test partial matches
    it('should match partial model names', () => {
      const result = getModelContextLimit('claude-3-sonnet')
      expect(result).toEqual({ limit: 200000, isEstimate: false })
    })
  })

  describe('getBatteryColor', () => {
    it('should return green for 0-70%', () => {
      expect(getBatteryColor(0)).toBe('#22c55e')
      expect(getBatteryColor(0.5)).toBe('#22c55e')
      expect(getBatteryColor(0.7)).toBe('#22c55e')
    })

    it('should return yellow for 71-90%', () => {
      expect(getBatteryColor(0.71)).toBe('#eab308')
      expect(getBatteryColor(0.8)).toBe('#eab308')
      expect(getBatteryColor(0.9)).toBe('#eab308')
    })

    it('should return red for 91%+', () => {
      expect(getBatteryColor(0.91)).toBe('#ef4444')
      expect(getBatteryColor(1.0)).toBe('#ef4444')
      expect(getBatteryColor(1.5)).toBe('#ef4444') // overflow
    })
  })

  describe('getBatteryLevel', () => {
    it('should return correct battery levels', () => {
      expect(getBatteryLevel(0.1)).toBe(5) // 0-20%
      expect(getBatteryLevel(0.3)).toBe(4) // 21-40%
      expect(getBatteryLevel(0.5)).toBe(3) // 41-60%
      expect(getBatteryLevel(0.7)).toBe(2) // 61-80%
      expect(getBatteryLevel(0.9)).toBe(1) // 81-100%
      expect(getBatteryLevel(1.2)).toBe(1) // overflow
    })
  })

  describe('BATTERY_THRESHOLDS', () => {
    it('should have correct threshold values', () => {
      expect(BATTERY_THRESHOLDS.GREEN).toBe(0.7)
      expect(BATTERY_THRESHOLDS.YELLOW).toBe(0.9)
      expect(BATTERY_THRESHOLDS.RED).toBe(1.0)
    })
  })
})
