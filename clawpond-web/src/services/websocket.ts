import type { WSEvent, OnlineMember, Message } from '../types'

type EventHandler = (event: WSEvent) => void
type StatusHandler = (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void

export class ChatWebSocket {
  private ws: WebSocket | null = null
  private roomId: string
  private userId: string
  private username: string
  private userType: string
  private eventHandlers: EventHandler[] = []
  private statusHandlers: StatusHandler[] = []
  private reconnectTimer: number | null = null
  private reconnectAttempts = 0
  private readonly maxReconnects = 5

  constructor(
    roomId: string,
    userId: string,
    username: string,
    userType: 'human' | 'agent' | 'system' = 'human',
  ) {
    this.roomId = roomId
    this.userId = userId
    this.username = username
    this.userType = userType
  }

  connect() {
    const wsBase = import.meta.env.VITE_WS_URL ?? `ws://${window.location.hostname}:8000`
    const params = new URLSearchParams({
      user_id: this.userId,
      username: this.username,
      user_type: this.userType,
    })
    const url = `${wsBase}/ws/${this.roomId}?${params.toString()}`

    this.setStatus('connecting')
    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      this.reconnectAttempts = 0
      this.setStatus('connected')
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

    this.ws.onclose = () => {
      this.setStatus('disconnected')
      this.scheduleReconnect()
    }
  }

  disconnect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.maxReconnects && (this.reconnectAttempts = this.maxReconnects) // 阻止自动重连
    this.ws?.close()
    this.ws = null
  }

  sendMessage(text: string, mentions: import('../types').MentionTarget[] = [], reply_to?: number) {
    this.send({
      method: 'sendMessage',
      params: { text, mentions, reply_to },
    })
  }

  ping() {
    this.send({ method: 'ping' })
  }

  getOnlineMembers(): Promise<OnlineMember[]> {
    return new Promise((resolve) => {
      const handler: EventHandler = (event) => {
        if ('method' in event && (event as unknown as { method: string }).method === 'onlineMembers') {
          this.eventHandlers = this.eventHandlers.filter((h) => h !== handler)
          resolve((event as unknown as { data: OnlineMember[] }).data ?? [])
        }
      }
      this.eventHandlers.push(handler)
      this.send({ method: 'getOnlineMembers' })
    })
  }

  getRecentMessages(limit = 50): Promise<Message[]> {
    return new Promise((resolve) => {
      const handler: EventHandler = (event) => {
        if ('method' in event && (event as unknown as { method: string }).method === 'recentMessages') {
          this.eventHandlers = this.eventHandlers.filter((h) => h !== handler)
          resolve((event as unknown as { data: Message[] }).data ?? [])
        }
      }
      this.eventHandlers.push(handler)
      this.send({ method: 'getRecentMessages', params: { limit } })
    })
  }

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
}
