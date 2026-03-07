import { ChannelConfigAdapter, ClawPondAccount, OpenClawConfig } from "./types.js";

export const configAdapter: ChannelConfigAdapter = {
  listAccountIds(config: OpenClawConfig): string[] {
    return Object.keys(config.channels?.clawpond?.accounts ?? {});
  },

  resolveAccount(
    config: OpenClawConfig,
    accountId: string | undefined
  ): ClawPondAccount | undefined {
    const accounts = config.channels?.clawpond?.accounts;
    if (!accounts) return undefined;

    const id = accountId ?? "default";
    const raw = accounts[id];
    if (!raw) return undefined;

    if (!raw.relayUrl || !raw.relayWsUrl || !raw.agentName) {
      return undefined;
    }

    return {
      accountId: id,
      relayUrl: raw.relayUrl,
      relayWsUrl: raw.relayWsUrl,
      agentName: raw.agentName,
      agentDescription: raw.agentDescription ?? "OpenClaw Agent",
      reconnectInterval: raw.reconnectInterval ?? 1000,
      maxReconnectDelay: raw.maxReconnectDelay ?? 30_000,
    };
  },
};
