import axios from 'axios'
import type { Room, RoomMember, Message, AgentInfo } from '../types'

const BASE_URL = import.meta.env.VITE_API_URL ?? ''

const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('cp_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('cp_token')
      localStorage.removeItem('cp_user_id')
      localStorage.removeItem('cp_username')
      window.location.reload()
    }
    return Promise.reject(error)
  },
)

// ─── Rooms ───────────────────────────────────────────────────────────────────

/** 创建房间响应 — plain_password 为一次性明文密码，仅此次返回 */
export interface RoomCreateResponse extends Room {
  plain_password: string
}

export interface CreateRoomParams {
  name: string
  description?: string
  max_members?: number
  allow_anonymous?: boolean
}

export interface JoinRoomParams {
  room_id?: string
  user_id: string
  username: string
  /** access_token，由创建房间时服务端生成并一次性返回的 plain_password */
  password: string
  user_type?: 'human' | 'agent' | 'system'
  a2a_endpoint?: string
}

export async function listRooms(page = 1, page_size = 20) {
  const res = await api.get<{ rooms: Room[]; total: number; page: number; page_size: number }>(
    `/api/v1/rooms`,
    { params: { page, page_size } },
  )
  return res.data
}

/**
 * 创建房间 — 无需传入密码，服务端自动生成。
 * 响应中的 `plain_password` 为一次性明文密码，请妥善保存。
 */
export async function createRoom(
  params: CreateRoomParams,
  creator_id: string,
  creator_username: string,
): Promise<RoomCreateResponse> {
  const res = await api.post<RoomCreateResponse>(`/api/v1/rooms`, {
    ...params,
    user_id: creator_id,
    username: creator_username,
  })
  return res.data
}

export async function getRoom(room_id: string) {
  const res = await api.get<Room>(`/api/v1/rooms/${room_id}`)
  return res.data
}

/**
 * 加入房间 — 通过 password（access_token）定位房间，无需 room_id。
 */
export async function joinRoom(params: JoinRoomParams) {
  const res = await api.post<RoomMember>(`/api/v1/rooms/join`, params)
  return res.data
}

/**
 * 离开房间 — 通过 password（access_token）定位房间，无需 room_id。
 */
export async function leaveRoom(password: string, user_id: string) {
  const res = await api.post(`/api/v1/rooms/leave`, { password, user_id })
  return res.data
}

/**
 * 获取房间成员 — 通过 password（access_token）定位房间，改为 POST。
 */
export async function getRoomMembers(password: string) {
  const res = await api.post<RoomMember[]>(`/api/v1/rooms/members`, { password })
  return res.data
}

// ─── Messages ────────────────────────────────────────────────────────────────

/**
 * 获取房间消息历史 — 通过 password（access_token）定位房间。
 */
export async function getMessages(password: string, limit = 50, start_message_id?: number) {
  const params: { password: string; limit: number; start_message_id?: number } = {
    password,
    limit,
  }
  if (start_message_id != null) {
    params.start_message_id = start_message_id
  }
  const res = await api.get<{ messages: Message[]; total: number; room_id: string }>(
    `/api/v1/rooms/messages`,
    { params },
  )
  return res.data
}

// ─── Agents ──────────────────────────────────────────────────────────────────

export async function listAgents(room_id?: string) {
  const res = await api.get<{ agents: AgentInfo[]; total: number }>(`/api/v1/agents`, {
    params: room_id ? { room_id } : {},
  })
  return res.data
}

/** Agent 注册响应 — agent_secret 仅此次明文返回 */
export interface AgentRegisterResponse {
  agent_id: string
  agent_secret: string
  name: string
  message: string
}

/** 注册新 Agent（仅获取身份凭据，不加入房间） */
export async function registerAgent(params: {
  name: string
  endpoint?: string
  description?: string
  skills?: string[]
}): Promise<AgentRegisterResponse> {
  const res = await api.post<AgentRegisterResponse>(`/api/v1/agents/register`, params)
  return res.data
}

/** Agent 加入房间响应 */
export interface AgentJoinResponse {
  agent_id: string
  user_id: string
  username: string
  room_id: string
  message: string
}

/** Agent 凭 agent_id + agent_secret + room_password 加入房间 */
export async function agentJoinRoom(params: {
  agent_id: string
  agent_secret: string
  room_id: string
  room_password: string
}): Promise<AgentJoinResponse> {
  const res = await api.post<AgentJoinResponse>(`/api/v1/agents/join`, params)
  return res.data
}

export async function unregisterAgent(agent_id: string) {
  const res = await api.delete(`/api/v1/agents/${agent_id}`)
  return res.data
}

export async function pingAgent(agent_id: string) {
  const res = await api.post(`/api/v1/agents/${agent_id}/ping`)
  return res.data
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface AuthResponse {
  access_token: string
  token_type: string
  user_id: string
  username: string
}

export async function register(username: string, password: string): Promise<AuthResponse> {
  const res = await api.post<AuthResponse>('/api/v1/auth/register', { username, password })
  return res.data
}

export async function login(username: string, password: string): Promise<AuthResponse> {
  const res = await api.post<AuthResponse>('/api/v1/auth/login', { username, password })
  return res.data
}

export async function getMe() {
  const res = await api.get('/api/v1/auth/me')
  return res.data
}
