#\!/bin/bash

# URL encode function
urlencode() {
    python3 -c "import urllib.parse; print(urllib.parse.quote('''$1'''))"
}

TITLE="Major technical debt cleanup and memory leak fixes"
BODY="## Summary
- Fixed critical memory leaks in message and credential caches
- Removed unused dependencies and outdated configuration files  
- Improved code security by removing sensitive data logging

## Memory Leak Fixes
- **previousUserMessages Map**: Implemented LRU cache with 1000 entry limit to prevent unbounded growth
- **Credential cache**: Added TTL (1 hour) and size limit (100 entries) with automatic cleanup every 5 minutes
- Both caches now properly evict old entries when limits are reached

## Code Quality Improvements
- Extracted database configuration to eliminate duplication between Pool and StorageService
- Defined constants for all magic numbers (DEFAULT_DB_PORT, MAX_SLACK_LINES, etc.)
- Made OAuth CLIENT_ID configurable via CLAUDE_OAUTH_CLIENT_ID environment variable
- Fixed infinite recursion bug in setCachedMessage function

## Security Enhancements
- Removed debug console.log in credentials.ts that was logging sensitive OAuth refresh tokens
- Improved credential caching with proper TTL management to reduce exposure window

## Repository Cleanup
- Removed unused \`axios\` dependency from package.json
- Deleted outdated \`compose.yml\` with 20+ unused environment variables
- Moved test scripts to \`scripts/\` directory for better organization
- Removed \`tsconfig.tsbuildinfo\` from git tracking (build cache file)

## Impact
- **Reduced memory usage**: Prevents memory leaks in long-running deployments
- **Improved security**: No more sensitive tokens in logs
- **Better maintainability**: Constants make configuration changes easier
- **Cleaner repository**: Removed redundant files and dependencies

## Test plan
- [x] Verify previousUserMessages cache evicts entries when full
- [x] Verify credential cache expires entries after 1 hour
- [x] Confirm OAuth refresh still works without logging tokens
- [x] Test that all endpoints still function correctly
- [ ] Monitor memory usage in production to confirm leak fixes

🤖 Generated with [Claude Code](https://claude.ai/code)"

ENCODED_TITLE=$(urlencode "$TITLE")
ENCODED_BODY=$(urlencode "$BODY")

echo "Click this URL to create the PR:"
echo ""
echo "https://github.com/Moonsong-Labs/agent-prompttrain-proxy/compare/main...technical-debt-cleanup?quick_pull=1&title=$ENCODED_TITLE&body=$ENCODED_BODY"
