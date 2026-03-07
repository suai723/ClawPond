import type { RefObject } from 'react'
import type { Message } from '../types'

interface MessageListProps {
  messages: Message[]
  currentUserId: string
  messagesEndRef: RefObject<HTMLDivElement | null>
}

function formatTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function renderText(text: string) {
  // 高亮 @mention
  return text.split(/(@[a-zA-Z0-9_\-]+)/g).map((part, i) =>
    part.startsWith('@') ? (
      <span key={i} className="rounded bg-indigo-900/60 px-1 text-indigo-300 font-medium">
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  )
}

export default function MessageList({ messages, currentUserId, messagesEndRef }: MessageListProps) {
  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      <div className="space-y-1">
        {messages.map((msg) => {
          if (msg.type === 'system') {
            return (
              <div key={msg.id} className="flex justify-center py-1">
                <span className="rounded-full bg-gray-800 px-3 py-1 text-xs text-gray-400">
                  {msg.text}
                </span>
              </div>
            )
          }

          const isMe = msg.sender_id === currentUserId
          const isAgent = msg.metadata?.agent === true || msg.sender_id.startsWith('agent-')
          const isDeleted = msg.status === 'deleted'

          if (isMe) {
            return (
              <div key={msg.id} className="flex justify-end gap-2 py-0.5">
                <div className="max-w-[70%]">
                  <div className="mb-1 flex items-baseline justify-end gap-2">
                    <span className="text-xs text-gray-500">{formatTime(msg.created_at)}</span>
                    <span className="text-sm font-medium text-indigo-400">{msg.sender_name}</span>
                  </div>
                  {msg.reply_to && (
                    <div className="mb-1 rounded border-l-2 border-indigo-500 bg-gray-800/50 px-2 py-1 text-xs text-gray-400">
                      回复 #{msg.reply_to}
                    </div>
                  )}
                  <div className="rounded-2xl rounded-tr-sm bg-indigo-600 px-4 py-2.5 text-sm text-white">
                    {isDeleted ? (
                      <span className="italic text-indigo-300">消息已撤回</span>
                    ) : (
                      renderText(msg.text)
                    )}
                  </div>
                </div>
              </div>
            )
          }

          return (
            <div key={msg.id} className="flex gap-2 py-0.5">
              {/* 头像 */}
              <div
                className={`mt-5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                  isAgent
                    ? 'bg-purple-700 text-purple-100'
                    : 'bg-gray-700 text-gray-300'
                }`}
              >
                {isAgent ? '🤖' : msg.sender_name.charAt(0).toUpperCase()}
              </div>

              <div className="max-w-[70%]">
                <div className="mb-1 flex items-baseline gap-2">
                  <span className={`text-sm font-medium ${isAgent ? 'text-purple-400' : 'text-gray-300'}`}>
                    {msg.sender_name}
                  </span>
                  {isAgent && (
                    <span className="rounded-full bg-purple-900/50 px-1.5 py-0.5 text-xs text-purple-400">
                      Agent
                    </span>
                  )}
                  <span className="text-xs text-gray-500">{formatTime(msg.created_at)}</span>
                </div>
                {msg.reply_to && (
                  <div className="mb-1 rounded border-l-2 border-gray-600 bg-gray-800/50 px-2 py-1 text-xs text-gray-400">
                    回复 #{msg.reply_to}
                  </div>
                )}
                <div
                  className={`rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm ${
                    isAgent
                      ? 'bg-purple-900/40 text-purple-100 ring-1 ring-purple-800/50'
                      : 'bg-gray-800 text-gray-100'
                  }`}
                >
                  {isDeleted ? (
                    <span className="italic text-gray-500">消息已撤回</span>
                  ) : (
                    renderText(msg.text)
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <div ref={messagesEndRef} />
    </div>
  )
}
