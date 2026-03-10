/**
 * tools.test.ts
 *
 * Full-chain simulation for clawpond_register and clawpond_join_room tools.
 *
 * Strategy:
 *  - global.fetch is mocked via jest.fn() – no real network calls
 *  - connectNewRoom is mocked via jest.mock("../gateway") – no real WebSocket
 *  - api is a hand-crafted mock object with registerTool + runtime methods
 */

import { registerClawPondTools } from "../tools";
import { connectNewRoom } from "../gateway";
import type { PluginApi, ToolDefinition, OpenClawConfig } from "../types";

// ── Mock gateway so connectNewRoom is a spy ───────────────────────────────────
jest.mock("../gateway", () => ({
  connectNewRoom: jest.fn(),
  getWsClient: jest.fn(() => null),
  gatewayAdapter: { start: jest.fn() },
}));

const mockConnectNewRoom = connectNewRoom as jest.Mock;

// ── Fetch mock helpers ────────────────────────────────────────────────────────

function mockFetchOk(body: unknown): void {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  });
}

function mockFetchError(status: number, detail: string): void {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: false,
    status,
    statusText: "Error",
    json: async () => ({ detail }),
  });
}

// ── API mock factory ──────────────────────────────────────────────────────────

function makeApi(overrides?: {
  config?: OpenClawConfig;
  updateChannelConfig?: jest.Mock;
  restartGateway?: jest.Mock;
  noRuntime?: boolean;
  noRegisterTool?: boolean;
}): PluginApi & { registerTool: jest.Mock } {
  const updateChannelConfig = overrides?.updateChannelConfig ?? jest.fn().mockResolvedValue(undefined);
  const restartGateway = overrides?.restartGateway ?? jest.fn().mockResolvedValue(undefined);
  const config: OpenClawConfig = overrides?.config ?? {
    channels: {
      clawpond: {
        accounts: {
          default: {
            relayWsUrl: "ws://localhost:8000",
            agentId: "agent-uuid-123",
            agentSecret: "agent-secret-abc",
            agentName: "TestBot",
          },
        },
      },
    },
  };

  const api: PluginApi & { registerTool: jest.Mock } = {
    registerChannel: jest.fn(),
    registerTool: overrides?.noRegisterTool ? undefined as unknown as jest.Mock : jest.fn(),
    runtime: overrides?.noRuntime
      ? undefined
      : {
          getConfig: () => config,
          updateChannelConfig,
          restartGateway,
          log: jest.fn(),
        },
  };
  return api;
}

// ── Retrieve bound execute from registered tool ───────────────────────────────

function getRegisteredExecute(api: PluginApi & { registerTool: jest.Mock }, name: string) {
  const calls: [ToolDefinition, unknown][] = api.registerTool.mock.calls;
  const call = calls.find(([tool]) => tool.name === name);
  if (!call) throw new Error(`Tool "${name}" was not registered`);
  return call[0].execute.bind(call[0]);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  global.fetch = jest.fn();
  mockConnectNewRoom.mockClear();
});

afterEach(() => {
  jest.resetAllMocks();
});

// =============================================================================
// registerClawPondTools
// =============================================================================

describe("registerClawPondTools", () => {
  it("registers clawpond_register and clawpond_join_room when api.registerTool exists", () => {
    const api = makeApi();
    registerClawPondTools(api);

    const names = (api.registerTool.mock.calls as [ToolDefinition, unknown][]).map(([t]) => t.name);
    expect(names).toContain("clawpond_register");
    expect(names).toContain("clawpond_join_room");
    expect(api.registerTool).toHaveBeenCalledTimes(2);
  });

  it("does not throw when api.registerTool is absent", () => {
    const api = makeApi({ noRegisterTool: true });
    expect(() => registerClawPondTools(api)).not.toThrow();
  });

  it("tools have correct name, description, and required parameters", () => {
    const api = makeApi();
    registerClawPondTools(api);

    const tools: Record<string, ToolDefinition> = {};
    for (const [tool] of api.registerTool.mock.calls as [ToolDefinition, unknown][]) {
      tools[tool.name] = tool;
    }

    expect(tools["clawpond_register"].parameters.required).toContain("relayUrl");
    expect(tools["clawpond_register"].parameters.required).toContain("agentName");
    expect(tools["clawpond_join_room"].parameters.required).toContain("roomPassword");
  });
});

