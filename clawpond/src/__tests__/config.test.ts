import { configAdapter } from "../config";
import { OpenClawConfig } from "../types";

type AccountsMap = NonNullable<NonNullable<NonNullable<OpenClawConfig["channels"]>["clawpond"]>["accounts"]>;

const makeConfig = (accounts: Record<string, unknown> = {}): OpenClawConfig => ({
  channels: { clawpond: { accounts: accounts as AccountsMap } },
});

describe("configAdapter.listAccountIds", () => {
  it("returns all account keys from the config", () => {
    const config = makeConfig({
      default: { relayWsUrl: "ws://a", agentId: "id-a", agentSecret: "sec-a", agentName: "BotA" },
      secondary: { relayWsUrl: "ws://b", agentId: "id-b", agentSecret: "sec-b", agentName: "BotB" },
    });
    expect(configAdapter.listAccountIds(config)).toEqual(["default", "secondary"]);
  });

  it("returns empty array when accounts is empty", () => {
    expect(configAdapter.listAccountIds(makeConfig())).toEqual([]);
  });

  it("returns empty array when channels.clawpond is absent", () => {
    expect(configAdapter.listAccountIds({})).toEqual([]);
  });

  it("returns empty array when channels is absent", () => {
    expect(configAdapter.listAccountIds({ channels: undefined })).toEqual([]);
  });
});

describe("configAdapter.resolveAccount", () => {
  const validRaw = {
    relayWsUrl: "ws://localhost:8000",
    agentId: "test-agent-uuid",
    agentSecret: "test-secret",
    agentName: "TestBot",
  };

  it("resolves a fully-specified account correctly", () => {
    const config = makeConfig({ default: validRaw });
    const account = configAdapter.resolveAccount(config, "default");
    expect(account).toEqual({
      accountId: "default",
      relayWsUrl: "ws://localhost:8000",
      agentId: "test-agent-uuid",
      agentSecret: "test-secret",
      agentName: "TestBot",
      agentDescription: "OpenClaw Agent",
      reconnectInterval: 1000,
      maxReconnectDelay: 30_000,
    });
  });

  it("defaults accountId to 'default' when not provided", () => {
    const config = makeConfig({ default: validRaw });
    expect(configAdapter.resolveAccount(config, undefined)?.accountId).toBe("default");
  });

  it("injects default reconnectInterval", () => {
    const config = makeConfig({ default: validRaw });
    expect(configAdapter.resolveAccount(config, "default")?.reconnectInterval).toBe(1000);
  });

  it("injects default maxReconnectDelay", () => {
    const config = makeConfig({ default: validRaw });
    expect(configAdapter.resolveAccount(config, "default")?.maxReconnectDelay).toBe(30_000);
  });

  it("preserves custom reconnectInterval and maxReconnectDelay", () => {
    const config = makeConfig({
      default: { ...validRaw, reconnectInterval: 500, maxReconnectDelay: 5000 },
    });
    const account = configAdapter.resolveAccount(config, "default");
    expect(account?.reconnectInterval).toBe(500);
    expect(account?.maxReconnectDelay).toBe(5000);
  });

  it("injects default agentDescription", () => {
    const config = makeConfig({ default: validRaw });
    expect(configAdapter.resolveAccount(config, "default")?.agentDescription).toBe("OpenClaw Agent");
  });

  it("preserves custom agentDescription", () => {
    const config = makeConfig({ default: { ...validRaw, agentDescription: "My custom bot" } });
    expect(configAdapter.resolveAccount(config, "default")?.agentDescription).toBe("My custom bot");
  });

  // ── required field validation ─────────────────────────────────────────────

  it("returns undefined when relayWsUrl is missing", () => {
    const config = makeConfig({
      default: { agentId: "id", agentSecret: "sec", agentName: "Bot" },
    });
    expect(configAdapter.resolveAccount(config, "default")).toBeUndefined();
  });

  it("returns undefined when agentId is missing", () => {
    const config = makeConfig({
      default: { relayWsUrl: "ws://localhost:8000", agentSecret: "sec", agentName: "Bot" },
    });
    expect(configAdapter.resolveAccount(config, "default")).toBeUndefined();
  });

  it("returns undefined when agentSecret is missing", () => {
    const config = makeConfig({
      default: { relayWsUrl: "ws://localhost:8000", agentId: "id", agentName: "Bot" },
    });
    expect(configAdapter.resolveAccount(config, "default")).toBeUndefined();
  });

  it("returns undefined when agentName is missing", () => {
    const config = makeConfig({
      default: { relayWsUrl: "ws://localhost:8000", agentId: "id", agentSecret: "sec" },
    });
    expect(configAdapter.resolveAccount(config, "default")).toBeUndefined();
  });

  it("returns undefined when the accountId does not exist", () => {
    const config = makeConfig({ default: validRaw });
    expect(configAdapter.resolveAccount(config, "nonexistent")).toBeUndefined();
  });

  it("returns undefined when accounts object is absent", () => {
    expect(configAdapter.resolveAccount({}, "default")).toBeUndefined();
  });
});
