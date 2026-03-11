/**
 * integration.test.ts
 *
 * End-to-end integration test covering the full pipeline:
 *   gatewayAdapter.startAccount(ctx)
 *     → single WS connection with agent_id + agent_secret
 *     → connectNewRoom() sends joinRoom WS message
 *     → Mock WS Server broadcasts @mention message
 *     → handleInboundMessage → deps.emitMessage (OpenClaw)
 *     → outbound.sendText() → Mock WS Server receives reply with room_id
 */

import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { gatewayAdapter, connectNewRoom, getWsClient } from "../gateway";
import { createOutboundAdapter } from "../outbound";
import {
  ClawPondAccount,
  GatewayStartAccountCtx,
  OpenClawConfig,
  OutboundContext,
  ReplyContext,
  RelayBroadcast,
  RelayMessageData,
  ClawPondInbound,
} from "../types";

// ── helpers ──────────────────────────────────────────────────────────────────

async function startServer(): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("listening", () => {
      const addr = wss.address() as { port: number };
      resolve({ wss, port: addr.port });
    });
    wss.on("error", reject);
  });
}

function makeAccount(port: number): ClawPondAccount {
  return {
    accountId: "integration",
    relayWsUrl: `ws://localhost:${port}`,
    agentId: "integ-agent-uuid",
    agentSecret: "integ-secret",
    agentName: "IntegBot",
    agentDescription: "Integration test agent",
    reconnectInterval: 5000,
    maxReconnectDelay: 30_000,
  };
}

function makeCtx(
  port: number,
  opts?: { abortSignal?: AbortSignal; emitHandler?: (inbound: ClawPondInbound) => void }
): {
  ctx: GatewayStartAccountCtx;
  account: ClawPondAccount;
  onReady: jest.Mock;
} {
  const account = makeAccount(port);
  const log = jest.fn();
  const emit = jest.fn((event: string, data: unknown) => {
    if (event === "message:inbound" && opts?.emitHandler) {
      opts.emitHandler(data as ClawPondInbound);
    }
  });
  const onReady = jest.fn();
  const onError = jest.fn();
  const onDisconnect = jest.fn();
  const cfg: OpenClawConfig = {
    channels: { clawpond: { accounts: { integration: account } } },
  };
  const ctx: GatewayStartAccountCtx = {
    cfg,
    accountId: "integration",
    log,
    emit,
    onReady,
    onError,
    onDisconnect,
    abortSignal: opts?.abortSignal,
  };
  return { ctx, account, onReady };
}

const AGENT_ID = "integ-agent-uuid";
const ROOM_ID = "integ-room-001";
const ROOM_PASSWORD = "integ-room-password";

function makeMentionBroadcast(agentId: string, senderId = "user-human-1"): string {
  const data: RelayMessageData = {
    id: "integ-msg-1",
    message_id: 100,
    room_id: ROOM_ID,
    sender_id: senderId,
    sender_name: "Human User",
    text: "@IntegBot please help",
    type: "text",
    mentions: [{ agentId, username: "IntegBot" }],
    created_at: new Date().toISOString(),
  };
  const broadcast: RelayBroadcast = { event: "message", data };
  return JSON.stringify(broadcast);
}

// ── tests ─────────────────────────────────────────────────────────────────

