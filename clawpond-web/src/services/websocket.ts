import type { WSEvent, OnlineMember, Message, RoomJoinedData } from '../types'

type EventHandler = (event: WSEvent) => void
type StatusHandler = (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void

/**
 * 全局 WebSocket 客户端
 *
 * 每个用户/Agent 登录后建立一条连接，通过 joinRoom / leaveRoom 管理房间订阅。
 * 服务端按房间路由消息，客户端无需为每个房间单独建立连接。
 */
export class ChatWebSocket {
  private ws: WebSocket | null = null
  private userId: string
  private username: string
  private userType: string
  private agentSecret: string | undefined
  private eventHandlers: EventHandler[] = []
  private statusHandlers: StatusHandler[] = []
  private reconnectTimer: number | null = null
  private reconnectAttempts = 0
  private readonly maxReconnects = 5
  /** 标记本次连接是否曾经成功进入 OPEN 状态；握手被拒（403/401）时不重连 */
  private connectionWasOpen = false

  /** room_id → room access_token，用于断线重连时自动重新订阅 */
  private roomPasswordMap: Map<string, string> = new Map()

  constructor(
    userId: string,
    username: string,
    userType: 'human' | 'agent' | 'system' = 'human',
    /** Agent 专用：注册时返回的 agent_secret（对应 userId 为 agent_id） */
    agentSecret?: string,
  ) {
    this.userId = userId
    this.username = username
    this.userType = userType
    this.agentSecret = agentSecret
  }

  connect() {
    const wsBase = import.meta.env.VITE_WS_URL ?? `ws://${window.location.hostname}:8000`
    const params = new URLSearchParams({ user_type: this.userType })

    if (this.userType === 'human') {
      const token = localStorage.getItem('cp_token')
      if (token) params.set('token', token)
    } else if (this.userType === 'agent' && this.agentSecret) {
      // 新认证方式：agent_id + agent_secret
      params.set('agent_id', this.userId)
      params.set('agent_secret', this.agentSecret)
    } else {
      // 向后兼容 / system 等类型
      params.set('user_id', this.userId)
      params.set('username', this.username)
    }

    const url = `${wsBase}/ws?${params.toString()}`

    this.connectionWasOpen = false
    this.setStatus('connecting')
    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      this.connectionWasOpen = true
      this.reconnectAttempts = 0
      this.setStatus('connected')
      // 断线重连后自动重新订阅之前的房间
      if (this.roomPasswordMap.size > 0) {
        this.rejoinAllRooms()
      }
    }

    this.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as WSEvent
        this.eventHandlers.forEach((h) => h(data))
      } catch {
        console.warn('[WS] Failed to parse message', e.data)
      }
    }

    this.ws.onerror = () => {
      this.setStatus('error')
    }

    this.ws.onclose = (ev) => {
      const wasOpen = this.connectionWasOpen
      this.connectionWasOpen = false
      this.setStatus('disconnected')

      if (!wasOpen) {
        // 握手阶段就被服务端拒绝（如 401/403 token 过期），不要重试
        console.warn(`[WS] Handshake rejected (code=${ev.code}), will not reconnect. Please re-login.`)
        this.setStatus('error')
        return
      }

      this.scheduleReconnect()
    }
  }

  disconnect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempts = this.maxReconnects // 阻止自动重连
    this.roomPasswordMap.clear()
    this.ws?.close()
    this.ws = null
  }

  // ------------------------------------------------------------------
  // 房间订阅
  // ------------------------------------------------------------------

  joinRoom(password: string): Promise<RoomJoinedData> {
    return new Promise((resolve, reject) => {
      const handler: EventHandler = (event) => {
        if (event.event === 'roomJoined') {
          this.eventHandlers = this.eventHandlers.filter((h) => h !== handler)
          // 记录 room_id → password 供断线重连时自动重加入
          this.roomPasswordMap.set(event.data.room_id, password)
          resolve(event.data)
        } else if (event.event === 'error') {
          this.eventHandlers = this.eventHandlers.filter((h) => h !== handler)
          reject(new Error(event.data.message))
        }
      }
      this.eventHandlers.push(handler)
      this.send({ method: 'joinRoom', params: { password } })
    })
  }

  leaveRoom(roomId: string) {
    this.roomPasswordMap.delete(roomId)
    this.send({ method: 'leaveRoom', params: { room_id: roomId } })
  }

  // ------------------------------------------------------------------
  // 消息操作
  // ------------------------------------------------------------------

  sendMessage(
    roomId: string,
    text: string,
    mentions: import('../types').MentionTarget[] = [],
    reply_to?: number,
  ) {
    this.send({ method: 'sendMessage', params: { room_id: roomId, text, mentions, reply_to } })
  }

  ping() {
    this.send({ method: 'ping' })
  }

  getOnlineMembers(roomId: string): Promise<OnlineMember[]> {
    return new Promise((resolve) => {
      const handler: EventHandler = (event) => {
        if ('method' in event && (event as unknown as { method: string }).method === 'onlineMembers') {
          this.eventHandlers = this.eventHandlers.filter((h) => h !== handler)
          resolve((event as unknown as { data: OnlineMember[] }).data ?? [])
        }
      }
      this.eventHandlers.push(handler)
      this.send({ method: 'getOnlineMembers', params: { room_id: roomId } })
    })
  }

  getRecentMessages(roomId: string, limit = 50): Promise<Message[]> {
    return new Promise((resolve) => {
      const handler: EventHandler = (event) => {
        if ('method' in event && (event as unknown as { method: string }).method === 'recentMessages') {
          this.eventHandlers = this.eventHandlers.filter((h) => h !== handler)
          resolve((event as unknown as { data: Message[] }).data ?? [])
        }
      }
      this.eventHandlers.push(handler)
      this.send({ method: 'getRecentMessages', params: { room_id: roomId, limit } })
    })
  }

  // ------------------------------------------------------------------
  // 事件订阅
  // ------------------------------------------------------------------

  onEvent(handler: EventHandler) {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler)
    }
  }

  onStatus(handler: StatusHandler) {
    this.statusHandlers.push(handler)
    return () => {
      this.statusHandlers = this.statusHandlers.filter((h) => h !== handler)
    }
  }

  get isConnected() {
    return this.ws?.readyState === WebSocket.OPEN
  }

  // ------------------------------------------------------------------
  // 内部工具
  // ------------------------------------------------------------------

  private send(data: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  private setStatus(status: Parameters<StatusHandler>[0]) {
    this.statusHandlers.forEach((h) => h(status))
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnects) return
    this.reconnectAttempts++
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000)
    this.reconnectTimer = window.setTimeout(() => {
      console.log(`[WS] Reconnecting (attempt ${this.reconnectAttempts})...`)
      this.connect()
    }, delay)
  }

  /** 断线重连后重新订阅所有已知房间 */
  private rejoinAllRooms() {
    const entries = Array.from(this.roomPasswordMap.entries())
    // 先清空，由 joinRoom 的回调重新填充
    this.roomPasswordMap.clear()
    for (const [, password] of entries) {
      this.joinRoom(password).catch((err) => {
        console.warn('[WS] Auto-rejoin failed', err)
      })
    }
  }
}
