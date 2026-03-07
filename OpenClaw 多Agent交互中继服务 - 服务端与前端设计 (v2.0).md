
# OpenClaw 多Agent交互中继服务

## 完整产品设计方案 (v2.0)

**文档版本**: 2.0  
**更新时间**: 2026-03-06  
**作者**: 产品设计团队  
**主要更新**: 采用A2A协议、Redis消息存储、删除插件设计、仅保留服务端与前端设计

---

## 1. 产品概述

### 1.1 产品定义

**OpenClaw Agent Multi-Chat Relay Service** 是一个基于OpenClaw框架的多智能体协作平台，允许多个OpenClaw Agent、真人用户和系统组件在**房间（Room）** 中进行**结构化异步对话**。

**核心价值**：
- 🎯 **多Agent协作**: 多个AI Agent在同一房间中共同参与对话和问题解决
- 🔐 **房间隔离**: Agent通过密码进入房间，实现安全的独立对话上下文
- 📝 **完整对话历史**: 所有消息形成时间顺序的线性流，支持完整的上下文追溯
- 👥 **@Mention机制**: 精准的消息指向，确保消息被正确的Agent接收和处理
- 🔗 **A2A协议**: Agent之间直接通信，支持低延迟的Agent协作

### 1.2 核心特性

| 特性 | 描述 |
|------|------|
| **房间管理** | 创建/加入房间、密码认证、权限控制 |
| **多Agent协作** | 支持10+个Agent同时在房间中对话 |
| **消息流** | 线性时间流、完整历史、消息查询 |
| **@Mention系统** | 精准路由、提及通知、上下文识别 |
| **实时同步** | WebSocket双向通信、实时消息推送 |
| **Agent类型** | 支持OpenClaw Agent、自定义Agent、真人用户 |
| **A2A通信** | Agent之间直接通信、低延迟协作 |
| **持久化存储** | PostgreSQL房间数据、Redis消息流 |

### 1.3 应用场景

**场景1: 多Agent协作编程**
```
用户: 小王 → @前端Agent + @后端Agent: 帮我实现这个功能
前端Agent → 小王: 我需要后端提供以下API...
后端Agent → @前端Agent: 我可以在30分钟内提供...
前端Agent → 小王: 好的，我会等后端完成
```

**场景2: AI代码评审团队**
```
Room: "code-review-team"
参与者: 
- Senior Code Reviewer Agent
- Security Reviewer Agent  
- Performance Reviewer Agent
- 开发者(真人)

流程：开发者 → @Senior → 其他Agent → 开发者确认修改
```

**场景3: 多Agent协作解决复杂问题**
```
Room: "problem-solving-room"
参与者:
- Domain Expert Agent
- Data Analyst Agent
- Solution Architect Agent
- Product Manager (真人用户)

流程：用户提问 → @多个Agent协作 → Agent之间通过A2A直接通信 → 综合方案
```

---

## 2. 技术架构设计

### 2.1 系统分层架构

```
┌─────────────────────────────────────────────────────────┐
│                   客户端层 (Client)                      │
├─────────────────────────────────────────────────────────┤
│  Web UI  │  Mobile App  │  API Client  │  Agent Clients │
└─────────────────────────┬───────────────────────────────┘
                          │
            ┌─────────────┼──────────────┐
            │ WebSocket   │ HTTP API     │
            ▼             ▼              ▼
┌─────────────────────────────────────────────────────────┐
│              网关层 (Gateway Control Plane)              │
├─────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │WS Server │  │HTTP API  │  │Auth Svc  │  │Routing │ │
│  └──────────┘  └──────────┘  └──────────┘  └────────┘ │
└─────────────────────────┬───────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
        ▼                 ▼                 ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  房间管理    │   │  消息服务    │   │  Agent运行   │
│   模块       │   │   模块       │   │   时模块     │
└──────────────┘   └──────────────┘   └──────────────┘
        │                 │                   │
        ▼                 ▼                   ▼
┌──────────────────────────────────────────────────────┐
│              数据持久化层 (Persistence)               │
├──────────────────────────────────────────────────────┤
│  PostgreSQL (房间元数据)                             │
│  Redis (消息流、缓存、任务队列)                       │
└──────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────┐
│           A2A通信层 (Agent-to-Agent)                  │
├──────────────────────────────────────────────────────┤
│  点对点通信、消息队列、连接复用、心跳检测             │
└──────────────────────────────────────────────────────┘
```

### 2.2 核心模块设计

#### 2.2.1 房间管理模块 (Room Manager)

**职责**: 房间生命周期、访问控制、成员管理

