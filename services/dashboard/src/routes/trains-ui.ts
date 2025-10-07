import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { layout } from '../layout/index.js'
import { container } from '../container.js'
import {
  listTrainsWithAccounts,
  listTrainApiKeys,
  createTrain,
  createTrainApiKey,
  listCredentialsSafe,
  linkAccountToTrain,
  unlinkAccountFromTrain,
  getTrainMembers,
  addTrainMember,
} from '@agent-prompttrain/shared/database/queries'
import { getErrorMessage } from '@agent-prompttrain/shared'
import type { AnthropicCredentialSafe } from '@agent-prompttrain/shared/types'
import type { AuthContext } from '../middleware/auth.js'

export const trainsUIRoutes = new Hono<{ Variables: { auth: AuthContext } }>()

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
    const [trains, allCredentials] = await Promise.all([
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

        <!-- Create Train Form -->
        <div
          style="background: white; border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 1.5rem; margin-bottom: 1.5rem;"
        >
          <h3 style="font-size: 1.125rem; font-weight: bold; margin-bottom: 1rem;">
            Create New Train
          </h3>
          <form
            hx-post="/dashboard/trains/create"
            hx-swap="outerHTML"
            hx-target="#train-form-container"
            style="display: grid; gap: 1rem;"
            id="train-form-container"
          >
            <div>
              <label
                for="train_id"
                style="display: block; font-size: 0.875rem; font-weight: 600; margin-bottom: 0.25rem; color: #374151;"
              >
                Train ID<span style="color: #dc2626;">*</span>
              </label>
              <input
                type="text"
                id="train_id"
                name="train_id"
                required
                placeholder="e.g., marketing-prod"
                style="width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.25rem; font-size: 0.875rem;"
              />
              <p style="margin: 0.25rem 0 0 0; font-size: 0.75rem; color: #6b7280;">
                Unique identifier for this train (lowercase, alphanumeric, hyphens allowed)
              </p>
            </div>

            <div>
              <label
                for="name"
                style="display: block; font-size: 0.875rem; font-weight: 600; margin-bottom: 0.25rem; color: #374151;"
              >
                Display Name<span style="color: #dc2626;">*</span>
              </label>
              <input
                type="text"
                id="name"
                name="name"
                required
                placeholder="e.g., Marketing Team Production"
                style="width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.25rem; font-size: 0.875rem;"
              />
            </div>

            <div>
              <label
                for="description"
                style="display: block; font-size: 0.875rem; font-weight: 600; margin-bottom: 0.25rem; color: #374151;"
              >
                Description
              </label>
              <textarea
                id="description"
                name="description"
                rows="2"
                placeholder="Optional description of this train's purpose"
                style="width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.25rem; font-size: 0.875rem; resize: vertical;"
              ></textarea>
            </div>

            <div style="display: flex; gap: 1rem; align-items: center;">
              <button
                type="submit"
                style="background: #3b82f6; color: white; padding: 0.5rem 1.5rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer;"
              >
                Create Train
              </button>
              <div
                class="htmx-indicator"
                style="display: none; color: #6b7280; font-size: 0.875rem;"
              >
                Creating...
              </div>
            </div>
          </form>
        </div>

        ${trains.length === 0
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
                        ${train.description
                          ? html`<p style="color: #6b7280; margin: 0;">${train.description}</p>`
                          : ''}
                      </div>
                    </div>

                    <!-- Linked Credentials Section -->
                    <div style="margin-bottom: 1.5rem;">
                      <h4
                        style="font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem; color: #374151;"
                      >
                        Linked Credentials (${train.accounts?.length || 0})
                      </h4>

                      <!-- Link Credential Form -->
                      ${allCredentials.length > 0
                        ? html`
                            <form
                              hx-post="/dashboard/trains/${train.id}/link-credential"
                              hx-swap="beforebegin"
                              style="margin-bottom: 1rem; display: flex; gap: 0.5rem; align-items: end;"
                            >
                              <div style="flex: 1;">
                                <label
                                  for="credential-select-${train.id}"
                                  style="display: block; font-size: 0.75rem; font-weight: 600; margin-bottom: 0.25rem; color: #374151;"
                                >
                                  Select Credential to Link
                                </label>
                                <select
                                  id="credential-select-${train.id}"
                                  name="credential_id"
                                  required
                                  style="width: 100%; padding: 0.375rem; border: 1px solid #d1d5db; border-radius: 0.25rem; font-size: 0.875rem;"
                                >
                                  <option value="">-- Select a credential --</option>
                                  ${allCredentials
                                    .filter(
                                      cred =>
                                        !train.accounts?.some(
                                          (a: AnthropicCredentialSafe) => a.id === cred.id
                                        )
                                    )
                                    .map(
                                      cred => html`
                                        <option value="${cred.id}">
                                          ${cred.account_name} (${cred.account_id})
                                        </option>
                                      `
                                    )}
                                </select>
                              </div>
                              <button
                                type="submit"
                                style="background: #3b82f6; color: white; padding: 0.375rem 1rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer; font-size: 0.875rem;"
                              >
                                Link Credential
                              </button>
                            </form>
                          `
                        : ''}
                      ${!train.accounts || train.accounts.length === 0
                        ? html`
                            <div
                              style="background-color: #fef3c7; border: 1px solid #f59e0b; padding: 0.75rem; border-radius: 0.25rem;"
                            >
                              <p style="margin: 0; color: #92400e; font-size: 0.875rem;">
                                ⚠️ No credentials linked. Link a credential to enable API access.
                              </p>
                            </div>
                          `
                        : html`
                            <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                              ${train.accounts.map(
                                (cred: AnthropicCredentialSafe) => html`
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
                                        ${new Date(cred.oauth_expires_at) < new Date()
                                          ? html`<span style="color: #dc2626; font-weight: 600;"
                                              >⚠️ EXPIRED</span
                                            >`
                                          : ''}
                                      </div>
                                    </div>
                                    <form
                                      hx-post="/dashboard/trains/${train.id}/unlink-credential"
                                      hx-swap="outerHTML"
                                      hx-target="closest div"
                                      hx-confirm="Are you sure you want to unlink this credential?"
                                      style="margin: 0;"
                                    >
                                      <input
                                        type="hidden"
                                        name="credential_id"
                                        value="${cred.id}"
                                      />
                                      <button
                                        type="submit"
                                        style="background: #ef4444; color: white; padding: 0.25rem 0.75rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer; font-size: 0.75rem;"
                                      >
                                        Unlink
                                      </button>
                                    </form>
                                  </div>
                                `
                              )}
                            </div>
                          `}
                    </div>

                    <!-- Members Section -->
                    <div style="margin-bottom: 1.5rem;">
                      <h4
                        style="font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem; color: #374151;"
                      >
                        Members
                      </h4>
                      <div
                        id="members-${train.id}"
                        hx-get="/dashboard/trains/${train.id}/members-list"
                        hx-trigger="load"
                        hx-swap="innerHTML"
                      >
                        <div
                          style="background: #f9fafb; padding: 1rem; border-radius: 0.25rem; text-align: center; color: #6b7280;"
                        >
                          Loading members...
                        </div>
                      </div>
                    </div>

                    <!-- API Keys Section -->
                    <div>
                      <h4
                        style="font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem; color: #374151;"
                      >
                        API Keys
                      </h4>

                      <!-- Generate API Key Form -->
                      <form
                        hx-post="/dashboard/trains/${train.id}/generate-api-key"
                        hx-swap="beforebegin"
                        style="margin-bottom: 1rem; display: flex; gap: 0.5rem; align-items: end;"
                      >
                        <div style="flex: 1;">
                          <label
                            for="api-key-name-${train.id}"
                            style="display: block; font-size: 0.75rem; font-weight: 600; margin-bottom: 0.25rem; color: #374151;"
                          >
                            Key Name (optional)
                          </label>
                          <input
                            type="text"
                            id="api-key-name-${train.id}"
                            name="name"
                            placeholder="e.g., Production Key"
                            style="width: 100%; padding: 0.375rem; border: 1px solid #d1d5db; border-radius: 0.25rem; font-size: 0.875rem;"
                          />
                        </div>
                        <button
                          type="submit"
                          style="background: #10b981; color: white; padding: 0.375rem 1rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer; font-size: 0.875rem;"
                        >
                          Generate API Key
                        </button>
                      </form>

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
                    ${train.slack_webhook_url
                      ? html`
                          <div
                            style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #e5e7eb;"
                          >
                            <div style="font-size: 0.875rem; color: #6b7280;">
                              <strong>Slack Webhook:</strong> Configured ✅
                            </div>
                          </div>
                        `
                      : ''}
                  </div>
                `
              )}
            `}
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
        raw(`<script>
          // Handle HTMX errors
          document.body.addEventListener('htmx:responseError', function(evt) {
            evt.target.innerHTML = '<div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">Failed to load API keys</div>';
          });
        </script>`),
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
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
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
                ${key.revoked_at
                  ? html`<span
                      style="background: #ef4444; color: white; padding: 0.125rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem;"
                      >REVOKED</span
                    >`
                  : html`<span
                      style="background: #10b981; color: white; padding: 0.125rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem;"
                      >ACTIVE</span
                    >`}
              </div>
              <div style="font-size: 0.75rem; color: #6b7280;">
                Created: ${new Date(key.created_at).toLocaleString()}
                ${key.last_used_at
                  ? html`• Last used: ${new Date(key.last_used_at).toLocaleString()}`
                  : html`• Never used`}
              </div>
            </div>
          `
        )}
      </div>
    `)
  } catch (error) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        Error: ${getErrorMessage(error)}
      </div>
    `)
  }
})

/**
 * HTMX endpoint to load members for a specific train
 */
trainsUIRoutes.get('/:trainId/members-list', async c => {
  const trainId = c.req.param('trainId')
  const pool = container.getPool()

  if (!pool) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        Database not configured
      </div>
    `)
  }

  try {
    const members = await getTrainMembers(pool, trainId)

    if (members.length === 0) {
      return c.html(html`
        <div
          style="background: #fef3c7; border: 1px solid #f59e0b; padding: 0.75rem; border-radius: 0.25rem; color: #92400e;"
        >
          ⚠️ No members found. This train should have at least one owner.
        </div>
      `)
    }

    return c.html(html`
      <div style="display: flex; flex-direction: column; gap: 0.5rem;">
        ${members.map(
          member => html`
            <div
              style="background: #f9fafb; border: 1px solid #e5e7eb; padding: 0.75rem; border-radius: 0.25rem; display: flex; justify-content: space-between; align-items: center;"
            >
              <div>
                <div style="font-weight: 600; font-size: 0.875rem;">${member.user_email}</div>
                <div style="font-size: 0.75rem; color: #6b7280;">
                  <span
                    style="background: ${member.role === 'owner'
                      ? '#3b82f6'
                      : '#6b7280'}; color: white; padding: 0.125rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; text-transform: uppercase;"
                  >
                    ${member.role}
                  </span>
                  • Added: ${new Date(member.added_at).toLocaleDateString()} by ${member.added_by}
                </div>
              </div>
            </div>
          `
        )}
      </div>
    `)
  } catch (error) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        Error: ${getErrorMessage(error)}
      </div>
    `)
  }
})

/**
 * Generate a new API key for a train (HTMX form submission)
 */
trainsUIRoutes.post('/:trainId/generate-api-key', async c => {
  const trainId = c.req.param('trainId')
  const pool = container.getPool()

  if (!pool) {
    return c.html(html`
      <div
        style="background: #fee2e2; color: #991b1b; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
      >
        <strong>Error:</strong> Database not configured
      </div>
    `)
  }

  try {
    const formData = await c.req.parseBody()
    const name = (formData.name as string) || undefined

    const generatedKey = await createTrainApiKey(pool, trainId, {
      name,
      created_by: undefined,
    })

    return c.html(html`
      <div
        style="background: #d1fae5; border: 2px solid #10b981; padding: 1.5rem; border-radius: 0.5rem; margin-bottom: 1.5rem;"
      >
        <div style="margin-bottom: 1rem;">
          <strong style="color: #065f46; font-size: 1rem;"
            >✅ API Key Generated Successfully!</strong
          >
        </div>
        <div style="margin-bottom: 0.5rem;">
          <strong style="color: #065f46;">⚠️ Important:</strong>
          <span style="color: #065f46;">
            Copy this key now. It will not be shown again for security reasons.
          </span>
        </div>
        <div
          style="background: white; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem; border: 1px solid #10b981;"
        >
          <div style="font-size: 0.75rem; font-weight: 600; color: #6b7280; margin-bottom: 0.5rem;">
            ${generatedKey.name || 'Unnamed API Key'}
          </div>
          <code
            style="background: #f3f4f6; padding: 0.5rem; border-radius: 0.25rem; font-size: 0.875rem; word-break: break-all; display: block; color: #111827; font-family: monospace;"
            >${generatedKey.api_key}</code
          >
        </div>
        <button
          onclick="navigator.clipboard.writeText('${generatedKey.api_key}'); this.textContent='✅ Copied!'; setTimeout(() => this.textContent='Copy to Clipboard', 2000)"
          style="background: #3b82f6; color: white; padding: 0.5rem 1rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer; margin-right: 0.5rem;"
        >
          Copy to Clipboard
        </button>
        <button
          onclick="location.reload()"
          style="background: #6b7280; color: white; padding: 0.5rem 1rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer;"
        >
          Done
        </button>
      </div>
    `)
  } catch (error) {
    return c.html(html`
      <div
        style="background: #fee2e2; color: #991b1b; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
      >
        <strong>Error:</strong> ${getErrorMessage(error)}
      </div>
    `)
  }
})

/**
 * Link a credential to a train (HTMX form submission)
 */
trainsUIRoutes.post('/:trainId/link-credential', async c => {
  const trainId = c.req.param('trainId')
  const pool = container.getPool()

  if (!pool) {
    return c.html(html`
      <div
        style="background: #fee2e2; color: #991b1b; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
      >
        <strong>Error:</strong> Database not configured
      </div>
    `)
  }

  try {
    const formData = await c.req.parseBody()
    const credentialId = formData.credential_id as string

    if (!credentialId) {
      return c.html(html`
        <div
          style="background: #fee2e2; color: #991b1b; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
        >
          <strong>Error:</strong> Please select a credential
        </div>
      `)
    }

    await linkAccountToTrain(pool, trainId, credentialId)

    return c.html(html`
      <div
        style="background: #d1fae5; color: #065f46; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
      >
        <strong>✅ Success!</strong> Credential linked successfully.
      </div>
      <div style="text-align: center;">
        <button
          onclick="location.reload()"
          style="background: #3b82f6; color: white; padding: 0.5rem 1.5rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer;"
        >
          Reload Page
        </button>
      </div>
    `)
  } catch (error) {
    const errorMessage = getErrorMessage(error)

    return c.html(html`
      <div
        style="background: #fee2e2; color: #991b1b; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
      >
        <strong>Error:</strong> ${errorMessage}
      </div>
      <div style="text-align: center;">
        <button
          onclick="location.reload()"
          style="background: #3b82f6; color: white; padding: 0.5rem 1.5rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer;"
        >
          Try Again
        </button>
      </div>
    `)
  }
})

/**
 * Unlink a credential from a train (HTMX form submission)
 */
trainsUIRoutes.post('/:trainId/unlink-credential', async c => {
  const trainId = c.req.param('trainId')
  const pool = container.getPool()

  if (!pool) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        Database not configured
      </div>
    `)
  }

  try {
    const formData = await c.req.parseBody()
    const credentialId = formData.credential_id as string

    const success = await unlinkAccountFromTrain(pool, trainId, credentialId)

    if (success) {
      // Return empty div to remove the credential from the list
      return c.html(html``)
    } else {
      return c.html(html`
        <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
          Failed to unlink credential
        </div>
      `)
    }
  } catch (error) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        Error: ${getErrorMessage(error)}
      </div>
    `)
  }
})

/**
 * Create a new train (HTMX form submission)
 */
trainsUIRoutes.post('/create', async c => {
  const pool = container.getPool()

  if (!pool) {
    return c.html(html`
      <div
        style="background: #fee2e2; color: #991b1b; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
      >
        <strong>Error:</strong> Database not configured
      </div>
    `)
  }

  const auth = c.get('auth')
  const client = await pool.connect()

  try {
    const formData = await c.req.parseBody()
    const trainId = formData.train_id as string
    const name = formData.name as string
    const description = (formData.description as string) || undefined

    // Validate train ID format
    if (!/^[a-z0-9-]+$/.test(trainId)) {
      client.release()
      return c.html(html`
        <div
          style="background: #fee2e2; color: #991b1b; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
        >
          <strong>Error:</strong> Train ID must be lowercase alphanumeric with hyphens only
        </div>
        <div style="text-align: center;">
          <button
            onclick="location.reload()"
            style="background: #3b82f6; color: white; padding: 0.5rem 1.5rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer;"
          >
            Try Again
          </button>
        </div>
      `)
    }

    // Create train and auto-assign creator as owner in a transaction
    await client.query('BEGIN')
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const train = await createTrain(client as any, {
        train_id: trainId,
        name: name,
        description: description,
      })

      // Add the creator as an owner
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await addTrainMember(client as any, train.id, auth.principal, 'owner', auth.principal)

      await client.query('COMMIT')

      return c.html(html`
        <div
          style="background: #d1fae5; color: #065f46; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
        >
          <strong>✅ Success!</strong> Train "${train.train_id}" created successfully.
        </div>
        <div style="text-align: center;">
          <button
            onclick="location.reload()"
            style="background: #3b82f6; color: white; padding: 0.5rem 1.5rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer;"
          >
            Reload Page
          </button>
        </div>
      `)
    } catch (innerError) {
      await client.query('ROLLBACK')
      throw innerError
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    const isDuplicate = errorMessage.includes('unique') || errorMessage.includes('duplicate')

    return c.html(html`
      <div
        style="background: #fee2e2; color: #991b1b; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
      >
        <strong>Error:</strong>
        ${isDuplicate ? 'A train with this ID already exists' : errorMessage}
      </div>
      <div style="text-align: center;">
        <button
          onclick="location.reload()"
          style="background: #3b82f6; color: white; padding: 0.5rem 1.5rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer;"
        >
          Try Again
        </button>
      </div>
    `)
  } finally {
    client.release()
  }
})
