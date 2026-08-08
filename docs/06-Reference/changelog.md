# Changelog

All notable changes to Agent Prompt Troject will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Subagent and post-compaction requests are grouped back into the session they belong to, instead of each starting its own conversation (see [ADR-003](../04-Architecture/ADRs/adr-003-conversation-tracking.md))
  - Claude Code 2.1 renamed the subagent tool `Task` → `Agent`. Subtask detection matched the literal name `Task`, so every subagent became a root conversation instead of a `subtask_N` branch. `SUBAGENT_TOOL_NAMES` now covers both names, in the subtask lookup and in the `task_tool_invocation` extraction that the dashboard reads
  - Claude Code 2.1 auto-compact carries the tail of the previous transcript over with the summary, so the first request after a compaction has 3+ conversation messages. Compact detection only ran on single-message requests, and the request's computed parent hash covers only the summary message — which was never sent on its own — so nothing could link it. Compact detection now also runs as a fallback for multi-message requests, after prefix and grandparent matching fail, so a genuine prefix match still wins and follow-up requests keep their branch
  - The compact preamble was reworded (`Summary:` after "The summary below covers the earlier portion of the conversation", trailing `If you need specific details from before compaction…` / `Continue the conversation from where it left off…`). Both the 2.1 and pre-2.1 markers are now recognised, and the summary is cut at the earliest trailing marker present
  - The summarizing response now wraps the summary in `<analysis>…</analysis><summary>`, so the compact parent search matches a bounded 2000-character prefix of the summary as a substring instead of requiring the response to start with it. Summaries under 100 characters are rejected rather than matching every row; the legacy `starts_with` comparison is retained for pre-2.1 data
  - Measured by replaying 6 hours of one project's production request bodies: 53 stored conversations collapse to 2 (one long session plus one unrelated single request), with 24 subagents correctly attached as `subtask_N` branches. Four other projects were replayed as a regression check — three unchanged, one improved 31 → 28
  - Existing rows keep their fragmented `conversation_id`; run `bun run scripts/db/rebuild-conversations.ts` to re-link historical data
- Conversation detection no longer fragments a single Claude Code session into many 1-2 request conversations (see [ADR-003](../04-Architecture/ADRs/adr-003-conversation-tracking.md))
  - Claude Code 2.1 injects `role: 'system'` messages into the `messages` array (system-reminders, hook output, tool nudges). They appear and disappear between turns and flip between plain-string and content-block form, which broke the prefix hashing that links a request to its parent
  - `ConversationLinker` now hashes the durable transcript only (`user`/`assistant` messages), and applies the same filter to the parent/grandparent offsets and to single-message compact/subtask detection — restoring subtask linking for subagent requests, whose first request is now `[user, system]`
  - String message content now has `<system-reminder>` blocks stripped, matching the content-block path, so both wire representations of the same message hash identically
  - Measured on 10 hours of production traffic: parent-link rate 72% → 93%, i.e. 76% fewer conversations created
  - Existing rows keep their fragmented `conversation_id`; run `bun run scripts/db/rebuild-conversations.ts` to re-link historical data
- System prompt hash no longer churns mid-session: the `x-anthropic-billing-header:` prelude (whose `cc_version` changes on every Claude Code release) is dropped, the new Claude Code prompt markers (`You are Claude Code, ...`, `You are an agent for Claude Code, ...`) are recognised, and the whole `gitStatus:` tail is removed instead of only its first paragraph
- Dashboard context gauge ("battery") no longer shows impossible percentages such as 300%+
  - `claude-opus-5` had no context-window rule, so its ~780k-token contexts were measured against the 200k default
  - Added rules for Claude Opus 5 and Mythos Preview (1M), plus `inferContextLimitByGeneration` so an unrecognised `claude-<family>-<n>` model with `n >= 5` is treated as 1M (200k for Haiku) and flagged as an estimate rather than silently defaulting to 200k
