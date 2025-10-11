/**
 * Authentication and authorization utilities
 */

/**
 * Normalize email address for consistent comparison
 * - Converts to lowercase
 * - Trims whitespace
 * @param email - Email address to normalize
 * @returns Normalized email address
 */
export function normalizeEmail(email: string | undefined | null): string | null {
  if (!email) {
    return null
  }
  return email.trim().toLowerCase()
}

/**
 * Validate that a string is a valid PostgreSQL parameter placeholder
 * @param param - The parameter string to validate (e.g., '$1', '$2')
 * @throws Error if the parameter is not a valid placeholder
 */
function assertPgPlaceholder(param: string): void {
  if (!/^\$\d+$/.test(param)) {
    throw new Error(`Invalid SQL parameter placeholder: ${param}. Expected format: $1, $2, etc.`)
  }
}

/**
 * SQL fragment for project privacy filtering
 * This returns a WHERE clause fragment that filters projects based on privacy settings
 *
 * @param projectAlias - The alias used for the projects table in the query (default: 'p')
 * @param memberAlias - The alias to use for project_members table (default: 'pm')
 * @returns SQL WHERE clause fragment
 *
 * @example
 * const query = `
 *   SELECT * FROM conversations c
 *   JOIN projects p ON c.project_id = p.id
 *   LEFT JOIN project_members pm ON p.id = pm.project_id AND pm.user_email = $1
 *   WHERE ${getProjectPrivacyFilter()}
 * `;
 */
export function getProjectPrivacyFilter(projectAlias = 'p', memberAlias = 'pm'): string {
  return `(${projectAlias}.is_private = false OR ${memberAlias}.user_email IS NOT NULL)`
}

/**
 * SQL fragment for joining project_members table for privacy checks
 *
 * @param userEmailParam - The SQL parameter placeholder for user email (e.g., '$3')
 * @param projectAlias - The alias used for the projects table (default: 'p')
 * @param memberAlias - The alias to use for project_members table (default: 'pm')
 * @returns SQL JOIN fragment
 *
 * @example
 * const query = `
 *   SELECT * FROM conversations c
 *   JOIN projects p ON c.project_id = p.id
 *   ${getProjectMemberJoin('$1')}
 *   WHERE ${getProjectPrivacyFilter()}
 * `;
 */
export function getProjectMemberJoin(
  userEmailParam: string,
  projectAlias = 'p',
  memberAlias = 'pm'
): string {
  // Validate the parameter placeholder to prevent SQL injection
  assertPgPlaceholder(userEmailParam)
  return `LEFT JOIN project_members ${memberAlias} ON ${projectAlias}.id = ${memberAlias}.project_id AND ${memberAlias}.user_email = ${userEmailParam}`
}
