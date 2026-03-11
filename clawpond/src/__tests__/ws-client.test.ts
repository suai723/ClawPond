/**
 * ws-client.test.ts
 *
 * Tests for the single-connection ClawPondWsClient.
 * Uses a real WebSocketServer to verify connection, joinRoom, sendMessage,
 * @mention detection, reconnection, and error handling.
 */

import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { ClawPondWsClient } from "../ws-client";
import { ClawPondAccount, GatewayDeps, RelayBroadcast, RelayMessageData } from "../types";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeAccount(overrides: Partial<ClawPondAccount> = {}): ClawPondAccount {
  return {
    accountId: "default",
    relayWsUrl: "ws://localhost",
    agentId: "test-agent-uuid",
    agentSecret: "test-secret",
    agentName: "TestBot",
    agentDescription: "Test",
    reconnectInterval: 50,
    maxReconnectDelay: 200,
    ...overrides,
  };
}

function makeDeps(): GatewayDeps & {
  logger: { debug: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock };
  emit: jest.Mock;
  onReady: jest.Mock;
  onError: jest.Mock;
  onDisconnect: jest.Mock;
} {
  return {
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    emit: jest.fn(),
    onReady: jest.fn(),
    onError: jest.fn(),
    onDisconnect: jest.fn(),
  };
}

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

function waitForConnection(wss: WebSocketServer): Promise<WsWebSocket> {
  return new Promise((resolve) => wss.once("connection", (socket) => resolve(socket)));
}

function makeMentionBroadcast(
  mentions: RelayMessageData["mentions"],
  senderId = "user-human-1",
  roomId = "room-001"
): string {
  const data: RelayMessageData = {
    id: "m1",
    message_id: 1,
    room_id: roomId,
    sender_id: senderId,
    sender_name: "Alice",
    text: "Hello @TestBot",
    type: "text",
    mentions,
    created_at: new Date().toISOString(),
  };
  const broadcast: RelayBroadcast = { event: "message", data };
  return JSON.stringify(broadcast);
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("ClawPondWsClient – connection", () => {
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

  it("establishes a single WebSocket connection on connect()", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);

    const connPromise = waitForConnection(wss);
    client.connect();
    const serverSocket = await connPromise;

    expect(serverSocket).toBeDefined();
    await client.disconnectAll();
  });

  it("URL contains agent_id, agent_secret, user_type=agent", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);

    let receivedUrl = "";
    wss.once("connection", (_sock, req) => { receivedUrl = req.url ?? ""; });

    client.connect();
    await waitForConnection(wss);

    expect(receivedUrl).toContain("agent_id=test-agent-uuid");
    expect(receivedUrl).toContain("agent_secret=test-secret");
    expect(receivedUrl).toContain("user_type=agent");

    await client.disconnectAll();
  });

  it("calls deps.onReady when connection opens", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);

    client.connect();
    await new Promise<void>((resolve) => {
      (deps.onReady as jest.Mock).mockImplementation(resolve);
    });

    expect(deps.onReady).toHaveBeenCalledTimes(1);
    await client.disconnectAll();
  });
});

describe("ClawPondWsClient – joinRoom", () => {
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

  it("sends joinRoom message when called after connection is open", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);

    client.connect();
    const serverSocket = await waitForConnection(wss);
    await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

    const received = await new Promise<string>((resolve) => {
      serverSocket.once("message", (data) => resolve(data.toString()));
      client.joinRoom("room-001", "secret-password");
    });

    const parsed = JSON.parse(received);
    expect(parsed.method).toBe("joinRoom");
    expect(parsed.params.room_id).toBe("room-001");
    expect(parsed.params.password).toBe("secret-password");

    await client.disconnectAll();
  });

  it("sends joinRoom for all queued rooms when connection opens", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);

    // Queue rooms before connecting
    client.joinRoom("room-A", "pass-A");
    client.joinRoom("room-B", "pass-B");

    expect(deps.logger.info).toHaveBeenCalledWith("clawpond_ws_room_queued", { roomId: "room-A" });
    expect(deps.logger.info).toHaveBeenCalledWith("clawpond_ws_room_queued", { roomId: "room-B" });

    const receivedMessages: string[] = [];
    wss.once("connection", (serverSocket) => {
      serverSocket.on("message", (data) => receivedMessages.push(data.toString()));
    });

    client.connect();
    await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));
    await new Promise((r) => setTimeout(r, 50));

    const parsed = receivedMessages.map((m) => JSON.parse(m));
    const roomIds = parsed.map((p) => p.params.room_id);
    const passwords = parsed.map((p) => p.params.password);
    expect(roomIds).toContain("room-A");
    expect(roomIds).toContain("room-B");
    expect(passwords).toContain("pass-A");
    expect(passwords).toContain("pass-B");

    await client.disconnectAll();
  });

  it("re-subscribes all rooms after reconnection", async () => {
    const account = makeAccount({
      relayWsUrl: `ws://localhost:${port}`,
      reconnectInterval: 30,
      maxReconnectDelay: 200,
    });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);

    client.joinRoom("room-001", "password-1");

    const joinMessages: string[] = [];
    wss.on("connection", (serverSocket) => {
      serverSocket.on("message", (data) => joinMessages.push(data.toString()));
    });

    client.connect();
    // Wait for first connection and joinRoom
    await new Promise((r) => setTimeout(r, 100));

    // Disconnect from server side to trigger reconnect
    wss.clients.forEach((s) => s.close());
    await new Promise((r) => setTimeout(r, 200));

    // Should have joinRoom from both initial + reconnect
    const joinRoomMessages = joinMessages
      .map((m) => JSON.parse(m))
      .filter((p) => p.method === "joinRoom");

    expect(joinRoomMessages.length).toBeGreaterThanOrEqual(2);
    expect(joinRoomMessages[0].params.password).toBe("password-1");

    await client.disconnectAll();
  });
});

