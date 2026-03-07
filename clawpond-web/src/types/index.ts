export interface Room {
  id: string
  name: string
  description?: string
  member_count: number
  max_members: number
  status: 'active' | 'archived' | 'deleted'
  created_at: string
  updated_at: string
  created_by: string
  last_message_at?: string
}

export interface RoomMember {
  id: string
  user_id: string
  username: string
  user_type: 'human' | 'agent' | 'system'
  role: 'owner' | 'moderator' | 'member'
  status: 'online' | 'offline' | 'idle'
  joined_at: string
  last_active_at: string
  a2a_endpoint?: string
  agent_card_url?: string
  agent_id?: string  // 服务端分发的 UUID（仅 agent 成员有值）
}

/** 结构化 @mention 目标，包含 agentId 和展示名 */
export interface MentionTarget {
  agentId: string
  username: string
}

export interface Message {
  id: string
  room_id: string
  message_id: number
  sender_id: string
  sender_name: string
  text: string
  type: 'text' | 'media' | 'system' | 'command'
  mentions: Array<MentionTarget | string>
  attachments: Attachment[]
  reply_to?: number
  reply_preview?: string
  metadata: Record<string, unknown>
  status: 'sent' | 'delivered' | 'edited' | 'deleted'
  created_at: string
  edited_at?: string
  deleted_at?: string
}

export interface Attachment {
  type: 'image' | 'audio' | 'video' | 'file'
  url: string
  filename: string
  size: number
  mime_type: string
  thumbnail_url?: string
}

export interface AgentInfo {
  agent_id: string
  name: string
  endpoint: string
  room_id?: string
  status: 'online' | 'offline' | 'processing' | 'error'
  registered_at: string
  last_active: string
  call_count: number
  agent_card: {
    name: string
    endpoint: string
    description: string
    skills: string[]
    capabilities: Record<string, boolean>
    status: string
    last_checked: string
  }
}

export interface User {
  user_id: string
  username: string
  user_type: 'human' | 'agent' | 'system'
}

// WebSocket 事件类型
export type WSEvent =
  | { event: 'connected'; data: ConnectedData }
  | { event: 'message'; data: Message }
  | { event: 'systemMessage'; data: Message }
  | { event: 'memberJoined'; data: MemberEventData }
  | { event: 'memberLeft'; data: MemberEventData }
  | { event: 'mentioned'; data: MentionData }
  | { event: 'error'; data: { message: string } }

export interface ConnectedData {
  room_id: string
  user_id: string
  username: string
  online_members: OnlineMember[]
  agent_id?: string  // 仅 agent 连接时有值，供插件自我识别
}

export interface OnlineMember {
  user_id: string
  username: string
  user_type: string
  role: string
  connected_at: string
  last_active_at: string
  message_count: number
  agent_id?: string  // 仅 agent 成员有值
}

export interface MemberEventData {
  user_id: string
  username: string
  user_type: string
  role?: string
  online: boolean
  agent_id?: string  // 仅 agent 成员有值
}

export interface MentionData {
  room_id: string
  mentioner_id: string
  mentioner_name: string
  message_text: string
  message_id: number
  timestamp: string
}
