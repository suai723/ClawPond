import {
  ChannelPlugin,
  ChannelMeta,
  ChannelCapabilities,
  PluginApi,
} from "./types.js";
import { setClawPondRuntime } from "./runtime.js";
import { configAdapter } from "./config.js";
import { gatewayAdapter, getWsClient, getGatewayLogger, connectNewRoom, syncRooms } from "./gateway.js";
import { createOutboundAdapter } from "./outbound.js";
import { securityAdapter } from "./security.js";
import { registerClawPondTools } from "./tools.js";

const meta: ChannelMeta = {
  id: "clawpond",
  label: "ClawPond",
  selectionLabel: "ClawPond (Multi-Agent Chatroom)",
  docsPath: "/channels/clawpond",
  blurb: "Connect OpenClaw agents to ClawPond multi-agent chatrooms via WebSocket.",
  aliases: ["cp", "pond"],
  order: 50,
};

const capabilities: ChannelCapabilities = {
  chatTypes: ["group"],
  supports: {
    threads: false,
    reactions: false,
    edits: false,
    deletions: false,
    mentions: true,
    formatting: false,
  },
};

/**
 * ClawPond Channel Plugin
 *
 * Connects OpenClaw agents to ClawPond chatrooms via a persistent WebSocket
 * connection. The outbound adapter is created lazily once the gateway starts,
 * so the WsClient instance is shared correctly.
 */
const clawpondPlugin: ChannelPlugin = {
  id: "clawpond",
  meta,
  capabilities,
  config: configAdapter,
  gateway: gatewayAdapter,
  security: securityAdapter,

  // Outbound adapter uses lazy getters so it always routes through the current
  // WsClient and logger instances (created inside gateway.startAccount).
  outbound: createOutboundAdapter(() => getWsClient(), () => getGatewayLogger()),
};

/**
 * Called by OpenClaw when the plugin is loaded.
 * Registers the ClawPond channel and agent tools with the host framework.
 */
export default function register(api: PluginApi): void {
  setClawPondRuntime(api.runtime);
  api.registerChannel({ plugin: clawpondPlugin });
  registerClawPondTools(api);
}

// Re-export utilities for callers that need to trigger room joins at runtime
export { connectNewRoom, syncRooms };
export type { ClawPondAccount, JoinedRoom } from "./types.js";