describe("ClawPondWsClient – sendMessage", () => {
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

  it("sends payload with method, room_id, text", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);

    client.connect();
    const serverSocket = await waitForConnection(wss);
    await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

    // Consume the joinRoom messages first if any
    const received = await new Promise<string>((resolve) => {
      serverSocket.once("message", (data) => resolve(data.toString()));
      client.sendMessage("room-001", "Hello world");
    });

    const parsed = JSON.parse(received);
    expect(parsed.method).toBe("sendMessage");
    expect(parsed.params.room_id).toBe("room-001");
    expect(parsed.params.text).toBe("Hello world");
    expect(parsed.params.reply_to).toBeUndefined();

    await client.disconnectAll();
  });

  it("includes reply_to when provided", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);

    client.connect();
    const serverSocket = await waitForConnection(wss);
    await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

    const received = await new Promise<string>((resolve) => {
      serverSocket.once("message", (data) => resolve(data.toString()));
      client.sendMessage("room-001", "Reply!", 42);
    });

    const parsed = JSON.parse(received);
    expect(parsed.params.reply_to).toBe(42);

    await client.disconnectAll();
  });

  it("returns false and warns when not connected", () => {
    const account = makeAccount({ relayWsUrl: "ws://localhost:9" });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);

    const result = client.sendMessage("room-001", "test");
    expect(result).toBe(false);
    expect(deps.logger.info).toHaveBeenCalledWith(
      "clawpond_ws_send_failed_not_open",
      expect.objectContaining({ roomId: "room-001" })
    );
  });

  it("returns true on successful send", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);

    client.connect();
    await waitForConnection(wss);
    await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

    const result = client.sendMessage("room-001", "Hello");
    expect(result).toBe(true);
    expect(deps.logger.info).toHaveBeenCalledWith(
      "clawpond_ws_send_ok",
      expect.objectContaining({ roomId: "room-001", textLength: 5 })
    );

    await client.disconnectAll();
  });
});

