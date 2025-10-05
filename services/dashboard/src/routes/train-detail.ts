/**
 * Train detail page route
 *
 * Displays a single train with its accounts, and provides UI for:
 * - Generating new API keys
 * - Revoking existing keys
 * - Managing train configuration
 */

import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { layout } from '../layout/index.js'
import { container } from '../container.js'
import { CredentialsRepository, getErrorMessage, generateApiKey } from '@agent-prompttrain/shared'
import { logger } from '../middleware/logger.js'

export const trainDetailRoutes = new Hono()

function getRepository(): CredentialsRepository {
  const pool = container.getPool()
  const encryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY

  if (!encryptionKey) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY environment variable is required')
  }

  return new CredentialsRepository(pool, encryptionKey)
}

/**
 * Main train detail page
 */
trainDetailRoutes.get('/:trainId', async c => {
  const trainId = c.req.param('trainId')

  try {
    const repo = getRepository()
    const [train, accounts] = await Promise.all([
      repo.getTrainById(trainId),
      repo.getAccountsForTrain(trainId),
    ])

    if (!train) {
      return c.html(
        layout(
          'Train Not Found',
          html`
            <div class="error-banner"><strong>Error:</strong> Train "${trainId}" not found</div>
            <p><a href="/dashboard/configuration?tab=trains">← Back to Configuration</a></p>
          `
        )
      )
    }

    const content = html`
      <div class="config-container">
        <div style="margin-bottom: 1.5rem;">
          <a
            href="/dashboard/configuration?tab=trains"
            style="color: #3b82f6; text-decoration: none;"
          >
            ← Back to Trains
          </a>
        </div>

        <h2 style="margin-bottom: 0.5rem;">Train: ${train.trainId}</h2>
        ${train.description
          ? html`<p style="color: #6b7280; margin-bottom: 1.5rem;">${train.description}</p>`
          : ''}

        <!-- API Keys Section -->
        <div class="section" style="margin-bottom: 2rem;">
          <div class="section-header">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <h3>API Keys (${accounts.length})</h3>
              <button
                class="btn"
                hx-get="/dashboard/trains/${trainId}/generate-form"
                hx-target="#key-modal-container"
                hx-swap="innerHTML"
                data-testid="generate-api-key-button"
              >
                + Generate API Key
              </button>
            </div>
          </div>

          <div id="key-modal-container"></div>

          <div class="section-content">
            ${accounts.length === 0
              ? html`
                  <p style="color: #6b7280; text-align: center; padding: 2rem;">
                    No API keys configured for this train. Click "Generate API Key" to create one.
                  </p>
                `
              : html`
                  <table>
                    <thead>
                      <tr>
                        <th>Account Name</th>
                        <th>Type</th>
                        <th>Key Hash</th>
                        <th>Created</th>
                        <th>Status</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody id="accounts-list">
                      ${raw(
                        accounts
                          .map(
                            acc => `
                          <tr id="account-row-${acc.accountId}">
                            <td>
                              <strong>${acc.accountName}</strong>
                              ${acc.isGenerated ? '<span style="background: #dbeafe; color: #1e40af; padding: 0.125rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; margin-left: 0.5rem;">Generated</span>' : ''}
                            </td>
                            <td>${acc.credentialType === 'api_key' ? 'API Key' : 'OAuth'}</td>
                            <td class="text-sm" style="font-family: monospace;">
                              ${acc.keyHashLast4 ? `****${acc.keyHashLast4}` : '-'}
                            </td>
                            <td class="text-sm">${new Date(acc.createdAt).toLocaleString()}</td>
                            <td>
                              ${acc.revokedAt ? `<span style="color: #ef4444;">Revoked</span>` : acc.isActive ? '<span style="color: #10b981;">Active</span>' : '<span style="color: #6b7280;">Inactive</span>'}
                            </td>
                            <td>
                              ${
                                !acc.revokedAt
                                  ? `
                                <button
                                  class="btn"
                                  style="font-size: 0.75rem; padding: 0.25rem 0.75rem; background: #ef4444;"
                                  hx-patch="/api/credentials/accounts/${acc.accountId}/revoke"
                                  hx-confirm="Are you sure you want to revoke this API key? This action cannot be undone."
                                  hx-target="#account-row-${acc.accountId}"
                                  hx-swap="outerHTML"
                                  data-testid="revoke-key-button-${acc.accountId}"
                                >
                                  Revoke
                                </button>
                              `
                                  : '-'
                              }
                            </td>
                          </tr>
                        `
                          )
                          .join('')
                      )}
                    </tbody>
                  </table>
                `}
          </div>
        </div>

        <!-- Train Configuration Section -->
        <div class="section">
          <div class="section-header">
            <h3>Train Configuration</h3>
          </div>
          <div class="section-content">
            <table>
              <tr>
                <th style="width: 200px;">Train ID</th>
                <td style="font-family: monospace;">${train.trainId}</td>
              </tr>
              <tr>
                <th>Description</th>
                <td>${train.description || '-'}</td>
              </tr>
              <tr>
                <th>Status</th>
                <td>
                  ${train.isActive
                    ? '<span style="color: #10b981;">Active</span>'
                    : '<span style="color: #6b7280;">Inactive</span>'}
                </td>
              </tr>
              <tr>
                <th>Created</th>
                <td>${new Date(train.createdAt).toLocaleString()}</td>
              </tr>
              <tr>
                <th>Last Updated</th>
                <td>${new Date(train.updatedAt).toLocaleString()}</td>
              </tr>
            </table>

            <div style="margin-top: 1.5rem;">
              <button
                class="btn btn-secondary"
                hx-get="/dashboard/configuration/trains/${trainId}/edit"
                hx-target="body"
                hx-push-url="true"
              >
                Edit Configuration
              </button>
            </div>
          </div>
        </div>
      </div>

      <script src="https://unpkg.com/htmx.org@1.9.10"></script>
    `

    return c.html(layout(`Train: ${trainId}`, content, '', c))
  } catch (error) {
    logger.error('Failed to load train detail page', {
      error: getErrorMessage(error),
      metadata: { trainId },
    })
    return c.html(
      layout(
        'Error',
        html`
          <div class="error-banner">
            <strong>Error:</strong> Failed to load train details. ${getErrorMessage(error)}
          </div>
          <p><a href="/dashboard/configuration?tab=trains">← Back to Configuration</a></p>
        `
      )
    )
  }
})

