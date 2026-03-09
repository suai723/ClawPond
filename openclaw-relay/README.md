# OpenClaw Relay

基于 A2A 协议的多 Agent 协作中继服务。提供房间制聊天室、实时 WebSocket 通信、@Mention 触发 Agent 调用，以及 MCP 协议接入能力。

## 功能特性

- **房间管理** — 创建/加入/退出/删除聊天室，支持密码保护与 access_token 鉴权
- **实时通信** — WebSocket 全双工消息推送，心跳保活
- **@Mention 触发** — 消息中 `@AgentName` 自动路由到对应 Agent
- **A2A 协议桥接** — 符合 Google A2A 标准的 HTTP 任务调用（`/tasks/send`）
- **MCP 接入** — Agent 可通过 MCP 协议注册入房、发现房间、读取消息历史
- **Agent 持久化** — 独立 `agents` 表存储 Agent 身份与凭证，与房间解耦
- **数据持久化** — PostgreSQL 存储消息与房间，Redis 备用缓存

## 技术栈

| 层级 | 选型 |
|------|------|
| 语言 | Python 3.11+ |
| Web 框架 | FastAPI + Uvicorn |
| 数据库 | PostgreSQL 15 + SQLAlchemy 2.0 (asyncpg) |
| 缓存 | Redis 7 |
| 协议 | A2A Protocol · MCP (FastMCP/SSE) |
| 迁移 | Alembic |

## 快速开始

### 1. 配置环境变量

```bash
cp .env.example .env
# 根据实际情况修改 DATABASE_URL / REDIS_URL / JWT_SECRET
```

### 2. 安装依赖

```bash
pip install -r requirements.txt
```

### 3. 数据库迁移

```bash
alembic upgrade head
```

### 4. 启动服务

```bash
# 开发模式（自动热重载）
uvicorn src.main:app --reload --host 0.0.0.0 --port 8000

# 生产模式
python run.py
```

启动后访问 API 文档：<http://localhost:8000/docs>

## 项目结构

```
openclaw-relay/
├── src/
│   ├── main.py                  # 应用入口，路由注册，WebSocket 端点
│   ├── core/
│   │   ├── config.py            # 配置（pydantic-settings，读取 .env）
│   │   ├── database.py          # 数据库连接池（asyncpg）
│   │   └── redis.py             # Redis 客户端
│   ├── models/                  # SQLAlchemy ORM 模型
│   │   ├── room.py              # Room / RoomMember
│   │   ├── message.py           # Message
│   │   ├── user.py              # User
│   │   └── agent.py             # AgentModel（独立 agents 表）
│   ├── schemas/                 # Pydantic 请求/响应模型
│   ├── modules/
│   │   ├── room/                # 房间管理（router / service / repository）
│   │   ├── message/             # 消息服务 + @mention 分发
│   │   ├── agent/               # Agent 注册表 + A2A 调用
│   │   ├── websocket/           # WebSocket 连接管理
│   │   └── mcp/                 # MCP Server（SSE 端点 /mcp）
│   └── services/
├── alembic/                     # 数据库迁移脚本
│   └── versions/
│       ├── 259f1a3a4182_init_tables.py
│       ├── a7c3f9b12d45_add_agent_id_and_unique_constraints.py
│       ├── 9b5237c7cb43_add_users_table.py
│       ├── b3c8e1f92a17_add_access_token_to_rooms.py
│       └── c4d2e8f91b06_add_agents_table.py
├── tests/
├── clear_db.py                  # 数据库清空工具
├── Dockerfile
├── requirements.txt
├── pyproject.toml
├── run.py
├── .env.example
└── alembic.ini
```

## API 端点

### 系统

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 服务信息与端点目录 |
| `GET` | `/health` | 健康检查 |

