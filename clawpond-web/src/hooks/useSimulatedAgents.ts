import { useState, useCallback, useRef } from 'react'
import { ChatWebSocket } from '../services/websocket'
import {
  registerAgent as apiRegisterAgent,
  agentJoinRoom as apiAgentJoinRoom,
  joinRoom as apiJoinRoom,
  leaveRoom as apiLeaveRoom,
} from '../services/api'
import type { Message, WSEvent, OnlineMember, MentionTarget } from '../types'

const AGENT_COLORS = [
  '#22c55e',
  '#3b82f6',
  '#f59e0b',
  '#ef4444',
  '#a855f7',
  '#06b6d4',
  '#ec4899',
  '#f97316',
]

export type AgentStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'

export interface SimulatedAgent {
  localId: string
  /** WS 连接所用 user_id（agent 为 agent-{agentId}，human 为 sim-xxx） */
  userId: string
  username: string
  userType: 'human' | 'agent'
  color: string
  roomId: string | null
  roomPassword: string | null
  status: AgentStatus
  inputText: string
  /** 服务端分配的 agent UUID（仅 agent 类型有值，注册后持久化） */
  agentId?: string
  /** 注册时返回的 secret，仅内存保存，用于 WS 认证 */
  agentSecret?: string
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

  const wsClientsRef = useRef<Map<string, ChatWebSocket>>(new Map())
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

  const updateAgentCredentials = useCallback((
    localId: string,
    agentId: string,
    agentSecret: string,
  ) => {
    setAgents((prev) =>
      prev.map((a) =>
        a.localId === localId
          ? { ...a, agentId, agentSecret, userId: `agent-${agentId}` }
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

    updateAgentStatus(localId, 'connecting', roomId, password)

    if (agent.userType === 'agent') {
      // ── Agent 流程：register（首次）→ agentJoinRoom → WS ──────────────────

      let agentId = agent.agentId
      let agentSecret = agent.agentSecret

      // 步骤 1：首次加入，先向服务端注册获取凭据
      if (!agentId || !agentSecret) {
        try {
          const reg = await apiRegisterAgent({ name: agent.username })
          agentId = reg.agent_id
          agentSecret = reg.agent_secret
          updateAgentCredentials(localId, agentId, agentSecret)
        } catch (err) {
          console.error(`[DebugLab] ${agent.username} 注册失败`, err)
          updateAgentStatus(localId, 'error')
          pushEvent({
            id: crypto.randomUUID(),
            type: 'error',
            text: `${agent.username} 注册失败: ${(err as Error).message ?? '未知错误'}`,
            timestamp: new Date().toISOString(),
            agentColor: agent.color,
          })
          return
        }
      }

      // 步骤 2：调用 /agents/join 加入房间（写入 DB room_members）
      try {
        await apiAgentJoinRoom({
          agent_id: agentId,
          agent_secret: agentSecret,
          room_id: roomId,
          room_password: password,
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

      // 步骤 3：建立 WebSocket（userId = agentId，用 agentSecret 认证）
      let ws = wsClientsRef.current.get(localId)
      if (!ws) {
        ws = new ChatWebSocket(agentId, agent.username, 'agent', agentSecret)

        ws.onStatus((s) => {
          if (s === 'disconnected') updateAgentStatus(localId, 'disconnected')
          else if (s === 'error') updateAgentStatus(localId, 'error')
        })

        ws.onEvent((event: WSEvent) => {
          if (!('event' in event)) return
          switch (event.event) {
            case 'roomJoined':
              setOnlineMembers(event.data.online_members)
              if (event.data.agent_id) updateAgentId(localId, event.data.agent_id)
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
        })

        ws.connect()
        wsClientsRef.current.set(localId, ws)
      }

      // 步骤 4：WS 订阅房间
      const doJoin = async (wsInstance: ChatWebSocket) => {
        try {
          await wsInstance.joinRoom(password)
          updateAgentStatus(localId, 'connected', roomId)
        } catch (err) {
          console.error(`[DebugLab] ${agent.username} joinRoom 失败`, err)
          updateAgentStatus(localId, 'error')
          pushEvent({
            id: crypto.randomUUID(),
            type: 'error',
            text: `${agent.username} joinRoom 失败: ${(err as Error).message ?? '未知错误'}`,
            timestamp: new Date().toISOString(),
            agentColor: agent.color,
          })
        }
      }

      if (ws.isConnected) {
        await doJoin(ws)
      } else {
        const unsubStatus = ws.onStatus((s) => {
          if (s === 'connected') {
            unsubStatus()
            doJoin(ws!)
          }
        })
      }

    } else {
      // ── Human 模拟流程（保持原有逻辑）─────────────────────────────────────

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

      let ws = wsClientsRef.current.get(localId)
      if (!ws) {
        ws = new ChatWebSocket(agent.userId, agent.username, agent.userType)

        ws.onStatus((s) => {
          if (s === 'disconnected') updateAgentStatus(localId, 'disconnected')
          else if (s === 'error') updateAgentStatus(localId, 'error')
        })

        ws.onEvent((event: WSEvent) => {
          if (!('event' in event)) return
          switch (event.event) {
            case 'roomJoined':
              setOnlineMembers(event.data.online_members)
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
        })

        ws.connect()
        wsClientsRef.current.set(localId, ws)
      }

      const doJoin = async (wsInstance: ChatWebSocket) => {
        try {
          await wsInstance.joinRoom(password)
          updateAgentStatus(localId, 'connected', roomId)
        } catch (err) {
          console.error(`[DebugLab] ${agent.username} joinRoom 失败`, err)
          updateAgentStatus(localId, 'error')
          pushEvent({
            id: crypto.randomUUID(),
            type: 'error',
            text: `${agent.username} joinRoom 失败: ${(err as Error).message ?? '未知错误'}`,
            timestamp: new Date().toISOString(),
            agentColor: agent.color,
          })
        }
      }

      if (ws.isConnected) {
        await doJoin(ws)
      } else {
        const unsubStatus = ws.onStatus((s) => {
          if (s === 'connected') {
            unsubStatus()
            doJoin(ws!)
          }
        })
      }
    }
  }, [agents, updateAgentStatus, updateAgentCredentials, updateAgentId, pushMessage, pushEvent])

  const leaveRoom = useCallback(async (localId: string) => {
    const agent = agents.find((a) => a.localId === localId)
    if (!agent || !agent.roomId || !agent.roomPassword) return

    const ws = wsClientsRef.current.get(localId)
    if (ws) {
      ws.leaveRoom(agent.roomId)
    }

    try {
      await apiLeaveRoom(agent.roomPassword, agent.userId)
    } catch (err) {
      console.warn(`[DebugLab] ${agent.username} 离开房间时出错`, err)
    }

    updateAgentStatus(localId, 'idle', null, null)
  }, [agents, updateAgentStatus])

  const sendMessage = useCallback((localId: string, text: string, mentions: MentionTarget[] = []) => {
    const agent = agents.find((a) => a.localId === localId)
    if (!agent?.roomId) return
    const ws = wsClientsRef.current.get(localId)
    if (!ws || !ws.isConnected) return
    ws.sendMessage(agent.roomId, text.trim(), mentions)
    setAgents((prev) =>
      prev.map((a) => (a.localId === localId ? { ...a, inputText: '' } : a)),
    )
  }, [agents])

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
    for (const agent of agents) {
      if (agent.status === 'connected' && agent.roomId) {
        const ws = wsClientsRef.current.get(agent.localId)
        if (ws) {
          const members = await ws.getOnlineMembers(agent.roomId)
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