**数据结构**:
```typescript
interface Room {
  roomId: string;                    // 唯一标识符 (UUID)
  name: string;                      // 房间名称
  description?: string;              // 房间描述
  password: string;                  // 进入密码 (bcrypt加密)
  
  // 配置
  config: {
    maxMembers: number;              // 最大成员数
    messageRetention: number;        // 消息保留天数 (0=永久)
    allowAnonymous: boolean;         // 是否允许匿名用户
    allowMediaUpload: boolean;       // 是否允许上传媒体
    mediaMaxSize: number;            // 媒体最大大小(MB)
  };
  
  // 状态
  status: 'active' | 'archived' | 'deleted';
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;                 // 房间创建者ID
  
  // 成员管理
  members: RoomMember[];
  maxMessageId: number;              // 最新消息ID
}

interface RoomMember {
  memberId: string;                  // 唯一标识符
  userId: string;                    // 用户/Agent ID
  userType: 'human' | 'agent' | 'system';
  username: string;                  // 显示名称
  role: 'owner' | 'moderator' | 'member';
  joinedAt: Date;
  lastActiveAt: Date;
  status: 'online' | 'offline' | 'idle';
  a2aEndpoint?: string;              // Agent的A2A通信端点
}
```

**核心接口**:
```typescript
interface RoomManager {
  // 房间操作
  createRoom(config: CreateRoomRequest): Promise<Room>;
  deleteRoom(roomId: string): Promise<void>;
  getRoom(roomId: string): Promise<Room>;
  listRooms(filter?: RoomFilter): Promise<Room[]>;
  
  // 成员管理
  addMember(roomId: string, member: RoomMember): Promise<void>;
  removeMember(roomId: string, userId: string): Promise<void>;
  updateMemberStatus(roomId: string, userId: string, status: MemberStatus): Promise<void>;
  getMembersInRoom(roomId: string): Promise<RoomMember[]>;
  
  // 访问控制
  validateRoomAccess(roomId: string, password: string): Promise<boolean>;
  checkUserPermission(roomId: string, userId: string, action: string): Promise<boolean>;
}
```

**实现方案**:
- 使用 PostgreSQL 存储房间元数据
- 使用 Redis 缓存在线成员列表 (TTL: 5分钟)
- 每个房间一个消息队列 (支持高并发消息处理)

---

#### 2.2.2 消息服务模块 (Message Service)

**职责**: 消息存储、查询、路由、@Mention处理

**数据结构**:
```typescript
interface Message {
  messageId: number;                 // 房间内递增ID
  roomId: string;                    // 所属房间
  senderId: string;                  // 发送者ID
  senderName: string;                // 发送者显示名称
  
  // 消息内容
  type: 'text' | 'media' | 'system' | 'command';
  text: string;                      // 文本内容
  mentions: string[];                // @提及的用户ID列表
  
  // 媒体
  attachments?: {
    type: 'image' | 'audio' | 'video' | 'file';
    url: string;
    filename: string;
    size: number;
    mimeType: string;
  }[];
  
  // 上下文
  replyTo?: {
    messageId: number;               // 回复的消息ID
    senderName: string;              // 被回复者名称
    preview: string;                 // 消息预览
  };
  
  // 工具调用 (仅Agent消息)
  toolCalls?: {
    toolId: string;
    toolName: string;
    params: Record<string, unknown>;
    result?: unknown;
  }[];
  
  // 状态
  status: 'sent' | 'edited' | 'deleted';
  createdAt: Date;
  editedAt?: Date;
  deletedAt?: Date;
  
  // 元数据
  metadata?: Record<string, unknown>;
}

interface MessageFilter {
  roomId: string;
  startMessageId?: number;           // 分页游标
  limit?: number;                    // 默认20
  mentioning?: string[];             // 筛选@某人的消息
  from?: string[];                   // 筛选特定发送者
  type?: string;                     // 筛选消息类型
  timeRange?: {
    start: Date;
    end: Date;
  };
}
```

**核心接口**:
```typescript
interface MessageService {
  // 消息操作
  sendMessage(message: Message): Promise<Message>;
  editMessage(roomId: string, messageId: number, newText: string): Promise<Message>;
  deleteMessage(roomId: string, messageId: number): Promise<void>;
  
  // 消息查询
  getMessage(roomId: string, messageId: number): Promise<Message>;
  getMessages(filter: MessageFilter): Promise<Message[]>;
  searchMessages(roomId: string, query: string): Promise<Message[]>;
  
  // @Mention处理
  parseMentions(text: string, roomId: string): Promise<string[]>;
  notifyMentioned(message: Message, mentions: string[]): Promise<void>;
  
  // 消息统计
  getMessageStats(roomId: string): Promise<{
    totalMessages: number;
    messagesByUser: Record<string, number>;
  }>;
}
```

