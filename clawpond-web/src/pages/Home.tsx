import { useState, useEffect, useCallback } from 'react'
import { listRooms, createRoom, joinRoom } from '../services/api'
import type { Room } from '../types'

interface HomeProps {
  userId: string
  username: string
  onEnterRoom: (roomId: string, roomPassword: string) => void
  onOpenDebugLab: () => void
  onLogout: () => void
}

export default function Home({ userId, username, onEnterRoom, onOpenDebugLab, onLogout }: HomeProps) {
  const [rooms, setRooms] = useState<Room[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

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
    max_members: 50,
  })
  const [createError, setCreateError] = useState('')
  const [creating, setCreating] = useState(false)

  // 一次性密码展示弹窗（创建房间后显示）
  const [newRoomSecret, setNewRoomSecret] = useState<{
    roomId: string
    roomName: string
    plainPassword: string
  } | null>(null)
  const [passwordCopied, setPasswordCopied] = useState(false)
  const [roomIdCopied, setRoomIdCopied] = useState(false)

  const [searchQuery, setSearchQuery] = useState('')

  const fetchRooms = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await listRooms()
      setRooms(data.rooms)
    } catch (e: unknown) {
      const err = e as { response?: { status?: number; data?: { detail?: string } }; code?: string; message?: string }
      if (err.response) {
        const detail = typeof err.response.data?.detail === 'string' ? err.response.data.detail : undefined
        setError(detail ?? `请求失败 (${err.response.status ?? '未知'})，请检查后端服务`)
      } else if (err.code === 'ERR_NETWORK' || !err.response) {
        setError('无法连接后端。开发时请确保 openclaw-relay 在 http://localhost:8000 运行，且前端通过 npm run dev 启动以使用代理。')
      } else {
        setError('无法加载房间列表，请检查后端服务是否运行')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchRooms()
  }, [fetchRooms])

  const handleJoinClick = (room: Room) => {
    setJoinModal({ roomId: room.id, roomName: room.name })
    setJoinPassword('')
    setJoinError('')
  }

  const handleJoinSubmit = async () => {
    if (!joinModal) return
    setJoining(true)
    setJoinError('')
    try {
      await joinRoom({
        room_id: joinModal.roomId,
        user_id: userId,
        username: username,
        password: joinPassword,
        user_type: 'human',
      })
      setJoinModal(null)
      onEnterRoom(joinModal.roomId, joinPassword)
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setJoinError(msg ?? '加入失败，请检查密码')
    } finally {
      setJoining(false)
    }
  }

  const handleCreateSubmit = async () => {
    setCreating(true)
    setCreateError('')
    try {
      const result = await createRoom(
        {
          name: createForm.name,
          description: createForm.description || undefined,
          max_members: createForm.max_members,
        },
        userId,
        username,
      )
      setCreateModal(false)
      setRooms((prev) => [result, ...prev])
      // 展示一次性密码弹窗（不立即跳转，等用户确认保存密码）
      setNewRoomSecret({
        roomId: result.id,
        roomName: result.name,
        plainPassword: result.plain_password,
      })
      setPasswordCopied(false)
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setCreateError(msg ?? '创建失败')
    } finally {
      setCreating(false)
    }
  }

  const handleCopyRoomId = async () => {
    if (!newRoomSecret) return
    try {
      await navigator.clipboard.writeText(newRoomSecret.roomId)
      setRoomIdCopied(true)
      setTimeout(() => setRoomIdCopied(false), 2000)
    } catch {
      const el = document.createElement('textarea')
      el.value = newRoomSecret.roomId
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setRoomIdCopied(true)
      setTimeout(() => setRoomIdCopied(false), 2000)
    }
  }

  const handleCopyPassword = async () => {
    if (!newRoomSecret) return
    try {
      await navigator.clipboard.writeText(newRoomSecret.plainPassword)
      setPasswordCopied(true)
      setTimeout(() => setPasswordCopied(false), 2000)
    } catch {
      // 降级方案
      const el = document.createElement('textarea')
      el.value = newRoomSecret.plainPassword
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setPasswordCopied(true)
      setTimeout(() => setPasswordCopied(false), 2000)
    }
  }

  const handleEnterNewRoom = () => {
    if (!newRoomSecret) return
    const { roomId, plainPassword } = newRoomSecret
    setNewRoomSecret(null)
    onEnterRoom(roomId, plainPassword)
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

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5">
              <div className="h-2 w-2 rounded-full bg-green-400" />
              <span className="text-sm text-gray-200">{username}</span>
              <span className="text-xs text-gray-500">{userId}</span>
            </div>
            <button
              onClick={onLogout}
              className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-400 hover:border-red-700 hover:text-red-400 transition-colors"
            >
              退出
            </button>
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
                  <span>{room.member_count} / {room.max_members} 人</span>
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
            <p className="mt-3 text-xs text-gray-500">
              密码将由服务端自动生成，创建成功后一次性显示，请妥善保存。
            </p>
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
                disabled={creating || !createForm.name}
                className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
              >
                {creating ? '创建中...' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 一次性密码展示弹窗 */}
      {newRoomSecret && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="w-full max-w-md rounded-xl border border-yellow-700/60 bg-gray-900 p-6">
            <div className="mb-1 flex items-center gap-2 text-yellow-400">
              <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
              <h3 className="text-lg font-semibold">请保存房间密码</h3>
            </div>
            <p className="mb-4 text-sm text-gray-400">
              房间 <span className="font-medium text-gray-200">{newRoomSecret.roomName}</span> 已创建成功。
              以下房间 ID 与密码<span className="text-yellow-400 font-medium">仅显示一次</span>，
              分享给需要加入的成员后请妥善保存。
            </p>
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2">
              <span className="flex-shrink-0 text-xs text-gray-400">房间 ID</span>
              <code className="flex-1 break-all font-mono text-sm text-blue-300 select-all">
                {newRoomSecret.roomId}
              </code>
              <button
                onClick={handleCopyRoomId}
                className="flex-shrink-0 rounded-md border border-gray-600 px-3 py-1.5 text-xs hover:bg-gray-700 transition-colors"
              >
                {roomIdCopied ? '已复制' : '复制'}
              </button>
            </div>
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-3">
              <code className="flex-1 break-all font-mono text-sm text-green-400 select-all">
                {newRoomSecret.plainPassword}
              </code>
              <button
                onClick={handleCopyPassword}
                className="flex-shrink-0 rounded-md border border-gray-600 px-3 py-1.5 text-xs hover:bg-gray-700 transition-colors"
              >
                {passwordCopied ? '已复制' : '复制'}
              </button>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setNewRoomSecret(null)}
                className="flex-1 rounded-lg border border-gray-700 py-2 text-sm hover:bg-gray-800"
              >
                稍后进入
              </button>
              <button
                onClick={handleEnterNewRoom}
                className="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium hover:bg-indigo-700"
              >
                进入房间
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
