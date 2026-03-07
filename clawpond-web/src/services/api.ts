import axios from 'axios'
import type { Room, RoomMember, Message, AgentInfo } from '../types'

const BASE_URL = import.meta.env.VITE_API_URL ?? ''

const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json' },
})

// ─── Rooms ───────────────────────────────────────────────────────────────────

export interface CreateRoomParams {
  name: string
  description?: string
  password: string
  max_members?: number
  allow_anonymous?: boolean
}

export interface JoinRoomParams {
  user_id: string
  username: string
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

export async function createRoom(params: CreateRoomParams, creator_id: string, creator_username: string) {
  const res = await api.post<Room>(`/api/v1/rooms`, {
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

export async function joinRoom(room_id: string, params: JoinRoomParams) {
  const res = await api.post<RoomMember>(`/api/v1/rooms/${room_id}/join`, params)
  return res.data
}

export async function leaveRoom(room_id: string, user_id: string) {
  const res = await api.post(`/api/v1/rooms/${room_id}/leave`, { user_id })
  return res.data
}

export async function getRoomMembers(room_id: string) {
  const res = await api.get<RoomMember[]>(`/api/v1/rooms/${room_id}/members`)
  return res.data
}

// ─── Messages ────────────────────────────────────────────────────────────────

export async function getMessages(room_id: string, limit = 50, start_message_id?: number) {
  const res = await api.get<{ messages: Message[]; total: number; room_id: string }>(
    `/api/v1/rooms/${room_id}/messages`,
    { params: { limit, start_message_id } },
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

export async function registerAgent(params: {
  name: string
  endpoint: string
  room_id: string
  room_password: string
  description?: string
  skills?: string[]
}) {
  const res = await api.post(`/api/v1/agents/register`, params)
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
