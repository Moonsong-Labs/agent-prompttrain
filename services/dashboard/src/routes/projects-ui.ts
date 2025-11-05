import { Hono } from 'hono'
import { html, raw } from 'hono/html'
import { layout } from '../layout/index.js'
import { container } from '../container.js'
import {
  listProjectsWithAccounts,
  listTrainApiKeys,
  createProject,
  createTrainApiKey,
  setProjectDefaultAccount,
  getProjectMembers,
  addProjectMember,
  deleteProject,
  isProjectOwner,
  getProjectStats,
  getProjectWithAccounts,
  getProjectById,
  updateProject,
} from '@agent-prompttrain/shared/database/queries'
import { getErrorMessage } from '@agent-prompttrain/shared'
import type { CredentialSafe, AnthropicCredentialSafe } from '@agent-prompttrain/shared/types'
import type { AuthContext } from '../middleware/auth.js'

export const trainsUIRoutes = new Hono<{ Variables: { auth: AuthContext } }>()

/**
 * Projects management UI page - Table view
 */
trainsUIRoutes.get('/', async c => {
  const pool = container.getPool()
  const auth = c.get('auth')

  if (!pool) {
    return c.html(
      layout(
        'Projects',
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
    const projects = await listProjectsWithAccounts(pool)

    // Fetch stats and ownership for each train
    const trainData = await Promise.all(
      projects.map(async train => {
        const [stats, members, isOwner] = await Promise.all([
          getProjectStats(pool, train.id),
          getProjectMembers(pool, train.id),
          auth.isAuthenticated ? isProjectOwner(pool, train.id, auth.principal) : false,
        ])

        const firstOwner = members.find(m => m.role === 'owner')

        return {
          ...train,
          stats,
          membersCount: members.length,
          firstOwner: firstOwner?.user_email || 'Unknown',
          isOwner,
        }
      })
    )

    const content = html`
      <div style="margin-bottom: 2rem;">
        <div
          style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;"
        >
          <h2 style="font-size: 1.5rem; font-weight: bold; margin: 0;">Project Management</h2>
          <button
            onclick="document.getElementById('create-train-modal').style.display='flex'"
            style="background: #10b981; color: white; padding: 0.5rem 1.5rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer;"
          >
            + Create New Project
          </button>
        </div>

        ${trainData.length === 0
          ? html`
              <div
                style="background-color: #fef3c7; border: 1px solid #f59e0b; padding: 1rem; border-radius: 0.25rem;"
              >
                <p style="margin: 0; color: #92400e;">
                  <strong>⚠️ No projects found.</strong> Create a project to get started.
                </p>
              </div>
            `
          : html`
              <table
                style="width: 100%; background: white; border: 1px solid #e5e7eb; border-radius: 0.5rem; border-collapse: collapse; overflow: hidden;"
              >
                <thead style="background: #f9fafb; border-bottom: 2px solid #e5e7eb;">
                  <tr>
                    <th
                      style="padding: 0.75rem 1rem; text-align: left; font-size: 0.875rem; font-weight: 600; color: #374151;"
                    >
                      Project ID
                    </th>
                    <th
                      style="padding: 0.75rem 1rem; text-align: left; font-size: 0.875rem; font-weight: 600; color: #374151;"
                    >
                      Name
                    </th>
                    <th
                      style="padding: 0.75rem 1rem; text-align: center; font-size: 0.875rem; font-weight: 600; color: #374151;"
                    >
                      Status
                    </th>
                    <th
                      style="padding: 0.75rem 1rem; text-align: left; font-size: 0.875rem; font-weight: 600; color: #374151;"
                    >
                      Default Account
                    </th>
                    <th
                      style="padding: 0.75rem 1rem; text-align: left; font-size: 0.875rem; font-weight: 600; color: #374151;"
                    >
                      Owner
                    </th>
                    <th
                      style="padding: 0.75rem 1rem; text-align: center; font-size: 0.875rem; font-weight: 600; color: #374151;"
                    >
                      Members
                    </th>
                    <th
                      style="padding: 0.75rem 1rem; text-align: left; font-size: 0.875rem; font-weight: 600; color: #374151;"
                    >
                      Last Used
                    </th>
                    <th
                      style="padding: 0.75rem 1rem; text-align: center; font-size: 0.875rem; font-weight: 600; color: #374151;"
                    >
                      24h Requests
                    </th>
                    <th
                      style="padding: 0.75rem 1rem; text-align: center; font-size: 0.875rem; font-weight: 600; color: #374151;"
                    >
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  ${trainData.map(
                    train => html`
                      <tr style="border-bottom: 1px solid #e5e7eb;">
                        <td style="padding: 0.75rem 1rem;">
                          <a
                            href="/dashboard/projects/${train.project_id}/view"
                            style="color: #3b82f6; font-weight: 600; text-decoration: none; hover:text-decoration: underline;"
                          >
                            ${train.project_id}
                          </a>
                        </td>
                        <td style="padding: 0.75rem 1rem; font-size: 0.875rem;">
                          ${train.name}
                          ${train.is_private
                            ? html`<span
                                style="display: inline-flex; align-items: center; gap: 0.25rem; margin-left: 0.5rem; padding: 0.125rem 0.5rem; background: #fef3c7; color: #92400e; border-radius: 0.25rem; font-size: 0.75rem; font-weight: 600;"
                                title="Private project - only visible to members"
                              >
                                🔒 Private
                              </span>`
                            : ''}
                        </td>
                        <td style="padding: 0.75rem 1rem; text-align: center;">
                          <span
                            style="background: #10b981; color: white; padding: 0.125rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem;"
                          >
                            ACTIVE
                          </span>
                        </td>
                        <td style="padding: 0.75rem 1rem; font-size: 0.875rem;">
                          ${train.accounts.find(a => a.id === train.default_account_id)
                            ?.account_name || 'None'}
                        </td>
                        <td style="padding: 0.75rem 1rem; font-size: 0.875rem;">
                          ${train.firstOwner}
                        </td>
                        <td style="padding: 0.75rem 1rem; text-align: center; font-size: 0.875rem;">
                          ${train.membersCount}
                        </td>
                        <td style="padding: 0.75rem 1rem; font-size: 0.875rem;">
                          ${train.stats.lastUsedAt
                            ? new Date(train.stats.lastUsedAt).toLocaleString()
                            : 'Never'}
                        </td>
                        <td style="padding: 0.75rem 1rem; text-align: center; font-size: 0.875rem;">
                          ${train.stats.requestCount24h}
                        </td>
                        <td style="padding: 0.75rem 1rem; text-align: center;">
                          ${train.isOwner
                            ? html`
                                <form
                                  hx-delete="/dashboard/projects/${train.id}/delete"
                                  hx-confirm="Are you sure you want to delete '${train.project_id}'? This action cannot be undone."
                                  hx-swap="outerHTML"
                                  hx-target="closest tr"
                                  style="margin: 0;"
                                >
                                  <button
                                    type="submit"
                                    style="background: #ef4444; color: white; padding: 0.25rem 0.75rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer; font-size: 0.75rem;"
                                  >
                                    Delete
                                  </button>
                                </form>
                              `
                            : ''}
                        </td>
                      </tr>
                    `
                  )}
                </tbody>
              </table>
            `}
      </div>

      <!-- Create Project Modal -->
      <div
        id="create-train-modal"
        style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); align-items: center; justify-content: center; z-index: 1000;"
        onclick="if(event.target === this) this.style.display='none'"
      >
        <div
          style="background: white; border-radius: 0.5rem; padding: 2rem; max-width: 500px; width: 90%;"
          onclick="event.stopPropagation()"
        >
          <h3 style="font-size: 1.25rem; font-weight: bold; margin-bottom: 1.5rem;">
            Create New Project
          </h3>
          <form
            hx-post="/dashboard/projects/create"
            hx-swap="outerHTML"
            hx-target="#create-train-modal"
            style="display: grid; gap: 1rem;"
          >
            <div>
              <label
                for="project_id"
                style="display: block; font-size: 0.875rem; font-weight: 600; margin-bottom: 0.25rem; color: #374151;"
              >
                Project ID<span style="color: #dc2626;">*</span>
              </label>
              <input
                type="text"
                id="project_id"
                name="project_id"
                required
                placeholder="e.g., marketing-prod"
                style="width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.25rem; font-size: 0.875rem;"
              />
              <p style="margin: 0.25rem 0 0 0; font-size: 0.75rem; color: #6b7280;">
                Lowercase, alphanumeric, hyphens only
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

            <div style="background: #f3f4f6; padding: 0.75rem; border-radius: 0.25rem;">
              <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                <input
                  type="checkbox"
                  name="is_private"
                  value="true"
                  style="width: 1rem; height: 1rem; cursor: pointer;"
                />
                <span style="font-size: 0.875rem; font-weight: 600; color: #374151;">
                  Make this project private
                </span>
              </label>
              <p style="margin: 0.5rem 0 0 1.5rem; font-size: 0.75rem; color: #6b7280;">
                Private projects are only visible to invited members. You can manage members after
                creating the project.
              </p>
            </div>

            <div style="display: flex; gap: 1rem; justify-content: flex-end; margin-top: 0.5rem;">
              <button
                type="button"
                onclick="document.getElementById('create-train-modal').style.display='none'"
                style="background: #6b7280; color: white; padding: 0.5rem 1.5rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer;"
              >
                Cancel
              </button>
              <button
                type="submit"
                style="background: #10b981; color: white; padding: 0.5rem 1.5rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer;"
              >
                Create Project
              </button>
            </div>
          </form>
        </div>
      </div>
    `

    return c.html(
      layout(
        'Projects',
        content,
        raw(`<script>
          document.body.addEventListener('htmx:responseError', function(evt) {
            evt.target.innerHTML = '<div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">Operation failed</div>';
          });
        </script>`),
        c
      )
    )
  } catch (error) {
    return c.html(
      layout(
        'Projects - Error',
        html`
          <div class="error-banner">
            <strong>Error:</strong> Failed to load projects: ${getErrorMessage(error)}
          </div>
        `,
        '',
        c
      )
    )
  }
})

/**
 * Project detail view page
 */
trainsUIRoutes.get('/:projectId/view', async c => {
  const projectId = c.req.param('projectId')
  const pool = container.getPool()
  const auth = c.get('auth')

  if (!pool) {
    return c.html(
      layout(
        'Project Details',
        html` <div class="error-banner"><strong>Error:</strong> Database not configured.</div> `,
        '',
        c
      )
    )
  }

  try {
    const train = await getProjectWithAccounts(pool, projectId)

    if (!train) {
      return c.html(
        layout(
          'Project Not Found',
          html` <div class="error-banner"><strong>Error:</strong> Project not found</div> `,
          '',
          c
        )
      )
    }

    const isOwner = auth.isAuthenticated
      ? await isProjectOwner(pool, train.id, auth.principal)
      : false

    const content = html`
      <div style="margin-bottom: 2rem;">
        <div style="margin-bottom: 1.5rem;">
          <a
            href="/dashboard/projects"
            style="color: #3b82f6; text-decoration: none; font-size: 0.875rem;"
          >
            ← Back to Projects
          </a>
        </div>

        <div
          style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 1.5rem;"
        >
          <div>
            <h2 style="font-size: 1.5rem; font-weight: bold; margin: 0 0 0.5rem 0;">
              ${train.project_id}
              <span
                style="background: #10b981; color: white; padding: 0.125rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; margin-left: 0.5rem;"
              >
                ACTIVE
              </span>
              ${train.is_private
                ? html`<span
                    style="background: #fef3c7; color: #92400e; padding: 0.125rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; margin-left: 0.5rem;"
                    title="Private project - only visible to members"
                  >
                    🔒 Private
                  </span>`
                : ''}
            </h2>
            <p style="color: #6b7280; margin: 0; font-size: 0.875rem;">${train.name}</p>
          </div>
        </div>

        <!-- Project Information -->
        <div
          style="background: white; border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 1.5rem; margin-bottom: 1.5rem;"
        >
          <h3 style="font-size: 1.125rem; font-weight: bold; margin-bottom: 1rem;">
            Project Information
          </h3>
          <div style="display: grid; gap: 0.75rem;">
            <div>
              <div style="font-size: 0.75rem; color: #6b7280; font-weight: 600;">Project ID</div>
              <div style="font-size: 0.875rem;">${train.project_id}</div>
            </div>
            <div>
              <div style="font-size: 0.75rem; color: #6b7280; font-weight: 600;">Name</div>
              <div style="font-size: 0.875rem;">${train.name}</div>
            </div>
            <div>
              <div style="font-size: 0.75rem; color: #6b7280; font-weight: 600;">Privacy</div>
              <div style="font-size: 0.875rem;">
                ${train.is_private ? '🔒 Private' : '🌐 Public'}
              </div>
            </div>
            <div>
              <div style="font-size: 0.75rem; color: #6b7280; font-weight: 600;">Created</div>
              <div style="font-size: 0.875rem;">${new Date(train.created_at).toLocaleString()}</div>
            </div>
          </div>
        </div>

        <!-- Privacy Settings Section (Owner Only) -->
        ${isOwner
          ? html`
              <div
                style="background: white; border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 1.5rem; margin-bottom: 1.5rem;"
                id="privacy-settings"
              >
                <h3 style="font-size: 1.125rem; font-weight: bold; margin-bottom: 1rem;">
                  Privacy Settings
                </h3>
                <div style="background: #f3f4f6; padding: 1rem; border-radius: 0.25rem;">
                  <form
                    hx-post="/dashboard/projects/${train.id}/toggle-privacy"
                    hx-swap="outerHTML"
                    hx-target="#privacy-settings"
                    style="display: flex; align-items: center; justify-content: space-between;"
                  >
                    <div>
                      <div style="font-weight: 600; font-size: 0.875rem; margin-bottom: 0.25rem;">
                        Project Privacy: ${train.is_private ? '🔒 Private' : '🌐 Public'}
                      </div>
                      <div style="font-size: 0.75rem; color: #6b7280;">
                        ${train.is_private
                          ? 'Only project members can view conversations and requests from this project.'
                          : 'All authenticated users can view conversations and requests from this project.'}
                      </div>
                    </div>
                    <button
                      type="submit"
                      style="background: ${train.is_private
                        ? '#10b981'
                        : '#f59e0b'}; color: white; padding: 0.5rem 1rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer; font-size: 0.875rem;"
                      onclick="return confirm('Are you sure you want to make this project ${train.is_private
                        ? 'public'
                        : 'private'}? This will affect who can see conversations and requests.');"
                    >
                      Make ${train.is_private ? 'Public' : 'Private'}
                    </button>
                  </form>
                </div>
                ${train.is_private
                  ? html`
                      <div
                        style="background: #fef3c7; border: 1px solid #f59e0b; padding: 0.75rem; border-radius: 0.25rem; margin-top: 0.75rem;"
                      >
                        <p style="margin: 0; color: #92400e; font-size: 0.75rem;">
                          <strong>⚠️ Note:</strong> While this project is private, only members
                          listed below can view its conversations and requests. The project name and
                          member list remain visible to all authenticated users.
                        </p>
                      </div>
                    `
                  : ''}
              </div>
            `
          : ''}

        <!-- Default Account Section -->
        <div
          style="background: white; border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 1.5rem; margin-bottom: 1.5rem;"
        >
          <h3 style="font-size: 1.125rem; font-weight: bold; margin-bottom: 1rem;">
            Default Account
          </h3>
          <p style="font-size: 0.75rem; color: #6b7280; margin-bottom: 0.75rem;">
            All projects have access to all credentials. The default account is used for API calls.
          </p>

          ${!train.accounts || train.accounts.length === 0
            ? html`
                <div
                  style="background-color: #fef3c7; border: 1px solid #f59e0b; padding: 0.75rem; border-radius: 0.25rem;"
                >
                  <p style="margin: 0; color: #92400e; font-size: 0.875rem;">
                    ⚠️ No credentials available.
                  </p>
                </div>
              `
            : html`
                <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                  ${train.accounts.map(
                    (cred: CredentialSafe) => html`
                      <div
                        style="background: ${train.default_account_id === cred.id
                          ? '#eff6ff'
                          : '#f9fafb'}; border: 1px solid ${train.default_account_id === cred.id
                          ? '#3b82f6'
                          : '#e5e7eb'}; padding: 0.75rem; border-radius: 0.25rem; display: flex; justify-content: space-between; align-items: center;"
                      >
                        <div style="flex: 1;">
                          <div style="font-weight: 600; font-size: 0.875rem;">
                            ${cred.account_name}
                            ${train.default_account_id === cred.id
                              ? html`<span
                                  style="background: #3b82f6; color: white; padding: 0.125rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; margin-left: 0.5rem; font-weight: 600;"
                                  >DEFAULT</span
                                >`
                              : ''}
                          </div>
                          <div style="font-size: 0.75rem; color: #6b7280;">
                            <code
                              style="background: white; padding: 0.125rem 0.25rem; border-radius: 0.125rem;"
                              >${cred.account_id}</code
                            >
                            ${cred.provider === 'anthropic'
                              ? html`
                                  • Expires:
                                  ${new Date(
                                    (cred as AnthropicCredentialSafe).oauth_expires_at
                                  ).toLocaleDateString()}
                                  ${new Date((cred as AnthropicCredentialSafe).oauth_expires_at) <
                                  new Date()
                                    ? html`<span style="color: #dc2626; font-weight: 600;"
                                        >⚠️ EXPIRED</span
                                      >`
                                    : ''}
                                `
                              : html`• Region: ${(cred as any).aws_region}`}
                          </div>
                        </div>
                        ${isOwner && train.default_account_id !== cred.id
                          ? html`
                              <form
                                hx-post="/dashboard/projects/${train.id}/set-default-account"
                                hx-swap="outerHTML"
                                hx-target="closest div[style*='margin-bottom: 1.5rem']"
                                style="margin: 0;"
                              >
                                <input type="hidden" name="credential_id" value="${cred.id}" />
                                <button
                                  type="submit"
                                  style="background: #3b82f6; color: white; padding: 0.25rem 0.75rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer; font-size: 0.75rem;"
                                >
                                  Set as Default
                                </button>
                              </form>
                            `
                          : ''}
                      </div>
                    `
                  )}
                </div>
              `}
        </div>

        <!-- Members Section -->
        <div
          style="background: white; border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 1.5rem; margin-bottom: 1.5rem;"
        >
          <h3 style="font-size: 1.125rem; font-weight: bold; margin-bottom: 1rem;">Members</h3>

          ${isOwner
            ? html`
                <form
                  hx-post="/dashboard/projects/${train.id}/add-member"
                  hx-swap="beforebegin"
                  style="margin-bottom: 1rem; display: flex; gap: 0.5rem; align-items: end;"
                >
                  <div style="flex: 1;">
                    <label
                      for="member-email-${train.id}"
                      style="display: block; font-size: 0.75rem; font-weight: 600; margin-bottom: 0.25rem; color: #374151;"
                    >
                      Email Address
                    </label>
                    <input
                      type="email"
                      id="member-email-${train.id}"
                      name="user_email"
                      required
                      placeholder="e.g., user@example.com"
                      style="width: 100%; padding: 0.375rem; border: 1px solid #d1d5db; border-radius: 0.25rem; font-size: 0.875rem;"
                    />
                  </div>
                  <div style="width: 150px;">
                    <label
                      for="member-role-${train.id}"
                      style="display: block; font-size: 0.75rem; font-weight: 600; margin-bottom: 0.25rem; color: #374151;"
                    >
                      Role
                    </label>
                    <select
                      id="member-role-${train.id}"
                      name="role"
                      required
                      style="width: 100%; padding: 0.375rem; border: 1px solid #d1d5db; border-radius: 0.25rem; font-size: 0.875rem;"
                    >
                      <option value="member">Member</option>
                      <option value="owner">Owner</option>
                    </select>
                  </div>
                  <button
                    type="submit"
                    style="background: #10b981; color: white; padding: 0.375rem 1rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer; font-size: 0.875rem;"
                  >
                    Add Member
                  </button>
                </form>
              `
            : ''}

          <div
            id="members-${train.id}"
            hx-get="/dashboard/projects/${train.id}/members-list"
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
        <div
          style="background: white; border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 1.5rem;"
        >
          <h3 style="font-size: 1.125rem; font-weight: bold; margin-bottom: 1rem;">API Keys</h3>

          ${isOwner
            ? html`
                <form
                  hx-post="/dashboard/projects/${train.id}/generate-api-key"
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
              `
            : ''}

          <div
            id="api-keys-${train.id}"
            hx-get="/dashboard/projects/${train.id}/api-keys-list"
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
      </div>
    `

    return c.html(
      layout(
        `Project: ${train.project_id}`,
        content,
        raw(`<script>
          document.body.addEventListener('htmx:responseError', function(evt) {
            evt.target.innerHTML = '<div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">Failed to load</div>';
          });
        </script>`),
        c
      )
    )
  } catch (error) {
    return c.html(
      layout(
        'Project Error',
        html`
          <div class="error-banner">
            <strong>Error:</strong> Failed to load train: ${getErrorMessage(error)}
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
trainsUIRoutes.get('/:projectId/api-keys-list', async c => {
  const projectId = c.req.param('projectId')
  const pool = container.getPool()

  if (!pool) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        Database not configured
      </div>
    `)
  }

  try {
    const apiKeys = await listTrainApiKeys(pool, projectId)

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
                Owner: ${key.created_by || 'Unknown'} • Created:
                ${new Date(key.created_at).toLocaleString()}
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
trainsUIRoutes.get('/:projectId/members-list', async c => {
  const projectId = c.req.param('projectId')
  const pool = container.getPool()

  if (!pool) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        Database not configured
      </div>
    `)
  }

  try {
    const members = await getProjectMembers(pool, projectId)

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
 * Generate a new API key for a project (HTMX form submission - owner only)
 */
trainsUIRoutes.post('/:projectId/generate-api-key', async c => {
  const projectId = c.req.param('projectId')
  const pool = container.getPool()
  const auth = c.get('auth')

  if (!pool) {
    return c.html(html`
      <div
        style="background: #fee2e2; color: #991b1b; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
      >
        <strong>Error:</strong> Database not configured
      </div>
    `)
  }

  // Check authentication
  if (!auth.isAuthenticated) {
    return c.html(html`
      <div
        style="background: #fee2e2; color: #991b1b; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
      >
        <strong>Error:</strong> Unauthorized - please log in
      </div>
    `)
  }

  // Check ownership
  const isOwner = await isProjectOwner(pool, projectId, auth.principal)
  if (!isOwner) {
    return c.html(html`
      <div
        style="background: #fee2e2; color: #991b1b; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
      >
        <strong>Error:</strong> Only train owners can generate API keys
      </div>
    `)
  }

  try {
    const formData = await c.req.parseBody()
    const name = (formData.name as string) || undefined

    const generatedKey = await createTrainApiKey(pool, projectId, {
      name,
      created_by: auth.principal,
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
          data-api-key="${generatedKey.api_key}"
          onclick="navigator.clipboard.writeText(this.getAttribute('data-api-key')); this.textContent='✅ Copied!'; setTimeout(() => this.textContent='Copy to Clipboard', 2000)"
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
      <script>
        setTimeout(() => location.reload(), 10000)
      </script>
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
 * Set default account for a project (HTMX form submission - owner only)
 */
trainsUIRoutes.post('/:projectId/set-default-account', async c => {
  const projectId = c.req.param('projectId')
  const pool = container.getPool()
  const auth = c.get('auth')

  if (!pool) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        Database not configured
      </div>
    `)
  }

  // Check authentication
  if (!auth.isAuthenticated) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        <strong>Error:</strong> Unauthorized - please log in
      </div>
    `)
  }

  // Check ownership
  const isOwner = await isProjectOwner(pool, projectId, auth.principal)
  if (!isOwner) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        <strong>Error:</strong> Only train owners can change the default account
      </div>
    `)
  }

  try {
    const formData = await c.req.parseBody()
    const credentialId = formData.credential_id as string

    await setProjectDefaultAccount(pool, projectId, credentialId)

    // Reload the credentials section
    return c.html(html`
      <div
        style="background: #d1fae5; color: #065f46; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
      >
        <strong>✅ Success!</strong> Default account updated.
      </div>
      <script>
        setTimeout(() => location.reload(), 1500)
      </script>
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
 * Delete a project (HTMX form submission - owner only)
 */
trainsUIRoutes.delete('/:projectId/delete', async c => {
  const projectId = c.req.param('projectId')
  const pool = container.getPool()
  const auth = c.get('auth')

  if (!pool) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        Database not configured
      </div>
    `)
  }

  // Check authentication
  if (!auth.isAuthenticated) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        <strong>Error:</strong> Unauthorized - please log in
      </div>
    `)
  }

  try {
    // Check ownership
    const isOwner = await isProjectOwner(pool, projectId, auth.principal)
    if (!isOwner) {
      return c.html(html`
        <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
          <strong>Error:</strong> Only train owners can delete projects
        </div>
      `)
    }

    const success = await deleteProject(pool, projectId)

    if (!success) {
      return c.html(html`
        <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
          Project not found
        </div>
      `)
    }

    // Return empty HTML to remove the project row via HTMX swap
    return c.html(html``)
  } catch (error) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        Error: ${getErrorMessage(error)}
      </div>
    `)
  }
})

