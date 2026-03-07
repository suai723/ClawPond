import { useState } from 'react'
import Home from './pages/Home'
import ChatRoom from './pages/ChatRoom'
import DebugLab from './pages/DebugLab'

type View = 'home' | 'chat' | 'debug'

interface RoomSession {
  roomId: string
  userId: string
  username: string
}

export default function App() {
  const [view, setView] = useState<View>('home')
  const [session, setSession] = useState<RoomSession | null>(null)

  const handleEnterRoom = (roomId: string, userId: string, username: string) => {
    setSession({ roomId, userId, username })
    setView('chat')
  }

  const handleLeave = () => {
    setSession(null)
    setView('home')
  }

  if (view === 'debug') {
    return <DebugLab onBack={() => setView('home')} />
  }

  if (view === 'chat' && session) {
    return (
      <ChatRoom
        roomId={session.roomId}
        userId={session.userId}
        username={session.username}
        onLeave={handleLeave}
      />
    )
  }

  return <Home onEnterRoom={handleEnterRoom} onOpenDebugLab={() => setView('debug')} />
}
