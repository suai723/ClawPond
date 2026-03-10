import WebSocket from "ws";
import {
  ClawPondAccount,
  MentionTarget,
  RelayBroadcast,
  RelayMessageData,
  GatewayDeps,
} from "./types.js";

type MessageHandler = (data: RelayMessageData, roomId: string) => void;

/**
 * ClawPondWsClient manages a single WebSocket connection per account.
 * Rooms are subscribed via joinRoom() messages after the connection opens.
 * Exponential-backoff reconnection automatically re-subscribes all rooms.
 */
export class ClawPondWsClient {
  private account: ClawPondAccount;
  private deps: GatewayDeps;
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempts = 0;
  /** roomId → roomPassword (access_token) */
  private rooms = new Map<string, string>();
  private onMessageHandler: MessageHandler | null = null;

  constructor(account: ClawPondAccount, deps: GatewayDeps) {
    this.account = account;
    this.deps = deps;
  }

  /** Register a handler that receives @mention messages */
  onMessage(handler: MessageHandler): void {
    this.onMessageHandler = handler;
  }

  /** Start the WebSocket connection */
  connect(): void {
    this._connect();
  }

  /**
   * Subscribe to a room. If already connected, sends joinRoom immediately.
   * Otherwise the room will be joined once the connection opens/reconnects.
   */
  joinRoom(roomId: string, roomPassword: string): void {
    this.rooms.set(roomId, roomPassword);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this._sendJoinRoom(roomPassword);
    }
  }

  /** Send a chat message to a specific room */
  sendMessage(roomId: string, text: string, replyTo?: number): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.deps.logger.warn("clawpond_ws_send_failed_not_open", { roomId });
      return false;
    }

    const payload = {
      method: "sendMessage",
      params: {
        room_id: roomId,
        text,
        ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
      },
    };

    this.ws.send(JSON.stringify(payload));
    return true;
  }

  /** Close the connection and stop all reconnect attempts */
  async disconnectAll(): Promise<void> {
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }

  private _connect(): void {
    if (this.stopped) return;

    const { relayWsUrl, agentId, agentSecret } = this.account;
    const url =
      `${relayWsUrl}/ws` +
      `?agent_id=${encodeURIComponent(agentId)}` +
      `&agent_secret=${encodeURIComponent(agentSecret)}` +
      `&user_type=agent`;

    this.deps.logger.info("clawpond_ws_connecting", { url: `${relayWsUrl}/ws` });

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.deps.logger.info("clawpond_ws_connected");
      this.deps.onReady();

      // Re-subscribe to all rooms (handles initial connect and reconnect)
      for (const [roomId, roomPassword] of this.rooms) {
        this.deps.logger.info("clawpond_ws_joining_room", { roomId });
        this._sendJoinRoom(roomPassword);
      }
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const broadcast: RelayBroadcast = JSON.parse(raw.toString());
        this._handleBroadcast(broadcast);
      } catch (err) {
        this.deps.logger.warn("clawpond_ws_parse_error", {
          error: String(err),
        });
      }
    });

    ws.on("error", (err: Error) => {
      this.deps.logger.error("clawpond_ws_error", { error: err.message });
      this.deps.onError(err);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      this.deps.logger.info("clawpond_ws_closed", {
        code,
        reason: reason.toString(),
      });
      this.deps.onDisconnect();
      this._scheduleReconnect();
    });
  }

  private _sendJoinRoom(roomPassword: string): void {
    this.ws?.send(
      JSON.stringify({ method: "joinRoom", params: { password: roomPassword } })
    );
  }

  private _handleBroadcast(broadcast: RelayBroadcast): void {
    if (broadcast.event !== "message") return;

    const data = broadcast.data as RelayMessageData;
    if (!data || !Array.isArray(data.mentions)) return;

    const { agentId, agentName } = this.account;
    const selfUserId = `agent-${agentId}`;

    // Check @mention: prefer structured agentId match, fall back to legacy string username
    const mentioned = data.mentions.some((m) => {
      if (typeof m === "object" && "agentId" in m) {
        return (m as MentionTarget).agentId === agentId;
      }
      return typeof m === "string" && m.toLowerCase() === agentName.toLowerCase();
    });
    if (!mentioned) return;

    // Don't respond to own messages
    if (data.sender_id === selfUserId) return;

    this.deps.logger.info("clawpond_mention_received", {
      roomId: data.room_id,
      messageId: data.message_id,
      senderId: data.sender_id,
    });

    this.onMessageHandler?.(data, data.room_id);
  }

  private _scheduleReconnect(): void {
    if (this.stopped) return;

    const base = this.account.reconnectInterval;
    const max = this.account.maxReconnectDelay;
    const delay = Math.min(base * Math.pow(2, this.reconnectAttempts), max);
    this.reconnectAttempts += 1;

    this.deps.logger.info("clawpond_ws_reconnecting", {
      delayMs: delay,
      attempt: this.reconnectAttempts,
    });

    setTimeout(() => this._connect(), delay);
  }
}
