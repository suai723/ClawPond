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

/**
 * Fetches the list of rooms that this agent has already joined on the relay.
 * The relay's GET /api/v1/agents endpoint returns all registered agents;
 * we filter by agentName and use the returned agent_id (UUID) as the identity.
 */
async function fetchJoinedRooms(
  account: ClawPondAccount,
  deps: GatewayDeps
): Promise<JoinedRoom[]> {
  try {
    const res = await fetch(
      `${account.relayUrl}/api/v1/agents?` +
        new URLSearchParams({ limit: "100" }).toString()
    );
    if (!res.ok) return [];

    const body = (await res.json()) as { agents: Array<{
      agent_id: string;
      name: string;
      room_id: string | null;
    }> };

    const joined: JoinedRoom[] = [];
    for (const agent of body.agents ?? []) {
      // 通过 agentName 找到属于本 agent 的记录
      if (agent.name === account.agentName && agent.room_id) {
        const agentId = agent.agent_id;
        joined.push({
          roomId: agent.room_id,
          agentId,
          // user_id 格式与注册时一致：agent-{agentId}
          userId: `agent-${agentId}`,
        });
      }
    }
    return joined;
  } catch (err) {
    deps.logger.warn("clawpond_fetch_joined_rooms_failed", { error: String(err) });
    return [];
  }
}

export const gatewayAdapter: ChannelGatewayAdapter = {
  async start(
    account: ClawPondAccount,
    deps: GatewayDeps
  ): Promise<{ stop: () => Promise<void> }> {
    const wsClient = new ClawPondWsClient(account, deps);
    _wsClient = wsClient;

    const stopFns: Array<() => void> = [];

    // Wire up @mention → OpenClaw
    const messagingDeps: MessagingDeps = {
      logger: deps.logger,
      emitMessage: (inbound) => deps.emit("message:inbound", inbound),
    };

    wsClient.onMessage((data, roomId) => {
      handleInboundMessage(data, roomId, account.accountId, messagingDeps);
    });

    // Connect to all rooms this agent is already registered in
    const joinedRooms = await fetchJoinedRooms(account, deps);

    if (joinedRooms.length === 0) {
      deps.logger.info("clawpond_no_joined_rooms", {
        agentName: account.agentName,
        hint: "Use the 'Join ClawPond Room' Agent Skill to join a room",
      });
      deps.onReady();
    }

    for (const room of joinedRooms) {
      deps.logger.info("clawpond_connecting_room", { roomId: room.roomId });
      const stop = wsClient.connectRoom(room);
      stopFns.push(stop);
    }

    return {
      async stop() {
        for (const fn of stopFns) fn();
        await wsClient.disconnectAll();
        _wsClient = null;
      },
    };
  },
};

/**
 * Called externally (e.g. from a room-join webhook handler) to connect
 * the WsClient to a newly joined room at runtime.
 */
export function connectNewRoom(joinedRoom: JoinedRoom): (() => void) | null {
  if (!_wsClient) return null;
  return _wsClient.connectRoom(joinedRoom);
}
