import { useState, useCallback, useRef } from 'react'
import { ChatWebSocket } from '../services/websocket'
import { joinRoom as apiJoinRoom, leaveRoom as apiLeaveRoom } from '../services/api'
import type { Message, WSEvent, OnlineMember, MentionTarget } from '../types'

// 颜色色板，循环分配给各模拟用户
const AGENT_COLORS = [
  '#22c55e', // green
  '#3b82f6', // blue
  '#f59e0b', // amber
  '#ef4444', // red
  '#a855f7', // purple
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#f97316', // orange
]

export type AgentStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'

export interface SimulatedAgent {
  localId: string
  userId: string
  username: string
  userType: 'human' | 'agent'
  color: string
  /** 仅用于 UI 展示（房间名查找） */
  roomId: string | null
  /** 用于 WS 连接和离开操作的 access_token */
  roomPassword: string | null
  status: AgentStatus
  inputText: string
  agentId?: string  // 加入房间后由后端分配
}

export interface FeedMessage extends Message {
  agentColor: string
  agentLocalId: string
}

export interface FeedEvent {
  id: string
  type: 'memberJoined' | 'memberLeft' | 'error' | 'system'
  text: string
  timestamp: string
  agentColor?: string
}

type FeedItem =
  | { kind: 'message'; data: FeedMessage }
  | { kind: 'event'; data: FeedEvent }

let colorIndex = 0

function nextColor(): string {
  const c = AGENT_COLORS[colorIndex % AGENT_COLORS.length]
  colorIndex++
  return c
}

function generateUserId(): string {
  return 'sim-' + Math.random().toString(36).slice(2, 10)
}