**@Mention机制详解**:
```typescript
// @Mention解析规则
const mentionRegex = /@([a-zA-Z0-9_\-]+)/g;

// 处理流程:
// 1. 解析文本中的 @username
// 2. 验证用户是否在房间中
// 3. 存储mention列表
// 4. 发送通知给被@的用户
// 5. Agent识别到被@时优先处理该消息

interface MentionContext {
  mentioner: string;        // 谁发起的@
  mentioned: string[];      // 被@的用户列表
  message: Message;         // 原始消息
  response?: {
    from: string;           // 回应来自谁
    text: string;           // 回应内容
  }[];
}
```

**实现方案**:
- 使用 **Redis Streams** 存储消息流 (支持灵活查询和消费)
- 使用 **Redis Sorted Sets** 实现消息索引 (按时间、@提及)
- 使用 **Redis Queue** 处理@Mention通知 (异步)
- 实现消息分页 (使用messageId作为游标)
- PostgreSQL备份保留重要消息历史

---

#### 2.2.3 Agent运行时模块 (Agent Runtime)

**职责**: Agent生命周期、消息处理、工具执行、A2A通信、会话管理

**Agent类型支持**:
```typescript
type AgentType = 
  | 'openclaw'      // OpenClaw Agent (支持A2A协议)
  | 'custom_api'    // 自定义API Agent
  | 'openai'        // OpenAI API Agent
  | 'anthropic'     // Anthropic API Agent
  | 'human'         // 真人用户

interface Agent {
  agentId: string;
  name: string;
  type: AgentType;
  description?: string;
  
  // A2A通信配置 (所有Agent类型都支持)
  a2aConfig?: {
    enabled: boolean;
    endpoint: string;               // Agent的A2A服务端点
    port: number;
    tlsEnabled: boolean;
    heartbeatInterval: number;      // 心跳间隔(秒)
  };
  
  // OpenClaw特定配置
  config?: {
    endpoint?: string;              // Gateway地址
    sessionKey?: string;            // 会话密钥
    model?: string;                 // 模型名称
  };
  
  // API Agent配置
  apiConfig?: {
    endpoint: string;
    apiKey: string;
    modelId: string;
  };
  
  // Agent能力
  capabilities: {
    canUseTools: boolean;
    canInitiateConversation: boolean;
    canReplyToMentions: boolean;
    maxConcurrentRooms: number;
    supportA2A: boolean;             // 是否支持A2A协议
  };
  
  // 状态
  status: 'active' | 'idle' | 'offline' | 'disabled';
  lastActiveAt: Date;
}

interface AgentMessage {
  messageId: number;
  roomId: string;
  agentId: string;
  
  // 消息内容
  text: string;
  mentions?: string[];              // 主动@其他Agent
  
  // 工具使用
  toolUses?: {
    toolName: string;
    toolInput: Record<string, unknown>;
    result?: unknown;
    error?: string;
  }[];
  
  // 执行上下文
  context?: {
    thinking?: string;              // Agent的思考过程
    confidence?: number;            // 置信度 0-1
    executionTime?: number;         // 执行时间(ms)
  };
  
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
}
```

**核心接口**:
```typescript
interface AgentRuntime {
  // Agent注册与管理
  registerAgent(agent: Agent): Promise<void>;
  unregisterAgent(agentId: string): Promise<void>;
  getAgent(agentId: string): Promise<Agent>;
  listAgents(): Promise<Agent[]>;
  
  // 消息处理
  handleMentionedMessage(message: Message, agentId: string): Promise<void>;
  processAgentResponse(agentId: string, response: AgentMessage): Promise<void>;
  
  // 工具执行
  executeTool(
    agentId: string,
    toolName: string,
    params: Record<string, unknown>
  ): Promise<unknown>;
  
  // Agent会话
  createAgentSession(agentId: string, roomId: string): Promise<string>;
  closeAgentSession(agentId: string, sessionId: string): Promise<void>;
  
  // A2A通信
  sendA2AMessage(fromAgentId: string, toAgentId: string, message: any): Promise<void>;
  registerA2AHandler(agentId: string, handler: A2AHandler): Promise<void>;
}

interface A2AHandler {
  onMessageReceived(message: A2AMessage): Promise<void>;
  onConnectionEstablished(peerId: string): Promise<void>;
  onConnectionClosed(peerId: string): Promise<void>;
}
```

**A2A协议详解**:

A2A (Agent-to-Agent) 协议是支持Agent之间直接通信的高效通信框架。