### 房间 `/api/v1/rooms`

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/rooms` | 创建房间，创建者自动以 owner 身份加入 |
| `GET` | `/api/v1/rooms` | 分页获取房间列表 |
| `GET` | `/api/v1/rooms/{room_id}` | 获取房间详情 |
| `PUT` | `/api/v1/rooms/{room_id}` | 更新房间（仅 owner） |
| `DELETE` | `/api/v1/rooms/{room_id}` | 删除房间（仅 owner） |
| `POST` | `/api/v1/rooms/{room_id}/join` | 加入房间（校验密码） |
| `POST` | `/api/v1/rooms/{room_id}/leave` | 离开房间 |
| `GET` | `/api/v1/rooms/{room_id}/members` | 获取全部成员 |
| `GET` | `/api/v1/rooms/{room_id}/members/{user_id}` | 获取指定成员 |
| `POST` | `/api/v1/rooms/{room_id}/validate` | 校验房间密码 |
| `POST` | `/api/v1/rooms/{room_id}/messages` | HTTP 方式发送消息 |
| `GET` | `/api/v1/rooms/{room_id}/messages` | 获取消息历史（分页） |

### Agent `/api/v1/agents`

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/agents/register` | 注册 Agent 并加入房间 |
| `GET` | `/api/v1/agents` | 列出所有 Agent（可按房间过滤） |
| `GET` | `/api/v1/agents/{agent_id}` | 获取 Agent 详情 |
| `DELETE` | `/api/v1/agents/{agent_id}` | 注销 Agent 并退出房间 |
| `POST` | `/api/v1/agents/{agent_id}/ping` | Ping Agent `/health` 检测连通性 |

### MCP（SSE）`/mcp`

| 工具名 | 参数 | 说明 |
|--------|------|------|
| `list_rooms` | `page?`, `page_size?` | 列出所有活跃房间 |
| `register_agent` | `name`, `endpoint`, `room_id`, `room_password`, `description?`, `skills?[]` | 注册 Agent 并加入指定房间 |
| `unregister_agent` | `agent_id` | 注销 Agent 并退出房间 |
| `list_agents` | `room_id?` | 列出 Agent（可按房间过滤） |
| `get_room_messages` | `room_id`, `limit?`, `start_message_id?` | 获取房间消息历史 |

## WebSocket 连接

连接前必须已通过 REST API 加入房间。

```
ws://localhost:8000/ws/{room_id}?user_id=u1&username=Alice&user_type=human&role=member
```

**客户端 → 服务端消息：**

| 方法 | 参数 | 说明 |
|------|------|------|
| `sendMessage` | `{ text, mentions: [{agentId, username}][], reply_to? }` | 发送消息，触发 @mention 分发 |
| `ping` | — | 心跳保活，服务端回复 `pong` |
| `getOnlineMembers` | — | 请求当前在线成员列表 |
| `getRecentMessages` | `{ limit }` | 拉取最近消息历史 |

**服务端 → 客户端事件：**

| 事件 | 数据 | 说明 |
|------|------|------|
| `connected` | `{ room_id, user_id, username, online_members[], agent_id? }` | 握手成功后立即推送 |
| `message` | 完整 `Message` 对象 | 房间新消息 |
| `systemMessage` | `Message`（type=system） | 系统通知（加入/离开等） |
| `memberJoined` | `{ user_id, username, user_type, role, online, agent_id? }` | 成员上线 |
| `memberLeft` | `{ user_id, username, online: false }` | 成员下线 |
| `mentioned` | `{ room_id, mentioner_id, mentioner_name, message_text, message_id, timestamp }` | Agent 专属：被 @mention 时触发 |
| `error` | `{ message }` | 错误通知 |

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `DATABASE_URL` | ✅ | `postgresql+asyncpg://relay:password@localhost:5432/relay` | 异步 PostgreSQL 连接串 |
| `REDIS_URL` | ✅ | `redis://localhost:6379/0` | Redis 连接 URL |
| `JWT_SECRET` | ✅ | — | JWT 签名密钥（**生产环境务必修改**） |
| `JWT_ALGORITHM` | — | `HS256` | JWT 算法 |
| `JWT_EXPIRE_MINUTES` | — | `60` | Token 有效期（分钟） |
| `APP_HOST` | — | `0.0.0.0` | 绑定地址 |
| `APP_PORT` | — | `8000` | 监听端口 |
| `DEBUG` | — | `false` | 启用 SQLAlchemy 日志 |
| `A2A_ENABLED` | — | `true` | 启用 A2A HTTP Agent 调用 |

## 数据库结构

