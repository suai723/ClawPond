import { useState, useEffect, useCallback } from 'react'
import { listRooms, createRoom, joinRoom, getRoomMembers } from '../services/api'
import type { Room } from '../types'

interface HomeProps {
  onEnterRoom: (roomId: string, userId: string, username: string) => void
  onOpenDebugLab: () => void
}

export default function Home({ onEnterRoom, onOpenDebugLab }: HomeProps) {
  const [rooms, setRooms] = useState<Room[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 登录表单
  const [username, setUsername] = useState(() => localStorage.getItem('cp_username') ?? '')
  const [userId] = useState(() => {
    const stored = localStorage.getItem('cp_user_id')
    if (stored) return stored
    const id = `user-${Date.now()}`
    localStorage.setItem('cp_user_id', id)
    return id
  })

  // 加入房间弹窗
  const [joinModal, setJoinModal] = useState<{ roomId: string; roomName: string } | null>(null)
  const [joinPassword, setJoinPassword] = useState('')
  const [joinError, setJoinError] = useState('')
  const [joining, setJoining] = useState(false)

  // 创建房间弹窗
  const [createModal, setCreateModal] = useState(false)
  const [createForm, setCreateForm] = useState({
    name: '',
    description: '',
    password: '',
    max_members: 50,
  })
  const [createError, setCreateError] = useState('')
  const [creating, setCreating] = useState(false)

  const [searchQuery, setSearchQuery] = useState('')

  const [roomOnlineCounts, setRoomOnlineCounts] = useState<
    Record<string, { humans: number; agents: number }>
  >({})

  const fetchOnlineCounts = useCallback(async (rooms: Room[]) => {
    const results = await Promise.allSettled(rooms.map((r) => getRoomMembers(r.id)))
    const counts: Record<string, { humans: number; agents: number }> = {}
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        const online = result.value.filter((m) => m.status === 'online')
        counts[rooms[i].id] = {
          humans: online.filter((m) => m.user_type === 'human').length,
          agents: online.filter((m) => m.user_type === 'agent').length,
        }
      }
    })
    setRoomOnlineCounts(counts)
  }, [])

  const fetchRooms = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await listRooms()
      setRooms(data.rooms)
      fetchOnlineCounts(data.rooms)
    } catch {
      setError('无法加载房间列表，请检查后端服务是否运行')
    } finally {
      setLoading(false)
    }
  }, [fetchOnlineCounts])

  useEffect(() => {
    fetchRooms()
  }, [fetchRooms])

  useEffect(() => {
    const timer = setInterval(() => {
      setRooms((prev) => {
        if (prev.length > 0) fetchOnlineCounts(prev)
        return prev
      })
    }, 30000)
    return () => clearInterval(timer)
  }, [fetchOnlineCounts])

  const handleSaveUsername = () => {
    if (!username.trim()) return
    localStorage.setItem('cp_username', username.trim())
  }

  const handleJoinClick = (room: Room) => {
    if (!username.trim()) {
      setError('请先设置用户名')
      return
    }
    setJoinModal({ roomId: room.id, roomName: room.name })
    setJoinPassword('')
    setJoinError('')
  }

  const handleJoinSubmit = async () => {
    if (!joinModal) return
    setJoining(true)
    setJoinError('')
    try {
      await joinRoom(joinModal.roomId, {
        user_id: userId,
        username: username.trim(),
        password: joinPassword,
        user_type: 'human',
      })
      setJoinModal(null)
      onEnterRoom(joinModal.roomId, userId, username.trim())
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setJoinError(msg ?? '加入失败，请检查密码')
    } finally {
      setJoining(false)
    }
  }

  const handleCreateSubmit = async () => {
    if (!username.trim()) {
      setCreateError('请先设置用户名')
      return
    }
    setCreating(true)
    setCreateError('')
    try {
      const room = await createRoom(
        {
          name: createForm.name,
          description: createForm.description || undefined,
          password: createForm.password,
          max_members: createForm.max_members,
        },
        userId,
        username.trim(),
      )
      setCreateModal(false)
      setRooms((prev) => [room, ...prev])
      // 创建者自动加入
      onEnterRoom(room.id, userId, username.trim())
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setCreateError(msg ?? '创建失败')
    } finally {
      setCreating(false)
    }
  }

  const filteredRooms = rooms.filter(
    (r) =>
      r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (r.description ?? '').toLowerCase().includes(searchQuery.toLowerCase()),
  )

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900 px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 text-lg font-bold">
              C
            </div>
            <div>
              <h1 className="text-lg font-semibold">ClawPond</h1>
              <p className="text-xs text-gray-400">OpenClaw Multi-Agent Relay</p>
            </div>
          </div>

          {/* 用户名设置 */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onBlur={handleSaveUsername}
              placeholder="输入你的用户名"
              className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-xl font-semibold">聊天室列表</h2>
          <div className="flex gap-2">
            <button
              onClick={fetchRooms}
              className="rounded-lg border border-gray-700 px-4 py-2 text-sm hover:bg-gray-800"
            >
              刷新
            </button>
            <button
              onClick={onOpenDebugLab}
              className="rounded-lg border border-amber-700/60 px-4 py-2 text-sm text-amber-400 hover:bg-amber-900/20"
            >
              调试实验室
            </button>
            <button
              onClick={() => {
                if (!username.trim()) {
                  setError('请先设置用户名')
                  return
                }
                setCreateModal(true)
                setCreateError('')
              }}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-700"
            >
              创建房间
            </button>
          </div>
        </div>

        <div className="relative mb-4">
          <svg
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
            />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索房间名称或描述..."
            className="w-full rounded-lg border border-gray-700 bg-gray-800 py-2 pl-9 pr-4 text-sm placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-900/40 border border-red-800 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20 text-gray-500">加载中...</div>
        ) : rooms.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-500">
            <p className="mb-2 text-lg">暂无房间</p>
            <p className="text-sm">创建第一个聊天室开始协作</p>
          </div>
        ) : filteredRooms.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-500">
            <p className="mb-2 text-lg">未找到匹配的房间</p>
            <p className="text-sm">试试其他关键词</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredRooms.map((room) => (
              <div
                key={room.id}
                className="flex flex-col rounded-xl border border-gray-800 bg-gray-900 p-5 transition hover:border-gray-700"
              >
                <div className="mb-3 flex items-start justify-between">
                  <h3 className="font-semibold text-gray-100">{room.name}</h3>
                  <span className="rounded-full bg-green-900/50 px-2 py-0.5 text-xs text-green-400">
                    {room.status}
                  </span>
                </div>
                {room.description && (
                  <p className="mb-3 text-sm text-gray-400 line-clamp-2">{room.description}</p>
                )}
                <div className="mt-auto flex items-center justify-between text-xs text-gray-500">
                  <span>
                    {roomOnlineCounts[room.id]
                      ? `${roomOnlineCounts[room.id].humans} 人 / ${roomOnlineCounts[room.id].agents} 智能体`
                      : `${room.member_count} / ${room.max_members} 人`}
                  </span>
                </div>
                <button
                  onClick={() => handleJoinClick(room)}
                  className="mt-3 w-full rounded-lg bg-indigo-600/80 py-2 text-sm font-medium hover:bg-indigo-600"
                >
                  加入房间
                </button>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* 加入房间弹窗 */}
      {joinModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-sm rounded-xl border border-gray-700 bg-gray-900 p-6">
            <h3 className="mb-4 text-lg font-semibold">加入 {joinModal.roomName}</h3>
            <input
              type="password"
              value={joinPassword}
              onChange={(e) => setJoinPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleJoinSubmit()}
              placeholder="请输入房间密码"
              autoFocus
              className="mb-3 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
            {joinError && <p className="mb-3 text-sm text-red-400">{joinError}</p>}
            <div className="flex gap-2">
              <button
                onClick={() => setJoinModal(null)}
                className="flex-1 rounded-lg border border-gray-700 py-2 text-sm hover:bg-gray-800"
              >
                取消
              </button>
              <button
                onClick={handleJoinSubmit}
                disabled={joining}
                className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
              >
                {joining ? '加入中...' : '确认加入'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 创建房间弹窗 */}
      {createModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 p-6">
            <h3 className="mb-4 text-lg font-semibold">创建新房间</h3>
            <div className="space-y-3">
              <input
                type="text"
                value={createForm.name}
                onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="房间名称（必填）"
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <input
                type="text"
                value={createForm.description}
                onChange={(e) => setCreateForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="描述（可选）"
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <input
                type="password"
                value={createForm.password}
                onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="房间密码（至少4位）"
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-400">最大成员数</label>
                <input
                  type="number"
                  value={createForm.max_members}
                  onChange={(e) =>
                    setCreateForm((f) => ({ ...f, max_members: parseInt(e.target.value) || 50 }))
                  }
                  min={2}
                  max={1000}
                  className="w-24 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>
            {createError && <p className="mt-2 text-sm text-red-400">{createError}</p>}
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setCreateModal(false)}
                className="flex-1 rounded-lg border border-gray-700 py-2 text-sm hover:bg-gray-800"
              >
                取消
              </button>
              <button
                onClick={handleCreateSubmit}
                disabled={creating || !createForm.name || !createForm.password}
                className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
              >
                {creating ? '创建中...' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