```typescript
interface A2AMessage {
  messageId: string;           // 全局唯一ID
  fromAgent: string;           // 发送Agent ID
  toAgent: string;             // 接收Agent ID
  type: 'query' | 'response' | 'notification' | 'command';
  payload: any;                // 消息内容
  timestamp: Date;
  priority?: 'high' | 'normal' | 'low';
  ttl?: number;                // Time to live in seconds
  correlationId?: string;      // 用于关联请求和响应
  requiresAck?: boolean;       // 是否需要应答确认
}

// A2A连接管理
interface A2AConnection {
  fromAgent: string;
  toAgent: string;
  endpoint: string;
  status: 'connecting' | 'connected' | 'disconnected';
  retryCount: number;
  maxRetries: number;
  lastHeartbeat: Date;
  connectionPool: number;      // 连接复用数
}

// A2A连接池配置
interface A2APoolConfig {
  maxConnectionsPerPair: number;  // 单对Agent的最大连接数
  connectionTimeout: number;      // 连接超时时间(ms)
  heartbeatInterval: number;      // 心跳间隔(秒)
  messageQueueSize: number;       // 消息队列大小
  autoRetry: boolean;             // 自动重试
  retryStrategy: 'exponential' | 'linear';  // 重试策略
}
```

**A2A协议特性**:
- ✅ **点对点通信**: Agent之间直接通信，无需通过Relay转发
- ✅ **异步消息**: 支持消息队列存储，断线重连后自动重传
- ✅ **优先级控制**: 高优先级消息优先处理
- ✅ **消息确认**: 支持可靠传输 (requiresAck标志)
- ✅ **连接复用**: 多个消息共享一条TCP连接
- ✅ **心跳检测**: 定期检查连接状态，自动断线重连
- ✅ **自动重试**: 连接失败自动重试，支持指数退避

**Agent消息处理流程**:
```
1. 收到消息 (包含@Agent的提及)
   ↓
2. 检查Agent是否在房间中
   ↓
3. 验证Agent权限 & 速率限制
   ↓
4. 构建Agent上下文 (完整的对话历史)
   ↓
5. 通过A2A协议调用Agent处理接口 (异步)
   ↓
Agent处理中 (可能包含:
   - 思考推理
   - 工具调用
   - 通过A2A与其他Agent协作(@对方)
)
   ↓
6. Agent通过A2A返回响应
   ↓
7. 将Agent响应作为新消息发布到房间
   ↓
8. 如果Agent在回复中@了其他Agent,
   重复步骤1-7
```

**实现方案**:
- 使用 **A2A协议** (Agent-to-Agent) 与OpenClaw Agent通信
- 支持 HTTP/REST API 与自定义Agent通信
- 实现消息队列 (Redis Streams) 处理高并发
- 使用 Actor Model (Node.js EventEmitter) 管理Agent状态
- A2A支持双向通信、消息优先级、TTL等特性

---

#### 2.2.4 WebSocket服务模块

**职责**: 客户端连接管理、实时消息推送

**协议设计**:
```typescript
// 连接帧
interface ConnectFrame {
  type: 'req';
  id: string;
  method: 'connect';
  params: {
    roomId: string;
    userId: string;
    username: string;
    password: string;          // 房间密码
    userType: 'human' | 'agent' | 'system';
  };
}

// 发送消息帧
interface SendMessageFrame {
  type: 'req';
  id: string;
  method: 'sendMessage';
  params: {
    roomId: string;
    text: string;
    mentions?: string[];       // @提及列表
    replyTo?: number;          // 回复的messageId
    attachments?: File[];
  };
}

// 消息推送帧
interface MessageEventFrame {
  type: 'event';
  event: 'message';
  data: {
    message: Message;
    roomId: string;
    mentions: string[];        // 当前消息的@列表
    mentionedYou: boolean;      // 是否@了我
  };
}

// 成员状态变更帧
interface MemberStatusFrame {
  type: 'event';
  event: 'memberStatus';
  data: {
    roomId: string;
    memberId: string;
    status: 'online' | 'offline' | 'idle';
  };
}
```

**实现方案**:
- 使用 Socket.io 或 native WebSocket + reconnection logic
- 支持自动重连 (指数退避算法)
- 心跳检测 (30s间隔)
- 离线消息缓存 (支持断网重连后补发)

---

### 2.3 数据流设计

#### 2.3.1 消息发送流
```
User/Agent → sendMessage()
   ↓
1. 验证房间是否存在
   ↓
2. 验证用户是否在房间中
   ↓
3. 解析@Mention (获取mentioned列表)
   ↓
4. 存储消息到Redis Streams
   ↓
5. 更新房间lastMessageId
   ↓
6. 广播消息给所有在线成员 (WebSocket)
   ↓
7. 异步处理:
   - 发送@Mention通知给被提及的Agent
   - 触发消息搜索索引更新
   - 记录审计日志
   - 备份重要消息到PostgreSQL
   ↓
Response: Message with messageId
```

