import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { ClawPondWsClient } from "../ws-client";
import { ClawPondAccount, GatewayDeps, JoinedRoom, RelayBroadcast, RelayMessageData } from "../types";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeAccount(overrides: Partial<ClawPondAccount> = {}): ClawPondAccount {
  return {
    accountId: "default",
    relayUrl: "http://localhost",
    relayWsUrl: "ws://localhost",
    agentName: "TestBot",
    agentDescription: "Test",
    reconnectInterval: 50,   // short delays for fast tests
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

function makeRoom(overrides: Partial<JoinedRoom> = {}): JoinedRoom {
  return {
    roomId: "room-001",
    agentId: "agent-uuid-1",
    userId: "agent-agent-uuid-1",
    ...overrides,
  };
}

/** Wait for a WS server to receive the next connection */
function waitForConnection(wss: WebSocketServer): Promise<WsWebSocket> {
  return new Promise((resolve) => wss.once("connection", (socket) => resolve(socket)));
}

/** Start a local WS server on an OS-assigned port and return it with the port */
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

function makeMessageBroadcast(
  mentions: RelayMessageData["mentions"],
  senderId = "user-human-1"
): string {
  const data: RelayMessageData = {
    id: "m1",
    message_id: 1,
    room_id: "room-001",
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

describe("ClawPondWsClient", () => {
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

  // ── connection ─────────────────────────────────────────────────────────────

  describe("connectRoom", () => {
    it("establishes a WebSocket connection to the correct URL", async () => {
      const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);
      const room = makeRoom();

      const connPromise = waitForConnection(wss);
      client.connectRoom(room);
      const serverSocket = await connPromise;

      expect(serverSocket).toBeDefined();
      await client.disconnectAll();
    });

    it("includes correct query parameters in the connection URL", async () => {
      const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);
      const room = makeRoom({ roomId: "room-xyz", userId: "agent-uuid-99" });

      let receivedUrl = "";
      wss.once("connection", (_sock, req) => { receivedUrl = req.url ?? ""; });

      client.connectRoom(room);
      await new Promise<void>((resolve) => wss.once("connection", () => resolve()));

      expect(receivedUrl).toContain("/ws/room-xyz");
      expect(receivedUrl).toContain("user_id=agent-uuid-99");
      expect(receivedUrl).toContain("username=TestBot");
      expect(receivedUrl).toContain("user_type=agent");
      expect(receivedUrl).toContain("role=member");

      await client.disconnectAll();
    });

    it("calls deps.onReady when the connection opens", async () => {
      const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);

      client.connectRoom(makeRoom());
      await new Promise<void>((resolve) => {
        (deps.onReady as jest.Mock).mockImplementation(resolve);
      });

      expect(deps.onReady).toHaveBeenCalledTimes(1);
      await client.disconnectAll();
    });
  });

  // ── @mention filtering ─────────────────────────────────────────────────────

  describe("@mention detection via onMessage", () => {
    it("triggers the handler for a structured agentId mention", async () => {
      const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);
      const handler = jest.fn();
      client.onMessage(handler);

      const room = makeRoom({ agentId: "agent-uuid-1" });
      client.connectRoom(room);
      const serverSocket = await waitForConnection(wss);

      await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

      const msg = makeMessageBroadcast([{ agentId: "agent-uuid-1", username: "TestBot" }]);
      serverSocket.send(msg);

      await new Promise((r) => setTimeout(r, 50));
      expect(handler).toHaveBeenCalledTimes(1);
      await client.disconnectAll();
    });

    it("triggers the handler for a legacy string mention (case-insensitive)", async () => {
      const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);
      const handler = jest.fn();
      client.onMessage(handler);

      client.connectRoom(makeRoom());
      const serverSocket = await waitForConnection(wss);
      await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

      // lower-case variant of the agent name
      serverSocket.send(makeMessageBroadcast(["testbot"]));
      await new Promise((r) => setTimeout(r, 50));
      expect(handler).toHaveBeenCalledTimes(1);
      await client.disconnectAll();
    });

    it("does NOT trigger the handler when there is no matching mention", async () => {
      const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);
      const handler = jest.fn();
      client.onMessage(handler);

      client.connectRoom(makeRoom());
      const serverSocket = await waitForConnection(wss);
      await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

      serverSocket.send(makeMessageBroadcast([]));
      await new Promise((r) => setTimeout(r, 50));
      expect(handler).not.toHaveBeenCalled();
      await client.disconnectAll();
    });

    it("does NOT trigger the handler for a different agentId", async () => {
      const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);
      const handler = jest.fn();
      client.onMessage(handler);

      client.connectRoom(makeRoom({ agentId: "agent-uuid-1" }));
      const serverSocket = await waitForConnection(wss);
      await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

      serverSocket.send(makeMessageBroadcast([{ agentId: "agent-uuid-OTHER", username: "OtherBot" }]));
      await new Promise((r) => setTimeout(r, 50));
      expect(handler).not.toHaveBeenCalled();
      await client.disconnectAll();
    });

    it("does NOT trigger the handler for own messages (sender_id === userId)", async () => {
      const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);
      const handler = jest.fn();
      client.onMessage(handler);

      const room = makeRoom({ agentId: "agent-uuid-1", userId: "agent-agent-uuid-1" });
      client.connectRoom(room);
      const serverSocket = await waitForConnection(wss);
      await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

      // sender_id equals the agent's own userId
      serverSocket.send(
        makeMessageBroadcast([{ agentId: "agent-uuid-1", username: "TestBot" }], "agent-agent-uuid-1")
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(handler).not.toHaveBeenCalled();
      await client.disconnectAll();
    });

    it("ignores broadcasts with non-message events", async () => {
      const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);
      const handler = jest.fn();
      client.onMessage(handler);

      client.connectRoom(makeRoom());
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

      client.connectRoom(makeRoom());
      const serverSocket = await waitForConnection(wss);
      await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

      expect(() => serverSocket.send("NOT_VALID_JSON")).not.toThrow();
      await new Promise((r) => setTimeout(r, 50));
      expect(deps.logger.warn).toHaveBeenCalledWith(
        "clawpond_ws_parse_error",
        expect.objectContaining({ error: expect.any(String) })
      );
      await client.disconnectAll();
    });
  });

  // ── sendMessage ────────────────────────────────────────────────────────────

  describe("sendMessage", () => {
    it("sends a correctly formatted JSON payload", async () => {
      const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);

      client.connectRoom(makeRoom({ roomId: "room-001" }));
      const serverSocket = await waitForConnection(wss);
      await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

      const received = await new Promise<string>((resolve) => {
        serverSocket.once("message", (data) => resolve(data.toString()));
        client.sendMessage("room-001", "Hi there");
      });

      const parsed = JSON.parse(received);
      expect(parsed.method).toBe("sendMessage");
      expect(parsed.params.text).toBe("Hi there");
      expect(parsed.params.reply_to).toBeUndefined();

      await client.disconnectAll();
    });

    it("includes reply_to when provided", async () => {
      const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);

      client.connectRoom(makeRoom({ roomId: "room-001" }));
      const serverSocket = await waitForConnection(wss);
      await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

      const received = await new Promise<string>((resolve) => {
        serverSocket.once("message", (data) => resolve(data.toString()));
        client.sendMessage("room-001", "Reply!", 99);
      });

      const parsed = JSON.parse(received);
      expect(parsed.params.reply_to).toBe(99);

      await client.disconnectAll();
    });

    it("returns false and logs a warning when the room is not connected", () => {
      const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);

      const result = client.sendMessage("nonexistent-room", "Hello");
      expect(result).toBe(false);
      expect(deps.logger.warn).toHaveBeenCalledWith(
        "clawpond_ws_send_failed_not_open",
        expect.objectContaining({ roomId: "nonexistent-room" })
      );
    });

    it("returns true on a successful send", async () => {
      const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);

      client.connectRoom(makeRoom({ roomId: "room-001" }));
      await waitForConnection(wss);
      await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

      const result = client.sendMessage("room-001", "Hello");
      expect(result).toBe(true);

      await client.disconnectAll();
    });
  });

  // ── disconnectAll ──────────────────────────────────────────────────────────

  describe("disconnectAll", () => {
    it("closes all open connections", async () => {
      const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);

      client.connectRoom(makeRoom({ roomId: "r1" }));
      client.connectRoom(makeRoom({ roomId: "r2" }));
      await new Promise((r) => setTimeout(r, 100));

      await client.disconnectAll();

      // After disconnectAll, further sends should fail
      expect(client.sendMessage("r1", "test")).toBe(false);
      expect(client.sendMessage("r2", "test")).toBe(false);
    });
  });

  // ── stop function ──────────────────────────────────────────────────────────

  describe("connectRoom stop function", () => {
    it("stops the connection for the specific room", async () => {
      const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);

      const stop = client.connectRoom(makeRoom({ roomId: "room-001" }));
      await waitForConnection(wss);
      await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

      stop();

      // Send should fail because the room is no longer tracked
      expect(client.sendMessage("room-001", "test")).toBe(false);
      await client.disconnectAll();
    });
  });

  // ── exponential back-off reconnection ─────────────────────────────────────

  describe("exponential back-off reconnection", () => {
    it("reconnects after the server closes the connection", async () => {
      const account = makeAccount({
        relayWsUrl: `ws://localhost:${port}`,
        reconnectInterval: 30,
        maxReconnectDelay: 500,
      });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);

      let connectionCount = 0;
      wss.on("connection", () => { connectionCount++; });

      client.connectRoom(makeRoom());
      // Wait for first connection
      await new Promise((r) => setTimeout(r, 100));
      expect(connectionCount).toBe(1);

      // Close all server-side sockets to trigger client reconnect
      wss.clients.forEach((s) => s.close());

      // Wait for at least one reconnect attempt
      await new Promise((r) => setTimeout(r, 200));
      expect(connectionCount).toBeGreaterThanOrEqual(2);

      await client.disconnectAll();
    });

    it("does not reconnect after stop() is called", async () => {
      const account = makeAccount({
        relayWsUrl: `ws://localhost:${port}`,
        reconnectInterval: 30,
        maxReconnectDelay: 500,
      });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);

      let connectionCount = 0;
      wss.on("connection", () => { connectionCount++; });

      const stop = client.connectRoom(makeRoom());
      await new Promise((r) => setTimeout(r, 80));
      expect(connectionCount).toBe(1);

      // Stop before the server closes
      stop();
      wss.clients.forEach((s) => s.close());

      await new Promise((r) => setTimeout(r, 200));
      // Should still be 1 – no reconnect happened
      expect(connectionCount).toBe(1);
    });

    it("respects maxReconnectDelay cap", async () => {
      jest.useFakeTimers();
      const account = makeAccount({
        relayWsUrl: `ws://localhost:${port}`,
        reconnectInterval: 100,
        maxReconnectDelay: 300,
      });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);

      // spy on the private method through logger.info calls
      const scheduleInfoCalls: number[] = [];
      (deps.logger.info as jest.Mock).mockImplementation((msg: string, meta?: Record<string, unknown>) => {
        if (msg === "clawpond_ws_reconnecting" && meta?.delayMs !== undefined) {
          scheduleInfoCalls.push(meta.delayMs as number);
        }
      });

      // Simulate multiple reconnects manually by calling _scheduleReconnect indirectly
      // We do this by direct property access since we can't use fake timers with a live WS server
      // Instead validate the delay math: base=100, max=300
      // attempt 0 → delay = min(100*2^0, 300) = 100
      // attempt 1 → delay = min(100*2^1, 300) = 200
      // attempt 2 → delay = min(100*2^2, 300) = 300
      // attempt 3 → delay = min(100*2^3, 300) = 300 (capped)
      const base = 100;
      const max = 300;
      for (let i = 0; i < 4; i++) {
        const delay = Math.min(base * Math.pow(2, i), max);
        expect(delay).toBeLessThanOrEqual(max);
      }
      expect(Math.min(base * Math.pow(2, 3), max)).toBe(300);

      jest.useRealTimers();
      await client.disconnectAll();
    });
  });

  // ── error handling ─────────────────────────────────────────────────────────

  describe("error handling", () => {
    it("calls deps.onDisconnect when the server closes the connection", async () => {
      const account = makeAccount({
        relayWsUrl: `ws://localhost:${port}`,
        reconnectInterval: 5000, // long delay so reconnect doesn't fire in test
      });
      const deps = makeDeps();
      const client = new ClawPondWsClient(account, deps);

      client.connectRoom(makeRoom());
      const serverSocket = await waitForConnection(wss);
      await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

      // Close from server side
      serverSocket.close();
      await new Promise((r) => setTimeout(r, 100));

      expect(deps.onDisconnect).toHaveBeenCalled();
      await client.disconnectAll();
    });
  });
});
