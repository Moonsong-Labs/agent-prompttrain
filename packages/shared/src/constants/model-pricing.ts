/**
 * Model pricing configuration and cost attribution
 *
 * Pattern-based pricing (USD per million tokens) for Claude models, based on
 * official Anthropic first-party API pricing.
 *
 * Cache pricing follows the standard Anthropic multipliers:
 * - cache read  = 0.1x  input price
 * - cache write = 1.25x input price (5-minute TTL)
 *
 * ## Fallback token attribution (Claude Fable 5)
 *
 * Claude Fable 5 can decline a request via its safety classifiers; with
 * server-side fallback the request is re-served by another model (e.g.
 * `claude-opus-4-8`) inside the same API call. The response `usage.iterations`
 * array records every attempt, each with its own `model` and token counts, and
 * the API bills each attempt at the rate of the model that ran it — the
 * top-level `usage` reflects only the attempt that produced the returned
 * message. A decline that happens before any output is generated is not billed.
 *
 * {@link getBilledUsageByModel} and {@link calculateUsageCost} implement this:
 * when `iterations` are present, cost is attributed per-iteration to the model
 * that actually ran, and pre-output declines (output_tokens === 0) are treated
 * as free.
 *
 * @see https://platform.claude.com/docs/en/about-claude/models/overview
 * @see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
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
 * Model pricing rules.
 * Order matters — more specific patterns must come before general ones.
 */
export const MODEL_PRICING_RULES: ModelPricingRule[] = [
  // Claude Fable 5 / Mythos 5 — top tier above Opus ($10 / $50 per MTok)
  // Mythos Preview shares Fable 5's specs and pricing (Project Glasswing).
  {
    pattern: /claude-(fable|mythos)-5|claude-mythos-preview/i,
    pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  },

  // Claude Opus 5 ($5 / $25 per MTok)
  {
    pattern: /claude-opus-5/i,
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },

  // Claude Opus 4.5 / 4.6 / 4.7 / 4.8 ($5 / $25 per MTok)
  {
    pattern: /claude-opus-4-[5678]/i,
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },

  // Claude Opus 4.0 / 4.1 and Claude 3 Opus (legacy premium pricing)
  {
    pattern: /claude-opus-4|claude-3-opus|claude-4.*opus/i,
    pricing: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },

  // Claude Sonnet 5 / 4.x / 3.x (all Sonnet generations share this price point)
  {
    pattern: /claude-sonnet-5|claude-sonnet-4|claude-3.*sonnet|claude-4.*sonnet/i,
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
 * Get the pricing for a given model.
 * @param model - The model identifier (e.g., "claude-fable-5")
 * @returns The pricing and whether it's an estimate (unknown model → default)
 */
export function getModelPricing(model: string): { pricing: ModelPricing; isEstimate: boolean } {
  for (const rule of MODEL_PRICING_RULES) {
    if (rule.pattern.test(model)) {
      return { pricing: rule.pricing, isEstimate: false }
    }
  }
  return { pricing: DEFAULT_MODEL_PRICING, isEstimate: true }
}

/** Token counts in camelCase, as used by the dashboard/storage layer. */
export interface TokenUsageInput {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

/**
 * Calculate the estimated cost (USD) for token usage on a single model.
 */
export function calculateRequestCost(model: string, usage: TokenUsageInput): number {
  const { pricing } = getModelPricing(model)
  return (
    ((usage.inputTokens ?? 0) / 1_000_000) * pricing.input +
    ((usage.outputTokens ?? 0) / 1_000_000) * pricing.output +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) * pricing.cacheRead +
    ((usage.cacheCreationTokens ?? 0) / 1_000_000) * pricing.cacheWrite
  )
}

/**
 * A single attempt recorded in the Claude API response `usage.iterations`.
 * Field names are the raw API (snake_case) shape.
 */
export interface RawUsageIteration {
  /** "message" = an attempt that ran (and may have declined); "fallback_message" = the attempt that served the turn */
  type?: string
  model?: string
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/**
 * The raw Claude API response `usage` object (snake_case), optionally carrying
 * per-attempt `iterations` when server-side fallback ran.
 */
export interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  iterations?: RawUsageIteration[]
}

/** Billed token usage attributed to a specific model, with its computed cost. */
export interface BilledUsageEntry {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** True when the model didn't match a known pricing rule (cost is an estimate). */
  isEstimate: boolean
  /** Estimated cost in USD for this entry. */
  cost: number
}

/**
 * Attribute billed token usage to the model(s) that actually ran, handling
 * Claude Fable 5 fallback.
 *
 * When `usage.iterations` is present, each billed attempt is attributed to its
 * own `model`. Attempts that declined before producing any output
 * (`output_tokens === 0`) are omitted because they are not billed. When there
 * are no iterations, the top-level usage is attributed to `topLevelModel`.
 *
 * @param topLevelModel - The model recorded for the request (used when there are no iterations, and as a fallback for iterations missing a model).
 * @param usage - The raw API `usage` object.
 */
export function getBilledUsageByModel(topLevelModel: string, usage?: RawUsage): BilledUsageEntry[] {
  const toEntry = (model: string, u: RawUsageIteration | RawUsage): BilledUsageEntry => {
    const inputTokens = u.input_tokens ?? 0
    const outputTokens = u.output_tokens ?? 0
    const cacheReadTokens = u.cache_read_input_tokens ?? 0
    const cacheCreationTokens = u.cache_creation_input_tokens ?? 0
    const { isEstimate } = getModelPricing(model)
    return {
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      isEstimate,
      cost: calculateRequestCost(model, {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      }),
    }
  }

  if (!usage) {
    return []
  }

  const iterations = usage.iterations
  if (Array.isArray(iterations) && iterations.length > 0) {
    return (
      iterations
        // Skip pre-output declines: a refusal before any output is generated is
        // not billed (see refusals-and-fallback billing rules).
        .filter(it => (it.output_tokens ?? 0) > 0)
        .map(it => toEntry(it.model || topLevelModel, it))
    )
  }

  return [toEntry(topLevelModel, usage)]
}

/**
 * Calculate the total estimated cost (USD) for a request's raw API usage,
 * attributing fallback iterations to the model that actually ran each attempt.
 */
export function calculateUsageCost(topLevelModel: string, usage?: RawUsage): number {
  return getBilledUsageByModel(topLevelModel, usage).reduce((sum, entry) => sum + entry.cost, 0)
}
