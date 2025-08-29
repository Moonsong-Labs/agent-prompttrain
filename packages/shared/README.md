# Agent Prompt Train Shared Package

Shared types, configurations, and utilities used by both proxy and dashboard services.

## Overview

This package contains common code shared between services to ensure consistency and reduce duplication.

## Contents

### Types (`src/types/`)

- `claude.ts` - Claude API types and interfaces
- `context.ts` - Hono context types
- `errors.ts` - Custom error types

### Configuration (`src/config/`)

- `index.ts` - Centralized configuration management with validation

## Usage

```typescript
// Import from other services
import { config, validateConfig } from '@agent-prompttrain/shared/config'
import { ClaudeMessagesRequest } from '@agent-prompttrain/shared/types'
```

## Development

```bash
# Install dependencies
cd packages/shared
bun install

# Build the package
bun run build

# Watch for changes
bun run watch
```

## Build Output

The package builds to `dist/` with:

- CommonJS and ESM formats
- TypeScript declarations
- Source maps for debugging