function generateLocalId(): string {
  return 'agent-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

export function useSimulatedAgents() {
  const [agents, setAgents] = useState<SimulatedAgent[]>([])
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [onlineMembers, setOnlineMembers] = useState<OnlineMember[]>([])

  // 保存 WS 客户端引用，不放进 state 以避免不必要的重渲染
  const wsClientsRef = useRef<Map<string, ChatWebSocket>>(new Map())
  // 已知消息 id，用于去重
  const knownMessageIds = useRef<Set<string>>(new Set())

  const pushMessage = useCallback((msg: Message, agentColor: string, agentLocalId: string) => {
    if (knownMessageIds.current.has(msg.id)) return
    knownMessageIds.current.add(msg.id)
    setFeed((prev) => [
      ...prev,
      { kind: 'message', data: { ...msg, agentColor, agentLocalId } },
    ])
  }, [])

  const pushEvent = useCallback((evt: FeedEvent) => {
    setFeed((prev) => [...prev, { kind: 'event', data: evt }])
  }, [])

  const updateAgentStatus = useCallback((
    localId: string,
    status: AgentStatus,
    roomId?: string | null,
    roomPassword?: string | null,
  ) => {
    setAgents((prev) =>
      prev.map((a) =>
        a.localId === localId
          ? {
              ...a,
              status,
              ...(roomId !== undefined ? { roomId } : {}),
              ...(roomPassword !== undefined ? { roomPassword } : {}),
            }
          : a,
      ),
    )
  }, [])

  const updateAgentId = useCallback((localId: string, agentId: string) => {
    setAgents((prev) =>
      prev.map((a) => (a.localId === localId ? { ...a, agentId } : a)),
    )
  }, [])

  const addAgent = useCallback((username: string, userType: 'human' | 'agent') => {
    const newAgent: SimulatedAgent = {
      localId: generateLocalId(),
      userId: generateUserId(),
      username: username.trim() || `${userType === 'agent' ? 'Agent' : 'User'}${agents.length + 1}`,
      userType,
      color: nextColor(),
      roomId: null,
      roomPassword: null,
      status: 'idle',
      inputText: '',
    }
    setAgents((prev) => [...prev, newAgent])
    return newAgent.localId
  }, [agents.length])

  const removeAgent = useCallback((localId: string) => {
    const ws = wsClientsRef.current.get(localId)
    if (ws) {
      ws.disconnect()
      wsClientsRef.current.delete(localId)
    }
    setAgents((prev) => prev.filter((a) => a.localId !== localId))
  }, [])

  const joinRoom = useCallback(async (localId: string, roomId: string, password: string) => {
    const agent = agents.find((a) => a.localId === localId)
    if (!agent) return

    // 先断开旧连接（如有）
    const oldWs = wsClientsRef.current.get(localId)
    if (oldWs) {
      oldWs.disconnect()
      wsClientsRef.current.delete(localId)
    }

    updateAgentStatus(localId, 'connecting', roomId, password)

    try {
      await apiJoinRoom({
        user_id: agent.userId,
        username: agent.username,
        password,
        user_type: agent.userType,
      })
    } catch (err) {
      console.error(`[DebugLab] ${agent.username} 加入房间失败`, err)
      updateAgentStatus(localId, 'error')
      pushEvent({
        id: crypto.randomUUID(),
        type: 'error',
        text: `${agent.username} 加入房间失败: ${(err as Error).message ?? '未知错误'}`,
        timestamp: new Date().toISOString(),
        agentColor: agent.color,
      })
      return
    }

    const ws = new ChatWebSocket(password, agent.userId, agent.username, agent.userType)

    ws.onStatus((status) => {
      if (status === 'connected') {
        updateAgentStatus(localId, 'connected', roomId)
      } else if (status === 'disconnected') {
        updateAgentStatus(localId, 'disconnected')
      } else if (status === 'error') {
        updateAgentStatus(localId, 'error')
      }
    })

    ws.onEvent((event: WSEvent) => {
      if ('event' in event) {
        switch (event.event) {
          case 'connected':
            setOnlineMembers(event.data.online_members)
            if (event.data.agent_id) {
              updateAgentId(localId, event.data.agent_id)
            }
            break
          case 'message':
          case 'systemMessage':
            pushMessage(event.data, agent.color, localId)
            break
          case 'memberJoined':
            setOnlineMembers((prev) => {
              if (prev.some((m) => m.user_id === event.data.user_id)) return prev
              return [
                ...prev,
                {
                  user_id: event.data.user_id,
                  username: event.data.username,
                  user_type: event.data.user_type,
                  role: event.data.role ?? 'member',
                  connected_at: new Date().toISOString(),
                  last_active_at: new Date().toISOString(),
                  message_count: 0,
                  agent_id: event.data.agent_id,
                },
              ]
            })
            pushEvent({
              id: crypto.randomUUID(),
              type: 'memberJoined',
              text: `${event.data.username} 加入了房间`,
              timestamp: new Date().toISOString(),
              agentColor: agent.color,
            })
            break
          case 'memberLeft':
            setOnlineMembers((prev) => prev.filter((m) => m.user_id !== event.data.user_id))
            pushEvent({
              id: crypto.randomUUID(),
              type: 'memberLeft',
              text: `${event.data.username} 离开了房间`,
              timestamp: new Date().toISOString(),
              agentColor: agent.color,
            })
            break
          case 'error':
            pushEvent({
              id: crypto.randomUUID(),
              type: 'error',
              text: `错误: ${event.data.message}`,
              timestamp: new Date().toISOString(),
              agentColor: agent.color,
            })
            break
        }
      }
    })

    ws.connect()
    wsClientsRef.current.set(localId, ws)
  }, [agents, updateAgentStatus, updateAgentId, pushMessage, pushEvent])

  const leaveRoom = useCallback(async (localId: string) => {
    const agent = agents.find((a) => a.localId === localId)
    if (!agent || !agent.roomPassword) return

    const ws = wsClientsRef.current.get(localId)
    if (ws) {
      ws.disconnect()
      wsClientsRef.current.delete(localId)
    }

    try {
      await apiLeaveRoom(agent.roomPassword, agent.userId)
    } catch (err) {
      console.warn(`[DebugLab] ${agent.username} 离开房间时出错`, err)
    }

    updateAgentStatus(localId, 'idle', null, null)
  }, [agents, updateAgentStatus])

  const sendMessage = useCallback((localId: string, text: string, mentions: MentionTarget[] = []) => {
    const ws = wsClientsRef.current.get(localId)
    if (!ws || !ws.isConnected) return
    ws.sendMessage(text.trim(), mentions)
    setAgents((prev) =>
      prev.map((a) => (a.localId === localId ? { ...a, inputText: '' } : a)),
    )
  }, [])

  const setInputText = useCallback((localId: string, text: string) => {
    setAgents((prev) =>
      prev.map((a) => (a.localId === localId ? { ...a, inputText: text } : a)),
    )
  }, [])

  const clearFeed = useCallback(() => {
    setFeed([])
    knownMessageIds.current.clear()
  }, [])

  const refreshOnlineMembers = useCallback(async () => {
    // 从第一个已连接的 agent 获取在线成员列表
    for (const agent of agents) {
      if (agent.status === 'connected') {
        const ws = wsClientsRef.current.get(agent.localId)
        if (ws) {
          const members = await ws.getOnlineMembers()
          setOnlineMembers(members)
          return
        }
      }
    }
  }, [agents])

  return {
    agents,
    feed,
    onlineMembers,
    addAgent,
    removeAgent,
    joinRoom,
    leaveRoom,
    sendMessage,
    setInputText,
    clearFeed,
    refreshOnlineMembers,
  }
}
