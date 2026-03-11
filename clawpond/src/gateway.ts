import {
  ChannelGatewayAdapter,
  ClawPondAccount,
  GatewayDeps,
  GatewayStartAccountCtx,
  JoinedRoom,
  MessagingDeps,
  OpenClawConfig,
  RelayMessageData,
} from "./types.js";
import { configAdapter } from "./config.js";
import { ClawPondWsClient } from "./ws-client.js";
import { handleInboundMessage } from "./messaging.js";

/** Module-level WsClient instance shared between gateway and outbound adapters */
let _wsClient: ClawPondWsClient | null = null;

/** Logger from the active gateway deps (for connectNewRoom/syncRooms logging) */
let _gatewayLogger: GatewayDeps["logger"] | null = null;

/** Returns the active WsClient (used by outbound adapter factory) */
export function getWsClient(): ClawPondWsClient | null {
  return _wsClient;
}

/** Returns the active gateway logger (used by outbound adapter for consistent logging) */
export function getGatewayLogger(): GatewayDeps["logger"] | null {
  return _gatewayLogger;
}

const noopLog = (_msg: string, _meta?: Record<string, unknown>) => {};

/** Build logger from ctx: supports both a single log(msg, meta) and a { debug, info, warn, error } object. */
function buildLoggerFromCtx(ctx: GatewayStartAccountCtx): GatewayDeps["logger"] {
  const raw = ctx.log ?? ctx.runtime?.log;
  if (typeof raw === "function") {
    const logFn = raw as (msg: string, meta?: Record<string, unknown>) => void;
    return {
      debug: logFn,
      info: logFn,
      warn: logFn,
      error: logFn,
    };
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    return {
      debug: typeof o.debug === "function" ? (o.debug as (msg: string, meta?: Record<string, unknown>) => void).bind(o) : noopLog,
      info: typeof o.info === "function" ? (o.info as (msg: string, meta?: Record<string, unknown>) => void).bind(o) : noopLog,
      warn: typeof o.warn === "function" ? (o.warn as (msg: string, meta?: Record<string, unknown>) => void).bind(o) : noopLog,
      error: typeof o.error === "function" ? (o.error as (msg: string, meta?: Record<string, unknown>) => void).bind(o) : noopLog,
    };
  }
  return { debug: noopLog, info: noopLog, warn: noopLog, error: noopLog };
}

function buildDepsFromCtx(ctx: GatewayStartAccountCtx): GatewayDeps {
  const logger = buildLoggerFromCtx(ctx);
  const emit = ctx.emit ?? ctx.runtime?.emit ?? (() => {});
  const noop = () => {};
  return {
    logger,
    emit,
    onReady: ctx.onReady ?? ctx.runtime?.onReady ?? noop,
    onError: ctx.onError ?? ctx.runtime?.onError ?? noop,
    onDisconnect: ctx.onDisconnect ?? ctx.runtime?.onDisconnect ?? noop,
  };
}

/**
 * Internal: run gateway for one account; returns stop handle.
 * Used by startAccount only (not exported).
 */
function runGateway(
  account: ClawPondAccount,
  deps: GatewayDeps,
  cfg: OpenClawConfig
): { stop: () => Promise<void> } {
  const wsClient = new ClawPondWsClient(account, deps);
  _wsClient = wsClient;
  _gatewayLogger = deps.logger;

  const messagingDeps: MessagingDeps = {
    logger: deps.logger,
    emitMessage: (inbound) => deps.emit("message:inbound", inbound),
  };

  wsClient.onMessage((data: RelayMessageData, roomId: string) => {
    handleInboundMessage(data, roomId, account.accountId, cfg, messagingDeps);
  });

  // Pre-load configured rooms BEFORE connect() so they're subscribed on first open.
  // Without this, account.rooms from config are silently ignored and clawpond_ws_joining_room
  // is never printed on initial connect.
  if (account.rooms?.length) {
    deps.logger.info("clawpond_gateway_preload_rooms", {
      count: account.rooms.length,
      roomIds: account.rooms.map((r) => r.roomId),
    });
    for (const room of account.rooms) {
      wsClient.joinRoom(room.roomId, room.roomPassword);
    }
  }

  deps.logger.info("clawpond_gateway_start", {
    accountId: account.accountId,
    relayWsUrl: account.relayWsUrl,
  });

  wsClient.connect();

  return {
    async stop() {
      deps.logger.info("clawpond_gateway_stop", {
        accountId: account.accountId,
      });
      await wsClient.disconnectAll();
      _wsClient = null;
      _gatewayLogger = null;
    },
  };
}

export const gatewayAdapter: ChannelGatewayAdapter = {
  async startAccount(ctx: GatewayStartAccountCtx): Promise<void> {
    const account = configAdapter.resolveAccount(ctx.cfg, ctx.accountId);
    if (!account) {
      throw new Error(
        `ClawPond account "${ctx.accountId}" is not configured or missing required fields (relayWsUrl, agentId, agentSecret, agentName).`
      );
    }

    const deps = buildDepsFromCtx(ctx);
    const { stop } = runGateway(account, deps, ctx.cfg);

    if (ctx.setStatus) {
      ctx.setStatus({ accountId: ctx.accountId, relayWsUrl: account.relayWsUrl });
    }

    if (ctx.abortSignal) {
      return new Promise<void>((resolve) => {
        const handleAbort = () => {
          stop().then(resolve);
        };
        if (ctx.abortSignal!.aborted) {
          handleAbort();
          return;
        }
        ctx.abortSignal!.addEventListener("abort", handleAbort, { once: true });
      });
    }

    return new Promise(() => {});
  },
};

/**
 * Called externally after HTTP room-join to subscribe the agent to a room.
 * The WsClient sends a joinRoom WS message immediately if connected,
 * or queues it for the next (re)connect.
 */
export function connectNewRoom(joinedRoom: JoinedRoom): void {
  if (!_wsClient) return;
  _gatewayLogger?.info("clawpond_gateway_connect_room", {
    roomId: joinedRoom.roomId,
  });
  _wsClient.joinRoom(joinedRoom.roomId, joinedRoom.roomPassword);
}

/**
 * Sync a list of already-joined rooms (e.g. from HTTP API or config) to the
 * WebSocket client. Use this when the agent joined rooms outside the plugin
 * (e.g. from a room page or another service). Each room will be subscribed
 * via joinRoom WS message so the server pushes messages to this connection.
 */
export function syncRooms(rooms: JoinedRoom[]): void {
  if (!_wsClient) return;
  _gatewayLogger?.info("clawpond_gateway_sync_rooms", {
    count: rooms.length,
    roomIds: rooms.map((r) => r.roomId),
  });
  for (const r of rooms) {
    _wsClient.joinRoom(r.roomId, r.roomPassword);
  }
}
