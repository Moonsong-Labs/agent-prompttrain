/**
 * Configuration management routes
 *
 * Provides UI for managing accounts and trains when USE_DATABASE_CREDENTIALS=true
 */

import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { layout } from '../layout/index.js'
import { container } from '../container.js'
import { CredentialsRepository, getErrorMessage } from '@agent-prompttrain/shared'
import { logger } from '../middleware/logger.js'

export const configurationRoutes = new Hono()

function getRepository(): CredentialsRepository {
  const pool = container.getPool()
  const encryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY

  if (!encryptionKey) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY environment variable is required')
  }

  return new CredentialsRepository(pool, encryptionKey)
}

/**
 * Main configuration page with tabs for Accounts and Trains
 */
configurationRoutes.get('/', async c => {
  const activeTab = c.req.query('tab') || 'accounts'

  try {
    const repo = getRepository()
    const [accounts, trains] = await Promise.all([repo.listAccounts(), repo.listTrains()])

    const content = html`
      <div class="config-container">
        <h2 style="margin-bottom: 1.5rem;">Credential Management</h2>

        <!-- Tabs -->
        <div class="tabs" style="margin-bottom: 2rem; border-bottom: 1px solid #e5e7eb;">
          <a
            href="/dashboard/configuration?tab=accounts"
            class="tab ${activeTab === 'accounts' ? 'active' : ''}"
            style="display: inline-block; padding: 0.75rem 1.5rem; border-bottom: 2px solid ${activeTab ===
            'accounts'
              ? '#3b82f6'
              : 'transparent'}; color: ${activeTab === 'accounts'
              ? '#3b82f6'
              : '#6b7280'}; text-decoration: none;"
          >
            Accounts
          </a>
          <a
            href="/dashboard/configuration?tab=trains"
            class="tab ${activeTab === 'trains' ? 'active' : ''}"
            style="display: inline-block; padding: 0.75rem 1.5rem; border-bottom: 2px solid ${activeTab ===
            'trains'
              ? '#3b82f6'
              : 'transparent'}; color: ${activeTab === 'trains'
              ? '#3b82f6'
              : '#6b7280'}; text-decoration: none;"
          >
            Trains
          </a>
        </div>

        <!-- Accounts Tab -->
        ${activeTab === 'accounts'
          ? html`
              <div class="tab-content">
                <div
                  style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;"
                >
                  <h3>Accounts (${accounts.length})</h3>
                  <button
                    class="btn"
                    hx-get="/dashboard/configuration/accounts/new"
                    hx-target="#account-form-container"
                    hx-swap="innerHTML"
                  >
                    + Add Account
                  </button>
                </div>

                <div id="account-form-container" style="margin-bottom: 1.5rem;"></div>

                <div class="section">
                  <table>
                    <thead>
                      <tr>
                        <th>Account Name</th>
                        <th>Type</th>
                        <th>Status</th>
                        <th>Last Used</th>
                        <th>Created</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${accounts.length === 0
                        ? html` <tr>
                            <td colspan="6" style="text-align: center; color: #6b7280;">
                              No accounts configured
                            </td>
                          </tr>`
                        : raw(
                            accounts
                              .map(
                                acc => `
                          <tr id="account-row-${acc.accountId}">
                            <td><strong>${acc.accountName}</strong></td>
                            <td>${acc.credentialType === 'api_key' ? 'API Key' : 'OAuth'}</td>
                            <td>${acc.isActive ? '<span style="color: #10b981;">Active</span>' : '<span style="color: #6b7280;">Inactive</span>'}</td>
                            <td class="text-sm">${acc.lastUsedAt ? new Date(acc.lastUsedAt).toLocaleString() : 'Never'}</td>
                            <td class="text-sm">${new Date(acc.createdAt).toLocaleString()}</td>
                            <td>
                              <button
                                class="btn btn-secondary"
                                style="font-size: 0.75rem; padding: 0.25rem 0.75rem; margin-right: 0.5rem;"
                                hx-get="/dashboard/configuration/accounts/${acc.accountId}/edit"
                                hx-target="#account-row-${acc.accountId}"
                                hx-swap="outerHTML"
                              >
                                Edit
                              </button>
                              <button
                                class="btn"
                                style="font-size: 0.75rem; padding: 0.25rem 0.75rem; background: #ef4444;"
                                hx-delete="/api/credentials/accounts/${acc.accountId}"
                                hx-confirm="Are you sure you want to delete this account?"
                                hx-target="#account-row-${acc.accountId}"
                                hx-swap="outerHTML"
                              >
                                Delete
                              </button>
                            </td>
                          </tr>
                        `
                              )
                              .join('')
                          )}
                    </tbody>
                  </table>
                </div>
              </div>
            `
          : ''}

        <!-- Trains Tab -->
        ${activeTab === 'trains'
          ? html`
              <div class="tab-content">
                <div
                  style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;"
                >
                  <h3>Trains (${trains.length})</h3>
                  <button
                    class="btn"
                    hx-get="/dashboard/configuration/trains/new"
                    hx-target="#train-form-container"
                    hx-swap="innerHTML"
                  >
                    + Add Train
                  </button>
                </div>

                <div id="train-form-container" style="margin-bottom: 1.5rem;"></div>

                <div class="section">
                  <table>
                    <thead>
                      <tr>
                        <th>Train ID</th>
                        <th>Name</th>
                        <th>Description</th>
                        <th>Accounts</th>
                        <th>Status</th>
                        <th>Created</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${trains.length === 0
                        ? html` <tr>
                            <td colspan="7" style="text-align: center; color: #6b7280;">
                              No trains configured
                            </td>
                          </tr>`
                        : raw(
                            trains
                              .map(
                                train => `
                          <tr id="train-row-${train.trainId}">
                            <td><strong>${train.trainId}</strong></td>
                            <td>${train.trainName || '-'}</td>
                            <td class="text-sm">${train.description || '-'}</td>
                            <td class="text-sm">${train.accountIds.length} account(s)</td>
                            <td>${train.isActive ? '<span style="color: #10b981;">Active</span>' : '<span style="color: #6b7280;">Inactive</span>'}</td>
                            <td class="text-sm">${new Date(train.createdAt).toLocaleString()}</td>
                            <td>
                              <button
                                class="btn btn-secondary"
                                style="font-size: 0.75rem; padding: 0.25rem 0.75rem; margin-right: 0.5rem;"
                                hx-get="/dashboard/configuration/trains/${train.trainId}/edit"
                                hx-target="#train-row-${train.trainId}"
                                hx-swap="outerHTML"
                              >
                                Edit
                              </button>
                              <button
                                class="btn"
                                style="font-size: 0.75rem; padding: 0.25rem 0.75rem; background: #ef4444;"
                                hx-delete="/api/credentials/trains/${train.trainId}"
                                hx-confirm="Are you sure you want to delete this train?"
                                hx-target="#train-row-${train.trainId}"
                                hx-swap="outerHTML"
                              >
                                Delete
                              </button>
                            </td>
                          </tr>
                        `
                              )
                              .join('')
                          )}
                    </tbody>
                  </table>
                </div>
              </div>
            `
          : ''}
      </div>

      <script src="https://unpkg.com/htmx.org@1.9.10"></script>
    `

    return c.html(layout('Configuration', content, '', c))
  } catch (error) {
    logger.error('Failed to load configuration page', { error: getErrorMessage(error) })
    return c.html(
      layout(
        'Configuration Error',
        html`
          <div class="error-banner">
            <strong>Error:</strong> Failed to load configuration. ${getErrorMessage(error)}
          </div>
        `
      )
    )
  }
})

