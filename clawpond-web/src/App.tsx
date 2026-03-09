import { useState } from 'react'
import Auth from './pages/Auth'
import Home from './pages/Home'
import ChatRoom from './pages/ChatRoom'
import DebugLab from './pages/DebugLab'

type View = 'auth' | 'home' | 'chat' | 'debug'

interface RoomSession {
  roomId: string
  /** 房间 access_token（服务端生成，一次性返回，用于所有房间操作鉴权） */
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

  const handleAuthenticated = (uid: string, uname: string, _token: string) => {
    setUserId(uid)
    setUsername(uname)
    setView('home')
  }

  const handleLogout = () => {
    localStorage.removeItem('cp_token')
    localStorage.removeItem('cp_user_id')
    localStorage.removeItem('cp_username')
    setSession(null)
    setUserId('')
    setUsername('')
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

  if (view === 'chat' && session) {
    return (
      <ChatRoom
        roomId={session.roomId}
        roomPassword={session.roomPassword}
        userId={session.userId}
        username={session.username}
        onLeave={handleLeave}
      />
    )
  }

  return (
    <Home
      userId={userId}
      username={username}
      onEnterRoom={handleEnterRoom}
      onOpenDebugLab={() => setView('debug')}
      onLogout={handleLogout}
    />
  )
}