/**
 * Generate API Key form partial
 */
trainDetailRoutes.get('/:trainId/generate-form', async c => {
  const trainId = c.req.param('trainId')

  const form = html`
    <div
      id="generate-key-modal"
      class="modal"
      style="
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center;
      z-index: 1000;
    "
    >
      <div
        class="modal-content"
        style="
        background: white; padding: 2rem; border-radius: 0.5rem;
        max-width: 500px; width: 90%;
      "
      >
        <h3 style="margin-bottom: 1rem;">Generate API Key</h3>
        <form
          hx-post="/dashboard/trains/${trainId}/generate"
          hx-target="#generate-key-modal"
          hx-swap="outerHTML"
          data-testid="generate-key-form"
        >
          <div style="margin-bottom: 1rem;">
            <label style="display: block; margin-bottom: 0.5rem; font-weight: 500;">
              Key Name *
            </label>
            <input
              type="text"
              name="accountName"
              required
              placeholder="e.g., Production API Key"
              style="width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.375rem;"
              data-testid="key-name-input"
            />
            <small style="color: #6b7280;">
              A descriptive name to help you identify this key later
            </small>
          </div>

          <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
            <button
              type="button"
              class="btn btn-secondary"
              onclick="document.getElementById('key-modal-container').innerHTML = ''"
              data-testid="cancel-button"
            >
              Cancel
            </button>
            <button type="submit" class="btn" data-testid="generate-button">Generate Key</button>
          </div>
        </form>
      </div>
    </div>
  `

  return c.html(form)
})

/**
 * Handle API key generation (BFF endpoint)
 */