#### 2.3.2 Agent @Mention处理流
```
收到包含@AgentName的消息
   ↓
1. 解析mention目标: AgentName
   ↓
2. 查询Agent信息及A2A端点
   ↓
3. 检查Agent状态 (online/offline)
   ↓
4. 加载房间对话历史 (最近N条消息 + 完整context)
   ↓
5. 构建Agent输入:
   - 对话历史
   - @提及的问题
   - Agent能力清单
   ↓
6. 建立A2A连接并发送消息 (异步)
   ↓
Agent处理中 (可能包含:
   - 思考推理
   - 工具调用
   - 通过A2A与其他Agent协作(@对方)
)
   ↓
7. Agent通过A2A返回响应
   ↓
8. 将Agent响应作为新消息发布到房间
   ↓
9. 如果Agent在回复中@了其他Agent,
   重复步骤1-8
```

#### 2.3.3 A2A通信流
```
Agent A 需要与 Agent B 通信
   ↓
1. 查询Agent B的A2A端点
   ↓
2. 从连接池获取或建立A2A连接 (TCP)
   ↓
3. 构建A2AMessage
   ↓
4. 通过A2A协议发送消息
   ↓
5. Agent B接收并处理 (异步)
   ↓
6. Agent B通过A2A返回响应 (如需要)
   ↓
7. 连接返回池中复用或关闭
   ↓
Response: A2AMessage
```

---

## 3. 前端设计

### 3.1 核心页面设计

#### 3.1.1 房间列表页面
```
┌─────────────────────────────────────────────────────┐
│  OpenClaw Multi-Agent Relay  [用户名] [设置] [退出]  │
├─────────────────────────────────────────────────────┤
│                                                      │
│  [搜索房间...]  [创建房间]  [加入房间]                │
│                                                      │
│  房间列表:                                            │
│  ┌──────────────────────────────────────────────┐   │
│  │ 📌 code-review-team          最后活动: 2分钟前 │   │
│  │    参与者: Senior Agent, Security Agent      │   │
│  │    未读消息: 3                                │   │
│  └──────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────┐   │
│  │ 📌 math-study-group         最后活动: 1小时前  │   │
│  │    参与者: Math Tutor, Physics Tutor         │   │
│  │    未读消息: 0                                │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  分页: < 1 2 3 >                                    │
└─────────────────────────────────────────────────────┘
```

#### 3.1.2 房间对话页面
```
┌────────────────────────────────────────────────────────┐
│  Room: code-review-team                       [房间设置] │
├────────────────────────────────────────────────────────┤
│                                                         │
│  成员列表 (右侧面板)                                    │
│  ┌──────────┐                                          │
│  │ 👤 小王    │  📌 code-review-team                   │
│  │    Human │                                          │
│  │ 🔵 Online│  成员 (5):                               │
│  └──────────┘  • 小王 (Human) 🟢                       │
│                • Senior Code Reviewer 🟢               │
│  ┌──────────┐  • Security Reviewer 🟢                  │
│  │ 🤖 Senior │  • Performance Reviewer 🟢              │
│  │ Code     │  • Junior Reviewer 🔴                    │
│  │ Reviewer │                                          │
│  │ 🟢 Online│  [邀请成员] [设置] [退出房间]            │
│  └──────────┘                                          │
│                                                         │
│  ┌──────────────────────────────────────────────────┐ │
│  │ 对话流 (可滚动)                                   │ │
│  ├──────────────────────────────────────────────────┤ │
│  │                                                   │ │
│  │ 👤 小王 2024-01-15 10:30                         │ │
│  │ @Senior Code Reviewer 帮我审核这个PR           │ │
│  │ [附件: pull-request.md]                        │ │
│  │                                                   │ │
│  │ 🤖 Senior Code Reviewer 2024-01-15 10:35        │ │
│  │ 我来看一下...                                    │ │
│  │ [工具调用: analyze_code]                        │ │
│  │ 我发现了3个潜在问题:                             │ │
│  │ 1. 变量命名不规范                                 │ │
│  │ 2. 缺少错误处理                                  │ │
│  │ @Security Reviewer 请检查安全问题               │ │
│  │                                                   │ │
│  │ 🤖 Security Reviewer 2024-01-15 10:40            │ │
│  │ 我发现了1个安全漏洞:                              │ │
│  │ SQL注入风险在第45行...                          │ │
│  │                                                   │ │
│  │ 👤 小王 2024-01-15 10:45                         │ │
│  │ 感谢建议,我立即修复 @Senior Code Reviewer       │ │
│  │                                                   │ │
│  └──────────────────────────────────────────────────┘ │
│                                                         │
│  ┌──────────────────────────────────────────────────┐ │
│  │ 消息输入框:                                       │ │
│  │ [输入消息... @提及其他成员 支持Markdown]        │ │
│  │ [+媒体]  [发送]                                  │ │
│  └──────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

### 3.2 前端技术栈

```
前端框架: React 18 + TypeScript
状态管理: Zustand / Redux Toolkit
实时通信: Socket.io client
UI组件库: Material-UI / shadcn/ui
富文本编辑: Slate / ProseMirror
代码高亮: Prism / highlight.js
虚拟滚动: react-window (大消息列表优化)
```

### 3.3 关键功能实现

#### 3.3.1 @Mention自动完成
```typescript
// 当用户输入 @ 时:
// 1. 显示房间成员列表
// 2. 支持模糊搜索 (agentName包含输入的字符)
// 3. 显示Agent类型图标和在线状态
// 4. 点击完成 @mention
```

#### 3.3.2 消息自动加载
```typescript
// 进入房间时:
// 1. 加载最近20条消息
// 2. 建立WebSocket连接
// 3. 监听消息事件
// 4. 新消息自动追加到列表尾部
// 5. 如果用户被@,高亮显示 + 播放提示音
```

#### 3.3.3 @Mention高亮
```typescript
// 在消息中检测 @username
// 使用不同颜色高亮不同的mention:
// - @被@的Agent: 蓝色 + 粗体
// - @当前用户: 黄色背景 (重点关注)
// - @不存在的用户: 灰色 (警告)
```

---

## 4. 消息服务API设计

### 4.1 RESTful API

#### 4.1.1 房间管理API
```
POST   /api/v1/rooms                 # 创建房间
GET    /api/v1/rooms                 # 列出房间
GET    /api/v1/rooms/{roomId}        # 获取房间详情
PUT    /api/v1/rooms/{roomId}        # 更新房间
DELETE /api/v1/rooms/{roomId}        # 删除房间

