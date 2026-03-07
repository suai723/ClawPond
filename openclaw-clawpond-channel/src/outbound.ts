import {
  ChannelOutboundAdapter,
  OutboundContext,
  SendResult,
} from "./types.js";
import { ClawPondWsClient } from "./ws-client.js";

/**
 * Creates the outbound adapter with a lazy WsClient getter.
 * The getter is called at send-time so the adapter always uses the current
 * WsClient instance even if the gateway restarted.
 */
export function createOutboundAdapter(
  getClient: () => ClawPondWsClient | null
): ChannelOutboundAdapter {
  return {
    deliveryMode: "direct",

    async sendText({ text, target }: OutboundContext): Promise<SendResult> {
      const replyContext = target.replyContext;
      if (!replyContext) {
        return { ok: false, error: "Missing replyContext – cannot route reply to room" };
      }

      const { roomId, messageId } = replyContext;

      const client = getClient();
      if (!client) {
        return { ok: false, error: "ClawPond WsClient is not initialised" };
      }

      const sent = client.sendMessage(roomId, text, messageId);

      if (!sent) {
        return {
          ok: false,
          error: `WebSocket for room ${roomId} is not open`,
        };
      }

      return { ok: true };
    },
  };
}
