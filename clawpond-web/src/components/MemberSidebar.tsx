import { useState, useEffect } from 'react'
import { listAgents } from '../services/api'
import type { OnlineMember, AgentInfo } from '../types'

interface MemberSidebarProps {
  members: OnlineMember[]
  currentUserId: string
  roomId: string
}

export default function MemberSidebar({ members, currentUserId, roomId }: MemberSidebarProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [activeTab, setActiveTab] = useState<'online' | 'agents'>('online')

  useEffect(() => {
    listAgents(roomId)
      .then((data) => setAgents(data.agents))
      .catch(console.error)

    const timer = setInterval(() => {
      listAgents(roomId)
        .then((data) => setAgents(data.agents))
        .catch(console.error)
    }, 15000)

    return () => clearInterval(timer)
  }, [roomId])

  const humans = members.filter((m) => m.user_type !== 'agent' && m.user_type !== 'system')
  const onlineAgents = members.filter((m) => m.user_type === 'agent')

  return (
    <aside className="flex w-56 shrink-0 flex-col border-l border-gray-800 bg-gray-900">
      {/* Tab switcher */}
      <div className="flex border-b border-gray-800">
        <button
          onClick={() => setActiveTab('online')}
          className={`flex-1 px-3 py-2.5 text-xs font-medium ${
            activeTab === 'online'
              ? 'border-b-2 border-indigo-500 text-indigo-400'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          在线 ({members.length})
        </button>
        <button
          onClick={() => setActiveTab('agents')}
          className={`flex-1 px-3 py-2.5 text-xs font-medium ${
            activeTab === 'agents'
              ? 'border-b-2 border-purple-500 text-purple-400'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Agents ({agents.length})
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {activeTab === 'online' && (
          <div className="space-y-4">
            {/* 人类成员 */}
            {humans.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
                  用户 — {humans.length}
                </p>
                <div className="space-y-1">
                  {humans.map((m) => (
                    <div key={m.user_id} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
                      <div className="relative">
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-700 text-xs font-bold text-gray-300">
                          {m.username.charAt(0).toUpperCase()}
                        </div>
                        <div className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-gray-900 bg-green-400" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-gray-200">
                          {m.username}
                          {m.user_id === currentUserId && (
                            <span className="ml-1 text-gray-500">(你)</span>
                          )}
                        </p>
                        <p className="text-xs text-gray-600">{m.role}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 在线 Agent */}
            {onlineAgents.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Agent — {onlineAgents.length}
                </p>
                <div className="space-y-1">
                  {onlineAgents.map((m) => (
                    <div key={m.user_id} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
                      <div className="relative">
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-purple-800 text-sm">
                          🤖
                        </div>
                        <div className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-gray-900 bg-green-400" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-purple-300">{m.username}</p>
                        <p className="text-xs text-gray-600">Agent</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {members.length === 0 && (
              <p className="text-center text-xs text-gray-600 py-4">暂无在线成员</p>
            )}
          </div>
        )}

        {activeTab === 'agents' && (
          <div className="space-y-3">
            {agents.length === 0 ? (
              <div className="py-6 text-center">
                <p className="text-xs text-gray-500">暂无已注册 Agent</p>
                <p className="mt-1 text-xs text-gray-600">通过 MCP 或 API 注册 Agent</p>
              </div>
            ) : (
              agents.map((agent) => (
                <div
                  key={agent.agent_id}
                  className="rounded-lg border border-gray-800 bg-gray-800/50 p-3"
                >
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-base">🤖</span>
                    <span className="text-sm font-medium text-purple-300">{agent.name}</span>
                    <span
                      className={`ml-auto rounded-full px-1.5 py-0.5 text-xs ${
                        agent.status === 'online'
                          ? 'bg-green-900/50 text-green-400'
                          : agent.status === 'processing'
                          ? 'bg-yellow-900/50 text-yellow-400'
                          : 'bg-gray-700 text-gray-500'
                      }`}
                    >
                      {agent.status}
                    </span>
                  </div>

                  {agent.agent_card.description && (
                    <p className="mb-1.5 text-xs text-gray-400 line-clamp-2">
                      {agent.agent_card.description}
                    </p>
                  )}

                  {agent.agent_card.skills.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {agent.agent_card.skills.slice(0, 3).map((skill) => (
                        <span
                          key={skill}
                          className="rounded-full bg-purple-900/40 px-1.5 py-0.5 text-xs text-purple-400"
                        >
                          {skill}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="mt-2 text-xs text-gray-600">
                    <span>调用 {agent.call_count} 次</span>
                    <span className="ml-2 truncate">· {agent.endpoint}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* MCP 接入提示 */}
      {activeTab === 'agents' && (
        <div className="border-t border-gray-800 p-3">
          <p className="text-xs text-gray-600">
            MCP SSE 端点：
            <code className="ml-1 rounded bg-gray-800 px-1 text-gray-400">
              /mcp/sse
            </code>
          </p>
        </div>
      )}
    </aside>
  )
}
