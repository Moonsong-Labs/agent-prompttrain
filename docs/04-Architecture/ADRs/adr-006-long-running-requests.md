# ADR-006: Support for Long-Running Requests

## Status

Accepted

## Context

Claude API requests, especially those involving complex reasoning or large contexts, can take several minutes to complete. The default timeouts in many HTTP clients and servers (typically 30-60 seconds) were causing premature disconnections, resulting in:

- Failed requests despite Claude API processing successfully
- Lost work and wasted tokens
- Poor user experience with complex queries
- Inability to use Claude's full capabilities

We needed to support requests that could run for 10+ minutes while maintaining system stability and providing proper error handling.

## Decision Drivers

- **Claude API Compatibility**: Support Claude's actual processing times
- **User Experience**: Prevent frustrating timeout errors
- **System Stability**: Avoid resource exhaustion from hanging connections
- **Error Recovery**: Graceful handling of genuinely stuck requests
- **Configuration Flexibility**: Different timeouts for different use cases

## Considered Options

1. **Fixed Extended Timeout**
   - Description: Increase all timeouts to 10 minutes
   - Pros: Simple implementation
   - Cons: Wastes resources on genuinely failed requests

2. **Progressive Timeout**
   - Description: Start with short timeout, increase on retry
   - Pros: Fast failure for actual errors
   - Cons: Complex implementation, multiple request attempts

3. **Configurable Timeouts**
   - Description: Environment variables for different timeout values
   - Pros: Flexible, adaptable to different needs
   - Cons: Requires configuration knowledge

4. **Adaptive Timeout**
   - Description: Adjust timeout based on model and request size
   - Pros: Optimal for each request type
   - Cons: Complex logic, hard to predict

## Decision

We will implement **configurable timeouts** with sensible defaults for long-running requests.

### Implementation Details

1. **Timeout Configuration**:

   ```bash
   # Environment variables
   CLAUDE_API_TIMEOUT=600000      # 10 minutes (default)
   PROXY_SERVER_TIMEOUT=660000    # 11 minutes (default)
   ```

2. **Timeout Hierarchy**:
   - Claude API timeout: 10 minutes
   - Proxy server timeout: 11 minutes (allows for overhead)
   - Client connection timeout: Should be > 11 minutes

3. **Streaming Support**:

   ```typescript
   // Keep connection alive during streaming
   const streamWithHeartbeat = (stream: ReadableStream) => {
     const heartbeatInterval = setInterval(() => {
       // Send keep-alive comment every 30 seconds
       controller.enqueue(': keep-alive\n\n')
     }, 30000)

     stream.finally(() => clearInterval(heartbeatInterval))
   }
   ```

4. **Error Handling**:
   ```typescript
   try {
     const response = await fetchWithTimeout(claudeUrl, requestOptions, CLAUDE_API_TIMEOUT)
   } catch (error) {
     if (error.name === 'AbortError') {
       throw new Error('Claude API request timeout after 10 minutes')
     }
     throw error
   }
   ```

## Consequences

### Positive

- **Full Claude Capabilities**: Supports complex, long-running queries
- **Improved Reliability**: Fewer false timeout failures
- **Flexible Configuration**: Adapts to different deployment needs
- **Better UX**: Users can run sophisticated prompts without errors
- **Streaming Support**: Long-running streams don't disconnect

### Negative

- **Resource Usage**: Connections held open longer
- **Harder Debugging**: Long waits to confirm if request is stuck
- **Client Requirements**: Clients must also support long timeouts
- **Potential for Abuse**: Malicious users could exhaust connections

### Risks and Mitigations

- **Risk**: Resource exhaustion from many long connections
  - **Mitigation**: Connection limits per project_id
  - **Mitigation**: Monitor active connection count

- **Risk**: Genuinely stuck requests waste resources
  - **Mitigation**: Server timeout slightly higher than API timeout
  - **Mitigation**: Proper error logging for investigation

- **Risk**: Client disconnections during long requests
  - **Mitigation**: Document required client timeout settings
  - **Mitigation**: Keep-alive messages for streaming

## Implementation Notes

- Introduced in PR #16
- Default 10-minute timeout based on Claude API observations
- Server timeout 1 minute higher to allow for processing overhead
- Keep-alive mechanism for streaming responses
- Configurable via environment variables

## Operational Considerations

1. **Monitoring**:
   - Track request duration distribution
   - Alert on requests approaching timeout
   - Monitor timeout error rates

2. **Client Configuration**:

   ```bash
   # Example client timeouts
   curl --max-time 660 ...
   fetch(url, { signal: AbortSignal.timeout(660000) })
   ```

3. **Load Balancer Settings**:
   - Ensure LB timeout > 11 minutes
   - Configure keep-alive appropriately

## Future Enhancements

1. **Dynamic Timeouts**: Based on model and request complexity
2. **Timeout Warnings**: Notify when approaching timeout
3. **Request Estimation**: Predict processing time
4. **Partial Results**: Return partial response if timeout approaching
5. **Background Processing**: Async processing with webhook callbacks

## Links

- [PR #16: Long-running request support](https://github.com/Moonsong-Labs/agent-prompttrain/pull/16)
- [Configuration Guide](../../01-Getting-Started/configuration.md#timeouts)
- [Performance Guide](../../05-Troubleshooting/performance.md)

---

Date: 2024-06-25
Authors: Development Team
