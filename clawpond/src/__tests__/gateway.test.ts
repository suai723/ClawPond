/**
 * gateway.test.ts
 *
 * Tests gateway lifecycle and connectNewRoom() with the single-connection model.
 * Uses a real WebSocketServer; no HTTP mocks needed.
 */

import { WebSocketServer } from "ws";
import { gatewayAdapter, connectNewRoom, syncRooms, getWsClient } from "../gateway";
import { ClawPondAccount, GatewayStartAccountCtx, OpenClawConfig } from "../types";

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

function makeCtx(
  port: number,
  opts?: { abortSignal?: AbortSignal }
): {
  ctx: GatewayStartAccountCtx;
  log: jest.Mock;
  emit: jest.Mock;
  onReady: jest.Mock;
  onError: jest.Mock;
  onDisconnect: jest.Mock;
} {
  const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
  const log = jest.fn();
  const emit = jest.fn();
  const onReady = jest.fn();
  const onError = jest.fn();
  const onDisconnect = jest.fn();
  const cfg: OpenClawConfig = {
    channels: { clawpond: { accounts: { default: account } } },
  };
  const ctx: GatewayStartAccountCtx = {
    cfg,
    accountId: "default",
    log,
    emit,
    onReady,
    onError,
    onDisconnect,
    abortSignal: opts?.abortSignal,
  };
  return { ctx, log, emit, onReady, onError, onDisconnect };
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

  it("sets the module-level _wsClient on startAccount", async () => {
    const controller = new AbortController();
    const { ctx, log, onReady } = makeCtx(port, { abortSignal: controller.signal });

    expect(getWsClient()).toBeNull();
    const startPromise = gatewayAdapter.startAccount(ctx);
    await new Promise<void>((r) => onReady.mockImplementation(r));
    expect(getWsClient()).not.toBeNull();
    expect(log).toHaveBeenCalledWith(
      "clawpond_gateway_start",
      expect.objectContaining({ accountId: "default", relayWsUrl: `ws://localhost:${port}` })
    );
    controller.abort();
    await startPromise;
  });

  it("clears the module-level _wsClient on abort", async () => {
    const controller = new AbortController();
    const { ctx, log, onReady } = makeCtx(port, { abortSignal: controller.signal });

    const startPromise = gatewayAdapter.startAccount(ctx);
    await new Promise<void>((r) => onReady.mockImplementation(r));
    controller.abort();
    await startPromise;
    expect(log).toHaveBeenCalledWith(
      "clawpond_gateway_stop",
      expect.objectContaining({ accountId: "default" })
    );
    expect(getWsClient()).toBeNull();
  });

  it("WS connects to the server after startAccount()", async () => {
    const controller = new AbortController();
    const { ctx, onReady } = makeCtx(port, { abortSignal: controller.signal });

    let connectCount = 0;
    wss.on("connection", () => { connectCount++; });

    const startPromise = gatewayAdapter.startAccount(ctx);
    await new Promise<void>((r) => onReady.mockImplementation(r));
    await new Promise((r) => setTimeout(r, 100));

    expect(connectCount).toBe(1);
    controller.abort();
    await startPromise;
  });

  it("calls onReady once the WS connection opens", async () => {
    const controller = new AbortController();
    const { ctx, onReady } = makeCtx(port, { abortSignal: controller.signal });

    const startPromise = gatewayAdapter.startAccount(ctx);
    await new Promise<void>((r) => onReady.mockImplementation(r));

    expect(onReady).toHaveBeenCalledTimes(1);
    controller.abort();
    await startPromise;
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

  it("sends joinRoom WS message after gateway startAccount", async () => {
    const controller = new AbortController();
    const { ctx, log, onReady } = makeCtx(port, { abortSignal: controller.signal });

    const startPromise = gatewayAdapter.startAccount(ctx);

    const serverSocket = await new Promise<import("ws").WebSocket>((resolve) =>
      wss.once("connection", (s) => resolve(s))
    );
    await new Promise<void>((r) => onReady.mockImplementation(r));

    const joinMsg = await new Promise<string>((resolve) => {
      serverSocket.once("message", (data) => resolve(data.toString()));
      connectNewRoom({ roomId: "dynamic-room", roomPassword: "secret-pw" });
    });

    const parsed = JSON.parse(joinMsg);
    expect(parsed.method).toBe("joinRoom");
    expect(parsed.params.room_id).toBe("dynamic-room");
    expect(parsed.params.password).toBe("secret-pw");
    expect(log).toHaveBeenCalledWith("clawpond_gateway_connect_room", {
      roomId: "dynamic-room",
    });

    controller.abort();
    await startPromise;
  });

  it("syncRooms sends joinRoom for each HTTP-joined room", async () => {
    const controller = new AbortController();
    const { ctx, log, onReady } = makeCtx(port, { abortSignal: controller.signal });

    const startPromise = gatewayAdapter.startAccount(ctx);

    const serverSocket = await new Promise<import("ws").WebSocket>((resolve) =>
      wss.once("connection", (s) => resolve(s))
    );
    await new Promise<void>((r) => onReady.mockImplementation(r));

    const joinMessages: string[] = [];
    serverSocket.on("message", (data) => joinMessages.push(data.toString()));

    syncRooms([
      { roomId: "synced-a", roomPassword: "pass-a" },
      { roomId: "synced-b", roomPassword: "pass-b" },
    ]);

    await new Promise((r) => setTimeout(r, 100));

    const parsed = joinMessages.map((m) => JSON.parse(m));
    const roomIds = parsed.map((p) => p.params.room_id);
    const passwords = parsed.map((p) => p.params.password);
    expect(roomIds).toContain("synced-a");
    expect(roomIds).toContain("synced-b");
    expect(passwords).toContain("pass-a");
    expect(passwords).toContain("pass-b");
    expect(log).toHaveBeenCalledWith("clawpond_gateway_sync_rooms", {
      count: 2,
      roomIds: ["synced-a", "synced-b"],
    });

    controller.abort();
    await startPromise;
  });

  it("can connect multiple rooms independently", async () => {
    const controller = new AbortController();
    const { ctx, onReady } = makeCtx(port, { abortSignal: controller.signal });

    const startPromise = gatewayAdapter.startAccount(ctx);

    const serverSocket = await new Promise<import("ws").WebSocket>((resolve) =>
      wss.once("connection", (s) => resolve(s))
    );
    await new Promise<void>((r) => onReady.mockImplementation(r));

    const joinMessages: string[] = [];
    serverSocket.on("message", (data) => joinMessages.push(data.toString()));

    connectNewRoom({ roomId: "room-1", roomPassword: "pw-1" });
    connectNewRoom({ roomId: "room-2", roomPassword: "pw-2" });

    await new Promise((r) => setTimeout(r, 100));

    const parsed = joinMessages.map((m) => JSON.parse(m));
    const roomIds = parsed.map((p) => p.params.room_id);
    const passwords = parsed.map((p) => p.params.password);
    expect(roomIds).toContain("room-1");
    expect(roomIds).toContain("room-2");
    expect(passwords).toContain("pw-1");
    expect(passwords).toContain("pw-2");

    controller.abort();
    await startPromise;
  });
});