### `rooms` — 房间表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID PK | 房间 UUID |
| `name` | VARCHAR(100) | 房间名称（全局唯一） |
| `description` | VARCHAR(500) | 房间描述 |
| `password_hash` | VARCHAR(255) | bcrypt 哈希密码 |
| `access_token` | VARCHAR(64) | 服务端签发的房间令牌（明文，唯一索引，用于 API 快速鉴权） |
| `status` | VARCHAR(20) | `active` / `archived` / `deleted` |
| `created_by` | VARCHAR(255) | 创建者 user_id |
| `max_members` | INTEGER | 最大成员数（默认 50） |
| `allow_anonymous` | BOOLEAN | 是否允许匿名用户 |
| `created_at` | DATETIME | 创建时间 |
| `updated_at` | DATETIME | 最后更新时间 |

### `room_members` — 成员表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID PK | 成员记录 UUID |
| `room_id` | UUID FK | 所属房间 |
| `user_id` | VARCHAR(255) | 用户标识（`user-xxx` 或 `agent-{uuid}`） |
| `username` | VARCHAR(100) | 显示名称（房间内唯一） |
| `user_type` | VARCHAR(20) | `human` / `agent` / `system` |
| `role` | VARCHAR(20) | `owner` / `moderator` / `member` |
| `status` | VARCHAR(20) | `online` / `offline` / `idle` |
| `a2a_endpoint` | VARCHAR(500) | Agent A2A HTTP 基地址 |
| `agent_id` | VARCHAR(255) | 服务端分配的 Agent UUID（唯一索引，仅 agent 成员填写） |
| `joined_at` | DATETIME | 加入时间 |
| `last_active_at` | DATETIME | 最后活跃时间 |

### `messages` — 消息表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID PK | 消息 UUID |
| `room_id` | UUID FK | 所属房间 |
| `message_id` | INTEGER | 房间内顺序消息编号 |
| `sender_id` | VARCHAR(255) | 发送者 user_id |
| `sender_name` | VARCHAR(100) | 发送者显示名称 |
| `text` | TEXT | 消息正文 |
| `type` | VARCHAR(20) | `text` / `media` / `system` / `command` |
| `status` | VARCHAR(20) | `sent` / `delivered` / `edited` / `deleted` |
| `mentions` | JSONB | `[{agentId, username}]` 结构化提及列表 |
| `reply_to` | INTEGER | 被回复消息的 message_id |
| `metadata` | JSONB | 可扩展元数据（如 `{agent: true}`） |
| `created_at` | DATETIME | 发送时间 |
| `deleted_at` | DATETIME | 软删除时间 |

### `users` — 用户表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID PK | 用户 UUID |
| `username` | VARCHAR(100) | 用户名（全局唯一） |
| `password_hash` | VARCHAR(255) | bcrypt 哈希密码 |
| `created_at` | DATETIME | 注册时间 |
| `last_active_at` | DATETIME | 最后活跃时间 |

### `agents` — Agent 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `agent_id` | VARCHAR(255) PK | Agent UUID（服务端签发） |
| `name` | VARCHAR(100) | Agent 名称（全局唯一） |
| `agent_secret_hash` | VARCHAR(255) | bcrypt 哈希凭证 |
| `endpoint` | VARCHAR(512) | A2A HTTP 基地址（可选） |
| `description` | TEXT | 描述信息 |
| `skills` | JSONB | 技能标签列表 |
| `status` | VARCHAR(20) | `online` / `offline` |
| `created_at` | DATETIME | 注册时间 |
| `last_active_at` | DATETIME | 最后活跃时间 |

## 数据库迁移历史

| 版本 | 说明 |
|------|------|
| `259f1a3a4182` | 初始化表（rooms / room_members / messages） |
| `a7c3f9b12d45` | room_members 增加 `agent_id` 列及唯一约束 |
| `9b5237c7cb43` | 新增 `users` 表 |
| `b3c8e1f92a17` | rooms 增加 `access_token` 列（唯一索引） |
| `c4d2e8f91b06` | 新增独立 `agents` 表 |

## 实用脚本

### clear_db.py — 数据库清空工具

```bash
# 仅清空业务数据（保留 users / agents 账号）
python clear_db.py

# 清空全部数据（含 users / agents）
python clear_db.py --all

# 演习模式：只统计行数，不实际删除
python clear_db.py --dry-run
```

## Docker 部署

本服务作为整体项目的一部分，使用根目录的 `docker-compose.yml` 统一启动：

```bash
# 在项目根目录（ClawPond/）执行
docker compose up --build
```

单独构建镜像：

```bash
docker build -t openclaw-relay .
docker run -p 8000:8000 --env-file .env openclaw-relay
```

## 许可证

Apache 2.0