trainDetailRoutes.post('/:trainId/generate', async c => {
  const trainId = c.req.param('trainId')

  try {
    const formData = await c.req.parseBody()
    const accountName = formData.accountName as string

    if (!accountName) {
      return c.html(html`
        <div
          id="generate-key-modal"
          class="modal"
          style="
          position: fixed; top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center;
          z-index: 1000;
        "
        >
          <div
            class="modal-content"
            style="
            background: white; padding: 2rem; border-radius: 0.5rem;
            max-width: 500px; width: 90%;
          "
          >
            <div class="error-banner" style="margin-bottom: 1rem;">
              <strong>Error:</strong> Account name is required
            </div>
            <button
              class="btn"
              onclick="document.getElementById('key-modal-container').innerHTML = ''"
            >
              Close
            </button>
          </div>
        </div>
      `)
    }

    // Call repository methods directly (no fetch to avoid localhost/auth issues)
    const repo = getRepository()

    // Check per-train limit (10 keys per train)
    const perTrainCount = await repo.countGeneratedKeysForTrain(trainId)
    if (perTrainCount >= 10) {
      return c.html(html`
        <div
          id="generate-key-modal"
          class="modal"
          style="
          position: fixed; top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center;
          z-index: 1000;
        "
        >
          <div
            class="modal-content"
            style="
            background: white; padding: 2rem; border-radius: 0.5rem;
            max-width: 500px; width: 90%;
          "
          >
            <div class="error-banner" style="margin-bottom: 1rem;">
              <strong>Error:</strong> Per-train limit reached <br /><small
                >Maximum of 10 generated API keys per train</small
              >
            </div>
            <button
              class="btn"
              onclick="document.getElementById('key-modal-container').innerHTML = ''"
            >
              Close
            </button>
          </div>
        </div>
      `)
    }

    // Check global limit (50 keys total)
    const globalCount = await repo.countGeneratedKeysGlobal()
    if (globalCount >= 50) {
      return c.html(html`
        <div
          id="generate-key-modal"
          class="modal"
          style="
          position: fixed; top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center;
          z-index: 1000;
        "
        >
          <div
            class="modal-content"
            style="
            background: white; padding: 2rem; border-radius: 0.5rem;
            max-width: 500px; width: 90%;
          "
          >
            <div class="error-banner" style="margin-bottom: 1rem;">
              <strong>Error:</strong> Global limit reached <br /><small
                >Maximum of 50 generated API keys globally</small
              >
            </div>
            <button
              class="btn"
              onclick="document.getElementById('key-modal-container').innerHTML = ''"
            >
              Close
            </button>
          </div>
        </div>
      `)
    }

    // Generate and store the key
    const generatedKey = generateApiKey()
    const result = await repo.generateApiKeyForTrain(trainId, accountName, generatedKey)

    logger.info('API key generated', {
      metadata: {
        accountId: result.accountId,
        trainId,
        accountName,
      },
    })

    // Display the generated key
    const displayModal = html`
      <div
        id="generate-key-modal"
        class="modal"
        style="
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center;
        z-index: 1000;
      "
      >
        <div
          class="modal-content"
          style="
          background: white; padding: 2rem; border-radius: 0.5rem;
          max-width: 600px; width: 90%;
        "
        >
          <h3 style="margin-bottom: 1rem; color: #10b981;">✓ API Key Generated</h3>

          <div
            style="
            background: #fef3c7; border: 2px solid #f59e0b; padding: 1rem; border-radius: 0.375rem;
            margin-bottom: 1.5rem;
          "
          >
            <strong style="color: #92400e;">⚠️ Important:</strong>
            <p style="margin: 0.5rem 0 0 0; color: #92400e;">
              Please copy this key and store it securely. You will not be able to see it again.
            </p>
          </div>

          <div style="margin-bottom: 1.5rem;">
            <label style="display: block; margin-bottom: 0.5rem; font-weight: 500;">
              Your API Key:
            </label>
            <div style="display: flex; gap: 0.5rem;">
              <input
                type="text"
                id="generated-key-display"
                value="${generatedKey}"
                readonly
                data-testid="generated-api-key-display"
                style="
                  flex: 1; padding: 0.75rem; border: 2px solid #10b981;
                  border-radius: 0.375rem; font-family: monospace; font-size: 0.875rem;
                  background: #f0fdf4;
                "
              />
              <button
                class="btn"
                onclick="
                  navigator.clipboard.writeText('${generatedKey}');
                  this.textContent = 'Copied!';
                  setTimeout(() => this.textContent = 'Copy', 2000);
                "
                data-testid="copy-key-button"
                style="white-space: nowrap;"
              >
                Copy
              </button>
            </div>
          </div>

          <button
            class="btn"
            hx-get="/dashboard/trains/${trainId}"
            hx-target="body"
            hx-push-url="true"
            data-testid="close-modal-button"
          >
            Done
          </button>
        </div>
      </div>
    `

    return c.html(displayModal)
  } catch (error) {
    logger.error('Failed to generate API key', {
      error: getErrorMessage(error),
      metadata: { trainId },
    })
    return c.html(html`
      <div
        id="generate-key-modal"
        class="modal"
        style="
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center;
        z-index: 1000;
      "
      >
        <div
          class="modal-content"
          style="
          background: white; padding: 2rem; border-radius: 0.5rem;
          max-width: 500px; width: 90%;
        "
        >
          <div class="error-banner" style="margin-bottom: 1rem;">
            <strong>Error:</strong> ${getErrorMessage(error)}
          </div>
          <button
            class="btn"
            onclick="document.getElementById('key-modal-container').innerHTML = ''"
          >
            Close
          </button>
        </div>
      </div>
    `)
  }
})
