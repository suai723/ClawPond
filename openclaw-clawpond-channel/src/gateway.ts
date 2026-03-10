import {
  ChannelGatewayAdapter,
  ClawPondAccount,
  GatewayDeps,
  JoinedRoom,
  MessagingDeps,
} from "./types.js";
import { ClawPondWsClient } from "./ws-client.js";
import { handleInboundMessage } from "./messaging.js";

/** Module-level WsClient instance shared between gateway and outbound adapters */
let _wsClient: ClawPondWsClient | null = null;

/** Returns the active WsClient (used by outbound adapter factory) */
export function getWsClient(): ClawPondWsClient | null {
  return _wsClient;
}

export const gatewayAdapter: ChannelGatewayAdapter = {
  async start(
    account: ClawPondAccount,
    deps: GatewayDeps
  ): Promise<{ stop: () => Promise<void> }> {
    const wsClient = new ClawPondWsClient(account, deps);
    _wsClient = wsClient;

    // Wire up @mention → OpenClaw
    const messagingDeps: MessagingDeps = {
      logger: deps.logger,
      emitMessage: (inbound) => deps.emit("message:inbound", inbound),
    };

    wsClient.onMessage((data, roomId) => {
      handleInboundMessage(data, roomId, account.accountId, messagingDeps);
    });

    // Start the single WebSocket connection; onReady() is called once connected
    wsClient.connect();

    return {
      async stop() {
        await wsClient.disconnectAll();
        _wsClient = null;
      },
    };
  },
};

/**
 * Called externally after HTTP room-join to subscribe the agent to a room.
 * The WsClient sends a joinRoom WS message immediately if connected,
 * or queues it for the next (re)connect.
 */
export function connectNewRoom(joinedRoom: JoinedRoom): void {
  _wsClient?.joinRoom(joinedRoom.roomId, joinedRoom.roomPassword);
}