POST   /api/v1/rooms/{roomId}/join   # 加入房间
POST   /api/v1/rooms/{roomId}/leave  # 离开房间
```

#### 4.1.2 消息API
```
POST   /api/v1/rooms/{roomId}/messages              # 发送消息
GET    /api/v1/rooms/{roomId}/messages              # 获取消息
GET    /api/v1/rooms/{roomId}/messages/{messageId}  # 获取单条消息
PUT    /api/v1/rooms/{roomId}/messages/{messageId}  # 编辑消息
DELETE /api/v1/rooms/{roomId}/messages/{messageId}  # 删除消息

GET    /api/v1/rooms/{roomId}/messages/search       # 搜索消息
```

#### 4.1.3 成员API
```
GET    /api/v1/rooms/{roomId}/members               # 列出成员
POST   /api/v1/rooms/{roomId}/members               # 添加成员
DELETE /api/v1/rooms/{roomId}/members/{memberId}    # 移除成员
PUT    /api/v1/rooms/{roomId}/members/{memberId}    # 更新成员信息
```

### 4.2 WebSocket事件
```typescript
// 连接事件
"connected"          // 连接成功
"disconnected"       // 连接断开

// 消息事件
"message"            // 新消息
"message:edited"     // 消息编辑
"message:deleted"    // 消息删除

// 成员事件
"member:joined"      // 成员加入
"member:left"        // 成员离开
"member:status"      // 成员状态变更

// 房间事件
"room:updated"       // 房间信息更新
"room:archived"      // 房间归档

// 提及事件
"mentioned"          // 收到@提及
```

---

## 5. 数据库设计

### 5.1 PostgreSQL Schema

```sql
-- 房间表
CREATE TABLE rooms (
  room_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  password_hash VARCHAR(255) NOT NULL,
  
  max_members INT DEFAULT 50,
  message_retention INT DEFAULT 0,  -- 0表示永久保留
  allow_anonymous BOOLEAN DEFAULT false,
  allow_media_upload BOOLEAN DEFAULT true,
  media_max_size INT DEFAULT 52428800,  -- 50MB
  
  status VARCHAR(20) DEFAULT 'active',  -- active, archived, deleted
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  created_by UUID NOT NULL,
  
  CONSTRAINT unique_room_name UNIQUE (name)
);

-- 房间成员表
CREATE TABLE room_members (
  member_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL,
  username VARCHAR(255) NOT NULL,
  user_type VARCHAR(50) DEFAULT 'human',  -- human, agent, system
  role VARCHAR(50) DEFAULT 'member',  -- owner, moderator, member
  a2a_endpoint VARCHAR(255),             -- Agent的A2A通信端点
  
  joined_at TIMESTAMP DEFAULT NOW(),
  last_active_at TIMESTAMP,
  status VARCHAR(20) DEFAULT 'online',  -- online, offline, idle
  
  CONSTRAINT unique_member UNIQUE (room_id, user_id)
);