/**
 * Account form partial - new account
 */
configurationRoutes.get('/accounts/new', async c => {
  const form = html`
    <div class="section">
      <div class="section-header">New Account</div>
      <div class="section-content">
        <form
          hx-post="/api/credentials/accounts"
          hx-target="#account-form-container"
          hx-swap="innerHTML"
        >
          <div style="margin-bottom: 1rem;">
            <label style="display: block; margin-bottom: 0.5rem;">Account Name *</label>
            <input
              type="text"
              name="accountName"
              required
              style="width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.375rem;"
            />
          </div>

          <div style="margin-bottom: 1rem;">
            <label style="display: block; margin-bottom: 0.5rem;">Credential Type *</label>
            <select
              name="credentialType"
              required
              style="width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.375rem;"
            >
              <option value="api_key">API Key</option>
              <option value="oauth">OAuth</option>
            </select>
          </div>

          <div style="margin-bottom: 1rem;">
            <label style="display: block; margin-bottom: 0.5rem;">API Key (for API Key type)</label>
            <input
              type="password"
              name="apiKey"
              placeholder="sk-ant-..."
              style="width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.375rem;"
            />
            <small style="color: #6b7280;"
              >Note: This will be encrypted and cannot be retrieved later</small
            >
          </div>

          <div style="display: flex; gap: 0.5rem;">
            <button type="submit" class="btn">Create Account</button>
            <button
              type="button"
              class="btn btn-secondary"
              onclick="document.getElementById('account-form-container').innerHTML = ''"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  `

  return c.html(form)
})

/**
 * Train form partial - new train
 */
configurationRoutes.get('/trains/new', async c => {
  try {
    const repo = getRepository()
    const accounts = await repo.listAccounts()

    const form = html`
      <div class="section">
        <div class="section-header">New Train</div>
        <div class="section-content">
          <form
            hx-post="/api/credentials/trains"
            hx-target="#train-form-container"
            hx-swap="innerHTML"
          >
            <div style="margin-bottom: 1rem;">
              <label style="display: block; margin-bottom: 0.5rem;">Train ID *</label>
              <input
                type="text"
                name="trainId"
                required
                style="width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.375rem;"
              />
            </div>

            <div style="margin-bottom: 1rem;">
              <label style="display: block; margin-bottom: 0.5rem;">Train Name</label>
              <input
                type="text"
                name="trainName"
                style="width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.375rem;"
              />
            </div>

            <div style="margin-bottom: 1rem;">
              <label style="display: block; margin-bottom: 0.5rem;">Description</label>
              <textarea
                name="description"
                rows="3"
                style="width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.375rem;"
              ></textarea>
            </div>

            <div style="margin-bottom: 1rem;">
              <label style="display: block; margin-bottom: 0.5rem;">Associated Accounts</label>
              <select
                name="accountIds"
                multiple
                style="width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.375rem; min-height: 150px;"
              >
                ${raw(
                  accounts
                    .map(acc => `<option value="${acc.accountId}">${acc.accountName}</option>`)
                    .join('')
                )}
              </select>
              <small style="color: #6b7280;">Hold Ctrl/Cmd to select multiple accounts</small>
            </div>

            <div style="display: flex; gap: 0.5rem;">
              <button type="submit" class="btn">Create Train</button>
              <button
                type="button"
                class="btn btn-secondary"
                onclick="document.getElementById('train-form-container').innerHTML = ''"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    `

    return c.html(form)
  } catch (error) {
    logger.error('Failed to load train form', { error: getErrorMessage(error) })
    return c.text('Error loading form', 500)
  }
})
