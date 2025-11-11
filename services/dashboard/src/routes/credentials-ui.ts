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
        <h2 style="font-size: 1.5rem; font-weight: bold; margin-bottom: 1rem;">API Credentials</h2>

        <div
          style="background-color: #eff6ff; border: 1px solid #3b82f6; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1.5rem;"
        >
          <p style="margin: 0; color: #1e40af; margin-bottom: 0.5rem;">
            <strong>ℹ️ Note:</strong> Credentials are managed via command-line scripts:
          </p>
          <ul style="margin: 0.5rem 0 0 1.5rem; color: #1e40af;">
            <li>
              Anthropic OAuth:
              <code style="background: white; padding: 0.125rem 0.25rem; border-radius: 0.125rem;"
                >bun run scripts/auth/oauth-login.ts</code
              >
            </li>
            <li>
              AWS Bedrock:
              <code style="background: white; padding: 0.125rem 0.25rem; border-radius: 0.125rem;"
                >bun run scripts/auth/bedrock-login.ts</code
              >
            </li>
          </ul>
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
                        Provider
                      </th>
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
                        Details
                      </th>
                      <th
                        style="padding: 0.75rem; text-align: left; font-size: 0.875rem; font-weight: 600; color: #374151;"
                      >
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    ${credentials.map(
                      cred => html`
                        <tr style="border-bottom: 1px solid #e5e7eb;">
                          <td style="padding: 0.75rem; font-size: 0.875rem; color: #111827;">
                            ${cred.provider === 'anthropic'
                              ? html`<span
                                  style="display: inline-flex; align-items: center; background: #dbeafe; color: #1e40af; padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-weight: 500;"
                                  title="Anthropic Direct API"
                                >
                                  🔵 Anthropic
                                </span>`
                              : html`<span
                                  style="display: inline-flex; align-items: center; background: #fed7aa; color: #9a3412; padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-weight: 500;"
                                  title="AWS Bedrock"
                                >
                                  🟠 Bedrock
                                </span>`}
                          </td>
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
                            ${cred.provider === 'anthropic'
                              ? html`
                                  <div>
                                    Expires:
                                    ${new Date((cred as any).oauth_expires_at).toLocaleString()}
                                  </div>
                                  <div
                                    style="margin-top: 0.25rem; font-size: 0.75rem; color: #6b7280;"
                                  >
                                    Scopes: ${(cred as any).oauth_scopes.join(', ')}
                                  </div>
                                `
                              : html`
                                  <div>Region: ${(cred as any).aws_region}</div>
                                  <div
                                    style="margin-top: 0.25rem; font-size: 0.75rem; color: #6b7280;"
                                  >
                                    Key: ${(cred as any).aws_api_key_preview}
                                  </div>
                                `}
                          </td>
                          <td style="padding: 0.75rem; font-size: 0.875rem; color: #111827;">
                            ${cred.provider === 'anthropic'
                              ? (cred as any).oauth_expires_at &&
                                new Date((cred as any).oauth_expires_at) < new Date()
                                ? html`<span style="color: #dc2626; font-weight: 600;"
                                    >⚠️ EXPIRED</span
                                  >`
                                : html`<span style="color: #059669; font-weight: 600;"
                                    >✅ Active</span
                                  >`
                              : html`<span style="color: #059669; font-weight: 600;"
                                  >✅ Active</span
                                >`}
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
          Add New Credentials
        </h3>
        <p style="color: #6b7280; margin-bottom: 1rem;">
          Run the appropriate script to add credentials:
        </p>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div>
            <h4 style="font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem;">
              🔵 Anthropic OAuth
            </h4>
            <pre
              style="background: #1f2937; color: #f3f4f6; padding: 1rem; border-radius: 0.25rem; overflow-x: auto; font-size: 0.75rem;"
            ><code>bun run scripts/auth/oauth-login.ts</code></pre>
          </div>
          <div>
            <h4 style="font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem;">
              🟠 AWS Bedrock
            </h4>
            <pre
              style="background: #1f2937; color: #f3f4f6; padding: 1rem; border-radius: 0.25rem; overflow-x: auto; font-size: 0.75rem;"
            ><code>bun run scripts/auth/bedrock-login.ts</code></pre>
          </div>
        </div>
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
