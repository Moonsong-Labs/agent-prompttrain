# ADR-035: Model Pricing Registry and Fallback Cost Attribution

## Status

Accepted

## Context

The proxy stores token usage (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) per request in a model-agnostic way (see [ADR-005](./adr-005-token-usage-tracking.md)). Cost, however, was computed in two disconnected, out-of-date places in the dashboard:

- `services/dashboard/src/utils/conversation.ts` (`calculateCost`) — a flat, model-blind rate (Opus-era $15/$75), overridable only by two global env vars.
- `services/dashboard/src/routes/partials/analytics-conversation.ts` — a hardcoded `rates` map covering only Claude 3-era models (`claude-3-opus/sonnet/haiku`, `claude-2`), matched by a fuzzy `.includes()` that silently defaulted unknown models to Sonnet rates.

Neither knew about current models. **Claude Fable 5** (`claude-fable-5`) makes this concretely wrong:

1. Its pricing is $10/$50 per MTok — 2× Opus 4.8 and outside every existing rate entry, so it was being costed at the Sonnet default (~5× too low).
2. Fable 5 ships safety classifiers that can decline a request. With server-side fallback, the request is re-served by another model (e.g. Opus 4.8) **inside the same API call**. The response `usage.iterations` array records each attempt with its own `model` and token counts, and the API bills each attempt at the rate of the model that actually ran it — a decline before any output is not billed at all. The Messages API `usage` object is otherwise unchanged for Fable 5 (there is no new top-level token-count field).

A single "Fable 5 request" can therefore incur Opus 4.8 token costs. Attributing the whole request to `claude-fable-5` at Fable rates over/mis-states cost. We need (a) a single, current, per-model pricing source and (b) cost attribution that follows `usage.iterations` to the model that actually ran each attempt.

## Decision Drivers

- **Correctness**: current per-model rates, and cost attributed to the model that actually served each attempt.
- **Single source of truth**: one pricing registry in `packages/shared`, reused by every consumer (ADR-001).
- **No schema change**: usage is already persisted verbatim in `usage_data` (JSONB), including `iterations`; attribution is a read-time computation.
- **Low blast radius**: additive; unknown models keep working via a flagged default estimate.

## Considered Options

1. **Per-model pricing registry in `packages/shared` + fallback-aware attribution (chosen)**
   - Regex-based pricing rules (`getModelPricing`, `calculateRequestCost`) plus `getBilledUsageByModel`/`calculateUsageCost` that read `usage.iterations`.
   - Pros: single source of truth; correct fallback attribution; reusable across proxy/dashboard/scripts; unknown models flagged as estimates.
   - Cons: regex ordering must be maintained; attribution relies on the documented `iterations` shape.

2. **Patch the existing hardcoded dashboard rate maps in place**
   - Pros: smallest diff.
   - Cons: keeps two divergent sources of truth; still no fallback attribution; not reusable by the proxy or scripts.

3. **Persist a computed `cost` column at write time**
   - Pros: cheap reads; historical cost frozen at request time.
   - Cons: schema migration; rates baked in at write time can't be corrected retroactively; larger change than warranted.

## Decision

Add a shared pricing module `packages/shared/src/constants/model-pricing.ts`:

