/**
 * Model pricing configuration
 *
 * Pattern-based pricing (USD per million tokens) for Claude models, based on
 * official Anthropic first-party API pricing.
 *
 * Cache pricing follows the standard Anthropic multipliers:
 * - cache read  = 0.1x  input price
 * - cache write = 1.25x input price (5-minute TTL)
 *
 * @see https://platform.claude.com/docs/en/about-claude/models/overview
 * @see https://platform.claude.com/docs/en/pricing
 */

export interface ModelPricing {
  /** USD per 1M input tokens */
  input: number
  /** USD per 1M output tokens */
  output: number
  /** USD per 1M cache read tokens */
  cacheRead: number
  /** USD per 1M cache write tokens (5-minute TTL) */
  cacheWrite: number
}

export interface ModelPricingRule {
  pattern: RegExp
  pricing: ModelPricing
}

/**
 * Model pricing rules
 * Order matters - more specific patterns should come before general ones
 */
export const MODEL_PRICING_RULES: ModelPricingRule[] = [
  // Claude Fable 5 - new top tier above Opus
  {
    pattern: /claude-fable-5/i,
    pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  },

  // Claude Opus 4.5 / 4.6 / 4.7 / 4.8
  {
    pattern: /claude-opus-4-[5678]/i,
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },

  // Claude Opus 4.0 / 4.1 and Claude 3 Opus (legacy premium pricing)
  {
    pattern: /claude-opus-4|claude-3-opus|claude-4.*opus/i,
    pricing: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },

  // Claude Sonnet (all generations share the same price point)
  {
    pattern:
      /claude-sonnet-4|claude-3-7-sonnet|claude-3-5-sonnet|claude-3.*sonnet|claude-4.*sonnet/i,
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },

  // Claude Haiku 4.5
  {
    pattern: /claude-haiku-4/i,
    pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },

  // Claude 3.5 Haiku
  {
    pattern: /claude-3-5-haiku|claude-3\.5.*haiku/i,
    pricing: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  },

  // Claude 3 Haiku
  {
    pattern: /claude-3.*haiku/i,
    pricing: { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
  },

  // Claude 2.x (retired, kept for historical request data)
  {
    pattern: /claude-2/i,
    pricing: { input: 8, output: 24, cacheRead: 0.8, cacheWrite: 10 },
  },
]

/**
 * Default pricing for unknown models (Sonnet-tier as a middle-ground estimate)
 */
export const DEFAULT_MODEL_PRICING: ModelPricing = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
}

/**
 * Get the pricing for a given model
 * @param model - The model identifier (e.g., "claude-opus-4-8")
 * @returns An object with the pricing and whether it's an estimate (unknown model)
 */
export function getModelPricing(model: string): { pricing: ModelPricing; isEstimate: boolean } {
  for (const rule of MODEL_PRICING_RULES) {
    if (rule.pattern.test(model)) {
      return { pricing: rule.pricing, isEstimate: false }
    }
  }
  return { pricing: DEFAULT_MODEL_PRICING, isEstimate: true }
}

/**
 * Calculate the estimated cost (USD) for token usage on a given model
 */
export function calculateRequestCost(
  model: string,
  usage: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  }
): number {
  const { pricing } = getModelPricing(model)
  return (
    ((usage.inputTokens ?? 0) / 1_000_000) * pricing.input +
    ((usage.outputTokens ?? 0) / 1_000_000) * pricing.output +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) * pricing.cacheRead +
    ((usage.cacheCreationTokens ?? 0) / 1_000_000) * pricing.cacheWrite
  )
}
