# Features

Agent Prompt Train is a high-performance proxy for the Claude API with comprehensive monitoring and management capabilities.

## Core Features

### 🧠 AI-Powered Conversation Analysis

- **Smart Prompt Engineering**: Automated analysis of conversations using Gemini AI
- **Intelligent Truncation**: Tail-first priority preserving most recent context
- **Structured Insights**: JSON-formatted analysis with sentiment, outcomes, and quality metrics
- **Token Management**: Safe truncation with 855k token limit and safety margins
- **Versioned Prompts**: Support for evolving analysis templates

### 🚀 API Proxying

- **Direct API forwarding** to Claude with minimal latency
- **Streaming support** for real-time responses
- **Request/response transformation** capabilities
- **Configurable timeouts** (default 10 minutes for long-running requests)

### 🔐 Authentication & Security

- **Multi-auth support**:
  - API key authentication
  - OAuth 2.0 with automatic token refresh
  - Client API key authentication for proxy access
- **Domain-based credential management**
- **Timing-safe credential verification**
- **Secure credential storage** with separate files per domain

### 📊 Token Tracking & Usage

- **Comprehensive token usage tracking**:
  - Per-account tracking
  - Per-domain tracking
  - 5-hour rolling window monitoring
  - Historical daily usage data
- **Request type classification**:
  - Query evaluation
  - Inference requests
  - Quota checks
- **Tool call counting** and analysis

### 💾 Storage & Persistence

- **PostgreSQL-based storage** for all requests and responses
- **Streaming chunk storage** for complete conversation history
- **Batch processing** for efficient database writes
- **Partitioned tables** for scalable data management

### 🔄 Conversation Management

- **Automatic conversation tracking** using message hashing
- **Branch detection** and visualization
- **Parent-child message linking**
- **System reminder filtering** for consistent tracking
- **Sub-task detection** and visualization

### 📈 Monitoring Dashboard

- **Real-time usage monitoring**
- **Interactive charts** for token usage analysis
- **Request history browser**
- **Conversation visualization** with branch support
- **SSE (Server-Sent Events)** for live updates
- **Account-based analytics**

### 🔔 Notifications & Alerts

- **Slack webhook integration** for notifications
- **Configurable alert thresholds**
- **Error notification** with detailed context

### 🛠️ Developer Experience

- **Test sample collection** for development
- **Debug logging** with sensitive data masking
- **TypeScript** with full type safety
- **Bun runtime** for optimal performance
- **Monorepo structure** with shared packages

### 🔄 Error Handling & Resilience

- **Retry logic with exponential backoff** for transient failures
- **Jitter implementation** to prevent thundering herd
- **Configurable retry policies** for different error types
- **Retry-After header support** for rate limiting
- **Smart error classification** (retryable vs non-retryable)
- **Detailed error logging** with full context

### 🐳 Deployment Options

- **Docker support** with optimized images
- **Docker Compose** for full stack deployment
- **Separate images** for proxy and dashboard
- **Environment-based configuration**
- **Health check endpoints**

### 🔧 Operational Features

- **Graceful shutdown** handling
- **Comprehensive request retry logic**
- **Error recovery mechanisms**
- **Slow query logging** and monitoring
- **Database migration** support

## Advanced Features

### Message Normalization

- Consistent hashing regardless of content format
- Support for both string and array message content
- Automatic content type detection

### Request Metadata

- Detailed request/response logging
- Performance metrics tracking
- Error categorization and analysis

### API Compatibility

- Full Claude API compatibility
- Model-agnostic design
- Support for all Claude endpoints

## Planned Features

- Kubernetes deployment manifests
- Advanced rate limiting controls
- Custom middleware support
- GraphQL API endpoint
- Advanced analytics and reporting
- Multi-region deployment support

## Feature Comparison

| Feature               | Agent Prompt Train    | Direct Claude API |
| --------------------- | --------------------- | ----------------- |
| Token Tracking        | ✅ Comprehensive      | ❌ Limited        |
| Usage Analytics       | ✅ Built-in Dashboard | ❌ Manual         |
| Conversation Tracking | ✅ Automatic          | ❌ Manual         |
| Multi-Domain Support  | ✅ Native             | ❌ Manual         |
| Request Storage       | ✅ Automatic          | ❌ None           |
| Cost Analysis         | ✅ Per-account/domain | ❌ Account-only   |
| Debug Capabilities    | ✅ Enhanced           | ❌ Basic          |
| Deployment Options    | ✅ Multiple           | ❌ N/A            |