- `MODEL_PRICING_RULES` / `getModelPricing(model, servedAt?)` — regex-matched USD-per-MTok rates for input, output, cache read, and cache write, including `claude-fable-5`/`claude-mythos-5`/`claude-mythos-preview` ($10/$50), `claude-opus-5` and Opus 4.5–4.8 ($5/$25), legacy Opus (4.0/4.1/3) ($15/$75), all Sonnet generations ($3/$15), and the Haiku/Claude-2 tiers. Unknown models fall back to `DEFAULT_MODEL_PRICING` (Sonnet-tier) with `isEstimate: true`.
- **Time-aware introductory pricing.** A rule may carry an optional `introductory: { pricing, until }`, applied to requests served strictly before the cutover. Claude Sonnet 5 launched at $2/$10 per MTok with the standard $3/$15 taking effect 2026-09-01 ([docs](https://platform.claude.com/docs/en/about-claude/pricing#claude-sonnet-5-introductory-pricing)). Anthropic publishes these boundaries as calendar dates with no timezone, so `SONNET_5_STANDARD_PRICING_START` encodes UTC midnight.
- `calculateRequestCost(model, usage, servedAt?)` — single-model cost from camelCase token counts.
- `getBilledUsageByModel(topLevelModel, usage, servedAt?)` / `calculateUsageCost(...)` — **fallback-aware**: when `usage.iterations` is present, cost is attributed per iteration to the model that ran it, and attempts that declined before producing output (`output_tokens === 0`) are dropped because they are not billed. With no iterations, the top-level usage is attributed to the request's model.

`servedAt` is the timestamp of the request being priced, and callers must pass it: a request is billed at the rate in effect when it ran, so a July 2026 Sonnet 5 request keeps its $2/$10 rate when its cost is displayed in September. Omitting `servedAt` prices at the current wall clock, which is correct only for live traffic. The Bedrock cost report (`scripts/aws-bedrock-cost-report.ts`) intentionally does **not** apply the discount: partner-operated platforms set their own rates.

Consumers:

- Dashboard per-model breakdown (`analytics-conversation.ts`) now attributes tokens **and** cost to the model that actually ran each attempt, replacing the obsolete Claude-3 rate map.
- Single-request cost (`request-details.ts`) uses the registry (fallback-aware) instead of the flat `calculateCost`. `calculateCost` itself is left in place as a generic env-configurable fallback.
- `packages/shared/src/types/claude.ts` gains an optional `iterations?: ClaudeUsageIteration[]` on the response `usage` type.
- 1M context-window rules (`model-limits.ts`) add Fable 5/Mythos 5/Mythos Preview, Opus 5, Opus 4.7/4.8, and Sonnet 5. `inferContextLimitByGeneration` is a generational safety net: an unrecognised `claude-<family>-<n>` model with `n >= 5` is treated as 1M (200k for Haiku) and flagged `isEstimate: true`, so a newly released model no longer silently inherits the 200k default — that gap made the dashboard context gauge read 300%+ for Opus 5.
- `model-mapping.ts` gets a clarifying comment: newer models have no verified legacy ARN-versioned Bedrock IDs and intentionally pass through unchanged.

### Implementation Details

```ts
// Fallback example straight from the refusals-and-fallback docs:
// Fable 5 declines (output_tokens: 0), Opus 4.8 serves the turn.
calculateUsageCost('claude-fable-5', {
  input_tokens: 412,
  output_tokens: 264,
  iterations: [
    { type: 'message', model: 'claude-fable-5', input_tokens: 535, output_tokens: 0 },
    { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 412, output_tokens: 264 },
  ],
})
// → billed at Opus 4.8 rates only; the declined Fable 5 attempt is not billed.
```

## Consequences

### Positive

- One current, tested pricing source reused across services.
- Fallback requests are costed against the model that actually served them.
- Unknown/future models degrade gracefully (flagged estimate) rather than silently mis-pricing.

### Negative

- Regex rule ordering must be kept correct (most specific first); adding a model means adding a rule.
- The shared registry and the standalone `scripts/aws-bedrock-cost-report.ts` table remain separate (the script targets Bedrock per-region pricing); both must be updated when rates change.

### Risks and Mitigations

- **Risk**: the `output_tokens === 0 ⇒ unbilled` heuristic could under-count a genuinely-billed mid-stream decline.
  - **Mitigation**: matches the documented pre-output-refusal billing rule and the canonical `iterations` example; mid-output declines carry `output_tokens > 0` and are billed normally. Covered by unit tests.
- **Risk**: `usage.iterations` shape drift.
  - **Mitigation**: parsing is permissive (all fields optional) and falls back to top-level attribution when `iterations` is absent.

## Links

- [ADR-005: Token Usage Tracking](./adr-005-token-usage-tracking.md)
- [ADR-001: Monorepo Structure](./adr-001-monorepo-structure.md)
- [ADR-030: Multi-Provider Support](./adr-030-multi-provider-support.md)
- [Anthropic — Refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)
- [Anthropic — Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)

## Notes

Fable 5 uses the same tokenizer as Opus 4.8, so token _counts_ are unchanged versus Opus 4.7/4.8 — only the per-token _price_ differs (and, on fallback, the model those tokens are billed against). No count-conversion logic is needed.

---

Date: 2026-07-05
Authors: AI agent (Claude)
