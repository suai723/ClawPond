import { useState } from 'react'
import { register, login } from '../services/api'

interface AuthProps {
  onAuthenticated: (userId: string, username: string, token: string) => void
}

type Tab = 'login' | 'register'

export default function Auth({ onAuthenticated }: AuthProps) {
  const [tab, setTab] = useState<Tab>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async () => {
    setError('')
    if (!username.trim() || !password) {
      setError('用户名和密码不能为空')
      return
    }
    if (tab === 'register' && password !== confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }

    setLoading(true)
    try {
      const res =
        tab === 'login'
          ? await login(username.trim(), password)
          : await register(username.trim(), password)

      localStorage.setItem('cp_token', res.access_token)
      localStorage.setItem('cp_user_id', res.user_id)
      localStorage.setItem('cp_username', res.username)
      onAuthenticated(res.user_id, res.username, res.access_token)
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(detail ?? (tab === 'login' ? '登录失败，请检查用户名或密码' : '注册失败，请稍后重试'))
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit()
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600 text-2xl font-bold text-white shadow-lg">
            C
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold text-gray-100">ClawPond</h1>
            <p className="mt-1 text-sm text-gray-400">OpenClaw Multi-Agent Relay</p>
          </div>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-gray-800 bg-gray-900 p-8 shadow-xl">
          {/* Tabs */}
          <div className="mb-6 flex rounded-lg bg-gray-800 p-1">
            <button
              onClick={() => { setTab('login'); setError('') }}
              className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
                tab === 'login'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              登录
            </button>
            <button
              onClick={() => { setTab('register'); setError('') }}
              className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
                tab === 'register'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              注册
            </button>
          </div>

          {/* Form */}
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-400">用户名</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入用户名"
                autoFocus
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-400">密码</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={tab === 'register' ? '至少 6 位' : '输入密码'}
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            {tab === 'register' && (
              <div>
                <label className="mb-1.5 block text-xs font-medium text-gray-400">确认密码</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="再次输入密码"
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
                />
              </div>
            )}

            {error && (
              <div className="rounded-lg bg-red-900/40 border border-red-800 px-3 py-2.5 text-sm text-red-300">
                {error}
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={loading}
              className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {loading ? (tab === 'login' ? '登录中...' : '注册中...') : tab === 'login' ? '登录' : '注册'}
            </button>
          </div>
        </div>

        <p className="mt-4 text-center text-xs text-gray-600">
          {tab === 'login' ? '还没有账号？' : '已有账号？'}
          <button
            onClick={() => { setTab(tab === 'login' ? 'register' : 'login'); setError('') }}
            className="ml-1 text-indigo-400 hover:text-indigo-300"
          >
            {tab === 'login' ? '立即注册' : '去登录'}
          </button>
        </p>
      </div>
    </div>
  )
}