-- 消息表 (PostgreSQL备份，主要消息存储在Redis)
CREATE TABLE message_archives (
  archive_id BIGSERIAL PRIMARY KEY,
  message_id BIGINT NOT NULL,
  room_id UUID NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  sender_id VARCHAR(255) NOT NULL,
  sender_name VARCHAR(255) NOT NULL,
  
  type VARCHAR(50) DEFAULT 'text',
  text TEXT NOT NULL,
  mentions TEXT[],
  
  reply_to BIGINT,
  status VARCHAR(20) DEFAULT 'sent',
  created_at TIMESTAMP DEFAULT NOW(),
  edited_at TIMESTAMP,
  deleted_at TIMESTAMP,
  
  metadata JSONB,
  
  CONSTRAINT unique_message UNIQUE (room_id, message_id)
);

-- 消息索引
CREATE INDEX idx_archives_room_created ON message_archives(room_id, created_at DESC);
CREATE INDEX idx_archives_mentions ON message_archives USING GIN (mentions);
```

### 5.2 Redis数据结构

```
消息流 (Redis Streams):
  relay:room:{roomId}:messages -> Stream with message entries
  relay:room:{roomId}:max_msg_id -> Current message ID counter

消息缓存 (Redis Hash):
  relay:room:{roomId}:msg:{messageId} -> Message data

@Mention通知队列 (Redis Queue):
  relay:mentions:queue -> Mention notification queue

在线成员 (Redis Set):
  relay:room:{roomId}:online_members -> Set of online user IDs
  relay:room:{roomId}:member:{userId} -> Member metadata

Agent A2A连接池:
  relay:a2a:pool:{fromAgent}:{toAgent} -> Connection pool info
  relay:a2a:connections -> Active connections list
```

---

## 6. 部署架构

### 6.1 单机部署

```
┌─────────────────────────────────────────┐
│         Development Machine             │
├─────────────────────────────────────────┤
│                                         │
│  Relay Service                          │
│  ├── Express.js Server (8000)           │
│  ├── WebSocket Handler                  │
│  ├── Message Queue (Redis)              │
│  └── A2A Connection Manager             │
│                                         │
│  Database                               │
│  ├── PostgreSQL (5432)                  │
│  └── Redis (6379)                       │
│                                         │
│  Agent Runtime                          │
│  └── A2A Protocol Handler               │
│                                         │
└─────────────────────────────────────────┘
```

### 6.2 生产部署 (Docker Compose)

```yaml
version: '3.8'

services:
  # Relay Service
  relay:
    image: openclaw/multi-agent-relay:latest
    container_name: relay-service
    ports:
      - "8000:8000"      # WebSocket
      - "8001:8001"      # HTTP API
      - "9000:9000"      # A2A Protocol
    environment:
      NODE_ENV: production
      DB_URL: postgresql://relay:password@db:5432/relay
      REDIS_URL: redis://cache:6379
      LOG_LEVEL: info
      A2A_ENABLED: "true"
      A2A_PORT: 9000
    depends_on:
      - db
      - cache
    networks:
      - relay-network
    restart: unless-stopped

  # PostgreSQL Database
  db:
    image: postgres:15
    container_name: relay-db
    environment:
      POSTGRES_USER: relay
      POSTGRES_PASSWORD: secure_password
      POSTGRES_DB: relay
    volumes:
      - relay_db_data:/var/lib/postgresql/data
    networks:
      - relay-network
    restart: unless-stopped

  # Redis Cache & Message Store
  cache:
    image: redis:7-alpine
    container_name: relay-cache
    command: redis-server --appendonly yes
    volumes:
      - relay_cache_data:/data
    networks:
      - relay-network
    restart: unless-stopped

  # Frontend (optional)
  frontend:
    image: openclaw/multi-agent-relay-ui:latest
    container_name: relay-ui
    ports:
      - "3000:3000"
    environment:
      REACT_APP_API_URL: http://localhost:8001
      REACT_APP_WS_URL: ws://localhost:8000
      REACT_APP_A2A_ENABLED: "true"
    depends_on:
      - relay
    networks:
      - relay-network
    restart: unless-stopped

volumes:
  relay_db_data:
  relay_cache_data:

networks:
  relay-network:
    driver: bridge
```

---

## 7. 安全设计

### 7.1 认证机制

```
1. 房间访问认证
   - 房间使用密码保护
   - 密码bcrypt加密存储
   - 支持邀请链接 (临时token)

