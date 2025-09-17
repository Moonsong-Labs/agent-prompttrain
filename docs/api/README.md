# API Documentation

This directory contains API documentation for Agent Prompt Train services.

## AI Analysis API

The AI Analysis API provides endpoints for managing AI-powered conversation analysis.

### OpenAPI Specification

- **File**: [`openapi-analysis.yaml`](./openapi-analysis.yaml)
- **Version**: 1.0.0
- **Format**: OpenAPI 3.0.3

### Key Features

- **Asynchronous Processing**: Analysis requests are processed in the background
- **Rate Limiting**: 15 creation requests/minute, 100 retrieval requests/minute per train ID
- **Authentication**: Requires `X-Dashboard-Key` header
- **Structured Analysis**: Returns both markdown content and structured JSON data

### Endpoints

1. **POST /api/analyses** - Create a new analysis request
2. **GET /api/analyses/{conversationId}/{branchId}** - Get analysis status/result
3. **POST /api/analyses/{conversationId}/{branchId}/regenerate** - Force regeneration

### Using the API

#### Authentication

Include the dashboard API key in the request header:

```bash
X-Dashboard-Key: your-api-key
```

#### Example: Create Analysis

```bash
curl -X POST http://localhost:3000/api/analyses \
  -H "Content-Type: application/json" \
  -H "X-Dashboard-Key: $DASHBOARD_API_KEY" \
  -d '{
    "conversationId": "123e4567-e89b-12d3-a456-426614174000",
    "branchId": "main"
  }'
```

#### Example: Check Status

```bash
curl http://localhost:3000/api/analyses/123e4567-e89b-12d3-a456-426614174000/main \
  -H "X-Dashboard-Key: $DASHBOARD_API_KEY"
```

### Generate TypeScript Client

Generate a TypeScript client from the OpenAPI spec:

```bash
bun run scripts/generate-api-client.ts
```

This creates a client in `packages/shared/src/generated/api-client/`.

### Review OpenAPI Spec

Review the specification using Gemini:

```bash
GEMINI_API_KEY=your-key bun run scripts/review-openapi-spec.ts
```

### View Interactive Documentation

You can use tools like [Swagger UI](https://swagger.io/tools/swagger-ui/) or [Redoc](https://github.com/Redocly/redoc) to view the OpenAPI spec interactively:

```bash
# Using Redoc
bunx @redocly/cli preview-docs docs/api/openapi-analysis.yaml

# Using Swagger UI
docker run -p 8080:8080 -e SWAGGER_JSON=/api/openapi-analysis.yaml -v ${PWD}/docs/api:/api swaggerapi/swagger-ui
```

## Future APIs

Additional API specifications will be added here as new endpoints are developed.
