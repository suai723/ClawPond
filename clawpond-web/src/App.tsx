import { useState, useRef, useEffect } from 'react'
import Auth from './pages/Auth'
import Home from './pages/Home'
import ChatRoom from './pages/ChatRoom'
import DebugLab from './pages/DebugLab'
import { ChatWebSocket } from './services/websocket'
import { WebSocketContext } from './contexts/WebSocketContext'

type View = 'auth' | 'home' | 'chat' | 'debug'

interface RoomSession {
  roomId: string
  /** 房间 access_token，用于 joinRoom 订阅 */
  roomPassword: string
  userId: string
  username: string
}

function getInitialView(): View {
  return localStorage.getItem('cp_token') ? 'home' : 'auth'
}

export default function App() {
  const [view, setView] = useState<View>(getInitialView)
  const [session, setSession] = useState<RoomSession | null>(null)
  const [userId, setUserId] = useState(() => localStorage.getItem('cp_user_id') ?? '')
  const [username, setUsername] = useState(() => localStorage.getItem('cp_username') ?? '')

  /** 全局 WebSocket 实例，登录后创建，登出时销毁 */
  const wsRef = useRef<ChatWebSocket | null>(null)
  const [globalWs, setGlobalWs] = useState<ChatWebSocket | null>(null)

  /**
   * 页面刷新时若用户已登录，在 useEffect 里创建 WS 连接。
   * 使用 useEffect 而非 useState 初始化器，避免 React StrictMode 双调用
   * 导致两个 WS 实例并存、互相踢出形成无限重连循环。
   */
  useEffect(() => {
    const uid = localStorage.getItem('cp_user_id') ?? ''
    const uname = localStorage.getItem('cp_username') ?? ''
    const token = localStorage.getItem('cp_token')
    if (!uid || !uname || !token) return

    const ws = new ChatWebSocket(uid, uname, 'human')
    ws.connect()
    wsRef.current = ws
    setGlobalWs(ws)

    return () => {
      ws.disconnect()
      wsRef.current = null
      setGlobalWs(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // 仅在挂载时执行一次

  const handleAuthenticated = (uid: string, uname: string, _token: string) => {
    setUserId(uid)
    setUsername(uname)

    wsRef.current?.disconnect()

    const ws = new ChatWebSocket(uid, uname, 'human')
    ws.connect()
    wsRef.current = ws
    setGlobalWs(ws)

    setView('home')
  }

  const handleLogout = () => {
    localStorage.removeItem('cp_token')
    localStorage.removeItem('cp_user_id')
    localStorage.removeItem('cp_username')
    setSession(null)
    setUserId('')
    setUsername('')

    wsRef.current?.disconnect()
    wsRef.current = null
    setGlobalWs(null)

    setView('auth')
  }

  const handleEnterRoom = (roomId: string, roomPassword: string) => {
    setSession({ roomId, roomPassword, userId, username })
    setView('chat')
  }

  const handleLeave = () => {
    setSession(null)
    setView('home')
  }

  if (view === 'auth') {
    return <Auth onAuthenticated={handleAuthenticated} />
  }

  if (view === 'debug') {
    return <DebugLab onBack={() => setView('home')} />
  }

  return (
    <WebSocketContext.Provider value={globalWs}>
      {view === 'chat' && session ? (
        <ChatRoom
          roomId={session.roomId}
          roomPassword={session.roomPassword}
          userId={session.userId}
          username={session.username}
          onLeave={handleLeave}
        />
      ) : (
        <Home
          userId={userId}
          username={username}
          onEnterRoom={handleEnterRoom}
          onOpenDebugLab={() => setView('debug')}
          onLogout={handleLogout}
        />
      )}
    </WebSocketContext.Provider>
  )
}
