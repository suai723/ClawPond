import { useState, useEffect, useRef, useCallback } from 'react'
import { listRooms } from '../services/api'
import { useSimulatedAgents } from '../hooks/useSimulatedAgents'
import type { Room, OnlineMember, MentionTarget } from '../types'
import type { SimulatedAgent } from '../hooks/useSimulatedAgents'

interface DebugLabProps {
  onBack: () => void
}

// ─── 状态徽章 ────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: SimulatedAgent['status'] }) {
  const map: Record<SimulatedAgent['status'], { dot: string; label: string }> = {
    idle:         { dot: 'bg-gray-500',   label: '空闲' },
    connecting:   { dot: 'bg-yellow-400 animate-pulse', label: '连接中' },
    connected:    { dot: 'bg-green-400',  label: '已连接' },
    disconnected: { dot: 'bg-gray-600',   label: '已断开' },
    error:        { dot: 'bg-red-400',    label: '错误' },
  }
  const { dot, label } = map[status]
  return (
    <span className="flex items-center gap-1 text-xs text-gray-400">
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  )
}

// ─── 单个 Agent 卡片 ─────────────────────────────────────────────────────────

interface AgentCardProps {
  agent: SimulatedAgent
  rooms: Room[]
  onlineMembers: OnlineMember[]
  onRemove: (id: string) => void
  onJoin: (localId: string, roomId: string, password: string) => void
  onLeave: (id: string) => void
  onSend: (id: string, text: string, mentions: MentionTarget[]) => void
  onInputChange: (id: string, text: string) => void
  globalRoomId: string
  globalPassword: string
}

