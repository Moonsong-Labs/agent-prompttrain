/**
 * MCP Prompt detail page
 */

import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout } from '../layout/index.js'
import { ProxyApiClient } from '../services/api-client.js'

const promptDetailRoute = new Hono<{
  Variables: {
    apiClient?: ProxyApiClient
    trainId?: string
  }
}>()

promptDetailRoute.get('/:id', async c => {
  const promptId = c.req.param('id')
  const apiClient = c.get('apiClient')

  if (!apiClient) {
    return c.html(
      layout(
        'Error',
        html`
          <div class="error-banner">
            <strong>Error:</strong> API client not configured. Please check your configuration.
          </div>
        `
      )
    )
  }

  try {
    // Fetch prompt details
    const { prompt } = await apiClient.get<{ prompt: any }>(`/api/mcp/prompts/${promptId}`)

    const content = html`
      <div>
        <div class="header-section">
          <a href="/dashboard/prompts" class="back-link">← Back to Prompts</a>
          <h2>${prompt.name}</h2>
          ${prompt.description ? html`<p class="subtitle">${prompt.description}</p>` : ''}
        </div>

        <!-- Prompt Info -->
        <div class="info-grid">
          <div class="info-card">
            <h3>Prompt ID</h3>
            <p class="mono">${prompt.promptId}</p>
          </div>
          <div class="info-card">
            <h3>Name</h3>
            <p>${prompt.name}</p>
          </div>
        </div>

        <!-- Content -->
        <div class="section">
          <h3>Prompt Template</h3>
          <div class="content-container">
            <pre><code>${prompt.template}</code></pre>
          </div>
        </div>

        <!-- Template Help -->
        <div class="section">
          <h3>How to Use</h3>
          <p>
            This prompt uses Handlebars templating. Variables are referenced using
            <code>{{variableName}}</code> syntax.
          </p>
          <p>
            Example: If the template contains <code>{{name}}</code>, you would pass
            <code>{ "arguments": { "name": "John" } }</code> when calling the MCP endpoint.
          </p>
        </div>
      </div>

      <style>
        .header-section {
          margin-bottom: 2rem;
        }

        .back-link {
          color: #3b82f6;
          text-decoration: none;
          margin-bottom: 1rem;
          display: inline-block;
        }

        .back-link:hover {
          text-decoration: underline;
        }

        .subtitle {
          color: #6b7280;
          margin-top: 0.5rem;
        }

        .info-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 1rem;
          margin-bottom: 2rem;
        }

        .info-card {
          background-color: #f9fafb;
          padding: 1rem;
          border-radius: 0.5rem;
          border: 1px solid #e5e7eb;
        }

        .info-card h3 {
          font-size: 0.875rem;
          font-weight: 600;
          color: #6b7280;
          margin: 0 0 0.5rem 0;
        }

        .info-card p {
          margin: 0;
          color: #1f2937;
        }

        .mono {
          font-family: monospace;
          font-size: 0.875rem;
        }

        .section {
          background-color: white;
          border: 1px solid #e5e7eb;
          border-radius: 0.5rem;
          padding: 1.5rem;
          margin-bottom: 1.5rem;
        }

        .section h3 {
          margin: 0 0 1rem 0;
          color: #1f2937;
        }

        .arguments-list {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .argument-card {
          background-color: #f9fafb;
          padding: 1rem;
          border-radius: 0.375rem;
          border: 1px solid #e5e7eb;
        }

        .arg-header {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin-bottom: 0.5rem;
        }

        .arg-name {
          font-weight: 600;
          color: #1f2937;
        }

        .arg-required {
          background-color: #fee2e2;
          color: #dc2626;
          padding: 0.125rem 0.5rem;
          border-radius: 0.25rem;
          font-size: 0.75rem;
        }

        .arg-type {
          background-color: #dbeafe;
          color: #1e40af;
          padding: 0.125rem 0.5rem;
          border-radius: 0.25rem;
          font-size: 0.75rem;
        }

        .arg-description {
          color: #6b7280;
          margin: 0.5rem 0 0 0;
          font-size: 0.875rem;
        }

        .arg-default {
          color: #6b7280;
          margin: 0.5rem 0 0 0;
          font-size: 0.875rem;
        }

        .content-container,
        .metadata-container {
          background-color: #f9fafb;
          border-radius: 0.375rem;
          padding: 1rem;
          overflow-x: auto;
        }

        .content-container pre,
        .metadata-container pre {
          margin: 0;
        }

        .content-container code,
        .metadata-container code {
          font-size: 0.875rem;
          line-height: 1.5;
        }

        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 1rem;
          margin-bottom: 2rem;
        }

        .stat-card {
          background-color: #f9fafb;
          padding: 1.5rem;
          border-radius: 0.5rem;
          text-align: center;
        }

        .stat-value {
          font-size: 2rem;
          font-weight: 700;
          color: #1f2937;
        }

        .stat-label {
          font-size: 0.875rem;
          color: #6b7280;
          margin-top: 0.25rem;
        }

        .usage-chart h4 {
          font-size: 1rem;
          margin: 0 0 1rem 0;
          color: #1f2937;
        }

        .chart-container {
          display: flex;
          align-items: flex-end;
          height: 150px;
          gap: 2px;
          padding: 1rem 0;
          border-bottom: 1px solid #e5e7eb;
        }

        .chart-bar {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: flex-end;
          position: relative;
        }

        .bar {
          width: 100%;
          background-color: #3b82f6;
          border-radius: 2px 2px 0 0;
          transition: background-color 0.2s;
        }

        .chart-bar:hover .bar {
          background-color: #2563eb;
        }

        .bar-label {
          font-size: 0.75rem;
          color: #6b7280;
          margin-top: 0.25rem;
          position: absolute;
          bottom: -20px;
        }
      </style>
    `

    return c.html(layout(`${prompt.name} - MCP Prompt`, content))
  } catch (error) {
    console.error('Error loading prompt detail:', error)
    return c.html(
      layout(
        'Prompt Not Found',
        html`
          <div class="error-container">
            <h2>Error Loading Prompt</h2>
            <p>${error instanceof Error ? error.message : 'Unknown error'}</p>
            <a href="/dashboard/prompts" class="btn btn-primary">Back to Prompts</a>
          </div>
        `
      )
    )
  }
})

export { promptDetailRoute }
