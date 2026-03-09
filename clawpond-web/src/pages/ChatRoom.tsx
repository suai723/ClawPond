import { useState, useEffect, useRef, useCallback } from 'react'
import { getMessages, getRoom } from '../services/api'
import { useWebSocket } from '../contexts/WebSocketContext'
import type { Message, MentionTarget, Room, OnlineMember, WSEvent } from '../types'
import MessageList from '../components/MessageList'
import MessageInput from '../components/MessageInput'
import MemberSidebar from '../components/MemberSidebar'

interface ChatRoomProps {
  roomId: string
  /** 房间 access_token，用于 joinRoom 订阅 */
  roomPassword: string
  userId: string
  username: string
  onLeave: () => void
}

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export default function ChatRoom({ roomId, roomPassword, userId, username, onLeave }: ChatRoomProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [onlineMembers, setOnlineMembers] = useState<OnlineMember[]>([])
  const [room, setRoom] = useState<Room | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const ws = useWebSocket()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // 加载房间信息
  useEffect(() => {
    getRoom(roomId).catch(console.error).then((r) => r && setRoom(r))
  }, [roomId])

  // 加载历史消息
  useEffect(() => {
    getMessages(roomPassword, 50)
      .then((data) => setMessages(data.messages))
      .catch(console.error)
  }, [roomPassword])

  // 加入房间 + 订阅消息事件
  useEffect(() => {
    if (!ws) return

    // 用局部变量标记此次 effect 是否已被 cleanup，避免异步 await 后更新已卸载组件的状态
    let cancelled = false

    const doJoin = async () => {
      setStatus('connecting')
      try {
        const roomData = await ws.joinRoom(roomPassword)
        if (cancelled) return
        setOnlineMembers(roomData.online_members)
        setStatus('connected')
      } catch (err) {
        if (cancelled) return
        console.error('[ChatRoom] joinRoom failed', err)
        setStatus('error')
      }
    }

    // 订阅房间事件，仅处理属于本房间的消息
    const unsubEvent = ws.onEvent((event: WSEvent) => {
      if (event.event === 'message' || event.event === 'systemMessage') {
        if (event.data.room_id !== roomId) return
        setMessages((prev) => {
          if (prev.some((m) => m.id === event.data.id)) return prev
          return [...prev, event.data]
        })
        scrollToBottom()
      } else if (event.event === 'memberJoined') {
        if (event.data.room_id !== roomId) return
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
      } else if (event.event === 'memberLeft') {
        if (event.data.room_id !== roomId) return
        setOnlineMembers((prev) => prev.filter((m) => m.user_id !== event.data.user_id))
      } else if (event.event === 'connected') {
        // WS 断线重连后 server 会重新推送 connected，此时显示正在重新加入
        setStatus('connecting')
      }
    })

    // WS 已连接则立即加入，否则等 connected 事件后加入
    if (ws.isConnected) {
      doJoin()
    } else {
      const unsubReconnect = ws.onStatus((s) => {
        if (s === 'connected') {
          unsubReconnect()
          if (!cancelled) doJoin()
        } else if (s === 'error' || s === 'disconnected') {
          if (!cancelled) setStatus(s)
        }
      })
    }

    return () => {
      cancelled = true
      unsubEvent()
      ws.leaveRoom(roomId)
    }
  }, [ws, roomPassword, roomId, scrollToBottom])

  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  const handleSend = useCallback(
    (text: string, mentions: MentionTarget[], replyTo?: number) => {
      ws?.sendMessage(roomId, text, mentions, replyTo)
    },
    [ws, roomId],
  )

  const agentMembers = onlineMembers
    .filter((m) => m.user_type === 'agent')
    .map((m) => ({ username: m.username, agentId: m.agent_id }))

  const humanMembers = onlineMembers
    .filter((m) => m.user_type === 'human')
    .map((m) => ({ username: m.username, userId: m.user_id }))

  const statusColors: Record<ConnectionStatus, string> = {
    connecting: 'bg-yellow-400',
    connected: 'bg-green-400',
    disconnected: 'bg-gray-400',
    error: 'bg-red-400',
  }
  const statusLabels: Record<ConnectionStatus, string> = {
    connecting: '连接中',
    connected: '已连接',
    disconnected: '已断开',
    error: '连接错误',
  }

  return (
    <div className="flex h-screen flex-col bg-gray-950 text-gray-100">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-gray-800 bg-gray-900 px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onLeave}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm hover:bg-gray-800"
          >
            ← 返回
          </button>
          <div>
            <h1 className="font-semibold">{room?.name ?? '加载中...'}</h1>
            {room?.description && (
              <p className="text-xs text-gray-400">{room.description}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* 连接状态 */}
          <div className="flex items-center gap-1.5 text-xs text-gray-400">
            <div className={`h-2 w-2 rounded-full ${statusColors[status]}`} />
            {statusLabels[status]}
          </div>

          {/* 成员数 */}
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm hover:bg-gray-800"
          >
            {onlineMembers.length} 在线
          </button>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Chat area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <MessageList
            messages={messages}
            currentUserId={userId}
            messagesEndRef={messagesEndRef}
          />
          <MessageInput
            onSend={handleSend}
            agentMembers={agentMembers}
            humanMembers={humanMembers}
            memberNames={onlineMembers.map((m) => m.username)}
            disabled={status !== 'connected'}
          />
        </div>

        {/* Sidebar */}
        {sidebarOpen && (
          <MemberSidebar
            members={onlineMembers}
            currentUserId={userId}
            roomId={roomId}
          />
        )}
      </div>
    </div>
  )
}
