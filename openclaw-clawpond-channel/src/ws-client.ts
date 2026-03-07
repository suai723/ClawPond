import WebSocket from "ws";
import {
  ClawPondAccount,
  JoinedRoom,
  MentionTarget,
  RelayBroadcast,
  RelayMessageData,
  GatewayDeps,
} from "./types.js";

type MessageHandler = (data: RelayMessageData, roomId: string) => void;

interface RoomConnection {
  ws: WebSocket;
  roomId: string;
  userId: string;
  /** 服务端分发的 agent UUID，用于 mention 自我识别 */
  agentId: string;
  reconnectAttempts: number;
  stopped: boolean;
}

/**
 * ClawPondWsClient manages one WebSocket connection per joined room.
 * It handles exponential-backoff reconnection automatically.
 */
export class ClawPondWsClient {
  private account: ClawPondAccount;
  private deps: GatewayDeps;
  private connections = new Map<string, RoomConnection>();
  private onMessageHandler: MessageHandler | null = null;

  constructor(account: ClawPondAccount, deps: GatewayDeps) {
    this.account = account;
    this.deps = deps;
  }

  /** Register a handler that receives @mention messages */
  onMessage(handler: MessageHandler): void {
    this.onMessageHandler = handler;
  }

  /**
   * Connect to a room's WebSocket endpoint.
   * Returns a stop() function to close this specific room connection.
   */
  connectRoom(joinedRoom: JoinedRoom): () => void {
    const conn: RoomConnection = {
      ws: null as unknown as WebSocket,
      roomId: joinedRoom.roomId,
      userId: joinedRoom.userId,
      agentId: joinedRoom.agentId,
      reconnectAttempts: 0,
      stopped: false,
    };

    this.connections.set(joinedRoom.roomId, conn);
    this._connect(conn);

    return () => {
      conn.stopped = true;
      this.connections.delete(joinedRoom.roomId);
      try {
        conn.ws?.close();
      } catch {
        // ignore
      }
    };
  }

  /** Send a chat message to a specific room */
  sendMessage(roomId: string, text: string, replyTo?: number): boolean {
    const conn = this.connections.get(roomId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      this.deps.logger.warn("clawpond_ws_send_failed_not_open", { roomId });
      return false;
    }

    const payload = {
      method: "sendMessage",
      params: {
        text,
        ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
      },
    };

    conn.ws.send(JSON.stringify(payload));
    return true;
  }

  /** Close all room connections */
  async disconnectAll(): Promise<void> {
    for (const conn of this.connections.values()) {
      conn.stopped = true;
      try {
        conn.ws?.close();
      } catch {
        // ignore
      }
    }
    this.connections.clear();
  }

  private _connect(conn: RoomConnection): void {
    if (conn.stopped) return;

    const { agentName, relayWsUrl } = this.account;
    // user_id 用 agentId（服务端分发的 UUID），与 DB 中的 user_id 格式一致
    const userId = conn.userId; // "agent-{agentId}"
    const url =
      `${relayWsUrl}/ws/${conn.roomId}` +
      `?user_id=${encodeURIComponent(userId)}` +
      `&username=${encodeURIComponent(agentName)}` +
      `&user_type=agent` +
      `&role=member`;

    this.deps.logger.info("clawpond_ws_connecting", {
      roomId: conn.roomId,
      url,
    });

    const ws = new WebSocket(url);
    conn.ws = ws;

    ws.on("open", () => {
      conn.reconnectAttempts = 0;
      this.deps.logger.info("clawpond_ws_connected", { roomId: conn.roomId });
      this.deps.onReady();
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const broadcast: RelayBroadcast = JSON.parse(raw.toString());
        this._handleBroadcast(broadcast, conn);
      } catch (err) {
        this.deps.logger.warn("clawpond_ws_parse_error", {
          error: String(err),
        });
      }
    });

    ws.on("error", (err: Error) => {
      this.deps.logger.error("clawpond_ws_error", {
        roomId: conn.roomId,
        error: err.message,
      });
      this.deps.onError(err);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      this.deps.logger.info("clawpond_ws_closed", {
        roomId: conn.roomId,
        code,
        reason: reason.toString(),
      });
      this.deps.onDisconnect();
      this._scheduleReconnect(conn);
    });
  }

  private _handleBroadcast(broadcast: RelayBroadcast, conn: RoomConnection): void {
    if (broadcast.event !== "message") return;

    const data = broadcast.data as RelayMessageData;
    if (!data || !Array.isArray(data.mentions)) return;

    const agentId = conn.agentId;
    const wsUserId = conn.userId; // "agent-{agentId}"

    // 检测 @mention：优先用 agentId 精确匹配结构化 mentions
    const mentioned = data.mentions.some((m) => {
      if (typeof m === "object" && "agentId" in m) {
        return (m as MentionTarget).agentId === agentId;
      }
      // 兼容旧格式（纯字符串 username）
      return typeof m === "string" && m.toLowerCase() === this.account.agentName.toLowerCase();
    });
    if (!mentioned) return;

    // Don't respond to own messages
    if (data.sender_id === wsUserId) return;

    this.deps.logger.info("clawpond_mention_received", {
      roomId: conn.roomId,
      messageId: data.message_id,
      senderId: data.sender_id,
      agentId,
    });

    this.onMessageHandler?.(data, conn.roomId);
  }

  private _scheduleReconnect(conn: RoomConnection): void {
    if (conn.stopped) return;

    const base = this.account.reconnectInterval;
    const max = this.account.maxReconnectDelay;
    const delay = Math.min(base * Math.pow(2, conn.reconnectAttempts), max);
    conn.reconnectAttempts += 1;

    this.deps.logger.info("clawpond_ws_reconnecting", {
      roomId: conn.roomId,
      delayMs: delay,
      attempt: conn.reconnectAttempts,
    });

    setTimeout(() => this._connect(conn), delay);
  }
}
