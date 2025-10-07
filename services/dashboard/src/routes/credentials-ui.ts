import { Hono } from 'hono'
import { html } from 'hono/html'
import { layout } from '../layout/index.js'
import { container } from '../container.js'
import { listCredentialsSafe } from '@agent-prompttrain/shared/database/queries'
import { getErrorMessage } from '@agent-prompttrain/shared'

export const credentialsUIRoutes = new Hono()

/**
 * Credentials management UI page
 */
credentialsUIRoutes.get('/', async c => {
  const pool = container.getPool()

  if (!pool) {
    return c.html(
      layout(
        'Credentials',
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
    const credentials = await listCredentialsSafe(pool)

    const content = html`
      <div style="margin-bottom: 2rem;">
        <h2 style="font-size: 1.5rem; font-weight: bold; margin-bottom: 1rem;">
          OAuth Credentials
        </h2>

        <div
          style="background-color: #eff6ff; border: 1px solid #3b82f6; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1.5rem;"
        >
          <p style="margin: 0; color: #1e40af;">
            <strong>ℹ️ Note:</strong> OAuth credentials are managed via the command-line login
            script. Use
            <code style="background: white; padding: 0.125rem 0.25rem; border-radius: 0.125rem;"
              >bun run scripts/auth/oauth-login.ts</code
            >
            to add new credentials.
          </p>
        </div>

        ${credentials.length === 0
          ? html`
              <div
                style="background-color: #fef3c7; border: 1px solid #f59e0b; padding: 1rem; border-radius: 0.25rem;"
              >
                <p style="margin: 0; color: #92400e;">
                  <strong>⚠️ No credentials found.</strong> Add credentials using the OAuth login
                  script.
                </p>
              </div>
            `
          : html`
              <div style="overflow-x: auto;">
                <table
                  style="width: 100%; border-collapse: collapse; background: white; border: 1px solid #e5e7eb; border-radius: 0.25rem;"
                >
                  <thead style="background-color: #f9fafb; border-bottom: 1px solid #e5e7eb;">
                    <tr>
                      <th
                        style="padding: 0.75rem; text-align: left; font-size: 0.875rem; font-weight: 600; color: #374151;"
                      >
                        Account ID
                      </th>
                      <th
                        style="padding: 0.75rem; text-align: left; font-size: 0.875rem; font-weight: 600; color: #374151;"
                      >
                        Account Name
                      </th>
                      <th
                        style="padding: 0.75rem; text-align: left; font-size: 0.875rem; font-weight: 600; color: #374151;"
                      >
                        Expires At
                      </th>
                      <th
                        style="padding: 0.75rem; text-align: left; font-size: 0.875rem; font-weight: 600; color: #374151;"
                      >
                        Scopes
                      </th>
                      <th
                        style="padding: 0.75rem; text-align: left; font-size: 0.875rem; font-weight: 600; color: #374151;"
                      >
                        Is Max
                      </th>
                      <th
                        style="padding: 0.75rem; text-align: left; font-size: 0.875rem; font-weight: 600; color: #374151;"
                      >
                        Last Refreshed
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    ${credentials.map(
                      cred => html`
                        <tr style="border-bottom: 1px solid #e5e7eb;">
                          <td style="padding: 0.75rem; font-size: 0.875rem; color: #111827;">
                            <code
                              style="background: #f3f4f6; padding: 0.125rem 0.25rem; border-radius: 0.125rem;"
                              >${cred.account_id}</code
                            >
                          </td>
                          <td style="padding: 0.75rem; font-size: 0.875rem; color: #111827;">
                            ${cred.account_name}
                          </td>
                          <td style="padding: 0.75rem; font-size: 0.875rem; color: #111827;">
                            ${new Date(cred.oauth_expires_at).toLocaleString()}
                            ${new Date(cred.oauth_expires_at) < new Date()
                              ? html`<span
                                  style="color: #dc2626; font-weight: 600; margin-left: 0.5rem;"
                                  >⚠️ EXPIRED</span
                                >`
                              : ''}
                          </td>
                          <td style="padding: 0.75rem; font-size: 0.875rem; color: #111827;">
                            ${cred.oauth_scopes.join(', ')}
                          </td>
                          <td style="padding: 0.75rem; font-size: 0.875rem; color: #111827;">
                            ${cred.oauth_is_max ? '✅ Yes' : '❌ No'}
                          </td>
                          <td style="padding: 0.75rem; font-size: 0.875rem; color: #6b7280;">
                            ${cred.last_refresh_at
                              ? new Date(cred.last_refresh_at).toLocaleString()
                              : 'Never'}
                          </td>
                        </tr>
                      `
                    )}
                  </tbody>
                </table>
              </div>
            `}
      </div>

      <div style="margin-top: 2rem; padding-top: 2rem; border-top: 1px solid #e5e7eb;">
        <h3 style="font-size: 1.125rem; font-weight: bold; margin-bottom: 0.5rem;">
          Add New Credential
        </h3>
        <p style="color: #6b7280; margin-bottom: 1rem;">
          Run the OAuth login script to add a new credential:
        </p>
        <pre
          style="background: #1f2937; color: #f3f4f6; padding: 1rem; border-radius: 0.25rem; overflow-x: auto;"
        ><code>bun run scripts/auth/oauth-login.ts</code></pre>
      </div>
    `

    return c.html(layout('Credentials', content, '', c))
  } catch (error) {
    return c.html(
      layout(
        'Credentials - Error',
        html`
          <div class="error-banner">
            <strong>Error:</strong> Failed to load credentials: ${getErrorMessage(error)}
          </div>
        `,
        '',
        c
      )
    )
  }
})
