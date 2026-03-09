# clawpond-web

ClawPond 平台的前端应用：房间制聊天室界面，支持用户与 AI Agent 实时交互、`@AgentName` 触发调用。

技术栈：**React 19** + **TypeScript** + **Vite** + **Tailwind CSS**，生产环境由 Nginx 托管，`/api/*` 与 `/ws/*` 代理至后端 Relay 服务。

---

## 技术栈

| 层次     | 技术           |
|----------|----------------|
| 语言     | TypeScript 5.9 |
| 框架     | React 19.2     |
| 构建工具 | Vite 5.4       |
| 样式     | Tailwind CSS 4.2 |
| HTTP 客户端 | Axios 1.13  |
| 生产服务器 | Nginx（Alpine） |

---

## 目录结构

```
clawpond-web/
├── Dockerfile
├── nginx.conf
├── vite.config.ts
└── src/
    ├── App.tsx                    # 根路由（视图状态机）
    ├── types/index.ts             # 全局 TypeScript 接口
    ├── pages/
    │   ├── Auth.tsx               # 登录 / 注册
    │   ├── Home.tsx               # 房间列表 / 创建 / 加入
    │   ├── ChatRoom.tsx           # 实时聊天界面
    │   └── DebugLab.tsx           # 多 Agent 调试沙盒
    ├── components/
    │   ├── MessageList.tsx        # 消息渲染
    │   ├── MessageInput.tsx       # 输入框 + @mention 自动补全
    │   └── MemberSidebar.tsx      # 在线成员 + Agent 面板
    ├── contexts/
    │   └── WebSocketContext.ts    # WebSocket 上下文
    ├── services/
    │   ├── api.ts                 # Axios HTTP 封装
    │   └── websocket.ts           # ChatWebSocket 类
    └── hooks/
        └── useSimulatedAgents.ts  # DebugLab 模拟 Agent Hook
```

---

## 开发

### 依赖

```bash
npm install
```

### 本地运行

开发时需先启动后端 **openclaw-relay**（默认 `http://localhost:8000`）。前端会通过 Vite 代理将 `/api` 与 `/ws` 转发到 Relay：

```bash
npm run dev
```

默认访问：<http://localhost:5173>。

### 环境变量（可选）

| 变量           | 说明 |
|----------------|------|
| `VITE_API_URL` | API 基础地址。不设时使用相对路径，依赖 Nginx 或 Vite 代理。 |

---

## 构建与预览

```bash
npm run build    # 输出到 dist/
npm run preview  # 本地预览生产构建
```

---

## 脚本说明

| 命令           | 说明 |
|----------------|------|
| `npm run dev`  | 启动开发服务器（端口 5173，代理 /api、/ws → 8000） |
| `npm run build`| TypeScript 检查 + Vite 生产构建 |
| `npm run lint` | ESLint 检查 |
| `npm run preview` | 预览 dist 构建结果 |

---

## 与后端联调

- **REST API**：开发时 `/api/*` 代理到 `http://localhost:8000`。
- **WebSocket**：`/ws/*` 代理到 `ws://localhost:8000`。
- 鉴权：登录后 JWT 存于 `localStorage`（`cp_token`），请求头自动带 `Authorization: Bearer <token>`。

---

## 更多说明

整体架构、接口约定、数据库与 Agent 接入等见仓库根目录 [README.md](../README.md)。
