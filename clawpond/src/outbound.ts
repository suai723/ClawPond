import {
  ChannelOutboundAdapter,
  GatewayDeps,
  OutboundContext,
  SendResult,
} from "./types.js";
import { ClawPondWsClient } from "./ws-client.js";

type Logger = GatewayDeps["logger"];

const noop = (_msg: string, _meta?: Record<string, unknown>) => {};
const noopLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };

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
  // Proxy logger: delegates lazily to getLogger() at call-time (gateway may not
  // be started yet when this adapter is constructed), but lets call-sites write
  // logger.info(...) exactly like deps.logger.info(...) in gateway.ts.
  // Falls back to noop so logs never leak to the console.
  const logger: Logger = {
    debug: (msg, meta) => (getLogger?.() ?? noopLogger).debug(msg, meta),
    info:  (msg, meta) => (getLogger?.() ?? noopLogger).info(msg, meta),
    warn:  (msg, meta) => (getLogger?.() ?? noopLogger).warn(msg, meta),
    error: (msg, meta) => (getLogger?.() ?? noopLogger).error(msg, meta),
  };

  return {
    deliveryMode: "direct",

    async sendText(context: OutboundContext): Promise<SendResult> {
      const { text, target, replyTo } = context;

      const roomId = resolveRoomId(target);
      if (!roomId) {
        logger.error("clawpond_outbound_no_room", {
          targetId: target.id,
          hasReplyContext: !!target.replyContext,
        });
        return { ok: false, error: "Cannot resolve roomId from outbound target" };
      }

      // replyTo is optional – used for reply-threading only
      const replyToMessageId =
        target.replyContext?.messageId ?? replyTo?.messageId;

      logger.info("clawpond_outbound_send", {
        roomId,
        replyToMessageId,
        textLength: text.length,
      });

      const client = getClient();
      if (!client) {
        logger.error("clawpond_outbound_no_client", { roomId });
        return { ok: false, error: "ClawPond WsClient is not initialised" };
      }

      const sent = client.sendMessage(roomId, text, replyToMessageId);
      if (!sent) {
        logger.warn("clawpond_outbound_send_failed", { roomId });
        return { ok: false, error: `WebSocket for room ${roomId} is not open` };
      }

      logger.info("clawpond_outbound_send_ok", { roomId });
      return { ok: true };
    },
  };
}
