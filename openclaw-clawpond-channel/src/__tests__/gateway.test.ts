/**
 * gateway.test.ts
 *
 * Tests gateway lifecycle and connectNewRoom() with the single-connection model.
 * Uses a real WebSocketServer; no HTTP mocks needed.
 */

import { WebSocketServer } from "ws";
import { gatewayAdapter, connectNewRoom, getWsClient } from "../gateway";
import { ClawPondAccount, GatewayDeps } from "../types";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeAccount(overrides: Partial<ClawPondAccount> = {}): ClawPondAccount {
  return {
    accountId: "default",
    relayWsUrl: "ws://localhost",
    agentId: "gateway-agent-uuid",
    agentSecret: "gateway-secret",
    agentName: "GatewayBot",
    agentDescription: "Test",
    reconnectInterval: 5000,
    maxReconnectDelay: 30_000,
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

// ── tests ─────────────────────────────────────────────────────────────────

describe("gatewayAdapter lifecycle", () => {
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

  it("sets the module-level _wsClient on start", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();

    expect(getWsClient()).toBeNull();
    const { stop } = await gatewayAdapter.start(account, deps);
    expect(getWsClient()).not.toBeNull();
    await stop();
  });

  it("clears the module-level _wsClient on stop()", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();

    const { stop } = await gatewayAdapter.start(account, deps);
    await stop();
    expect(getWsClient()).toBeNull();
  });

  it("WS connects to the server after start()", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();

    let connectCount = 0;
    wss.on("connection", () => { connectCount++; });

    const { stop } = await gatewayAdapter.start(account, deps);
    await new Promise((r) => setTimeout(r, 100));

    expect(connectCount).toBe(1);
    await stop();
  });

  it("calls onReady once the WS connection opens", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();

    const { stop } = await gatewayAdapter.start(account, deps);
    await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

    expect(deps.onReady).toHaveBeenCalledTimes(1);
    await stop();
  });
});

describe("connectNewRoom", () => {
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

  it("returns without error when gateway has not been started", () => {
    expect(getWsClient()).toBeNull();
    // Should not throw
    expect(() =>
      connectNewRoom({ roomId: "r1", roomPassword: "pw1" })
    ).not.toThrow();
  });

  it("sends joinRoom WS message after gateway start", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();

    const { stop } = await gatewayAdapter.start(account, deps);

    const serverSocket = await new Promise<import("ws").WebSocket>((resolve) =>
      wss.once("connection", (s) => resolve(s))
    );
    await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

    const joinMsg = await new Promise<string>((resolve) => {
      serverSocket.once("message", (data) => resolve(data.toString()));
      connectNewRoom({ roomId: "dynamic-room", roomPassword: "secret-pw" });
    });

    const parsed = JSON.parse(joinMsg);
    expect(parsed.method).toBe("joinRoom");
    expect(parsed.params.password).toBe("secret-pw");

    await stop();
  });

  it("can connect multiple rooms independently", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();

    const { stop } = await gatewayAdapter.start(account, deps);

    const serverSocket = await new Promise<import("ws").WebSocket>((resolve) =>
      wss.once("connection", (s) => resolve(s))
    );
    await new Promise<void>((r) => (deps.onReady as jest.Mock).mockImplementation(r));

    const joinMessages: string[] = [];
    serverSocket.on("message", (data) => joinMessages.push(data.toString()));

    connectNewRoom({ roomId: "room-1", roomPassword: "pw-1" });
    connectNewRoom({ roomId: "room-2", roomPassword: "pw-2" });

    await new Promise((r) => setTimeout(r, 100));

    const parsed = joinMessages.map((m) => JSON.parse(m));
    const passwords = parsed.map((p) => p.params.password);
    expect(passwords).toContain("pw-1");
    expect(passwords).toContain("pw-2");

    await stop();
  });
});
