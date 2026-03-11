// ──────────────────────────────────────────────
// ClawPond Channel Plugin – Type Definitions
// ──────────────────────────────────────────────

/** Account configuration for one ClawPond relay connection */
export interface ClawPondAccount {
  /** Account identifier (key in openclaw.json) */
  accountId: string;
  /** ClawPond Relay WebSocket base URL, e.g. "ws://localhost:8000" */
  relayWsUrl: string;
  /** Agent UUID returned by POST /api/v1/agents/register */
  agentId: string;
  /** Agent secret returned by POST /api/v1/agents/register (stored sensitive) */
  agentSecret: string;
  /** Agent display name used for @mention legacy string matching */
  agentName: string;
  /** Human-readable description */
  agentDescription: string;
  /** Initial reconnect delay in ms (default: 1000) */
  reconnectInterval: number;
  /** Maximum reconnect delay in ms (default: 30000) */
  maxReconnectDelay: number;
  /** Pre-configured rooms to auto-join on connection (optional) */
  rooms?: JoinedRoom[];
}

/** A room subscription passed to connectNewRoom() after HTTP join */
export interface JoinedRoom {
  roomId: string;
  /** Room access_token (password) used in WS joinRoom message */
  roomPassword: string;
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
  /**
   * Explicit group peer ID used by OpenClaw core for session routing.
   * Set to roomId so each room gets its own isolated session context.
   * Mirrors feishu's resolveFeishuGroupSession peerId = chatId logic.
   */
  peerId: string;
  /** Always "group" for ClawPond rooms */
  peerKind: "group";
  /**
   * Optional session identifier for OpenClaw session routing.
   * If not provided, OpenClaw will generate one based on channel + peerId.
   */
  sessionId?: string;
  /**
   * Session key used by OpenClaw for routing messages to the correct session.
   * Format: agent:<agentId>:<channel>:<peerKind>:<peerId>
   * Example: agent:main:clawpond:group:room-id-123
   */
  SessionKey?: string;
  replyTo?: number;
  attachments?: RelayAttachment[];
  metadata?: Record<string, unknown>;
  timestamp: Date;
  /**
   * Context needed for routing replies back to the correct room and message.
   * Required by the outbound adapter to send responses.
   */
  replyContext: ReplyContext;
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

/** Context passed by OpenClaw when starting a channel account (aligns with Feishu gateway.startAccount). */
export interface GatewayStartAccountCtx {
  cfg: OpenClawConfig;
  accountId: string;
  setStatus?: (status: { accountId: string; [k: string]: unknown }) => void;
  log?: (msg: string, ...args: unknown[]) => void;
  runtime?: {
    log?: (msg: string, ...args: unknown[]) => void;
    error?: (err: unknown) => void;
    emit?: (event: string, data: unknown) => void;
    onReady?: () => void;
    onError?: (err: Error) => void;
    onDisconnect?: () => void;
  };
  abortSignal?: AbortSignal;
  emit?: (event: string, data: unknown) => void;
  onReady?: () => void;
  onError?: (err: Error) => void;
  onDisconnect?: () => void;
}

export interface ChannelGatewayAdapter {
  startAccount: (ctx: GatewayStartAccountCtx) => Promise<void>;
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

/** Tool parameter definition (JSON Schema subset) */
export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
  additionalProperties?: boolean;
}

/** A tool registered with OpenClaw via api.registerTool() */
export interface ToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: ToolParameterSchema;
  execute: (toolCallId: string, params: unknown) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

/** Plugin registration API */
export interface PluginApi {
  registerChannel: (opts: { plugin: ChannelPlugin }) => void;
  /** Register an agent-callable tool. Optional: may not be available in all host versions. */
  registerTool?: (tool: ToolDefinition, opts?: { name?: string }) => void;
  /** Access to OpenClaw runtime capabilities. Optional: may not be available in all host versions. */
  runtime?: {
    /** Write a partial config patch and persist to openclaw.json */
    updateChannelConfig?: (channelId: string, patch: Record<string, unknown>) => Promise<void>;
    /** Restart the gateway for a specific channel (triggers reconnect) */
    restartGateway?: (channelId: string) => Promise<void>;
    /** Read the current resolved config */
    getConfig?: () => OpenClawConfig;
    /** Generic logger */
    log?: (...args: unknown[]) => void;
  };
}
