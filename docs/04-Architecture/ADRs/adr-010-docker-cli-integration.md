# ADR-010: Docker-Based Claude CLI Integration

## Status

Accepted

## Context

Users wanted to use the official Claude CLI tool through the proxy for:

- Interactive Claude sessions with proxy benefits
- Token tracking for CLI usage
- Consistent authentication across tools
- Integration with existing workflows

The challenge was integrating a third-party CLI tool while maintaining security, usability, and the proxy's tracking capabilities.

## Decision Drivers

- **Official Tool Support**: Use Anthropic's official CLI
- **Security**: Isolate CLI from host system
- **Usability**: Simple commands for users
- **Token Tracking**: Maintain usage visibility
- **File Access**: Support file operations
- **Environment Consistency**: Same setup across platforms

## Considered Options

1. **Native Installation**
   - Description: Users install CLI directly
   - Pros: Direct access, full performance
   - Cons: Installation complexity, version mismatches

2. **Proxy CLI Wrapper**
   - Description: Custom CLI that wraps proxy API
   - Pros: Full control, tailored features
   - Cons: Maintenance burden, missing CLI features

3. **Docker Container**
   - Description: CLI in container with proxy config
   - Pros: Consistent environment, easy setup
   - Cons: Docker requirement, file access complexity

4. **Shell Script Wrapper**
   - Description: Script that configures and runs CLI
   - Pros: Simple, no Docker needed
   - Cons: Platform differences, configuration issues

## Decision

We will provide **Docker-based Claude CLI integration** with pre-configured containers.

### Implementation Details

1. **Docker Service Configuration**:

   ```yaml
   services:
     claude-cli:
       image: ghcr.io/anthropics/claude-cli:latest
       profiles: ['claude']
       environment:
         CLAUDE_API_URL: http://proxy:3000
         CLAUDE_API_KEY: ${CLAUDE_CLI_API_KEY}
       volumes:
         - ./workspace:/workspace
       working_dir: /workspace
       stdin_open: true
       tty: true
   ```

2. **Authentication Flow**:

   ```
   CLI → Bearer Token → Proxy → Domain Resolution → Claude API
   ```

   - CLI uses standard Bearer authentication
   - Proxy maps to localhost.credentials.json
   - Token tracked under localhost domain

3. **Usage Monitoring**:

   ```typescript
   // Additional monitoring for CLI usage
   if (domain === 'localhost' && userAgent.includes('claude-cli')) {
     metrics.trackCliUsage(request)
   }
   ```

4. **Helper Commands**:

   ```bash
   # Interactive session
   docker compose run --rm claude-cli claude

   # Single command
   docker compose run --rm claude-cli claude "Explain Docker"

   # With file access
   docker compose run --rm -v $(pwd):/workspace claude-cli claude "Review this code" /workspace/app.py
   ```

## Consequences

### Positive

- **Zero Installation**: No local CLI setup required
- **Version Control**: Consistent CLI version via Docker tags
- **Isolated Environment**: No system pollution
- **Token Tracking**: Full visibility of CLI usage
- **Cross-Platform**: Works identically on all Docker platforms
- **File Access**: Volume mounts enable file operations

### Negative

- **Docker Dependency**: Requires Docker installation
- **Performance Overhead**: Container startup time
- **File Path Complexity**: Must understand volume mounts
- **Network Isolation**: Container networking knowledge needed

### Risks and Mitigations

- **Risk**: File permissions issues with volumes
  - **Mitigation**: Document UID/GID considerations
  - **Mitigation**: Use consistent workspace directory

- **Risk**: Credential exposure in container
  - **Mitigation**: Mount credentials read-only
  - **Mitigation**: Use environment variables for sensitive data

## Implementation Notes

- Introduced in PRs #17 and #19
- Uses official ghcr.io/anthropics/claude-cli image
- Integrated with docker-compose profiles
- Includes usage monitoring script (monitor command)
- Supports both interactive and batch modes

## Usage Patterns

1. **Interactive Development**:

   ```bash
   docker compose --profile claude up -d
   docker compose exec claude-cli claude
   ```

2. **Script Integration**:

   ```bash
   echo "Explain this error: $ERROR" | \
     docker compose run --rm claude-cli claude
   ```

3. **File Analysis**:
   ```bash
   docker compose run --rm \
     -v $(pwd):/workspace \
     claude-cli claude "Review" /workspace/src/
   ```

## Monitoring Integration

- `ccusage` command for token statistics
- `monitor` command for real-time tracking
- Integration with proxy's token tracking
- Appears in dashboard under localhost domain

## Future Enhancements

1. **Native Binary Distribution**: Package CLI with proxy
2. **Web Terminal**: Browser-based CLI interface
3. **Session Persistence**: Save CLI conversation state
4. **Custom Commands**: Proxy-specific CLI features
5. **Multi-User Support**: Separate CLI sessions per user

## Links

- [PR #17: Docker CLI Setup](https://github.com/Moonsong-Labs/agent-prompttrain/pull/17)
- [PR #19: CLI Enhancements](https://github.com/Moonsong-Labs/agent-prompttrain/pull/19)
- [Claude CLI Guide](../../02-User-Guide/claude-cli.md)

---

Date: 2024-06-25
Authors: Development Team
