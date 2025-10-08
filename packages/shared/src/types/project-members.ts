/**
 * Database models for project membership and ownership
 */

export type ProjectMemberRole = 'owner' | 'member'

export interface ProjectMember {
  id: string
  project_id: string
  user_email: string
  role: ProjectMemberRole
  added_at: Date
  added_by: string
}

export interface ProjectWithMembers {
  id: string
  project_id: string
  name: string
  description: string | null
  slack_enabled: boolean
  slack_webhook_url: string | null
  slack_channel: string | null
  slack_username: string | null
  slack_icon_emoji: string | null
  created_at: Date
  updated_at: Date
  members: ProjectMember[]
}

export interface AddProjectMemberRequest {
  user_email: string
  role: ProjectMemberRole
}

export interface UpdateProjectMemberRequest {
  role: ProjectMemberRole
}
