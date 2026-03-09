import { useState, useEffect, useRef, useCallback } from 'react'
import { ChatWebSocket } from '../services/websocket'
import { getMessages, getRoom } from '../services/api'
import type { Message, MentionTarget, Room, OnlineMember, WSEvent } from '../types'
import MessageList from '../components/MessageList'
import MessageInput from '../components/MessageInput'
import MemberSidebar from '../components/MemberSidebar'

interface ChatRoomProps {
  roomId: string
  /** 房间 access_token，用于 WS 连接和消息操作 */
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

  const wsRef = useRef<ChatWebSocket | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // 加载房间信息（仍使用 room_id，此为公开端点）
  useEffect(() => {
    getRoom(roomId).catch(console.error).then((r) => r && setRoom(r))
  }, [roomId])

  // 加载历史消息（使用 roomPassword 作为 access_token）
  useEffect(() => {
    getMessages(roomPassword, 50).then((data) => {
      setMessages(data.messages)
    }).catch(console.error)
  }, [roomPassword])

  // WebSocket 连接（使用 roomPassword 定位房间）
  useEffect(() => {
    const ws = new ChatWebSocket(roomPassword, userId, username, 'human')
    wsRef.current = ws

    const unsubStatus = ws.onStatus(setStatus)

    const unsubEvent = ws.onEvent((event: WSEvent) => {
      if (event.event === 'connected') {
        setOnlineMembers(event.data.online_members)
      } else if (event.event === 'message' || event.event === 'systemMessage') {
        setMessages((prev) => {
          // 防止重复
          if (prev.some((m) => m.id === event.data.id)) return prev
          return [...prev, event.data]
        })
        scrollToBottom()
      } else if (event.event === 'memberJoined') {
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
        setOnlineMembers((prev) => prev.filter((m) => m.user_id !== event.data.user_id))
      }
    })

    ws.connect()

    return () => {
      unsubStatus()
      unsubEvent()
      ws.disconnect()
      wsRef.current = null
    }
  }, [roomPassword, userId, username, scrollToBottom])

  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  const handleSend = useCallback((text: string, mentions: MentionTarget[], replyTo?: number) => {
    wsRef.current?.sendMessage(text, mentions, replyTo)
  }, [])

  // 构建 agentMembers 列表，包含 agentId（供 @mention 选框使用）
  const agentMembers = onlineMembers
    .filter((m) => m.user_type === 'agent')
    .map((m) => ({ username: m.username, agentId: m.agent_id }))

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