/**
 * Add a member to a project (HTMX form submission - owner only)
 */
trainsUIRoutes.post('/:projectId/add-member', async c => {
  const projectId = c.req.param('projectId')
  const pool = container.getPool()
  const auth = c.get('auth')

  if (!pool) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        Database not configured
      </div>
    `)
  }

  // Check authentication
  if (!auth.isAuthenticated) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        <strong>Error:</strong> Unauthorized - please log in
      </div>
    `)
  }

  // Check ownership
  const isOwner = await isProjectOwner(pool, projectId, auth.principal)
  if (!isOwner) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        <strong>Error:</strong> Only train owners can add members
      </div>
    `)
  }

  try {
    const formData = await c.req.parseBody()
    const userEmail = formData.user_email as string
    const role = formData.role as 'owner' | 'member'

    await addProjectMember(pool, projectId, userEmail, role, auth.principal)

    return c.html(html`
      <div
        style="background: #d1fae5; color: #065f46; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
      >
        <strong>✅ Success!</strong> Member ${userEmail} added as ${role}.
      </div>
      <script>
        setTimeout(() => location.reload(), 1500)
      </script>
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
    const projectId = formData.project_id as string
    const name = formData.name as string
    const isPrivate = formData.is_private === 'true'

    // Validate train ID format
    if (!/^[a-z0-9-]+$/.test(projectId)) {
      client.release()
      return c.html(html`
        <div
          style="background: #fee2e2; color: #991b1b; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
        >
          <strong>Error:</strong> Project ID must be lowercase alphanumeric with hyphens only
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
      const train = await createProject(client as any, {
        project_id: projectId,
        name: name,
        is_private: isPrivate,
      })

      // Add the creator as an owner
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await addProjectMember(client as any, train.id, auth.principal, 'owner', auth.principal)

      await client.query('COMMIT')

      return c.html(html`
        <div
          style="background: #d1fae5; color: #065f46; padding: 1rem; border-radius: 0.25rem; margin-bottom: 1rem;"
        >
          <strong>✅ Success!</strong> Project "${train.project_id}" created successfully.
        </div>
        <script>
          setTimeout(() => location.reload(), 1500)
        </script>
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
      <script>
        setTimeout(() => location.reload(), 2000)
      </script>
    `)
  } finally {
    client.release()
  }
})

/**
 * Toggle project privacy (HTMX form submission - owner only)
 */
trainsUIRoutes.post('/:projectId/toggle-privacy', async c => {
  const projectId = c.req.param('projectId')
  const pool = container.getPool()
  const auth = c.get('auth')

  if (!pool) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        Database not configured
      </div>
    `)
  }

  // Check authentication
  if (!auth.isAuthenticated) {
    return c.html(html`
      <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
        <strong>Error:</strong> Unauthorized - please log in
      </div>
    `)
  }

  try {
    // Check ownership
    const isOwner = await isProjectOwner(pool, projectId, auth.principal)
    if (!isOwner) {
      return c.html(html`
        <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
          <strong>Error:</strong> Only project owners can change privacy settings
        </div>
      `)
    }

    // Get current project state using the numeric ID
    const project = await getProjectById(pool, projectId)
    if (!project) {
      return c.html(html`
        <div style="background: #fee2e2; color: #991b1b; padding: 0.75rem; border-radius: 0.25rem;">
          Project not found
        </div>
      `)
    }

    // Toggle privacy
    const newPrivacySetting = !project.is_private
    await updateProject(pool, projectId, { is_private: newPrivacySetting })

    // Return updated privacy settings section
    return c.html(html`
      <div
        style="background: white; border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 1.5rem; margin-bottom: 1.5rem;"
        id="privacy-settings"
      >
        <h3 style="font-size: 1.125rem; font-weight: bold; margin-bottom: 1rem;">
          Privacy Settings
        </h3>
        <div style="background: #f3f4f6; padding: 1rem; border-radius: 0.25rem;">
          <form
            hx-post="/dashboard/projects/${projectId}/toggle-privacy"
            hx-swap="outerHTML"
            hx-target="#privacy-settings"
            style="display: flex; align-items: center; justify-content: space-between;"
          >
            <div>
              <div style="font-weight: 600; font-size: 0.875rem; margin-bottom: 0.25rem;">
                Project Privacy: ${newPrivacySetting ? '🔒 Private' : '🌐 Public'}
              </div>
              <div style="font-size: 0.75rem; color: #6b7280;">
                ${newPrivacySetting
                  ? 'Only project members can view conversations and requests from this project.'
                  : 'All authenticated users can view conversations and requests from this project.'}
              </div>
            </div>
            <button
              type="submit"
              style="background: ${newPrivacySetting
                ? '#10b981'
                : '#f59e0b'}; color: white; padding: 0.5rem 1rem; border-radius: 0.25rem; font-weight: 600; border: none; cursor: pointer; font-size: 0.875rem;"
              onclick="return confirm('Are you sure you want to make this project ${newPrivacySetting
                ? 'public'
                : 'private'}? This will affect who can see conversations and requests.');"
            >
              Make ${newPrivacySetting ? 'Public' : 'Private'}
            </button>
          </form>
        </div>
        ${newPrivacySetting
          ? html`
              <div
                style="background: #fef3c7; border: 1px solid #f59e0b; padding: 0.75rem; border-radius: 0.25rem; margin-top: 0.75rem;"
              >
                <p style="margin: 0; color: #92400e; font-size: 0.75rem;">
                  <strong>⚠️ Note:</strong> While this project is private, only members listed below
                  can view its conversations and requests. The project name and member list remain
                  visible to all authenticated users.
                </p>
              </div>
            `
          : ''}
        <div
          style="background: #d1fae5; color: #065f46; padding: 0.75rem; border-radius: 0.25rem; margin-top: 0.75rem;"
        >
          <strong>✅ Success!</strong> Project privacy has been updated to
          ${newPrivacySetting ? 'Private' : 'Public'}.
        </div>
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
