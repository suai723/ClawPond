import {
  ClawPondInbound,
  MessagingDeps,
  RelayMessageData,
  OpenClawConfig,
} from "./types.js";
import { getClawPondRuntime } from "./runtime.js";

/**
 * Normalizes a raw relay message event into the ClawPondInbound format
 * and delivers it to OpenClaw via direct core API calls (like Feishu plugin).
 */
export function handleInboundMessage(
  data: RelayMessageData,
  roomId: string,
  accountId: string,
  cfg: OpenClawConfig,
  deps: MessagingDeps
): void {
  deps.logger.info("clawpond_handle_inbound_start", {
    roomId,
    messageId: data.message_id,
    senderId: data.sender_id,
    textLength: data.text?.length,
    mentions: data.mentions?.length || 0,
    rawData: JSON.stringify(data),
  });

  try {
    // Get the OpenClaw runtime (same as Feishu plugin)
    const core = getClawPondRuntime();
    if (!core) {
      deps.logger.error("clawpond_no_core_runtime", {
        message: "ClawPond runtime not initialized - cannot route message",
      });
      return;
    }

    deps.logger.info("clawpond_core_available", {
      hasChannel: !!core.channel,
      hasRouting: !!core.channel?.routing,
      hasReply: !!core.channel?.reply,
    });

    // Resolve agent route (like Feishu plugin)
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "clawpond",
      accountId,
      peer: {
        kind: "group",
        id: roomId,
      },
      // parentPeer is null for ClawPond rooms
      parentPeer: null,
    });

    deps.logger.info("clawpond_route_resolved", {
      sessionKey: route.sessionKey,
      agentId: route.agentId,
      matchedBy: route.matchedBy,
    });

    // Create timestamp in the format expected by finalizeInboundContext

        // Finalize inbound context (like Feishu plugin)
    const messageBody = data.text || '';
    const isMentioned = data.mentions?.some((m: any) => m.agentId === accountId) || false;
    const timestamp = new Date(data.created_at).toISOString();
    
    const inboundContext = core.channel.reply.finalizeInboundContext({
      // Basic message content
      Body: messageBody,
      BodyForAgent: messageBody,
      InboundHistory: [],
      ReplyToId: data.reply_to ?? undefined,
      RootMessageId: data.reply_to ?? undefined,
      RawBody: messageBody,
      CommandBody: messageBody,
      
      // Routing and session
      From: `clawpond:${data.sender_id}`,
      To: `room:${roomId}`,
      SessionKey: route.sessionKey,
      AccountId: accountId,
      ChatType: "group",
      GroupSubject: roomId,
      
      // Sender info
      SenderName: data.sender_name || data.sender_id,
      SenderId: data.sender_id,
      
      // Channel/provider info
      Provider: "clawpond",
      Surface: "clawpond",
      MessageSid: data.message_id?.toString() || '',
      
      // Metadata
      ReplyToBody: undefined,
      Timestamp: Date.now(),
      WasMentioned: isMentioned,
      CommandAuthorized: true, // Allow commands in ClawPond rooms
      
      // Originating context
      OriginatingChannel: "clawpond",
      OriginatingTo: `room:${roomId}`,
      
      // Group-specific
      GroupSystemPrompt: undefined,
    });

    deps.logger.info("clawpond_inbound_context_created", {
      inboundContextKeys: Object.keys(inboundContext),
      hasSurface: !!inboundContext.Surface,
    });

    // Dispatch reply (like Feishu plugin)
    deps.logger.info("clawpond_dispatching_reply", {
      sessionKey: route.sessionKey,
      messageId: data.message_id,
    });

    // Create a simple dispatcher for ClawPond (similar to Feishu's no-op dispatcher for observers)
    const dispatcher = {
      sendToolResult: () => false,
      sendBlockReply: () => false,
      sendFinalReply: () => false,
      waitForIdle: async () => {},
      getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
      markComplete: () => {},
    };

    // Use withReplyDispatcher wrapper (like Feishu plugin)
    core.channel.reply.withReplyDispatcher({
      dispatcher,
      run: () =>
        core.channel.reply.dispatchReplyFromConfig({
          ctx: inboundContext,
          cfg,
          dispatcher,
          // replyOptions can be omitted for now
        }),
    })
      .then(() => {
        deps.logger.info("clawpond_reply_dispatched", {
          roomId,
          messageId: data.message_id,
          success: true,
        });
      })
      .catch((error: any) => {
        deps.logger.error("clawpond_dispatch_error", {
          roomId,
          messageId: data.message_id,
          error: String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      });
  } catch (error: any) {
    deps.logger.error("clawpond_handle_inbound_error", {
      roomId,
      messageId: data.message_id,
      error: String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

/**
 * Legacy handler that uses emitMessage (for backward compatibility).
 */
export function handleInboundMessageLegacy(
  data: RelayMessageData,
  roomId: string,
  accountId: string,
  deps: MessagingDeps
): void {
  const inbound: ClawPondInbound = {
    id: data.id ?? `${data.room_id}-${data.message_id}`,
    channel: "clawpond",
    accountId,
    roomId,
    peerId: roomId,
    peerKind: "group",
    SessionKey: `agent:main:clawpond:group:${roomId}`,
    sessionId: `agent:main:clawpond:group:${roomId}`,
    messageId: data.message_id,
    senderId: data.sender_id,
    senderName: data.sender_name,
    text: data.text,
    isGroup: true,
    replyTo: data.reply_to ?? undefined,
    attachments: data.attachments,
    metadata: data.metadata,
    timestamp: new Date(data.created_at),
    replyContext: {
      roomId,
      messageId: data.message_id,
      senderId: data.sender_id,
      accountId,
    },
  };

  try {
    deps.emitMessage(inbound);
    deps.logger.info("clawpond_emit_message_called", {
      roomId,
      messageId: data.message_id,
      success: true,
    });
  } catch (error) {
    deps.logger.error("clawpond_emit_message_error", {
      roomId,
      messageId: data.message_id,
      error: String(error),
      stack: error instanceof Error ? error.stack : undefined,
      inbound: JSON.stringify(inbound),
    });
  }
}