// ──────────────────────────────────────────────
// ClawPond Channel Plugin – Type Definitions
// ──────────────────────────────────────────────

/** Account configuration for one ClawPond relay connection */
export interface ClawPondAccount {
  /** Account identifier (key in openclaw.json) */
  accountId: string;
  /** ClawPond Relay HTTP base URL, e.g. "http://localhost:8000" */
  relayUrl: string;
  /** ClawPond Relay WebSocket base URL, e.g. "ws://localhost:8000" */
  relayWsUrl: string;
  /** Agent display name shown in UI and @mentions (room-scoped, not globally unique) */
  agentName: string;
  /** Human-readable description sent during registration */
  agentDescription: string;
  /** Initial reconnect delay in ms (default: 1000) */
  reconnectInterval: number;
  /** Maximum reconnect delay in ms (default: 30000) */
  maxReconnectDelay: number;
}

/** A room that the plugin has successfully joined */
export interface JoinedRoom {
  roomId: string;
  /** 服务端分发的 agent UUID */
  agentId: string;
  /** WebSocket 连接使用的 user_id（格式: "agent-{agentId}"） */
  userId: string;
}

/** Raw broadcast payload from the relay WebSocket */
export interface RelayBroadcast {
  event: string;
  data: RelayMessageData | RelayMemberData | RelayConnectedData | Record<string, unknown>;
}

/** 结构化 @mention 目标（与 relay 和 web 保持一致） */
export interface MentionTarget {
  agentId: string;
  username: string;
}

/** message event payload */
export interface RelayMessageData {
  id: string;
  message_id: number;
  room_id: string;
  sender_id: string;
  sender_name: string;
  text: string;
  type: string;
  /** 结构化 mentions（含 agentId），兼容旧格式字符串数组 */
  mentions: MentionTarget[] | string[];
  reply_to?: number | null;
  attachments?: RelayAttachment[];
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface RelayAttachment {
  url: string;
  filename: string;
  size?: number;
  mime_type?: string;
}

/** memberJoined / memberLeft event payload */
export interface RelayMemberData {
  user_id: string;
  username: string;
  user_type: string;
  role: string;
  online: boolean;
  agent_id?: string;
}

/** connected event payload (received after WebSocket handshake) */
export interface RelayConnectedData {
  room_id: string;
  user_id: string;
  username: string;
  online_members: RelayMemberData[];
  /** 服务端分发的 agent UUID（仅 agent 连接时有值，供自我识别） */
  agent_id?: string;
}

/** Inbound message passed to OpenClaw after @mention detection */
export interface ClawPondInbound {
  id: string;
  channel: "clawpond";
  accountId: string;
  roomId: string;
  messageId: number;
  senderId: string;
  senderName: string;
  text: string;
  isGroup: boolean;
  replyTo?: number;
  attachments?: RelayAttachment[];
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

/** Context carried with each inbound message for routing the reply */
export interface ReplyContext {
  roomId: string;
  messageId: number;
  senderId: string;
  accountId: string;
}

/** OpenClaw Channel Plugin SDK interfaces (minimal stubs) */
export interface ChannelPlugin {
  id: string;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfigAdapter;
  outbound: ChannelOutboundAdapter;
  gateway?: ChannelGatewayAdapter;
  security?: ChannelSecurityAdapter;
  messaging?: ChannelMessagingAdapter;
}

export interface ChannelMeta {
  id: string;
  label: string;
  selectionLabel: string;
  docsPath: string;
  blurb: string;
  aliases?: string[];
  order?: number;
}

export interface ChannelCapabilities {
  chatTypes: ("direct" | "group")[];
  supports?: {
    threads?: boolean;
    reactions?: boolean;
    edits?: boolean;
    deletions?: boolean;
    mentions?: boolean;
    formatting?: boolean;
  };
}

export interface ChannelConfigAdapter {
  listAccountIds: (config: OpenClawConfig) => string[];
  resolveAccount: (config: OpenClawConfig, accountId: string | undefined) => ClawPondAccount | undefined;
}

export interface OutboundContext {
  text: string;
  target: { id: string; replyContext?: ReplyContext };
  account: ClawPondAccount;
  replyTo?: { messageId: number };
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface ChannelOutboundAdapter {
  deliveryMode: "direct" | "queued";
  sendText: (context: OutboundContext) => Promise<SendResult>;
}

export interface GatewayDeps {
  logger: {
    debug: (msg: string, meta?: Record<string, unknown>) => void;
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  emit: (event: string, data: unknown) => void;
  onReady: () => void;
  onError: (err: Error) => void;
  onDisconnect: () => void;
}

export interface ChannelGatewayAdapter {
  start: (account: ClawPondAccount, deps: GatewayDeps) => Promise<{ stop: () => Promise<void> }>;
}

export interface ChannelSecurityAdapter {
  getDmPolicy: (account: ClawPondAccount) => "open" | "pairing" | "closed";
  getAllowFrom: (account: ClawPondAccount) => string[];
}

export interface MessagingDeps {
  logger: GatewayDeps["logger"];
  emitMessage: (message: ClawPondInbound) => void;
}

export interface ChannelMessagingAdapter {
  onMessage: (event: { data: RelayMessageData; accountId: string }, deps: MessagingDeps) => Promise<void>;
}

/** OpenClaw config shape (minimal) */
export interface OpenClawConfig {
  channels?: {
    clawpond?: {
      accounts?: Record<string, Partial<ClawPondAccount>>;
    };
  };
}

/** Plugin registration API */
export interface PluginApi {
  registerChannel: (opts: { plugin: ChannelPlugin }) => void;
}
