import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout } from '../layout/index.js'
import { container } from '../container.js'
import {
  listTrainsWithAccounts,
  listCredentialsSafe,
  listTrainApiKeys,
} from '@agent-prompttrain/shared/database/queries'
import { getErrorMessage } from '@agent-prompttrain/shared'

export const trainsUIRoutes = new Hono()

/**
 * Trains management UI page
 */
trainsUIRoutes.get('/', async c => {
  const pool = container.getPool()

  if (!pool) {
    return c.html(
      layout(
        'Trains',
        html`
          <div class="error-banner">
            <strong>Error:</strong> Database not configured. Please set DATABASE_URL environment
            variable.
          </div>
        `,
        '',
        c
      )
    )
  }

  try {
    const [trains, credentials] = await Promise.all([
      listTrainsWithAccounts(pool),
      listCredentialsSafe(pool),
    ])

    const content = html`
      <div style="margin-bottom: 2rem;">
        <h2 style="font-size: 1.5rem; font-weight: bold; margin-bottom: 1rem;">Train Management</h2>

        <div
          style="background-color: #eff6ff; border: 1px solid #3b82f6; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1.5rem;"
        >
          <p style="margin: 0; color: #1e40af;">
            <strong>ℹ️ Trains</strong> represent isolated Claude API access configurations. Each
            train can link multiple credentials and generate unique API keys for client access.
          </p>
        </div>

        ${
          trains.length === 0
            ? html`
                <div
                  style="background-color: #fef3c7; border: 1px solid #f59e0b; padding: 1rem; border-radius: 0.25rem;"
                >
                  <p style="margin: 0; color: #92400e;">
                    <strong>⚠️ No trains found.</strong> Create a train using the API or dashboard.
                  </p>
                </div>
              `
            : html`
                ${trains.map(
                  train => html`
                    <div
                      style="background: white; border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 1.5rem; margin-bottom: 1.5rem;"
                    >
                      <div
                        style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 1rem;"
                      >
                        <div>
                          <h3 style="font-size: 1.25rem; font-weight: bold; margin-bottom: 0.5rem;">
                            ${train.train_id}
                            <span
                              style="background: #10b981; color: white; padding: 0.125rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; margin-left: 0.5rem;"
                              >ACTIVE</span
                            >
                          </h3>
                          ${
                            train.description
                              ? html`<p style="color: #6b7280; margin: 0;">${train.description}</p>`
                              : ''
                          }
                        </div>
                      </div>

                      <!-- Linked Credentials Section -->
                      <div style="margin-bottom: 1.5rem;">
                        <h4
                          style="font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem; color: #374151;"
                        >
                          Linked Credentials (${train.accounts?.length || 0})
                        </h4>
                        ${
                          !train.accounts || train.accounts.length === 0
                            ? html`
                                <div
                                  style="background-color: #fef3c7; border: 1px solid #f59e0b; padding: 0.75rem; border-radius: 0.25rem;"
                                >
                                  <p style="margin: 0; color: #92400e; font-size: 0.875rem;">
                                    ⚠️ No credentials linked. Link a credential to enable API
                                    access.
                                  </p>
                                </div>
                              `
                            : html`
                                <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                                  ${train.accounts.map(
                                    (cred: any) => html`
                                      <div
                                        style="background: #f9fafb; border: 1px solid #e5e7eb; padding: 0.75rem; border-radius: 0.25rem; display: flex; justify-content: space-between; align-items: center;"
                                      >
                                        <div>
                                          <div style="font-weight: 600; font-size: 0.875rem;">
                                            ${cred.account_name}
                                          </div>
                                          <div style="font-size: 0.75rem; color: #6b7280;">
                                            <code
                                              style="background: white; padding: 0.125rem 0.25rem; border-radius: 0.125rem;"
                                              >${cred.account_id}</code
                                            >
                                            • Expires:
                                            ${new Date(cred.oauth_expires_at).toLocaleDateString()}
                                            ${
                                              new Date(cred.oauth_expires_at) < new Date()
                                                ? html`<span style="color: #dc2626; font-weight: 600;"
                                                    >⚠️ EXPIRED</span
                                                  >`
                                                : ''
                                            }
                                          </div>
                                        </div>
                                      </div>
                                    `
                                  )}
                                </div>
                              `
                        }
                      </div>

                      <!-- API Keys Section -->
                      <div>
                        <h4
                          style="font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem; color: #374151;"
                        >
                          API Keys
                        </h4>
                        <div
                          id="api-keys-${train.id}"
                          hx-get="/dashboard/trains/${train.id}/api-keys-list"
                          hx-trigger="load"
                          hx-swap="innerHTML"
                        >
                          <div
                            style="background: #f9fafb; padding: 1rem; border-radius: 0.25rem; text-align: center; color: #6b7280;"
                          >
                            Loading API keys...
                          </div>
                        </div>
                      </div>

                      <!-- Slack Webhook -->
                      ${
                        train.slack_webhook_url
                          ? html`
                              <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #e5e7eb;">
                                <div style="font-size: 0.875rem; color: #6b7280;">
                                  <strong>Slack Webhook:</strong> Configured ✅
                                </div>
                              </div>
                            `
                          : ''
                      }
                    </div>
                  `
                )}
              `
        }
      </div>

      <!-- Instructions -->
      <div style="margin-top: 2rem; padding-top: 2rem; border-top: 1px solid #e5e7eb;">
        <h3 style="font-size: 1.125rem; font-weight: bold; margin-bottom: 1rem;">
          Managing Trains via API
        </h3>

        <div style="margin-bottom: 1.5rem;">
          <h4 style="font-size: 1rem; font-weight: 600; margin-bottom: 0.5rem;">
            Create a New Train
          </h4>
          <pre
            style="background: #1f2937; color: #f3f4f6; padding: 1rem; border-radius: 0.25rem; overflow-x: auto; font-size: 0.875rem;"
          ><code>curl -X POST http://localhost:3001/api/trains \\
  -H "Content-Type: application/json" \\
  -H "X-Dashboard-Key: your-dashboard-key" \\
  -d '{
    "train_id": "my-train",
    "description": "My production train",
    "is_active": true
  }'</code></pre>
        </div>

        <div style="margin-bottom: 1.5rem;">
          <h4 style="font-size: 1rem; font-weight: 600; margin-bottom: 0.5rem;">
            Link Credential to Train
          </h4>
          <pre
            style="background: #1f2937; color: #f3f4f6; padding: 1rem; border-radius: 0.25rem; overflow-x: auto; font-size: 0.875rem;"
          ><code>curl -X POST http://localhost:3001/api/trains/my-train/accounts \\
  -H "Content-Type: application/json" \\
  -H "X-Dashboard-Key: your-dashboard-key" \\
  -d '{"credential_id": "credential-uuid-here"}'</code></pre>
        </div>

        <div>
          <h4 style="font-size: 1rem; font-weight: 600; margin-bottom: 0.5rem;">
            Generate API Key
          </h4>
          <pre
            style="background: #1f2937; color: #f3f4f6; padding: 1rem; border-radius: 0.25rem; overflow-x: auto; font-size: 0.875rem;"
          ><code>curl -X POST http://localhost:3001/api/trains/my-train/api-keys \\
  -H "Content-Type: application/json" \\
  -H "X-Dashboard-Key: your-dashboard-key" \\
  -d '{"description": "Production key"}'</code></pre>
        </div>
      </div>
    `

    return c.html(
      layout(
        'Trains',
        content,
        // Add HTMX script for dynamic API key loading
        `<script>
          // Handle HTMX errors
          document.body.addEventListener('htmx:responseError', function(evt) {
            evt.target.innerHTML = '<div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">Failed to load API keys</div>';
          });
        </script>`,
        c
      )
    )
  } catch (error) {
    return c.html(
      layout(
        'Trains - Error',
        html`
          <div class="error-banner">
            <strong>Error:</strong> Failed to load trains: ${getErrorMessage(error)}
          </div>
        `,
        '',
        c
      )
    )
  }
})

