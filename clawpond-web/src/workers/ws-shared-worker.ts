/**
 * SharedWorker: 单例 WebSocket 连接，多标签页共享。
 * 主线程通过 postMessage 发 connect/disconnect/method，Worker 广播 event/status/response。
 */

const MAX_RECONNECTS = 5

type Port = MessagePort
const ports: Set<Port> = new Set()

let ws: WebSocket | null = null
let connectParams: {
  userId: string
  username: string
  userType: string
  token?: string
  agentSecret?: string
  wsBase: string
} | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let connectionWasOpen = false

// 按类型排队的待响应请求：收到 WS 响应时按顺序 resolve
interface Pending {
  port: Port
  resolve: (data: unknown) => void
  reject: (err: Error) => void
}
const joinRoomQueue: Pending[] = []
const getOnlineMembersQueue: Pending[] = []
const getRecentMessagesQueue: Pending[] = []

function broadcast(data: object) {
  ports.forEach((port) => {
    try {
      port.postMessage(data)
    } catch {
      // port may be closed
    }
  })
}

function broadcastStatus(status: 'connecting' | 'connected' | 'disconnected' | 'error') {
  broadcast({ type: 'status', status })
}

function buildWsUrl(wsBase: string, params: typeof connectParams): string {
  if (!params) throw new Error('no connect params')
  const p = new URLSearchParams({ user_type: params.userType })
  if (params.userType === 'human' && params.token) {
    p.set('token', params.token)
  } else if (params.userType === 'agent' && params.agentSecret) {
    p.set('agent_id', params.userId)
    p.set('agent_secret', params.agentSecret)
  } else {
    p.set('user_id', params.userId)
    p.set('username', params.username)
  }
  const base = wsBase.replace(/\/$/, '')
  return `${base}/ws?${p.toString()}`
}

function connect() {
  if (!connectParams) return
  const url = buildWsUrl(connectParams.wsBase, connectParams)
  connectionWasOpen = false
  broadcastStatus('connecting')
  ws = new WebSocket(url)

  ws.onopen = () => {
    connectionWasOpen = true
    reconnectAttempts = 0
    broadcastStatus('connected')
  }

  ws.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data as string) as Record<string, unknown>
      const event = data.event as string | undefined
      const method = data.method as string | undefined

      if (event !== undefined) {
        broadcast({ type: 'event', event: data })
        if (event === 'roomJoined' && joinRoomQueue.length > 0) {
          const first = joinRoomQueue.shift()!
          first.resolve((data as { data: unknown }).data)
        } else if (event === 'error' && joinRoomQueue.length > 0) {
          const first = joinRoomQueue.shift()!
          const msg = ((data as { data: { message?: string } }).data?.message) ?? 'Unknown error'
          first.reject(new Error(msg))
        }
      } else if (method !== undefined) {
        if (method === 'onlineMembers' && getOnlineMembersQueue.length > 0) {
          const first = getOnlineMembersQueue.shift()!
          first.resolve((data as { data: unknown }).data ?? [])
        } else if (method === 'recentMessages' && getRecentMessagesQueue.length > 0) {
          const first = getRecentMessagesQueue.shift()!
          first.resolve((data as { data: unknown }).data ?? [])
        }
        broadcast({ type: 'event', event: data })
      }
    } catch (err) {
      console.warn('[WS SharedWorker] parse message failed', e.data, err)
    }
  }

  ws.onerror = () => {
    broadcastStatus('error')
  }

  ws.onclose = () => {
    ws = null
    broadcastStatus('disconnected')
    if (!connectionWasOpen) {
      broadcastStatus('error')
      return
    }
    if (reconnectAttempts >= MAX_RECONNECTS) return
    reconnectAttempts++
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }
}

function disconnect() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempts = MAX_RECONNECTS
  connectParams = null
  if (ws) {
    ws.close()
    ws = null
  }
  broadcastStatus('disconnected')
}

function sendToWs(payload: object) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

;(self as unknown as { onconnect: (e: { ports: MessagePort[] }) => void }).onconnect = (e) => {
  const port = e.ports[0]
  ports.add(port)
  port.start()

  port.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data as Record<string, unknown>
    const type = msg.type as string

    if (type === 'connect') {
      const userId = msg.userId as string
      const username = msg.username as string
      const userType = msg.userType as string
      const token = msg.token as string | undefined
      const agentSecret = msg.agentSecret as string | undefined
      const wsBase = (msg.wsBase as string) || `ws://${self.location.hostname}:8000`
      const next = { userId, username, userType, token, agentSecret, wsBase }
      const same =
        connectParams &&
        connectParams.userId === next.userId &&
        connectParams.userType === next.userType
      if (!same) {
        disconnect()
        connectParams = next
        connect()
      } else {
        connectParams = next
        if (ws?.readyState === WebSocket.OPEN) {
          port.postMessage({ type: 'status', status: 'connected' })
        }
      }
    } else if (type === 'disconnect') {
      ports.delete(port)
      if (ports.size === 0) {
        disconnect()
      }
    } else if (type === 'method') {
      const requestId = msg.requestId as string
      const method = msg.method as string
      const params = (msg.params as Record<string, unknown>) || {}
      const payload = { method, params }

      if (method === 'joinRoom') {
        joinRoomQueue.push({
          port,
          resolve: (data) => port.postMessage({ type: 'response', requestId, data }),
          reject: (err) => port.postMessage({ type: 'response', requestId, error: err.message }),
        })
        sendToWs(payload)
      } else if (method === 'getOnlineMembers') {
        getOnlineMembersQueue.push({
          port,
          resolve: (data) => port.postMessage({ type: 'response', requestId, data }),
          reject: (err) => port.postMessage({ type: 'response', requestId, error: err.message }),
        })
        sendToWs(payload)
      } else if (method === 'getRecentMessages') {
        getRecentMessagesQueue.push({
          port,
          resolve: (data) => port.postMessage({ type: 'response', requestId, data }),
          reject: (err) => port.postMessage({ type: 'response', requestId, error: err.message }),
        })
        sendToWs(payload)
      } else {
        sendToWs(payload)
      }
    }
  })

  port.addEventListener('close', () => {
    ports.delete(port)
    if (ports.size === 0) {
      disconnect()
    }
  })
}