- Claude Opus 5 costs are no longer understated: it had no pricing rule and fell back to the Sonnet-tier default ($3/$15 instead of the correct $5/$25). Also added `claude-mythos-preview` (Fable 5 rates) and an Opus 5 entry to `scripts/aws-bedrock-cost-report.ts`
- Claude Sonnet 5 costs are no longer overstated by 50%: its [introductory pricing](https://platform.claude.com/docs/en/about-claude/pricing#claude-sonnet-5-introductory-pricing) of $2/$10 per MTok (cache write $2.50, cache read $0.20) is in effect through 2026-08-31, but the registry only carried the post-cutover $3/$15 rate
  - Pricing rules can now declare `introductory: { pricing, until }`; `getModelPricing`, `calculateRequestCost`, `getBilledUsageByModel` and `calculateUsageCost` take an optional `servedAt` timestamp
  - Dashboard cost paths pass each request's own timestamp, so a request priced under the introductory rate keeps that rate after the 2026-09-01 cutover instead of being retroactively re-priced
  - Measured on 7 days of traffic: Sonnet 5 spend $328.77 → $219.18 (−33.3%, exactly 2/3 of standard); all other models unchanged
  - The Bedrock cost report is intentionally left at $3/$15 — partner-operated platforms set their own rates
- Account pool no longer routes requests to accounts whose model-scoped limit is exhausted (fixes upstream `429 "This request could exceed your account's rate limit"` despite low 5h/7d usage)
  - Anthropic's OAuth usage response now carries a structured `limits[]` array with model-scoped weekly limits (e.g. a separate Claude Fable 5 allowance); the legacy `seven_day_opus`/`seven_day_sonnet` fields are null in live responses
  - Account selection is now model-aware: a saturated Fable-scoped limit exhausts the pool for Fable requests only, without blocking other models; sticky accounts are re-evaluated per requested model
  - Pool-exhausted 429s now surface the scoped limit's reset time
  - Dashboard/public token-usage pages now render model-scoped limit bars (e.g. "7-Day Fable") so exhausted limits are visible instead of only 5h/7d windows

### Changed

- Token Usage overview: projects with zero tokens are now hidden from the project list
- Token Usage overview: project list now shows 2-line format with percentage of 5-hour and 7-day windows including date ranges
- API `/api/token-usage/accounts` now returns `outputTokens7d` and `requests7d` per project for 7-day window usage

### Added

- Model pricing registry and Claude Fable 5 support (see [ADR-035](../04-Architecture/ADRs/adr-035-model-pricing-registry-and-fallback-cost-attribution.md))
  - New `packages/shared` pricing registry (`getModelPricing`, `calculateRequestCost`) with current per-model rates, including Claude Fable 5 / Mythos 5 ($10/$50 per MTok); replaces the obsolete hardcoded Claude-3-era rate table in the dashboard
  - Fallback-aware cost attribution (`getBilledUsageByModel`, `calculateUsageCost`): a Claude Fable 5 request re-served by an Opus 4.8 fallback is costed at the model that actually ran each attempt via the response `usage.iterations` array; pre-output declines are treated as unbilled
  - Dashboard per-model token/cost breakdown and single-request cost now use the registry (model-aware, fallback-aware)
  - Added Claude Fable 5 / Mythos 5, Opus 4.7 / 4.8, and Sonnet 5 to the 1M context-window rules
  - Added an optional `iterations` field to the shared Claude `usage` type
- Public token usage status page at `/public/token-usage` (no authentication required)
  - Shows Anthropic OAuth rate limit utilization (5h and 7d windows) per account
  - Compact multi-column layout with progress bars, reset times, and last-checked timestamps
  - Only Anthropic OAuth accounts shown; Bedrock accounts are filtered out
  - Link added to the authenticated Token Usage Overview page ("Public Status Page" button)
- Project disable/enable feature: administrators can disable abandoned projects to prevent members from using them
  - CLI script `scripts/disable-project.ts` to disable, re-enable, or list disabled projects
  - DB migration 021 adds `disabled` column to the `projects` table
  - Disabled projects reject all API key authentication while preserving historical data
  - Dashboard shows DISABLED badge for disabled projects
- Project system prompt override: projects can now define a system prompt that the proxy injects into all incoming Claude API requests
  - New `PUT /api/projects/:id/system-prompt` endpoint (requires project membership)
  - Enable/disable toggle and JSON editor in the dashboard project settings page
  - System prompt stored as a JSONB array of `SystemContentBlock` objects with optional `cache_control`
  - DB migration 020 adds `system_prompt_enabled` (boolean, default false) and `system_prompt` (JSONB) columns to the `projects` table
- Weekly conversations trend chart on dashboard overview page showing service usage over the last 12 weeks
  - New API endpoint `GET /api/analytics/conversations/weekly` with configurable week count and project filter
- Claude OAuth usage display in Token Usage page showing real-time account rate limits from Anthropic API
  - Overview page: Compact usage indicators (5h, 7d, Sonnet) under each account name
  - Detail page: Full "Claude Account Rate Limits" section with progress bars and reset times
  - New API endpoint `GET /api/oauth-usage/:accountId` to fetch usage from Anthropic OAuth API
- Silent OK handler for `/api/event_logging/*` endpoint used by Claude Code CLI (returns 200 without forwarding)
- Native Bedrock API error responses now forward `x-amzn-errortype`, `x-amzn-requestid`, and `retry-after` headers to clients for improved error handling and debugging
- Display of XML tags in dashboard conversation view (e.g., `<system-reminder>`, `<command>`) instead of filtering them
- Conversation branching visualization in dashboard
- Message count tracking at database level for performance
- Branch-specific statistics in conversation view
- Database backup script with timestamp support
- Comprehensive migration system with TypeScript support
- AI-powered conversation analysis infrastructure
  - New `conversation_analyses` table with ENUM status type
  - Automatic timestamp management via trigger
  - Optimized indexes for queue processing
  - Phase 2 Task 4: Prompt Engineering implementation
    - Smart truncation with tail-first priority
    - @lenml/tokenizer-gemini for local token counting
    - Zod schema validation for LLM responses
    - Versioned prompt templates (v1)
    - 855k token limit with 5% safety margin
  - Migration 011 for schema creation
  - Migration 012 for audit logging infrastructure
  - Comprehensive security implementation with PII redaction, rate limiting, and prompt injection protection
  - Security documentation with monitoring queries and best practices

### Changed

- Improved conversation tree rendering with squared arrows for branches
- Optimized dashboard queries using message_count column
- Reorganized scripts into categorized subdirectories
- Consolidated documentation into organized docs/ folder
- Updated request information display for better density
- Renamed client headers to `MSL-Project-Id` and `MSL-Account`, removing legacy `project-id`/`X-Train-Account`
- Switched account selection fallback to deterministic per-troject hashing instead of random rotation

### Fixed

- Content-Encoding header now properly filtered from proxy responses to prevent client ZlibError decompression failures (Fetch API auto-decompresses upstream responses)
- Branch parent resolution for conversations with hash collisions
- Conversation tree pointing to incorrect parent requests
- Message count display showing 0 for existing conversations
- Conversation UI now properly displays messages with multiple tool_use or tool_result blocks
- Added deduplication of tool_use and tool_result blocks by ID to prevent duplicate display
- System reminder text blocks are now filtered out from conversation display

## [2.0.0] - 2024-01-15

### Added

- Monorepo structure with separate proxy and dashboard services
- Real-time dashboard with SSE updates
- Conversation tracking with automatic message threading
- OAuth support with automatic token refresh
- Docker support with optimized separate images
- Comprehensive token usage tracking
- Branch detection for conversation forks

### Changed

- Complete rewrite using Bun runtime
- Migrated from single service to microservices architecture
- Improved streaming response handling
- Enhanced security with client API keys

### Removed

- Node.js dependency (now Bun-only)
- Single container deployment (now uses separate containers)

## [1.0.0] - 2023-12-01

### Added

- Initial proxy implementation
- Basic request forwarding to Claude API
- Simple logging and monitoring
- Docker support
- Environment-based configuration

---

_For detailed migration guides between versions, see [docs/MIGRATION.md](docs/MIGRATION.md)_