function AgentCard({
  agent, rooms, onlineMembers, onRemove, onJoin, onLeave, onSend, onInputChange,
  globalRoomId, globalPassword,
}: AgentCardProps) {
  const [localRoom, setLocalRoom] = useState(globalRoomId)
  const [localPass, setLocalPass] = useState(globalPassword)

  useEffect(() => { setLocalRoom(globalRoomId) }, [globalRoomId])
  useEffect(() => { setLocalPass(globalPassword) }, [globalPassword])

  const isConnected = agent.status === 'connected'
  const isBusy = agent.status === 'connecting'

  const handleSend = () => {
    const text = agent.inputText.trim()
    if (!text) return

    // 从文本中提取 @mention，在在线 agent 成员里查 agentId
    const rawMatches = text.match(/@([a-zA-Z0-9_\-]+)/g) ?? []
    const mentions: MentionTarget[] = []
    const seen = new Set<string>()
    for (const raw of rawMatches) {
      const username = raw.slice(1)
      if (seen.has(username)) continue
      seen.add(username)
      const member = onlineMembers.find(
        (m) => m.user_type === 'agent' && m.username.toLowerCase() === username.toLowerCase() && m.agent_id,
      )
      if (member?.agent_id) {
        mentions.push({ agentId: member.agent_id, username: member.username })
      }
    }

    onSend(agent.localId, text, mentions)
  }

  return (
    <div
      className="rounded-xl border bg-gray-900 p-3 transition"
      style={{ borderColor: agent.color + '55' }}
    >
      {/* 头部：名称 + 类型 + 状态 + 删除 */}
      <div className="mb-2 flex items-center gap-2">
        <span
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-gray-900"
          style={{ backgroundColor: agent.color }}
        >
          {agent.username[0]?.toUpperCase() ?? '?'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-gray-100">{agent.username}</span>
            <span
              className="rounded px-1 py-0.5 text-xs"
              style={{ backgroundColor: agent.color + '30', color: agent.color }}
            >
              {agent.userType}
            </span>
          </div>
          <StatusBadge status={agent.status} />
        </div>
        <button
          onClick={() => onRemove(agent.localId)}
          className="flex-shrink-0 rounded p-1 text-gray-600 hover:bg-gray-800 hover:text-red-400"
          title="移除"
        >
          ✕
        </button>
      </div>

      {/* user_id / agent_id 展示 */}
      <div className="mb-2 space-y-1">
        <div className="truncate rounded bg-gray-800 px-2 py-1 font-mono text-xs text-gray-500">
          {agent.userId}
        </div>
        {agent.agentId && (
          <div className="flex items-center gap-1 truncate rounded bg-gray-800 px-2 py-1 font-mono text-xs">
            <span className="flex-shrink-0 text-purple-500">id:</span>
            <span className="truncate text-purple-300">{agent.agentId}</span>
          </div>
        )}
      </div>

      {!isConnected ? (
        /* 加入房间区 */
        <div className="space-y-1.5">
          <select
            value={localRoom}
            onChange={(e) => setLocalRoom(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 focus:border-indigo-500 focus:outline-none"
          >
            <option value="">— 选择房间 —</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <input
            type="password"
            value={localPass}
            onChange={(e) => setLocalPass(e.target.value)}
            placeholder="房间密码"
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:border-indigo-500 focus:outline-none"
          />
          <button
            onClick={() => localRoom && onJoin(agent.localId, localRoom, localPass)}
            disabled={!localRoom || isBusy}
            className="w-full rounded-lg bg-indigo-600 py-1.5 text-xs font-medium hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isBusy ? '连接中...' : '加入房间'}
          </button>
        </div>
      ) : (
        /* 已连接：发消息 + 离开 */
        <div className="space-y-1.5">
          <div className="truncate rounded bg-gray-800 px-2 py-1 text-xs text-gray-400">
            房间：{rooms.find((r) => r.id === agent.roomId)?.name ?? agent.roomId}
          </div>
          <div className="flex gap-1">
            <input
              type="text"
              value={agent.inputText}
              onChange={(e) => onInputChange(agent.localId, e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
              placeholder="输入消息..."
              className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:border-indigo-500 focus:outline-none"
            />
            <button
              onClick={handleSend}
              disabled={!agent.inputText.trim()}
              className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-40"
              style={{ backgroundColor: agent.color }}
            >
              发
            </button>
          </div>
          <button
            onClick={() => onLeave(agent.localId)}
            className="w-full rounded-lg border border-gray-700 py-1.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-red-400"
          >
            离开房间
          </button>
        </div>
      )}
    </div>
  )
}

// ─── 主页面 ──────────────────────────────────────────────────────────────────

export default function DebugLab({ onBack }: DebugLabProps) {
  const {
    agents, feed, onlineMembers,
    addAgent, removeAgent, joinRoom, leaveRoom,
    sendMessage, setInputText, clearFeed, refreshOnlineMembers,
  } = useSimulatedAgents()

  const [rooms, setRooms] = useState<Room[]>([])
  const [roomsLoading, setRoomsLoading] = useState(false)

  // 全局默认值（填入所有 Agent 卡片）
  const [globalRoomId, setGlobalRoomId] = useState('')
  const [globalPassword, setGlobalPassword] = useState('')

  // 添加 Agent 表单
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<'human' | 'agent'>('agent')

  const feedRef = useRef<HTMLDivElement>(null)

  // 自动滚动到底部
  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [feed])

  const fetchRooms = useCallback(async () => {
    setRoomsLoading(true)
    try {
      const data = await listRooms(1, 50)
      setRooms(data.rooms)
    } catch {
      // 忽略错误
    } finally {
      setRoomsLoading(false)
    }
  }, [])

  useEffect(() => { fetchRooms() }, [fetchRooms])

  const handleAddAgent = () => {
    const name = newName.trim() || `${newType === 'agent' ? 'Agent' : 'User'}${agents.length + 1}`
    addAgent(name, newType)
    setNewName('')
  }

  const handleJoinAll = () => {
    if (!globalRoomId || !globalPassword) return
    agents.forEach((a) => {
      if (a.status === 'idle' || a.status === 'disconnected' || a.status === 'error') {
        joinRoom(a.localId, globalRoomId, globalPassword)
      }
    })
  }

  const handleLeaveAll = () => {
    agents.forEach((a) => {
      if (a.status === 'connected') leaveRoom(a.localId)
    })
  }

  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    } catch {
      return ''
    }
  }

  return (
    <div className="flex h-screen flex-col bg-gray-950 text-gray-100">
      {/* ── Header ── */}
      <header className="flex flex-shrink-0 items-center justify-between border-b border-gray-800 bg-gray-900 px-5 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-400 hover:bg-gray-800 hover:text-gray-200"
          >
            ← 返回
          </button>
          <div>
            <h1 className="text-base font-semibold">调试实验室</h1>
            <p className="text-xs text-gray-500">模拟多 Agent / Human 调试 WebSocket 协议</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>{agents.length} 个模拟用户</span>
          <span>·</span>
          <span>{agents.filter((a) => a.status === 'connected').length} 已连接</span>
        </div>
      </header>

      {/* ── 三栏主体 ── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">

        {/* ── 左栏：Agent 管理 ── */}
        <aside className="flex w-72 flex-shrink-0 flex-col border-r border-gray-800">
          <div className="flex-shrink-0 border-b border-gray-800 p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
              模拟用户
            </p>

            {/* 添加新 Agent */}
            <div className="flex gap-1.5">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddAgent()}
                placeholder="名称（可选）"
                className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:border-indigo-500 focus:outline-none"
              />
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value as 'human' | 'agent')}
                className="rounded-lg border border-gray-700 bg-gray-800 px-1.5 py-1.5 text-xs text-gray-200 focus:border-indigo-500 focus:outline-none"
              >
                <option value="agent">agent</option>
                <option value="human">human</option>
              </select>
              <button
                onClick={handleAddAgent}
                className="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium hover:bg-indigo-700"
              >
                +
              </button>
            </div>

            {/* 全局批量操作 */}
            {agents.length > 1 && (
              <div className="mt-2 flex gap-1.5">
                <button
                  onClick={handleJoinAll}
                  disabled={!globalRoomId}
                  className="flex-1 rounded-lg border border-indigo-700/60 py-1 text-xs text-indigo-400 hover:bg-indigo-900/30 disabled:opacity-40"
                >
                  全部加入
                </button>
                <button
                  onClick={handleLeaveAll}
                  className="flex-1 rounded-lg border border-gray-700 py-1 text-xs text-gray-400 hover:bg-gray-800"
                >
                  全部离开
                </button>
              </div>
            )}
          </div>

          {/* Agent 卡片列表 */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {agents.length === 0 ? (
              <p className="py-8 text-center text-xs text-gray-600">
                点击「+」添加模拟用户
              </p>
            ) : (
              agents.map((agent) => (
                <AgentCard
                  key={agent.localId}
                  agent={agent}
                  rooms={rooms}
                  onlineMembers={onlineMembers}
                  onRemove={removeAgent}
                  onJoin={joinRoom}
                  onLeave={leaveRoom}
                  onSend={sendMessage}
                  onInputChange={setInputText}
                  globalRoomId={globalRoomId}
                  globalPassword={globalPassword}
                />
              ))
            )}
          </div>
        </aside>

        {/* ── 中栏：消息流 ── */}
        <main className="flex flex-1 flex-col min-w-0">
          <div className="flex flex-shrink-0 items-center justify-between border-b border-gray-800 px-4 py-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              消息流 · {feed.length} 条
            </p>
            <button
              onClick={clearFeed}
              className="rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-800 hover:text-gray-400"
            >
              清空
            </button>
          </div>

          <div
            ref={feedRef}
            className="flex-1 overflow-y-auto px-4 py-3 space-y-2"
          >
            {feed.length === 0 ? (
              <div className="flex h-full items-center justify-center text-gray-700 text-sm">
                暂无消息，让模拟用户加入房间后开始发送
              </div>
            ) : (
              feed.map((item, idx) => {
                if (item.kind === 'event') {
                  const { data } = item
                  return (
                    <div
                      key={data.id ?? idx}
                      className="flex items-center gap-2 py-0.5"
                    >
                      <span className="text-xs text-gray-700">─────</span>
                      <span
                        className="text-xs"
                        style={{ color: data.type === 'error' ? '#f87171' : '#6b7280' }}
                      >
                        {data.text}
                      </span>
                      <span className="text-xs text-gray-700">─────</span>
                      <span className="ml-auto text-xs text-gray-700">{formatTime(data.timestamp)}</span>
                    </div>
                  )
                }

                const { data: msg } = item
                const isSystem = msg.type === 'system'
                return (
                  <div key={msg.id ?? idx} className="flex gap-2.5">
                    {/* 头像 */}
                    <div
                      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-gray-900"
                      style={{ backgroundColor: msg.agentColor }}
                    >
                      {msg.sender_name?.[0]?.toUpperCase() ?? '?'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span
                          className="text-sm font-medium"
                          style={{ color: msg.agentColor }}
                        >
                          {msg.sender_name}
                        </span>
                        <span className="text-xs text-gray-600">{formatTime(msg.created_at)}</span>
                        {isSystem && (
                          <span className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-500">
                            system
                          </span>
                        )}
                        {msg.reply_to && (
                          <span className="text-xs text-gray-600">↩ #{msg.reply_to}</span>
                        )}
                      </div>
                      <p className="mt-0.5 break-words text-sm text-gray-200">{msg.text}</p>
                      {msg.mentions && msg.mentions.length > 0 && (
                        <div className="mt-1 flex gap-1">
                          {msg.mentions.map((m, i) => {
                            const label = typeof m === 'string' ? m : m.username
                            const key = typeof m === 'string' ? m : (m.agentId ?? m.username ?? i)
                            return (
                              <span
                                key={key}
                                className="rounded bg-indigo-900/40 px-1.5 py-0.5 text-xs text-indigo-400"
                              >
                                @{label}
                              </span>
                            )
                          })}
                        </div>
                      )}
                    </div>
                    <div className="flex-shrink-0 text-xs text-gray-700">
                      #{msg.message_id}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </main>

        {/* ── 右栏：房间 & 成员 ── */}
        <aside className="flex w-64 flex-shrink-0 flex-col border-l border-gray-800">
          {/* 房间列表 */}
          <div className="flex-shrink-0 border-b border-gray-800 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">可用房间</p>
              <button
                onClick={fetchRooms}
                disabled={roomsLoading}
                className="rounded px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-800 hover:text-gray-400 disabled:opacity-40"
              >
                {roomsLoading ? '...' : '刷新'}
              </button>
            </div>

            <div className="max-h-40 space-y-1 overflow-y-auto">
              {rooms.map((room) => (
                <button
                  key={room.id}
                  onClick={() => setGlobalRoomId(room.id)}
                  className={`w-full rounded-lg px-2.5 py-2 text-left text-xs transition ${
                    globalRoomId === room.id
                      ? 'bg-indigo-600/30 border border-indigo-600/50 text-indigo-300'
                      : 'border border-transparent text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                  }`}
                >
                  <div className="font-medium">{room.name}</div>
                  <div className="text-gray-600">{room.member_count}/{room.max_members} 人</div>
                </button>
              ))}
              {rooms.length === 0 && !roomsLoading && (
                <p className="py-4 text-center text-xs text-gray-700">无可用房间</p>
              )}
            </div>

            {/* 全局密码 */}
            <div className="mt-2">
              <label className="mb-1 block text-xs text-gray-600">默认密码</label>
              <input
                type="password"
                value={globalPassword}
                onChange={(e) => setGlobalPassword(e.target.value)}
                placeholder="填写后同步到所有 Agent"
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            {/* 选中的房间 ID */}
            {globalRoomId && (
              <div className="mt-1.5 truncate rounded bg-gray-800 px-2 py-1 font-mono text-xs text-gray-600">
                {globalRoomId}
              </div>
            )}
          </div>

          {/* 在线成员 */}
          <div className="flex min-h-0 flex-1 flex-col p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                在线成员 · {onlineMembers.length}
              </p>
              <button
                onClick={refreshOnlineMembers}
                className="rounded px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-800 hover:text-gray-400"
              >
                刷新
              </button>
            </div>
            <div className="flex-1 space-y-1 overflow-y-auto">
              {onlineMembers.length === 0 ? (
                <p className="py-4 text-center text-xs text-gray-700">暂无在线成员</p>
              ) : (
                onlineMembers.map((m) => {
                  // 找到对应的模拟 agent 颜色
                  const matchedAgent = agents.find((a) => a.userId === m.user_id)
                  return (
                    <div key={m.user_id} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
                      <div
                        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-gray-900"
                        style={{ backgroundColor: matchedAgent?.color ?? '#6b7280' }}
                      >
                        {m.username[0]?.toUpperCase() ?? '?'}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-gray-300">{m.username}</div>
                        <div className="text-xs text-gray-600">{m.user_type} · {m.role}</div>
                      </div>
                      <span className="text-xs text-gray-700">{m.message_count}</span>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
