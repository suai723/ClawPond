import { securityAdapter } from "../security";
import { ClawPondAccount } from "../types";

const mockAccount: ClawPondAccount = {
  accountId: "default",
  relayWsUrl: "ws://localhost:8000",
  agentId: "test-agent-uuid",
  agentSecret: "test-secret",
  agentName: "TestBot",
  agentDescription: "Test agent",
  reconnectInterval: 1000,
  maxReconnectDelay: 30_000,
};

describe("securityAdapter", () => {
  describe("getDmPolicy", () => {
    it("returns 'open' for any account", () => {
      expect(securityAdapter.getDmPolicy(mockAccount)).toBe("open");
    });
  });

  describe("getAllowFrom", () => {
    it("returns an empty array for any account", () => {
      expect(securityAdapter.getAllowFrom(mockAccount)).toEqual([]);
    });

    it("returns a new array each call (not a shared reference)", () => {
      const first = securityAdapter.getAllowFrom(mockAccount);
      const second = securityAdapter.getAllowFrom(mockAccount);
      expect(first).not.toBe(second);
    });
  });
});
