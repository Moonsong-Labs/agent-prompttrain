/**
 * Database models for train membership and ownership
 */

export type TrainMemberRole = 'owner' | 'member'

export interface TrainMember {
  id: string
  train_id: string
  user_email: string
  role: TrainMemberRole
  added_at: Date
  added_by: string
}

export interface TrainWithMembers {
  id: string
  train_id: string
  name: string
  description: string | null
  slack_enabled: boolean
  slack_webhook_url: string | null
  slack_channel: string | null
  slack_username: string | null
  slack_icon_emoji: string | null
  created_at: Date
  updated_at: Date
  members: TrainMember[]
}

export interface AddTrainMemberRequest {
  user_email: string
  role: TrainMemberRole
}

export interface UpdateTrainMemberRequest {
  role: TrainMemberRole
}
