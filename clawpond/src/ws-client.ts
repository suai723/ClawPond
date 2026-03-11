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
  /** True after the first successful connection; gates onDisconnect() calls */
  private _everReady = false;
  /** roomId → roomPassword (access_token) */
  private rooms = new Map<string, string>();
  private onMessageHandler: MessageHandler | null = null;

  constructor(account: ClawPondAccount, deps: GatewayDeps) {
    this.account = account;
    this.deps = deps;
    this.deps.logger.info("clawpond_ws_client_created", {
      accountId: account.accountId,
    });
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
      this._sendJoinRoom(roomId, roomPassword);
    } else {
      this.deps.logger.info("clawpond_ws_room_queued", { roomId });
    }
  }

  /** Send a chat message to a specific room */
  sendMessage(roomId: string, text: string, replyTo?: number): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.deps.logger.info("clawpond_ws_send_failed_not_open", {
        roomId,
        readyState: this.ws?.readyState,
      });
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
    this.deps.logger.info("clawpond_ws_send_ok", {
      roomId,
      textLength: text.length,
    });
    return true;
  }

  /** Close the connection and stop all reconnect attempts */
  async disconnectAll(): Promise<void> {
    this.deps.logger.info("clawpond_ws_disconnect_all", {
      accountId: this.account.accountId,
    });
    this.stopped = true;
    this._everReady = false;
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

    const isReconnect = this.reconnectAttempts > 0;
    this.deps.logger.info("clawpond_ws_connecting", {
      url: `${relayWsUrl}/ws`,
      ...(isReconnect ? { attempt: this.reconnectAttempts + 1 } : {}),
    });

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this._everReady = true;
      this.deps.logger.info("clawpond_ws_connected");
      this.deps.onReady();

      // Re-subscribe to all rooms (handles initial connect and reconnect)
      for (const [roomId, roomPassword] of this.rooms) {
        this._sendJoinRoom(roomId, roomPassword);
      }
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const broadcast: RelayBroadcast = JSON.parse(raw.toString());
        if (broadcast.event !== "message") {
          this.deps.logger.info("clawpond_ws_broadcast", {
            event: broadcast.event,
          });
        }
        this._handleBroadcast(broadcast);
      } catch (err) {
        this.deps.logger.info("clawpond_ws_parse_error", {
          error: String(err),
        });
      }
    });

    ws.on("error", (err: Error) => {
      // Log connection-level errors (ECONNREFUSED, ETIMEDOUT, etc.) but do NOT
      // forward to deps.onError — OpenClaw treats that as an unrecoverable fatal
      // error and tears down the gateway. Transient connection failures are
      // handled entirely by our own reconnect loop. The "close" event fires
      // immediately after "error", which schedules the next reconnect attempt.
      this.deps.logger.warn("clawpond_ws_error", {
        error: err.message,
        attempt: this.reconnectAttempts,
      });
    });

    ws.on("close", (code: number, reason: Buffer) => {
      const reasonStr = reason.toString();
      this.deps.logger.info("clawpond_ws_closed", {
        code,
        reason: reasonStr,
        attemptAtClose: this.reconnectAttempts,
        everReady: this._everReady,
      });

      if (!this.stopped) {
        // Only signal disconnect to the host if we had previously announced
        // readiness. This avoids a spurious onDisconnect before onReady which
        // could cause OpenClaw to attempt an external gateway restart that
        // races with our own reconnect loop.
        if (this._everReady) {
          this.deps.onDisconnect();
        }
        this._scheduleReconnect();
      }
    });
  }

  private _sendJoinRoom(roomId: string, roomPassword: string): void {
    this.deps.logger.info("clawpond_ws_joining_room", { roomId });
    this.ws?.send(
      JSON.stringify({
        method: "joinRoom",
        params: { room_id: roomId, password: roomPassword },
      })
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
      nextAttempt: this.reconnectAttempts + 1,
    });

    setTimeout(() => this._connect(), delay);
  }
}
