# Changelog

All notable changes to Agent Prompt Train will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
- Renamed client headers to `MSL-Train-Id` and `MSL-Account`, removing legacy `train-id`/`X-Train-Account`

### Fixed

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