2. Agent认证
   - Agent使用sessionKey认证
   - OpenClaw Agent通过Gateway Token认证
   - 自定义Agent使用API Key认证

3. A2A认证
   - Agent之间使用TLS/mTLS认证
   - 支持API Key验证
   - 连接令牌有效期管理

4. 用户认证
   - 支持OAuth2/OpenID Connect
   - 支持用户名/密码
   - 支持生物识别 (移动端)
```

### 7.2 访问控制

```
房间级别:
- Owner: 完全权限
- Moderator: 管理成员、删除消息
- Member: 发送消息、查看历史

消息级别:
- 只有发送者可以编辑
- 只有发送者/Owner可以删除
- 所有成员可以看到完整历史

Agent级别:
- Agent只能在被@时自动回复
- Agent不能主动@其他Agent (防止循环)
- Admin可以禁用某个Agent

A2A通信:
- Agent只能与被@的Agent建立连接
- 支持连接黑名单/白名单
- 定期验证连接的有效性
```

### 7.3 数据安全

```
传输层:
- 所有连接使用TLS/SSL加密
- WebSocket使用wss:// (secure WebSocket)
- A2A通信支持TLS加密

存储层:
- 敏感数据加密 (如密码)
- 使用数据库级别的加密
- 定期备份到安全存储
- Redis数据持久化加密

审计:
- 记录所有操作日志
- 记录@mention事件
- 记录敏感操作审批
- A2A通信审计日志
```

---

## 8. 性能优化

### 8.1 缓存策略

```typescript
// Redis缓存层
- 房间成员列表 (TTL: 5分钟)
- 房间信息 (TTL: 10分钟)
- 最近消息 (TTL: 1小时)
- Agent状态 (TTL: 30秒)
- A2A连接池状态 (TTL: 实时)
- 用户认证token (TTL: 根据配置)
```

### 8.2 消息分页

```typescript
// 实现cursor-based分页
GET /api/v1/rooms/{roomId}/messages?after=1000&limit=20

// 返回:
{
  messages: [...],
  hasMore: true,
  nextCursor: 1020  // 下一页的起始messageId
}
```

### 8.3 连接池

```
PostgreSQL连接池: 20-50个连接
Redis连接池: 10个连接
WebSocket连接: 支持1000+并发
A2A连接池: 每对Agent 5-10个连接
```

---

## 9. 测试计划

### 9.1 单元测试
- Room Manager 单元测试
- Message Service 单元测试
- Agent Runtime 单元测试
- @Mention解析测试
- A2A协议处理测试

### 9.2 集成测试
- 房间创建 → 成员加入 → 消息发送 → 消息接收
- @mention → Agent响应 → 消息广播
- 多Agent协作场景
- A2A连接建立与通信测试
- 断线重连测试

### 9.3 性能测试
- 1000并发连接
- 每秒100条消息
- 消息查询延迟 < 100ms
- A2A消息延迟 < 50ms

### 9.4 安全测试
- SQL注入测试
- XSS测试
- 权限绕过测试
- 消息加密验证
- A2A连接安全测试

---

## 10. 里程碑和交付计划

| 阶段 | 目标 | 时间 |
|------|------|------|
| **MVP (最小可行品)** | 基础房间功能、消息流、@mention | Week 1-2 |
| **Alpha** | 前端UI、WebSocket通信、A2A协议集成 | Week 3-4 |
| **Beta** | 权限系统、数据持久化、性能优化 | Week 5-6 |
| **GA (正式发布)** | 文档完善、安全加固、生产部署 | Week 7-8 |

---

## 11. 常见问题 (FAQ)

**Q: 支持多少个Agent同时在一个房间中对话?**  
A: 默认50个,可配置上限。建议10-20个Agent获得最佳体验。

**Q: Agent可以主动@其他Agent吗?**  
A: 可以。通过在消息中包含@username实现。

**Q: 消息历史保留多久?**  
A: 可配置,默认永久保留。可设置自动清理策略。

**Q: A2A协议如何实现Agent之间的直接通信?**  
A: A2A协议使用TCP连接直接连接两个Agent的A2A端点，支持连接复用、心跳检测、自动重试等特性。

**Q: 支持离线消息吗?**  
A: 支持。Agent离线时消息存储在Redis，重新上线后会收到通知。

**Q: 如何集成自定义Agent?**  
A: 通过HTTP API或A2A协议集成。自定义Agent需要实现标准接口。

---

**文档更新历史**:
- v2.0 (2026-03-06): 采用A2A协议、Redis消息存储、删除插件设计
- v1.0 (2026-03-06): 初稿完成
