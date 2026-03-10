import type { WSEvent, OnlineMember, Message, RoomJoinedData } from '../types'
import type { IChatWebSocket } from './websocket'

type EventHandler = (event: WSEvent) => void
type StatusHandler = (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void

/** 主线程 → Worker 消息 */
interface WorkerInMessage {
  type: 'connect' | 'disconnect' | 'method'
  requestId?: string
  method?: string
  params?: Record<string, unknown>
  userId?: string
  username?: string
  userType?: string
  token?: string
  agentSecret?: string
  wsBase?: string
}

/** Worker → 主线程消息 */
interface WorkerOutMessage {
  type: 'event' | 'status' | 'response'
  event?: WSEvent
  status?: 'connecting' | 'connected' | 'disconnected' | 'error'
  requestId?: string
  data?: unknown
  error?: string
}

/**
 * 通过 SharedWorker 共享单连接的 WebSocket 代理，与 ChatWebSocket 对外 API 一致。
 */
export class SharedWorkerChatSocket implements IChatWebSocket {
  private worker: SharedWorker | null = null
  private port: MessagePort | null = null
  private eventHandlers: EventHandler[] = []
  private statusHandlers: StatusHandler[] = []
  private requestIdNext = 0
  private pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private _connected = false

  connect() {
    const wsBase = import.meta.env.VITE_WS_URL ?? `ws://${window.location.hostname}:8000`
    const userId = localStorage.getItem('cp_user_id') ?? ''
    const username = localStorage.getItem('cp_username') ?? ''
    const token = localStorage.getItem('cp_token') ?? ''

    try {
      this.worker = new SharedWorker(
        new URL('../workers/ws-shared-worker.ts', import.meta.url),
        { type: 'module' },
      )
      this.port = this.worker.port
      this.port.start()

      this.port.onmessage = (e: MessageEvent<WorkerOutMessage>) => {
        const msg = e.data
        if (msg.type === 'event' && msg.event) {
          this.eventHandlers.forEach((h) => h(msg.event!))
        } else if (msg.type === 'status' && msg.status) {
          this._connected = msg.status === 'connected'
          this.statusHandlers.forEach((h) => h(msg.status!))
        } else if (msg.type === 'response' && msg.requestId) {
          const pending = this.pendingRequests.get(msg.requestId)
          if (pending) {
            this.pendingRequests.delete(msg.requestId)
            if (msg.error) pending.reject(new Error(msg.error))
            else pending.resolve(msg.data)
          }
        }
      }

      const connectMsg: WorkerInMessage = {
        type: 'connect',
        userId,
        username,
        userType: 'human',
        token,
        wsBase,
      }
      this.port.postMessage(connectMsg)
    } catch (err) {
      console.warn('[SharedWorkerChatSocket] SharedWorker not supported or failed', err)
      this._connected = false
      this.statusHandlers.forEach((h) => h('error'))
    }
  }

  disconnect() {
    if (this.port) {
      this.port.postMessage({ type: 'disconnect' } as WorkerInMessage)
      this.port.close()
      this.port = null
    }
    this.worker = null
    this.pendingRequests.forEach(({ reject }) => reject(new Error('disconnected')))
    this.pendingRequests.clear()
    this._connected = false
    this.statusHandlers.forEach((h) => h('disconnected'))
  }

  private sendMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = `r${++this.requestIdNext}`
      this.pendingRequests.set(requestId, { resolve, reject })
      this.port?.postMessage({
        type: 'method',
        requestId,
        method,
        params,
      } as WorkerInMessage)
    })
  }

  joinRoom(password: string): Promise<RoomJoinedData> {
    return this.sendMethod('joinRoom', { password }) as Promise<RoomJoinedData>
  }

  leaveRoom(roomId: string) {
    this.port?.postMessage({
      type: 'method',
      method: 'leaveRoom',
      params: { room_id: roomId },
    } as WorkerInMessage)
  }

  sendMessage(
    roomId: string,
    text: string,
    mentions: import('../types').MentionTarget[] = [],
    reply_to?: number,
  ) {
    this.port?.postMessage({
      type: 'method',
      method: 'sendMessage',
      params: { room_id: roomId, text, mentions, reply_to },
    } as WorkerInMessage)
  }

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler)
    }
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.push(handler)
    return () => {
      this.statusHandlers = this.statusHandlers.filter((h) => h !== handler)
    }
  }

  getOnlineMembers(roomId: string): Promise<OnlineMember[]> {
    return this.sendMethod('getOnlineMembers', { room_id: roomId }) as Promise<OnlineMember[]>
  }

  getRecentMessages(roomId: string, limit = 50): Promise<Message[]> {
    return this.sendMethod('getRecentMessages', { room_id: roomId, limit }) as Promise<Message[]>
  }

  get isConnected(): boolean {
    return this._connected
  }
}
