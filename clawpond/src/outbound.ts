import {
  ChannelOutboundAdapter,
  GatewayDeps,
  OutboundContext,
  SendResult,
} from "./types.js";
import { ClawPondWsClient } from "./ws-client.js";

type Logger = GatewayDeps["logger"];

const consoleLogger: Logger = {
  debug: (msg, meta) => console.debug("[ClawPond Outbound]", msg, meta ?? ""),
  info: (msg, meta) => console.log("[ClawPond Outbound]", msg, meta ?? ""),
  warn: (msg, meta) => console.warn("[ClawPond Outbound]", msg, meta ?? ""),
  error: (msg, meta) => console.error("[ClawPond Outbound]", msg, meta ?? ""),
};

/**
 * Resolve the ClawPond roomId from the outbound target.
 *
 * Priority:
 *  1. target.replyContext.roomId  (explicit, set by legacy/compatible paths)
 *  2. Parse "room:{uuid}" from target.id  (set by core from inbound To field)
 *  3. Fall back to target.id as-is  (best-effort, covers bare UUID cases)
 */
function resolveRoomId(target: OutboundContext["target"]): string | undefined {
  if (target.replyContext?.roomId) {
    return target.replyContext.roomId;
  }
  const match = target.id.match(/^room:(.+)$/);
  if (match?.[1]) {
    return match[1];
  }
  // Best-effort: use target.id directly if it looks like a UUID
  if (target.id && target.id !== "") {
    return target.id;
  }
  return undefined;
}

/**
 * Creates the outbound adapter with a lazy WsClient getter and an optional
 * logger getter (falls back to console when no logger is provided).
 *
 * The getClient getter is called at send-time so the adapter always uses the
 * current WsClient instance even if the gateway restarted.
 */
export function createOutboundAdapter(
  getClient: () => ClawPondWsClient | null,
  getLogger?: () => Logger | null,
): ChannelOutboundAdapter {
  const log = (): Logger => getLogger?.() ?? consoleLogger;

  return {
    deliveryMode: "direct",

    async sendText(context: OutboundContext): Promise<SendResult> {
      const { text, target, replyTo } = context;

      const roomId = resolveRoomId(target);
      if (!roomId) {
        log().error("clawpond_outbound_no_room", {
          targetId: target.id,
          hasReplyContext: !!target.replyContext,
        });
        return { ok: false, error: "Cannot resolve roomId from outbound target" };
      }

      // replyTo is optional – used for reply-threading only
      const replyToMessageId =
        target.replyContext?.messageId ?? replyTo?.messageId;

      log().info("clawpond_outbound_send", {
        roomId,
        replyToMessageId,
        textLength: text.length,
      });

      const client = getClient();
      if (!client) {
        log().error("clawpond_outbound_no_client", { roomId });
        return { ok: false, error: "ClawPond WsClient is not initialised" };
      }

      const sent = client.sendMessage(roomId, text, replyToMessageId);
      if (!sent) {
        log().warn("clawpond_outbound_send_failed", { roomId });
        return { ok: false, error: `WebSocket for room ${roomId} is not open` };
      }

      log().info("clawpond_outbound_send_ok", { roomId });
      return { ok: true };
    },
  };
}
