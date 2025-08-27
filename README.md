# <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle; margin-right: 8px;"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="4" r="2"/><circle cx="20" cy="12" r="2"/><circle cx="12" cy="20" r="2"/><circle cx="4" cy="12" r="2"/><path d="M12 9 L12 7"/><path d="M15 12 L18 12"/><path d="M12 15 L12 18"/><path d="M9 12 L6 12"/></svg>Claude Nexus

Claude Nexus is a Claude Code management server for teams that includes comprehensive monitoring, conversation tracking, and dashboard visualizations.  Claude Nexus allows you to understand, manage, and improve your team's Claude Code usage.
(_Supports Claude Max plan_)

### 📖 Quick Navigation

- [**Getting Started**](#quick-start) - Set up Claude Nexus in seconds
- [**Features**](#-features) - Explore capabilities and functionality
- [**Development**](#development-setup) - Build and contribute
- [**Documentation**](#documentation) - Complete guides and references
- [**Deployment**](#production-deployment) - Production setup guides

## 🎯 Objectives

Claude Nexus empowers development teams to maximize their Claude AI usage through:

- 🔍 **Complete Visibility**: Real-time access to conversations, tool invocations, and prompts for effective troubleshooting and debugging
- 📈 **Historical Analytics**: Comprehensive activity history enabling usage monitoring, pattern identification, and continuous improvement
- 🤖 **Intelligent Insights**: AI-powered conversation analysis providing actionable prompt optimization suggestions and best practice recommendations

## 🚀 Demo

![Image](https://github.com/user-attachments/assets/91652db7-ebac-4386-994d-5775f455622f)

Experience Claude Nexus in action with our live demo:

👉 **[https://nexus-demo.moonsonglabs.dev](https://nexus-demo.moonsonglabs.dev)**

_Note: This is a read-only demo showcasing real usage data from our development team._

<img src="https://github.com/user-attachments/assets/aebffb8c-9535-4073-aa76-be31ee05a402" alt="Claude Nexus Dashboard" width="800">

## ✨ Features

- 🚀 **High-Performance Proxy** - Built with Bun and Hono for minimal latency
- 🔀 **Conversation Tracking** - Automatic message threading with branch, sub-agent & compact support
- 📊 **Real-time Dashboard** - Monitor usage, view conversations, and analyze patterns
- 🔐 **Multi-Auth Support** - API keys and OAuth with auto-refresh
- 📈 **Token Tracking** - Detailed usage statistics per domain and account
- 🔄 **Streaming Support** - Full SSE streaming with chunk storage
- 🐳 **Docker Ready** - Separate optimized images for each service
- 🤖 **Claude CLI Integration** - Run Claude CLI connected to the proxy
- 🧠 **AI-Powered Analysis** - Automated conversation insights using Gemini Pro

## 📚 Key Concepts

Understanding these terms will help you navigate Claude Nexus effectively:

### Core Concepts

- **🗣️ Conversation**: A complete interaction session between a user and Claude, consisting of multiple message exchanges. Each conversation has a unique ID and can span multiple requests.
- **🌳 Branch**: When you edit an earlier message in a conversation and continue from there, it creates a new branch - similar to Git branches. This allows exploring alternative conversation paths without losing the original.
- **📦 Compact**: When a conversation exceeds Claude's context window, it's automatically summarized and continued as a "compact" conversation, preserving the essential context while staying within token limits.
- **🤖 Sub-task**: When Claude spawns another AI agent using the Task tool, it creates a sub-task. These are tracked separately but linked to their parent conversation for complete visibility.

### Technical Terms

- **🔤 Token**: The basic unit of text that Claude processes. Monitoring token usage helps track costs and stay within API limits.
- **📊 Request**: A single API call to Claude, which may contain multiple messages. Conversations are built from multiple requests.
- **🔧 Tool Use**: Claude's ability to use external tools (like file reading, web search, or spawning sub-tasks). Each tool invocation is tracked and displayed.
- **📝 MCP (Model Context Protocol)**: A protocol for managing and sharing prompt templates across teams, with GitHub integration for version control.

### Dashboard Elements

- **Timeline View**: Shows the chronological flow of messages within a conversation
- **Tree View**: Visualizes conversation branches and sub-tasks as an interactive tree
- **Message Hash**: Unique identifier for each message, used to track conversation flow and detect branches

## 📸 Screenshots

### Conversation Tracking & Visualization

Visualize entire conversation flows as interactive trees, making it easy to understand complex interactions, debug issues, and track conversation branches.

<kbd><img src="https://github.com/user-attachments/assets/655f2c5c-91c0-41f6-9d82-19f44dd3ef6d" alt="Conversation tree visualization showing branching and message flow" width="400"></kbd> <kbd><img src="https://github.com/user-attachments/assets/e3e8df59-a4a8-47a8-9033-4a0624bf03cf" alt="Conversation timeline with branch filters and detailed metrics" width="400"> </kbd>

### Request Details & Tool Results

Examine individual API requests and responses with syntax highlighting, tool result visualization, and comprehensive metadata including token counts and timing information.

</kbd><img src="https://github.com/user-attachments/assets/aeda8a80-5a9a-407c-b14d-e6a8af6883de" alt="Request details showing tool results and conversation messages" width="400"></kbd>

### AI-Powered Conversation Analysis

Leverage Gemini Pro to automatically analyze conversations for sentiment, quality, outcomes, and actionable insights. Get intelligent recommendations for improving your AI interactions.

</kbd><img src="https://github.com/user-attachments/assets/63ed0346-ee2e-49b4-86df-49937516786f" alt="AI analysis panel showing comprehensive conversation insights" width="400"></kbd>

### MCP Prompt Management

Manage and sync Model Context Protocol prompts from GitHub repositories. Create reusable prompt templates that can be shared across your team and integrated with Claude Desktop.

</kbd><img src="https://github.com/user-attachments/assets/6cb406d7-cb2a-4698-b03d-0b67b7b44702" alt="MCP prompts interface showing GitHub-synced prompt library" width="400"></kbd>

### Raw JSON Debugging

For developers who need complete visibility, access the raw JSON view of any request or response with syntax highlighting and expandable tree structure.

</kbd><img src="https://github.com/user-attachments/assets/b3c247ca-e66b-4e6c-8b89-0f1a881b7198" alt="Raw JSON view for detailed debugging" width="400"></kbd>

### Token rate limit and Management

For administrators or heavy users, you can follow the token usage and see when approaching the rate limits.

</kbd><img width="400" alt="Token usage graph line per domain" src="https://github.com/user-attachments/assets/e16fedc5-c90a-45fb-bfa8-4c37a525edee" /></kbd>

## Quick Start

Get Claude Nexus running locally in seconds.

### 🔥 Super Quick Start (All-in-One Docker + Claude CLI)

**Prerequisites:**

- [Docker](https://docker.com)
- Claude Code (_already installed and setup_)

Start the Claude Nexus (_docker image with: Postgres + Proxy + Dashboard_):

```bash
docker run -d -p 3000:3000 -p 3001:3001 --name claude-nexus moonsonglabs/claude-nexus-all-in:latest
```

Start using it from any project, you can use multiple claude at the same time:

```bash
ANTHROPIC_BASE_URL=http://localhost:3000 claude
```

You're all set!

Access the **dashboard** at http://localhost:3001 to watch conversations as you use Claude Code.

---

Looking to develop or contribute? Jump to [Development Setup](#development-setup).

---

## Development Setup

For developers who want to modify the proxy or dashboard code with **hot reload** capabilities.

### Prerequisites

- [Bun](https://bun.sh) runtime (v1.0+)
- [Docker](https://docker.com) and Docker Compose
- Claude API Key

### 🛠️ Development Workflow

**1. Initial Setup**

```bash
# Clone and install dependencies
git clone https://github.com/Moonsong-Labs/claude-nexus.git
cd claude-nexus
bun run setup

# Configure environment
cp .env.example .env
# Edit .env with your settings
```

**2. Start Infrastructure Services**

```bash
# Start ONLY PostgreSQL, and Claude CLI (optimized for development)
bun run docker:dev:up
```

**3. Start Application Services Locally**

```bash
# Start proxy and dashboard with hot reload
bun run dev
```

### 🔧 Development Commands

```bash
# Infrastructure management
bun run docker:dev:up      # Start development infrastructure (postgres, claude-cli)
bun run docker:dev:down    # Stop development infrastructure
bun run docker:dev:logs    # View infrastructure logs

# Development workflow
bun run dev                # Start local services with hot reload
bun run typecheck          # Type checking
bun run test               # Run tests
bun run format             # Format code

# Database operations
bun run db:backup
bun run db:analyze-conversations
```

### 🎯 What This Gives You

- ✅ **Hot reload** for code changes (proxy & dashboard run locally)
- ✅ **Direct debugging** access with breakpoints
- ✅ **Fast iteration** cycle (no container rebuilds)
- ✅ **Production-like** database environment (PostgreSQL in Docker)
- ✅ **Separate concerns** (infrastructure vs application services)

### 🏗️ Architecture Comparison

**Development Mode:**

```
Local Machine:           Docker Containers:
├── Proxy (port 3000)    ├── PostgreSQL (port 5432)
├── Dashboard (port 3001) └── Claude CLI
└── Hot Reload ⚡
```

**vs. Full Docker Mode:**

```
Docker Containers:
├── PostgreSQL (port 5432)
├── Proxy (port 3000)
├── Dashboard (port 3001)
└── Claude CLI
```

---

## Production Deployment

For deploying Claude Nexus in production environments.

### 📖 Deployment Guides

Choose your deployment method:

- **[AWS Infrastructure](docs/03-Operations/deployment/aws-infrastructure.md)** - Complete AWS deployment with RDS, ECS, and load balancing
- **[Docker Compose Production](docs/03-Operations/deployment/docker-compose.md)** - Production Docker Compose setup
- **[Docker Deployment](docs/03-Operations/deployment/docker.md)** - Container-based deployment options

### 🔧 Operations Documentation

- **[Security Guide](docs/03-Operations/security.md)** - Authentication, authorization, and security best practices
- **[Monitoring](docs/03-Operations/monitoring.md)** - Observability and alerting setup
- **[Database Management](docs/03-Operations/database.md)** - Database administration and maintenance
- **[Backup & Recovery](docs/03-Operations/backup-recovery.md)** - Data protection strategies

### ⚠️ Important Considerations

- Always set `DASHBOARD_API_KEY` in production
- Configure proper SSL/TLS certificates
- Set up monitoring and alerting
- Implement proper backup strategies
- Review security documentation thoroughly

## Configuration

### Environment Variables

Essential configuration:

```bash
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/claude_nexus

# Dashboard Authentication
# ⚠️ CRITICAL SECURITY WARNING: Without this key, the dashboard runs in read-only mode
# with NO authentication, exposing ALL conversation data to anyone with network access!
# NEVER deploy to production without setting this!
DASHBOARD_API_KEY=your-secure-key

# Optional Features
STORAGE_ENABLED=true
DEBUG=false
```

See the [Documentation](docs/README.md) for complete configuration options.

### Domain Credentials

Create domain-specific credentials:

```bash
# Generate secure API key
bun run auth:generate-key

# Create credential file
cat > credentials/example.com.credentials.json << EOF
{
  "type": "api_key",
  "accountId": "acc_name_to_display",
  "api_key": "sk-ant-...",
  "client_api_key": "cnp_live_..."
}
EOF
```

(_Use `credentials/localhost\:3000.credentials.json` for using it locally_)

Authenticate your credential with Claude MAX Plan:

```bash
./scripts/auth/oauth-login.ts credentials/example.com.credentials.json
```

## Usage

### API Proxy

Use the proxy exactly like Claude's API:

```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Authorization: Bearer YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-opus-20240229",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Dashboard

Access the dashboard at `http://localhost:3001` with your `DASHBOARD_API_KEY`.

**⚠️ Security Warning**: If `DASHBOARD_API_KEY` is not set, the dashboard runs in read-only mode without any authentication, exposing all conversation data. This should NEVER be used in production. See the [Security Guide](docs/03-Operations/security.md) for details.

Features:

- Real-time request monitoring
- Conversation visualization with branching
- Token usage analytics
- Request history browsing

## Architecture

```
claude-nexus/
├── packages/shared/      # Shared types and utilities
├── services/
│   ├── proxy/           # Proxy API service
│   └── dashboard/       # Dashboard web service
└── scripts/             # Management utilities
```

See [Architecture Overview](docs/00-Overview/architecture.md) for detailed architecture documentation.

## Development

```bash
# Run type checking
bun run typecheck

# Run tests
bun test

# Format code
bun run format

# Database operations
bun run db:backup              # Backup database
bun run db:analyze-conversations # Analyze conversation structure
bun run db:rebuild-conversations # Rebuild conversation data

# AI Analysis management
bun run ai:check-jobs          # Check analysis job statuses
bun run ai:check-content       # Inspect analysis content
bun run ai:reset-stuck         # Reset jobs with high retry counts
```

See [Development Guide](docs/01-Getting-Started/development.md) for development guidelines.

## Deployment

### Environments (MoonsongLabs Internal)

Claude Nexus supports deployment to multiple environments:

- **Production (`prod`)** - Live production services
- **Staging (`staging`)** - Pre-production testing environment

For AWS EC2 deployments, use the `manage-nexus-proxies.sh` script with environment filtering:

```bash
# Deploy to production servers only
./scripts/ops/manage-nexus-proxies.sh --env prod up

# Check staging server status
./scripts/ops/manage-nexus-proxies.sh --env staging status
```

See [AWS Infrastructure Guide](docs/03-Operations/deployment/aws-infrastructure.md) for detailed multi-environment setup.

### Docker

#### Using Pre-built Images (Default)

```bash
# Run with docker-compose using images from registry
./docker-up.sh up -d
```

#### Using Locally Built Images

```bash
# Build and run with locally built images
docker compose -f docker/docker-compose.yml up -d --build
```

(_dashboard key: `key` - demo only, set DASHBOARD_API_KEY in production_)

#### Building Images Separately

```bash
# Build images individually
docker build -f docker/proxy/Dockerfile -t moonsonglabs/claude-nexus-proxy:local .
docker build -f docker/dashboard/Dockerfile -t claude-nexus-dashboard:local .
```

### Production

See the [Deployment Guide](docs/03-Operations/deployment/) for production deployment options.

## Documentation

Comprehensive documentation is available in the [docs](docs/) directory:

### 📚 Getting Started

- [Quick Start Guide](docs/00-Overview/quickstart.md) - Get up and running in 5 minutes
- [Installation](docs/01-Getting-Started/installation.md) - Detailed installation instructions
- [Configuration](docs/01-Getting-Started/configuration.md) - All configuration options

### 🔧 User Guides

- [API Reference](docs/02-User-Guide/api-reference.md) - Complete API documentation
- [Authentication](docs/02-User-Guide/authentication.md) - Auth setup and troubleshooting
- [Dashboard Guide](docs/02-User-Guide/dashboard-guide.md) - Using the monitoring dashboard
- [Claude CLI](docs/02-User-Guide/claude-cli.md) - CLI integration guide

### 🚀 Operations

- [Deployment](docs/03-Operations/deployment/) - Docker and production deployment
- [Security](docs/03-Operations/security.md) - Security best practices
- [Monitoring](docs/03-Operations/monitoring.md) - Metrics and observability
- [Backup & Recovery](docs/03-Operations/backup-recovery.md) - Data protection

### 🏗️ Architecture

- [System Architecture](docs/00-Overview/architecture.md) - High-level design
- [Internals](docs/04-Architecture/internals.md) - Deep implementation details
- [ADRs](docs/04-Architecture/ADRs/) - Architecture decision records

### 🔍 Troubleshooting

- [Common Issues](docs/05-Troubleshooting/common-issues.md) - FAQ and solutions
- [Performance](docs/05-Troubleshooting/performance.md) - Performance optimization
- [Debugging](docs/05-Troubleshooting/debugging.md) - Debug techniques

## Contributing

⚠️ Disclaimer: This project has been entirely vibe Coded (using Claude Nexus) with the goal to not manually touch a single file.

Contributions are welcome! Please read our [Contributing Guidelines](CONTRIBUTING.md) first.

## Support

- 📖 [Full Documentation](docs/README.md)
- 🐛 [Issue Tracker](https://github.com/Moonsong-Labs/claude-nexus/issues)
- 💬 [Discussions](https://github.com/Moonsong-Labs/claude-nexus/discussions)
- 📊 [Changelog](docs/06-Reference/changelog.md)