describe("Full plugin pipeline integration", () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    const srv = await startServer();
    wss = srv.wss;
    port = srv.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it("WS handshake carries agent_id and agent_secret query params", async () => {
    const controller = new AbortController();
    const { ctx, account, onReady } = makeCtx(port, { abortSignal: controller.signal });

    let receivedUrl = "";
    wss.once("connection", (_sock, req) => { receivedUrl = req.url ?? ""; });

    const startPromise = gatewayAdapter.startAccount(ctx);
    await new Promise<void>((r) => onReady.mockImplementation(r));
    await new Promise((r) => setTimeout(r, 100));

    expect(receivedUrl).toContain(`agent_id=${AGENT_ID}`);
    expect(receivedUrl).toContain("agent_secret=integ-secret");
    expect(receivedUrl).toContain("user_type=agent");

    controller.abort();
    await startPromise;
    expect(getWsClient()).toBeNull();
  });

  it("connectNewRoom sends joinRoom WS message with correct password", async () => {
    const controller = new AbortController();
    const { ctx, account, onReady } = makeCtx(port, { abortSignal: controller.signal });

    const startPromise = gatewayAdapter.startAccount(ctx);

    const serverSocket = await new Promise<WsWebSocket>((resolve) =>
      wss.once("connection", (s) => resolve(s))
    );
    await new Promise<void>((r) => onReady.mockImplementation(r));

    const joinMsg = await new Promise<string>((resolve) => {
      serverSocket.once("message", (data) => resolve(data.toString()));
      connectNewRoom({ roomId: ROOM_ID, roomPassword: ROOM_PASSWORD });
    });

    const parsed = JSON.parse(joinMsg);
    expect(parsed.method).toBe("joinRoom");
    expect(parsed.params.room_id).toBe(ROOM_ID);
    expect(parsed.params.password).toBe(ROOM_PASSWORD);

    controller.abort();
    await startPromise;
  });

  it("receives @mention → emits inbound message to OpenClaw", async () => {
    const emittedMessages: ClawPondInbound[] = [];
    const controller = new AbortController();
    const { ctx, account, onReady } = makeCtx(port, {
      abortSignal: controller.signal,
      emitHandler: (inbound) => emittedMessages.push(inbound),
    });

    const startPromise = gatewayAdapter.startAccount(ctx);

    const serverSocket = await new Promise<WsWebSocket>((resolve) =>
      wss.once("connection", (s) => resolve(s))
    );
    await new Promise<void>((r) => onReady.mockImplementation(r));

    connectNewRoom({ roomId: ROOM_ID, roomPassword: ROOM_PASSWORD });
    // consume the joinRoom message
    await new Promise((r) => setTimeout(r, 50));

    serverSocket.send(makeMentionBroadcast(AGENT_ID));
    await new Promise((r) => setTimeout(r, 100));

    expect(emittedMessages).toHaveLength(1);
    const msg = emittedMessages[0];
    expect(msg.channel).toBe("clawpond");
    expect(msg.accountId).toBe("integration");
    expect(msg.roomId).toBe(ROOM_ID);
    expect(msg.messageId).toBe(100);
    expect(msg.text).toBe("@IntegBot please help");
    expect(msg.isGroup).toBe(true);
    // Session isolation: each room is its own group peer
    expect(msg.peerId).toBe(ROOM_ID);
    expect(msg.peerKind).toBe("group");

    controller.abort();
    await startPromise;
  });

  it("outbound sendText sends payload with room_id to the server", async () => {
    const controller = new AbortController();
    const { ctx, account, onReady } = makeCtx(port, { abortSignal: controller.signal });

    const startPromise = gatewayAdapter.startAccount(ctx);

    const serverSocket = await new Promise<WsWebSocket>((resolve) =>
      wss.once("connection", (s) => resolve(s))
    );
    await new Promise<void>((r) => onReady.mockImplementation(r));

    connectNewRoom({ roomId: ROOM_ID, roomPassword: ROOM_PASSWORD });
    await new Promise((r) => setTimeout(r, 50));

    const outbound = createOutboundAdapter(() => getWsClient());

    const replyContext: ReplyContext = {
      roomId: ROOM_ID,
      messageId: 100,
      senderId: "user-human-1",
      accountId: "integration",
    };
    const outboundCtx: OutboundContext = {
      text: "I can help!",
      target: { id: "target-1", replyContext },
      account,
    };

    const serverReceived = await new Promise<string>((resolve) => {
      serverSocket.once("message", (data) => resolve(data.toString()));
      outbound.sendText(outboundCtx);
    });

    const parsed = JSON.parse(serverReceived);
    expect(parsed.method).toBe("sendMessage");
    expect(parsed.params.room_id).toBe(ROOM_ID);
    expect(parsed.params.text).toBe("I can help!");
    expect(parsed.params.reply_to).toBe(100);

    controller.abort();
    await startPromise;
  });

  it("full round-trip: receive @mention → emit → reply via outbound", async () => {
    let capturedInbound: ClawPondInbound | null = null;
    const controller = new AbortController();
    const { ctx, account, onReady } = makeCtx(port, {
      abortSignal: controller.signal,
      emitHandler: (inbound) => { capturedInbound = inbound; },
    });

    const startPromise = gatewayAdapter.startAccount(ctx);
    const outbound = createOutboundAdapter(() => getWsClient());

    const serverSocket = await new Promise<WsWebSocket>((resolve) =>
      wss.once("connection", (s) => resolve(s))
    );
    await new Promise<void>((r) => onReady.mockImplementation(r));

    connectNewRoom({ roomId: ROOM_ID, roomPassword: ROOM_PASSWORD });
    await new Promise((r) => setTimeout(r, 50));

    serverSocket.send(makeMentionBroadcast(AGENT_ID));
    await new Promise((r) => setTimeout(r, 100));

    expect(capturedInbound).not.toBeNull();
    // Verify session isolation fields in the round-trip inbound message
    expect(capturedInbound!.peerId).toBe(ROOM_ID);
    expect(capturedInbound!.peerKind).toBe("group");

    const replyContext: ReplyContext = {
      roomId: capturedInbound!.roomId,
      messageId: capturedInbound!.messageId,
      senderId: capturedInbound!.senderId,
      accountId: capturedInbound!.accountId,
    };

    const serverReceived = await new Promise<string>((resolve) => {
      serverSocket.once("message", (data) => resolve(data.toString()));
      outbound.sendText({
        text: "Round-trip reply",
        target: { id: "t1", replyContext },
        account,
      });
    });

    const parsed = JSON.parse(serverReceived);
    expect(parsed.params.room_id).toBe(ROOM_ID);
    expect(parsed.params.text).toBe("Round-trip reply");
    expect(parsed.params.reply_to).toBe(100);

    controller.abort();
    await startPromise;
  });

  it("ignores messages not mentioning the agent", async () => {
    const emittedMessages: ClawPondInbound[] = [];
    const controller = new AbortController();
    const { ctx, onReady } = makeCtx(port, {
      abortSignal: controller.signal,
      emitHandler: (inbound) => emittedMessages.push(inbound),
    });

    const startPromise = gatewayAdapter.startAccount(ctx);

    const serverSocket = await new Promise<WsWebSocket>((resolve) =>
      wss.once("connection", (s) => resolve(s))
    );
    await new Promise<void>((r) => onReady.mockImplementation(r));

    connectNewRoom({ roomId: ROOM_ID, roomPassword: ROOM_PASSWORD });
    await new Promise((r) => setTimeout(r, 50));

    const data: RelayMessageData = {
      id: "msg-other",
      message_id: 200,
      room_id: ROOM_ID,
      sender_id: "user-1",
      sender_name: "Alice",
      text: "@OtherBot hello",
      type: "text",
      mentions: [{ agentId: "other-agent-uuid", username: "OtherBot" }],
      created_at: new Date().toISOString(),
    };
    serverSocket.send(JSON.stringify({ event: "message", data }));
    await new Promise((r) => setTimeout(r, 100));

    expect(emittedMessages).toHaveLength(0);
    controller.abort();
    await startPromise;
  });
});
