import { createOutboundAdapter } from "../outbound";
import { ClawPondWsClient } from "../ws-client";
import { ClawPondAccount, GatewayDeps, OutboundContext, ReplyContext } from "../types";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeAccount(): ClawPondAccount {
  return {
    accountId: "default",
    relayWsUrl: "ws://localhost:8000",
    agentId: "test-agent-uuid",
    agentSecret: "test-secret",
    agentName: "Bot",
    agentDescription: "Test",
    reconnectInterval: 1000,
    maxReconnectDelay: 30_000,
  };
}

function makeDeps(): GatewayDeps {
  return {
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    emit: jest.fn(),
    onReady: jest.fn(),
    onError: jest.fn(),
    onDisconnect: jest.fn(),
  };
}

function makeContext(overrides: Partial<OutboundContext> = {}): OutboundContext {
  const replyContext: ReplyContext = {
    roomId: "room-001",
    messageId: 42,
    senderId: "user-1",
    accountId: "default",
  };
  return {
    text: "Hello!",
    target: { id: "target-1", replyContext },
    account: makeAccount(),
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────

describe("createOutboundAdapter", () => {
  describe("deliveryMode", () => {
    it("is 'direct'", () => {
      const adapter = createOutboundAdapter(() => null);
      expect(adapter.deliveryMode).toBe("direct");
    });
  });

  describe("sendText – success path", () => {
    it("returns { ok: true } when WsClient sends successfully", async () => {
      const account = makeAccount();
      const client = new ClawPondWsClient(account, makeDeps());
      // Mock sendMessage to return true (send succeeded)
      jest.spyOn(client, "sendMessage").mockReturnValue(true);

      const adapter = createOutboundAdapter(() => client);
      const result = await adapter.sendText(makeContext());

      expect(result.ok).toBe(true);
    });

    it("calls WsClient.sendMessage with the correct roomId, text and messageId", async () => {
      const account = makeAccount();
      const client = new ClawPondWsClient(account, makeDeps());
      const sendSpy = jest.spyOn(client, "sendMessage").mockReturnValue(true);

      const adapter = createOutboundAdapter(() => client);
      await adapter.sendText(makeContext({ text: "Hi there" }));

      expect(sendSpy).toHaveBeenCalledWith("room-001", "Hi there", 42);
    });
  });

  describe("sendText – failure paths", () => {
    it("returns { ok: false } with an error message when getClient() returns null", async () => {
      const adapter = createOutboundAdapter(() => null);
      const result = await adapter.sendText(makeContext());

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not initialised/i);
    });

    it("returns { ok: false } when WsClient.sendMessage returns false (WS not open)", async () => {
      const account = makeAccount();
      const client = new ClawPondWsClient(account, makeDeps());
      jest.spyOn(client, "sendMessage").mockReturnValue(false);

      const adapter = createOutboundAdapter(() => client);
      const result = await adapter.sendText(makeContext());

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/room-001/);
    });

    it("returns { ok: false } when replyContext is missing", async () => {
      const adapter = createOutboundAdapter(() => null);
      const ctx = makeContext({ target: { id: "t1", replyContext: undefined } });

      const result = await adapter.sendText(ctx);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/replyContext/i);
    });
  });

  describe("lazy WsClient getter", () => {
    it("calls the getter at send-time, not at construction time", async () => {
      const account = makeAccount();
      const client = new ClawPondWsClient(account, makeDeps());
      jest.spyOn(client, "sendMessage").mockReturnValue(true);

      let clientToReturn: ClawPondWsClient | null = null;
      const getter = jest.fn(() => clientToReturn);

      const adapter = createOutboundAdapter(getter);

      // Before the send, getter should not have been called yet
      expect(getter).not.toHaveBeenCalled();

      // Now set the client and send
      clientToReturn = client;
      await adapter.sendText(makeContext());

      expect(getter).toHaveBeenCalled();
    });

    it("reflects a new WsClient instance provided after construction", async () => {
      const account = makeAccount();
      const client1 = new ClawPondWsClient(account, makeDeps());
      const client2 = new ClawPondWsClient(account, makeDeps());

      const send1Spy = jest.spyOn(client1, "sendMessage").mockReturnValue(true);
      const send2Spy = jest.spyOn(client2, "sendMessage").mockReturnValue(true);

      let current: ClawPondWsClient = client1;
      const adapter = createOutboundAdapter(() => current);

      await adapter.sendText(makeContext());
      expect(send1Spy).toHaveBeenCalledTimes(1);
      expect(send2Spy).not.toHaveBeenCalled();

      // Simulate gateway restart: new client
      current = client2;
      await adapter.sendText(makeContext());
      expect(send1Spy).toHaveBeenCalledTimes(1); // unchanged
      expect(send2Spy).toHaveBeenCalledTimes(1);
    });
  });
});
