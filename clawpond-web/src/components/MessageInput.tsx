import { useState, useRef, useEffect, useCallback } from 'react'
import type { MentionTarget } from '../types'

/** 一条 mention 候选项：包含展示名和 agentId（仅 agent 有 agentId） */
interface MentionCandidate {
  username: string
  agentId?: string
}

interface MessageInputProps {
  onSend: (text: string, mentions: MentionTarget[], replyTo?: number) => void
  /** agent 成员列表（含 agentId） */
  agentMembers: MentionCandidate[]
  /** 所有成员用户名（人类 + agent，用于补全） */
  memberNames: string[]
  disabled?: boolean
  replyTo?: number
  onCancelReply?: () => void
}

export default function MessageInput({
  onSend,
  agentMembers,
  memberNames,
  disabled = false,
  replyTo,
  onCancelReply,
}: MessageInputProps) {
  const [text, setText] = useState('')
  const [suggestion, setSuggestion] = useState<{ candidates: MentionCandidate[]; index: number; query: string } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 已确认的 mentions（选中时记录完整结构）
  const confirmedMentionsRef = useRef<Map<string, MentionTarget>>(new Map())

  const agentNames = agentMembers.map((a) => a.username)

  // 自动调整高度
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`
  }, [text])

  /**
   * 从最终文本中提取 mentions：
   * - 优先从 confirmedMentionsRef（用户从选框选择的）取结构化数据
   * - 对于手动输入的 @username，在 agentMembers 中查找 agentId
   * - 普通人类成员不产生 MentionTarget（只发给 agent）
   */
  const extractMentions = (input: string): MentionTarget[] => {
    const rawMatches = input.match(/@([a-zA-Z0-9_\-]+)/g) ?? []
    const usernames = rawMatches.map((m) => m.slice(1))
    const result: MentionTarget[] = []
    const seen = new Set<string>()

    for (const username of usernames) {
      if (seen.has(username)) continue
      seen.add(username)

      // 优先用选框确认的（含 agentId）
      const confirmed = confirmedMentionsRef.current.get(username)
      if (confirmed) {
        result.push(confirmed)
        continue
      }

      // 后备：在 agentMembers 里找（处理手动输入的情况）
      const agentMember = agentMembers.find((a) => a.username.toLowerCase() === username.toLowerCase())
      if (agentMember && agentMember.agentId) {
        result.push({ agentId: agentMember.agentId, username: agentMember.username })
      }
    }

    return result
  }

  const handleInput = useCallback(
    (value: string) => {
      setText(value)

      // 检测是否正在输入 @mention
      const cursorPos = textareaRef.current?.selectionStart ?? value.length
      const beforeCursor = value.slice(0, cursorPos)
      const mentionMatch = beforeCursor.match(/@([a-zA-Z0-9_\-]*)$/)

      if (mentionMatch) {
        const query = mentionMatch[1].toLowerCase()
        // 合并 agent 和普通成员候选列表
        const agentCandidates: MentionCandidate[] = agentMembers.filter(
          (a) => a.username.toLowerCase().includes(query) && a.username.toLowerCase() !== query,
        )
        const humanCandidates: MentionCandidate[] = memberNames
          .filter((name) => !agentNames.includes(name) && name.toLowerCase().includes(query) && name.toLowerCase() !== query)
          .map((name) => ({ username: name }))

        const allCandidates = [...agentCandidates, ...humanCandidates]
        if (allCandidates.length > 0) {
          setSuggestion({ candidates: allCandidates, index: 0, query: mentionMatch[1] })
        } else {
          setSuggestion(null)
        }
      } else {
        setSuggestion(null)
      }
    },
    [agentMembers, memberNames, agentNames],
  )

  const completeMention = useCallback(
    (candidate: MentionCandidate) => {
      if (!textareaRef.current) return
      const cursorPos = textareaRef.current.selectionStart
      const beforeCursor = text.slice(0, cursorPos)
      const afterCursor = text.slice(cursorPos)
      const replaced = beforeCursor.replace(/@([a-zA-Z0-9_\-]*)$/, `@${candidate.username} `)
      const newText = replaced + afterCursor
      setText(newText)
      setSuggestion(null)

      // 记录选框确认的 mention（含 agentId）
      if (candidate.agentId) {
        confirmedMentionsRef.current.set(candidate.username, {
          agentId: candidate.agentId,
          username: candidate.username,
        })
      }

      textareaRef.current.focus()
      const newPos = replaced.length
      setTimeout(() => textareaRef.current?.setSelectionRange(newPos, newPos), 0)
    },
    [text],
  )

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestion) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSuggestion((s) => s && { ...s, index: (s.index + 1) % s.candidates.length })
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSuggestion((s) => s && { ...s, index: (s.index - 1 + s.candidates.length) % s.candidates.length })
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        completeMention(suggestion.candidates[suggestion.index])
        return
      }
      if (e.key === 'Escape') {
        setSuggestion(null)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleSend = () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    const mentions = extractMentions(trimmed)
    onSend(trimmed, mentions, replyTo)
    setText('')
    setSuggestion(null)
    confirmedMentionsRef.current.clear()
    if (onCancelReply) onCancelReply()
  }

  return (
    <div className="border-t border-gray-800 bg-gray-900 px-4 py-3">
      {/* 回复提示 */}
      {replyTo && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-gray-800 px-3 py-1.5 text-xs text-gray-400">
          <span>回复消息 #{replyTo}</span>
          <button onClick={onCancelReply} className="ml-2 text-gray-500 hover:text-gray-300">
            ✕
          </button>
        </div>
      )}

      {/* @mention 补全弹出层 */}
      {suggestion && (
        <div className="mb-2 rounded-lg border border-gray-700 bg-gray-800 py-1 shadow-lg">
          {suggestion.candidates.map((candidate, i) => (
            <button
              key={candidate.username}
              onMouseDown={(e) => {
                e.preventDefault()
                completeMention(candidate)
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm ${
                i === suggestion.index ? 'bg-indigo-600/40 text-indigo-300' : 'text-gray-300 hover:bg-gray-700'
              }`}
            >
              {candidate.agentId ? (
                <span className="text-purple-400">🤖</span>
              ) : (
                <span className="text-gray-500">👤</span>
              )}
              <span>{candidate.username}</span>
              {candidate.agentId && (
                <span className="ml-auto rounded-full bg-purple-900/50 px-1.5 text-xs text-purple-400">
                  Agent
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={disabled ? '连接中...' : '输入消息，@ 提及成员或 Agent...（Enter 发送，Shift+Enter 换行）'}
          rows={1}
          className="flex-1 resize-none rounded-xl border border-gray-700 bg-gray-800 px-4 py-3 text-sm text-gray-100 placeholder-gray-500 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={disabled || !text.trim()}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white transition hover:bg-indigo-700 disabled:opacity-40"
          title="发送 (Enter)"
        >
          <svg className="h-5 w-5 rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
          </svg>
        </button>
      </div>

      <p className="mt-1.5 text-right text-xs text-gray-600">
        输入 @ 触发成员/Agent 补全 · Shift+Enter 换行
      </p>
    </div>
  )
}
