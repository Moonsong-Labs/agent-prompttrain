/**
 * Model context window limits configuration
 *
 * This file contains the context window limits for various Claude models.
 * The limits are based on official Anthropic announcements and documentation.
 *
 * @see https://docs.anthropic.com/en/docs/about-claude/models
 */

export interface ModelContextRule {
  pattern: RegExp
  limit: number
  source?: string // Optional source link for documentation
}

/**
 * Model context window rules
 * Order matters - more specific patterns should come before general ones
 *
 * Claude Fable 5, Mythos 5, Opus 5, Opus 4.6/4.7/4.8, Sonnet 5 and Sonnet 4.6
 * support 1M context windows. Models with "[1m]" suffix in their display name
 * also indicate 1M context. Earlier Claude 4.x models and Haiku use 200k
 * context windows.
 *
 * When a rule is missing for a released model the lookup silently falls back to
 * {@link DEFAULT_CONTEXT_LIMIT} (200k), which makes the dashboard context gauge
 * read several hundred percent for 1M-context models. {@link inferContextLimitByGeneration}
 * is the safety net for that; new models should still get an explicit rule here.
 *
 * @see https://platform.claude.com/docs/en/about-claude/models/overview
 * @see https://claude.com/blog/1m-context-ga
 */
export const MODEL_CONTEXT_RULES: ModelContextRule[] = [
  // 1M context models: explicit "[1m]" suffix in model/display name
  // Source: Claude Code display format for 1M context models
  {
    pattern: /\[1m\]/i,
    limit: 1000000,
    source: 'https://claude.com/blog/1m-context-ga',
  },

  // Claude Fable 5 / Mythos 5 - 1M context window (new top tier above Opus)
  // Mythos Preview shares Fable 5's specs and pricing (Project Glasswing).
  // Source: https://platform.claude.com/docs/en/about-claude/models/overview
  { pattern: /claude-(fable|mythos)-5|claude-mythos-preview/i, limit: 1000000 },

  // Claude Opus 5 - 1M context window
  // Source: https://platform.claude.com/docs/en/about-claude/models/overview
  { pattern: /claude-opus-5/i, limit: 1000000 },

  // Claude Opus 4.6 / 4.7 / 4.8 - 1M context window
  // Source: https://platform.claude.com/docs/en/about-claude/models/overview
  { pattern: /claude-opus-4-[678]/i, limit: 1000000 },

  // Claude Sonnet 5 - 1M context window
  // Source: https://platform.claude.com/docs/en/about-claude/models/overview
  { pattern: /claude-sonnet-5/i, limit: 1000000 },

  // Claude Sonnet 4.6 - 1M context window (GA March 2026)
  // Source: https://claude.com/blog/1m-context-ga
  { pattern: /claude-sonnet-4-6/i, limit: 1000000 },

  // Claude 4.5 and earlier 4.x (new naming: claude-{family}-{version}) - 200k context
  // Source: Anthropic API docs
  { pattern: /claude-opus-4/i, limit: 200000 },
  { pattern: /claude-sonnet-4/i, limit: 200000 },
  { pattern: /claude-haiku-4/i, limit: 200000 },

  // Claude 4 (legacy naming: claude-4-{family})
  // Source: Anthropic API docs (200k standard for Claude 4)
  { pattern: /claude-4.*opus/i, limit: 200000 },
  { pattern: /claude-4.*sonnet/i, limit: 200000 },

  // Claude 3.5 (both confirmed with 200k)
  // Source: https://www.anthropic.com/news/claude-3-5-sonnet (June 20, 2024)
  // Source: https://www.anthropic.com/claude/haiku (Oct 22, 2024)
  { pattern: /claude-3\.5.*sonnet/i, limit: 200000 },
  { pattern: /claude-3\.5.*haiku/i, limit: 200000 },

  // Claude 3
  // Source: https://www.anthropic.com/news/claude-3-family (March 4, 2024)
  { pattern: /claude-3.*opus/i, limit: 200000 },
  { pattern: /claude-3.*sonnet/i, limit: 200000 },
  { pattern: /claude-3.*haiku/i, limit: 200000 },

  // Claude 2 (order matters - 2.1 before 2)
  // Source: Claude 2.1 announcement (200k), Claude 2.0 (100k)
  { pattern: /claude-2\.1/i, limit: 200000 },
  { pattern: /claude-2/i, limit: 100000 },

  // Claude Instant
  // Source: Anthropic docs (100k context)
  { pattern: /claude-instant/i, limit: 100000 },
]