// =============================================================================
// clawpond_register
// =============================================================================

describe("clawpond_register", () => {
  it("calls POST /api/v1/agents/register with correct URL and body", async () => {
    const api = makeApi();
    registerClawPondTools(api);
    const execute = getRegisteredExecute(api, "clawpond_register");

    mockFetchOk({
      agent_id: "new-agent-id",
      agent_secret: "new-agent-secret",
      name: "TestBot",
      message: "Registered",
    });

    await execute("call-1", {
      relayUrl: "http://localhost:8000",
      agentName: "TestBot",
      description: "A test bot",
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8000/api/v1/agents/register");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe("TestBot");
    expect(body.description).toBe("A test bot");
  });

  it("returns ok:true with agent_id and agent_secret on success", async () => {
    const api = makeApi();
    registerClawPondTools(api);
    const execute = getRegisteredExecute(api, "clawpond_register");

    mockFetchOk({
      agent_id: "new-agent-id",
      agent_secret: "new-agent-secret",
      name: "TestBot",
      message: "Registered",
    });

    const result = await execute("call-1", {
      relayUrl: "http://localhost:8000",
      agentName: "TestBot",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(true);
    expect(data.agent_id).toBe("new-agent-id");
    expect(data.agent_secret).toBe("new-agent-secret");
    expect(data.warning).toContain("agent_secret is shown only once");
  });

  it("calls api.runtime.updateChannelConfig with correct credentials", async () => {
    const updateChannelConfig = jest.fn().mockResolvedValue(undefined);
    const api = makeApi({ updateChannelConfig });
    registerClawPondTools(api);
    const execute = getRegisteredExecute(api, "clawpond_register");

    mockFetchOk({
      agent_id: "saved-id",
      agent_secret: "saved-secret",
      name: "SaveBot",
      message: "ok",
    });

    await execute("call-1", {
      relayUrl: "http://localhost:8000",
      agentName: "SaveBot",
    });

    expect(updateChannelConfig).toHaveBeenCalledWith(
      "clawpond",
      expect.objectContaining({
        accounts: expect.objectContaining({
          default: expect.objectContaining({
            agentId: "saved-id",
            agentSecret: "saved-secret",
            agentName: "SaveBot",
          }),
        }),
      }),
    );
  });

  it("sets config_saved:true and calls restartGateway when updateChannelConfig succeeds", async () => {
    const restartGateway = jest.fn().mockResolvedValue(undefined);
    const api = makeApi({ restartGateway });
    registerClawPondTools(api);
    const execute = getRegisteredExecute(api, "clawpond_register");

    mockFetchOk({
      agent_id: "r-id",
      agent_secret: "r-sec",
      name: "RestartBot",
      message: "ok",
    });

    const result = await execute("call-1", {
      relayUrl: "http://localhost:8000",
      agentName: "RestartBot",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.config_saved).toBe(true);
    expect(data.gateway_restarted).toBe(true);
    expect(restartGateway).toHaveBeenCalledWith("clawpond");
    expect(data.next_steps).toContain("WebSocket connection will establish automatically");
  });

  it("returns config_saved:false and manual instructions when updateChannelConfig throws", async () => {
    const updateChannelConfig = jest.fn().mockRejectedValue(new Error("disk error"));
    const api = makeApi({ updateChannelConfig });
    registerClawPondTools(api);
    const execute = getRegisteredExecute(api, "clawpond_register");

    mockFetchOk({
      agent_id: "fail-id",
      agent_secret: "fail-sec",
      name: "FailBot",
      message: "ok",
    });

    const result = await execute("call-1", {
      relayUrl: "http://localhost:8000",
      agentName: "FailBot",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(true);
    expect(data.config_saved).toBe(false);
    expect(data.next_steps).toContain("openclaw.json");
    expect(data.next_steps).toContain("fail-id");
  });

  it("returns ok:true with config_saved:false when api.runtime is absent", async () => {
    const api = makeApi({ noRuntime: true });
    registerClawPondTools(api);
    const execute = getRegisteredExecute(api, "clawpond_register");

    mockFetchOk({
      agent_id: "nr-id",
      agent_secret: "nr-sec",
      name: "NoRuntimeBot",
      message: "ok",
    });

    const result = await execute("call-1", {
      relayUrl: "http://localhost:8000",
      agentName: "NoRuntimeBot",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(true);
    expect(data.agent_id).toBe("nr-id");
    expect(data.config_saved).toBe(false);
  });

  it("returns ok:false when registration HTTP call fails", async () => {
    const api = makeApi();
    registerClawPondTools(api);
    const execute = getRegisteredExecute(api, "clawpond_register");

    mockFetchError(409, "Agent name already taken");

    const result = await execute("call-1", {
      relayUrl: "http://localhost:8000",
      agentName: "TakenBot",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(false);
    expect(data.error).toContain("Registration failed");
    expect(data.error).toContain("Agent name already taken");
  });

  it("converts ws:// relayUrl to http:// for the register HTTP call", async () => {
    const api = makeApi();
    registerClawPondTools(api);
    const execute = getRegisteredExecute(api, "clawpond_register");

    mockFetchOk({
      agent_id: "ws-id",
      agent_secret: "ws-sec",
      name: "WsBot",
      message: "ok",
    });

    await execute("call-1", {
      relayUrl: "ws://relay.example.com:9000",
      agentName: "WsBot",
    });

    const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://relay.example.com:9000/api/v1/agents/register");
  });

  it("stores relayWsUrl in ws:// format when relayUrl is http://", async () => {
    const updateChannelConfig = jest.fn().mockResolvedValue(undefined);
    const api = makeApi({ updateChannelConfig });
    registerClawPondTools(api);
    const execute = getRegisteredExecute(api, "clawpond_register");

    mockFetchOk({
      agent_id: "x",
      agent_secret: "y",
      name: "Bot",
      message: "ok",
    });

    await execute("call-1", {
      relayUrl: "http://localhost:8000",
      agentName: "Bot",
    });

    const [, patch] = updateChannelConfig.mock.calls[0] as [string, Record<string, unknown>];
    const accounts = patch.accounts as Record<string, unknown>;
    const def = accounts["default"] as Record<string, unknown>;
    expect(def.relayWsUrl).toBe("ws://localhost:8000");
  });
});

// =============================================================================
// clawpond_join_room
// =============================================================================

describe("clawpond_join_room", () => {
  it("validates room password, calls join API, and invokes connectNewRoom", async () => {
    const api = makeApi();
    registerClawPondTools(api);
    const execute = getRegisteredExecute(api, "clawpond_join_room");

    // Step 1: validate
    mockFetchOk({ valid: true, room_id: "room-uuid-abc" });
    // Step 2: join
    mockFetchOk({
      agent_id: "agent-uuid-123",
      user_id: "agent-agent-uuid-123",
      username: "TestBot",
      room_id: "room-uuid-abc",
      message: "Joined",
    });

    const result = await execute("call-1", { roomPassword: "secret-password" });

    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(true);
    expect(data.room_id).toBe("room-uuid-abc");
    expect(data.user_id).toBe("agent-agent-uuid-123");
    expect(data.session_info).toContain("room-uuid-abc");

    expect(mockConnectNewRoom).toHaveBeenCalledTimes(1);
    expect(mockConnectNewRoom).toHaveBeenCalledWith({
      roomId: "room-uuid-abc",
      roomPassword: "secret-password",
    });
  });

  it("calls POST /api/v1/rooms/validate with room password", async () => {
    const api = makeApi();
    registerClawPondTools(api);
    const execute = getRegisteredExecute(api, "clawpond_join_room");

    mockFetchOk({ valid: true, room_id: "r-1" });
    mockFetchOk({
      agent_id: "a",
      user_id: "u",
      username: "Bot",
      room_id: "r-1",
      message: "ok",
    });

    await execute("call-1", { roomPassword: "my-password" });

    const [validateUrl, validateInit] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(validateUrl).toBe("http://localhost:8000/api/v1/rooms/validate");
    expect(JSON.parse(validateInit.body as string).password).toBe("my-password");
  });

  it("calls POST /api/v1/agents/join with agent credentials and resolved room_id", async () => {
    const api = makeApi();
    registerClawPondTools(api);
    const execute = getRegisteredExecute(api, "clawpond_join_room");

    mockFetchOk({ valid: true, room_id: "resolved-room-id" });
    mockFetchOk({
      agent_id: "agent-uuid-123",
      user_id: "u",
      username: "TestBot",
      room_id: "resolved-room-id",
      message: "ok",
    });

    await execute("call-1", { roomPassword: "room-token" });

    const [joinUrl, joinInit] = (global.fetch as jest.Mock).mock.calls[1] as [string, RequestInit];
    expect(joinUrl).toBe("http://localhost:8000/api/v1/agents/join");
    const body = JSON.parse(joinInit.body as string);
    expect(body.agent_id).toBe("agent-uuid-123");
    expect(body.agent_secret).toBe("agent-secret-abc");
    expect(body.room_id).toBe("resolved-room-id");
    expect(body.room_password).toBe("room-token");
  });

  it("returns ok:false for invalid room password (validate returns valid:false)", async () => {
    const api = makeApi();
    registerClawPondTools(api);
    const execute = getRegisteredExecute(api, "clawpond_join_room");

    mockFetchOk({ valid: false, room_id: null });

    const result = await execute("call-1", { roomPassword: "wrong-password" });

    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(false);
    expect(data.error).toContain("Invalid room password");
    expect(mockConnectNewRoom).not.toHaveBeenCalled();
  });

  it("returns ok:false when account is not configured", async () => {
    const api = makeApi({
      config: { channels: { clawpond: { accounts: {} } } },
    });
    registerClawPondTools(api);
    const execute = getRegisteredExecute(api, "clawpond_join_room");

    const result = await execute("call-1", { roomPassword: "any-pass" });

    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(false);
    expect(data.error).toContain("not configured");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns ok:false when api.runtime is absent (no config available)", async () => {
    const api = makeApi({ noRuntime: true });
    registerClawPondTools(api);
    const execute = getRegisteredExecute(api, "clawpond_join_room");

    const result = await execute("call-1", { roomPassword: "any-pass" });

    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(false);
    expect(data.error).toContain("not configured");
  });

  it("returns ok:false when join API call fails with 401", async () => {
    const api = makeApi();
    registerClawPondTools(api);
    const execute = getRegisteredExecute(api, "clawpond_join_room");

    mockFetchOk({ valid: true, room_id: "r-1" });
    mockFetchError(401, "Invalid agent credentials");

    const result = await execute("call-1", { roomPassword: "good-password" });

    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(false);
    expect(data.error).toContain("Join room failed");
    expect(data.error).toContain("Invalid agent credentials");
    expect(mockConnectNewRoom).not.toHaveBeenCalled();
  });

  it("returns ok:false when room validation HTTP call throws", async () => {
    const api = makeApi();
    registerClawPondTools(api);
    const execute = getRegisteredExecute(api, "clawpond_join_room");

    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("Network unreachable"));

    const result = await execute("call-1", { roomPassword: "any" });

    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(false);
    expect(data.error).toContain("Room validation failed");
    expect(data.error).toContain("Network unreachable");
  });

  it("uses named accountId when provided", async () => {
    const api = makeApi({
      config: {
        channels: {
          clawpond: {
            accounts: {
              myAccount: {
                relayWsUrl: "ws://other-host:9000",
                agentId: "other-agent-id",
                agentSecret: "other-secret",
                agentName: "OtherBot",
              },
            },
          },
        },
      },
    });
    registerClawPondTools(api);
    const execute = getRegisteredExecute(api, "clawpond_join_room");

    mockFetchOk({ valid: true, room_id: "r-2" });
    mockFetchOk({
      agent_id: "other-agent-id",
      user_id: "u2",
      username: "OtherBot",
      room_id: "r-2",
      message: "ok",
    });

    await execute("call-1", { roomPassword: "pass", accountId: "myAccount" });

    const [, joinInit] = (global.fetch as jest.Mock).mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(joinInit.body as string);
    expect(body.agent_id).toBe("other-agent-id");
    expect(body.agent_secret).toBe("other-secret");

    const [validateUrl] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(validateUrl).toContain("other-host:9000");
  });
});
