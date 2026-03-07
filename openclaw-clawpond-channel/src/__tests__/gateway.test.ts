/**
 * gateway.test.ts
 *
 * Uses jest.spyOn(global, 'fetch') to mock the HTTP call inside fetchJoinedRooms,
 * and a real WebSocketServer for the WS connections.
 */

import { WebSocketServer } from "ws";
import { gatewayAdapter, connectNewRoom, getWsClient } from "../gateway";
import { ClawPondAccount, GatewayDeps } from "../types";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeAccount(overrides: Partial<ClawPondAccount> = {}): ClawPondAccount {
  return {
    accountId: "default",
    relayUrl: "http://relay-test.local",
    relayWsUrl: "ws://localhost",   // will be overridden per-test
    agentName: "GatewayBot",
    agentDescription: "Test",
    reconnectInterval: 5000,        // long – we don't want reconnect noise
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

/** Build a mock Response for a successful /api/v1/agents GET */
function makeAgentsResponse(agents: Array<{ agent_id: string; name: string; room_id: string | null }>) {
  return Promise.resolve(
    new Response(JSON.stringify({ agents }), { status: 200 })
  );
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

describe("fetchJoinedRooms (via gatewayAdapter.start)", () => {
  let wss: WebSocketServer;
  let port: number;
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    const srv = await startServer();
    wss = srv.wss;
    port = srv.port;
    fetchSpy = jest.spyOn(global, "fetch");
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it("filters agents by agentName and builds JoinedRoom list", async () => {
    fetchSpy.mockReturnValue(
      makeAgentsResponse([
        { agent_id: "uuid-1", name: "GatewayBot", room_id: "room-A" },
        { agent_id: "uuid-2", name: "OtherBot",  room_id: "room-B" },
        { agent_id: "uuid-3", name: "GatewayBot", room_id: "room-C" },
      ])
    );

    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();

    // We just want to see that two rooms are connected (not zero)
    let connectCount = 0;
    wss.on("connection", () => { connectCount++; });

    const { stop } = await gatewayAdapter.start(account, deps);
    await new Promise((r) => setTimeout(r, 100));

    expect(connectCount).toBe(2); // room-A + room-C
    await stop();
  });

  it("calls onReady and logs a hint when there are no joined rooms", async () => {
    fetchSpy.mockReturnValue(makeAgentsResponse([]));

    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();

    const { stop } = await gatewayAdapter.start(account, deps);

    expect(deps.onReady).toHaveBeenCalledTimes(1);
    expect(deps.logger.info).toHaveBeenCalledWith(
      "clawpond_no_joined_rooms",
      expect.objectContaining({ agentName: "GatewayBot" })
    );
    await stop();
  });

  it("returns empty list and warns when the fetch throws", async () => {
    fetchSpy.mockRejectedValue(new Error("Network error"));

    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();

    const { stop } = await gatewayAdapter.start(account, deps);
    await new Promise((r) => setTimeout(r, 50));

    // Warn should have been called from the catch block
    expect(deps.logger.warn).toHaveBeenCalledWith(
      "clawpond_fetch_joined_rooms_failed",
      expect.objectContaining({ error: expect.any(String) })
    );
    await stop();
  });

  it("returns empty list when the HTTP response is not ok", async () => {
    fetchSpy.mockReturnValue(
      Promise.resolve(new Response("", { status: 500 }))
    );

    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();
    let connectCount = 0;
    wss.on("connection", () => { connectCount++; });

    const { stop } = await gatewayAdapter.start(account, deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(connectCount).toBe(0);
    await stop();
  });

  it("ignores agents with null room_id", async () => {
    fetchSpy.mockReturnValue(
      makeAgentsResponse([
        { agent_id: "uuid-1", name: "GatewayBot", room_id: null },
      ])
    );

    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();
    let connectCount = 0;
    wss.on("connection", () => { connectCount++; });

    const { stop } = await gatewayAdapter.start(account, deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(connectCount).toBe(0);
    await stop();
  });
});

describe("gatewayAdapter lifecycle", () => {
  let wss: WebSocketServer;
  let port: number;
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    const srv = await startServer();
    wss = srv.wss;
    port = srv.port;
    fetchSpy = jest.spyOn(global, "fetch").mockReturnValue(
      makeAgentsResponse([{ agent_id: "uuid-1", name: "GatewayBot", room_id: "room-A" }])
    );
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
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
});

describe("connectNewRoom", () => {
  let wss: WebSocketServer;
  let port: number;
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    const srv = await startServer();
    wss = srv.wss;
    port = srv.port;
    // Start with no pre-joined rooms
    fetchSpy = jest.spyOn(global, "fetch").mockReturnValue(makeAgentsResponse([]));
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it("returns null when gateway has not been started", () => {
    // Ensure there is no active client
    expect(getWsClient()).toBeNull();
    const result = connectNewRoom({ roomId: "r1", agentId: "a1", userId: "agent-a1" });
    expect(result).toBeNull();
  });

  it("connects to the new room without affecting pre-existing rooms", async () => {
    const account = makeAccount({ relayWsUrl: `ws://localhost:${port}` });
    const deps = makeDeps();

    const { stop } = await gatewayAdapter.start(account, deps);

    let connectCount = 0;
    wss.on("connection", () => { connectCount++; });

    const stopRoom = connectNewRoom({ roomId: "dynamic-room", agentId: "uuid-d", userId: "agent-uuid-d" });
    expect(stopRoom).not.toBeNull();

    await new Promise((r) => setTimeout(r, 100));
    expect(connectCount).toBe(1); // only the dynamically joined room

    if (stopRoom) stopRoom();
    await stop();
  });
});