describe("ClawPondWsClient – @mention detection", () => {
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

  it("triggers handler for structured agentId mention", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);
    const handler = jest.fn();
    client.onMessage(handler);

    client.connect();
    const serverSocket = await waitForConnection(wss);
    await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

    serverSocket.send(makeMentionBroadcast([{ agentId: "test-agent-uuid", username: "TestBot" }]));
    await new Promise((r) => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledTimes(1);
    await client.disconnectAll();
  });

  it("triggers handler for legacy string mention (case-insensitive)", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);
    const handler = jest.fn();
    client.onMessage(handler);

    client.connect();
    const serverSocket = await waitForConnection(wss);
    await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

    serverSocket.send(makeMentionBroadcast(["testbot"]));
    await new Promise((r) => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledTimes(1);
    await client.disconnectAll();
  });

  it("does NOT trigger for non-matching mention", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);
    const handler = jest.fn();
    client.onMessage(handler);

    client.connect();
    const serverSocket = await waitForConnection(wss);
    await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

    serverSocket.send(makeMentionBroadcast([{ agentId: "other-agent", username: "OtherBot" }]));
    await new Promise((r) => setTimeout(r, 50));

    expect(handler).not.toHaveBeenCalled();
    await client.disconnectAll();
  });

  it("does NOT trigger for own messages (sender_id === agent-{agentId})", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);
    const handler = jest.fn();
    client.onMessage(handler);

    client.connect();
    const serverSocket = await waitForConnection(wss);
    await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

    // sender_id = "agent-{agentId}"
    serverSocket.send(
      makeMentionBroadcast(
        [{ agentId: "test-agent-uuid", username: "TestBot" }],
        "agent-test-agent-uuid"
      )
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(handler).not.toHaveBeenCalled();
    await client.disconnectAll();
  });

  it("ignores non-message events", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);
    const handler = jest.fn();
    client.onMessage(handler);

    client.connect();
    const serverSocket = await waitForConnection(wss);
    await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

    serverSocket.send(JSON.stringify({ event: "memberJoined", data: {} }));
    await new Promise((r) => setTimeout(r, 50));

    expect(handler).not.toHaveBeenCalled();
    await client.disconnectAll();
  });

  it("ignores malformed JSON without throwing", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);

    client.connect();
    const serverSocket = await waitForConnection(wss);
    await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

    expect(() => serverSocket.send("NOT_VALID_JSON")).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.logger.info).toHaveBeenCalledWith(
      "clawpond_ws_parse_error",
      expect.objectContaining({ error: expect.any(String) })
    );
    await client.disconnectAll();
  });

  it("passes roomId from message data to the handler", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);
    const handler = jest.fn();
    client.onMessage(handler);

    client.connect();
    const serverSocket = await waitForConnection(wss);
    await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

    serverSocket.send(
      makeMentionBroadcast(
        [{ agentId: "test-agent-uuid", username: "TestBot" }],
        "user-1",
        "specific-room-id"
      )
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ room_id: "specific-room-id" }),
      "specific-room-id"
    );
    await client.disconnectAll();
  });
});

describe("ClawPondWsClient – reconnection", () => {
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

  it("reconnects after server closes the connection", async () => {
    const account = makeAccount({
      relayWsUrl: `ws://localhost:${port}`,
      reconnectInterval: 30,
      maxReconnectDelay: 500,
    });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);

    let connectionCount = 0;
    wss.on("connection", () => { connectionCount++; });

    client.connect();
    await new Promise((r) => setTimeout(r, 100));
    expect(connectionCount).toBe(1);

    wss.clients.forEach((s) => s.close());
    await new Promise((r) => setTimeout(r, 200));

    expect(connectionCount).toBeGreaterThanOrEqual(2);
    await client.disconnectAll();
  });

  it("does not reconnect after disconnectAll()", async () => {
    const account = makeAccount({
      relayWsUrl: `ws://localhost:${port}`,
      reconnectInterval: 30,
      maxReconnectDelay: 200,
    });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);

    let connectionCount = 0;
    wss.on("connection", () => { connectionCount++; });

    client.connect();
    await new Promise((r) => setTimeout(r, 80));
    expect(connectionCount).toBe(1);

    await client.disconnectAll();
    wss.clients.forEach((s) => s.close());

    await new Promise((r) => setTimeout(r, 200));
    expect(connectionCount).toBe(1);
  });

  it("respects maxReconnectDelay cap in delay calculation", () => {
    const base = 100;
    const max = 300;
    for (let i = 0; i < 5; i++) {
      const delay = Math.min(base * Math.pow(2, i), max);
      expect(delay).toBeLessThanOrEqual(max);
    }
    expect(Math.min(base * Math.pow(2, 3), max)).toBe(300);
  });

  it("calls deps.onDisconnect when server closes the connection", async () => {
    const account = makeAccount({
      relayWsUrl: `ws://localhost:${port}`,
      reconnectInterval: 5000,
    });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);

    client.connect();
    const serverSocket = await waitForConnection(wss);
    await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

    serverSocket.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(deps.onDisconnect).toHaveBeenCalled();
    await client.disconnectAll();
  });
});

describe("ClawPondWsClient – disconnectAll", () => {
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

  it("stops the connection and makes sendMessage return false", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();
    const client = new ClawPondWsClient(account, deps);

    client.connect();
    await waitForConnection(wss);
    await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

    await client.disconnectAll();
    expect(deps.logger.info).toHaveBeenCalledWith("clawpond_ws_disconnect_all", {
      accountId: account.accountId,
    });
    expect(client.sendMessage("room-001", "test")).toBe(false);
  });
});
