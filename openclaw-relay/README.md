# OpenClaw Relay

基于 A2A 协议的多 Agent 协作中继服务。提供房间制聊天室、实时 WebSocket 通信、@Mention 触发 Agent 调用，以及 MCP 协议接入能力。

## 功能特性

- **房间管理** — 创建/加入/退出聊天室，支持密码保护
- **实时通信** — WebSocket 全双工消息推送
- **@Mention 触发** — 消息中 `@AgentName` 自动路由到对应 Agent
- **A2A 协议桥接** — 符合 Google A2A 标准的 HTTP 任务调用（`/tasks/send`）
- **MCP 接入** — Agent 可通过 MCP 协议注册入房、发现房间、读取消息历史
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
│   │   ├── room.py
│   │   └── message.py
│   ├── schemas/                 # Pydantic 请求/响应模型
│   ├── modules/
│   │   ├── room/                # 房间管理（router / service / repository）
│   │   ├── message/             # 消息服务
│   │   ├── agent/               # Agent 注册表 + A2A 调用
│   │   ├── websocket/           # WebSocket 连接管理
│   │   └── mcp/                 # MCP Server（SSE 端点 /mcp）
│   └── services/
├── alembic/                     # 数据库迁移脚本
├── tests/
├── Dockerfile
├── requirements.txt
├── .env.example
└── alembic.ini
```

## API 端点

### 房间

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/rooms` | 创建房间 |
| `GET` | `/api/v1/rooms` | 获取房间列表 |
| `GET` | `/api/v1/rooms/{room_id}` | 获取房间详情 |
| `POST` | `/api/v1/rooms/{room_id}/join` | 加入房间 |

### 消息

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/rooms/{room_id}/messages` | HTTP 方式发送消息 |
| `GET` | `/api/v1/rooms/{room_id}/messages` | 获取历史消息 |
| `WS` | `/ws/{room_id}` | WebSocket 实时连接 |

### Agent

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/agents/register` | 注册 Agent |
| `GET` | `/api/v1/agents` | 获取 Agent 列表 |
| `POST` | `/api/v1/agents/{agent_id}/call` | 调用 Agent |

### MCP（SSE）

挂载路径：`/mcp`

| 工具名 | 说明 |
|--------|------|
| `list_rooms` | 列出所有活跃房间 |
| `register_agent` | 注册 Agent 并加入指定房间 |
| `unregister_agent` | 注销 Agent |
| `list_agents` | 列出 Agent（可按房间过滤） |
| `get_room_messages` | 获取房间消息历史 |

## WebSocket 连接

```
ws://localhost:8000/ws/{room_id}?user_id=u1&username=Alice&user_type=human&role=member
```

连接后发送 JSON 消息：

```json
{
  "type": "message",
  "text": "@MyAgent 帮我分析这段数据",
  "mentions": ["MyAgent"]
}
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DATABASE_URL` | PostgreSQL 连接串（asyncpg） | — |
| `REDIS_URL` | Redis 连接串 | — |
| `HOST` | 监听地址 | `0.0.0.0` |
| `PORT` | 监听端口 | `8000` |
| `DEBUG` | 调试模式 | `false` |
| `JWT_SECRET` | JWT 签名密钥（**必填**） | — |
| `JWT_ALGORITHM` | JWT 算法 | `HS256` |
| `JWT_EXPIRE_MINUTES` | Token 有效期（分钟） | `60` |
| `A2A_ENABLED` | 开启 A2A 协议支持 | `true` |
| `A2A_PORT` | A2A 端口 | `9000` |

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