/**
 * HTMX endpoint to load API keys for a specific train
 */
trainsUIRoutes.get('/:trainId/api-keys-list', async c => {
  const trainId = c.req.param('trainId')
  const pool = container.getPool()

  if (!pool) {
    return c.html(html`
      <div
        style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;"
      >
        Database not configured
      </div>
    `)
  }

  try {
    const apiKeys = await listTrainApiKeys(pool, trainId)

    if (apiKeys.length === 0) {
      return c.html(html`
        <div
          style="background: #f9fafb; border: 1px solid #e5e7eb; padding: 0.75rem; border-radius: 0.25rem; color: #6b7280; text-align: center;"
        >
          No API keys generated yet
        </div>
      `)
    }

    return c.html(html`
      <div style="display: flex; flex-direction: column; gap: 0.5rem;">
        ${apiKeys.map(
          key => html`
            <div
              style="background: #f9fafb; border: 1px solid #e5e7eb; padding: 0.75rem; border-radius: 0.25rem;"
            >
              <div
                style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 0.25rem;"
              >
                <div>
                  <div style="font-weight: 600; font-size: 0.875rem;">
                    ${key.name || 'Unnamed API Key'}
                  </div>
                  <div style="font-size: 0.75rem; color: #6b7280;">
                    <code
                      style="background: white; padding: 0.125rem 0.25rem; border-radius: 0.125rem;"
                      >${key.key_preview}...</code
                    >
                  </div>
                </div>
                ${
                  key.revoked_at
                    ? html`<span
                        style="background: #ef4444; color: white; padding: 0.125rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem;"
                        >REVOKED</span
                      >`
                    : html`<span
                        style="background: #10b981; color: white; padding: 0.125rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem;"
                        >ACTIVE</span
                      >`
                }
              </div>
              <div style="font-size: 0.75rem; color: #6b7280;">
                Created: ${new Date(key.created_at).toLocaleString()}
                ${
                  key.last_used_at
                    ? html`• Last used: ${new Date(key.last_used_at).toLocaleString()}`
                    : html`• Never used`
                }
              </div>
            </div>
          `
        )}
      </div>
    `)
  } catch (error) {
    return c.html(html`
      <div
        style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;"
      >
        Error: ${getErrorMessage(error)}
      </div>
    `)
  }
})