/**
 * Default context limit for unknown models
 */
export const DEFAULT_CONTEXT_LIMIT = 200000

/**
 * Context limit for 1M-context models
 */
export const LARGE_CONTEXT_LIMIT = 1000000

/**
 * First Claude generation where the frontier families (Opus/Sonnet/Fable/Mythos)
 * ship with a 1M context window by default.
 *
 * Opus 4.6 was the first 1M model; every Opus/Sonnet/Fable release since has kept
 * 1M, so an unrecognised model from generation 5 or later is far more likely to be
 * 1M than 200k.
 */
const FIRST_LARGE_CONTEXT_GENERATION = 5

/**
 * Matches the modern `claude-<family>-<generation>[-<minor>]` id format,
 * e.g. `claude-opus-5`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`.
 */
const MODEL_GENERATION_PATTERN = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)/i

/**
 * Best-effort context limit for a model with no explicit rule.
 *
 * This exists so that a newly released model does not silently inherit the 200k
 * default - that under-reporting is what made the dashboard context gauge show
 * 300%+ for Claude Opus 5 before it had a rule. Results are always flagged as
 * estimates; add an explicit {@link MODEL_CONTEXT_RULES} entry once the real
 * limit is published.
 *
 * @param model - The model identifier
 * @returns The inferred limit, or null when the id shape is unrecognised
 */
export function inferContextLimitByGeneration(model: string): number | null {
  const match = MODEL_GENERATION_PATTERN.exec(model)
  if (!match) {
    return null
  }

  const family = match[1].toLowerCase()
  const generation = Number.parseInt(match[2], 10)

  // Haiku has stayed at 200k across every generation released so far.
  if (family === 'haiku') {
    return DEFAULT_CONTEXT_LIMIT
  }

  return generation >= FIRST_LARGE_CONTEXT_GENERATION ? LARGE_CONTEXT_LIMIT : null
}

/**
 * Get the context limit for a given model
 * @param model - The model identifier (e.g., "claude-3-opus-20240229")
 * @returns An object with the limit and whether it's an estimate
 */
export function getModelContextLimit(model: string): { limit: number; isEstimate: boolean } {
  for (const rule of MODEL_CONTEXT_RULES) {
    if (rule.pattern.test(model)) {
      return { limit: rule.limit, isEstimate: false }
    }
  }

  // No explicit rule - infer from the model generation before falling back
  const inferred = inferContextLimitByGeneration(model)
  if (inferred !== null) {
    return { limit: inferred, isEstimate: true }
  }

  // Unknown model - return default with estimate flag
  return { limit: DEFAULT_CONTEXT_LIMIT, isEstimate: true }
}

/**
 * Battery level thresholds for visualization
 * Non-linear scale to emphasize urgency near the limit
 */
export const BATTERY_THRESHOLDS = {
  GREEN: 0.7, // 0-70% = green (safe)
  YELLOW: 0.9, // 71-90% = yellow (caution)
  RED: 1.0, // 91-100% = red (warning)
  // >100% = red with exclamation (overflow)
} as const

/**
 * Get battery color based on usage percentage
 * @param percentage - Usage percentage (0-1+)
 * @returns CSS color value
 */
export function getBatteryColor(percentage: number): string {
  if (percentage <= BATTERY_THRESHOLDS.GREEN) {
    return '#22c55e'
  } // green-500
  if (percentage <= BATTERY_THRESHOLDS.YELLOW) {
    return '#eab308'
  } // yellow-500
  return '#ef4444' // red-500
}

/**
 * Get battery level (1-5) based on usage percentage
 * @param percentage - Usage percentage (0-1+)
 * @returns Battery level 1-5
 */
export function getBatteryLevel(percentage: number): number {
  if (percentage <= 0.2) {
    return 5
  }
  if (percentage <= 0.4) {
    return 4
  }
  if (percentage <= 0.6) {
    return 3
  }
  if (percentage <= 0.8) {
    return 2
  }
  return 1
}
