import {
  ClawPondInbound,
  MessagingDeps,
  RelayMessageData,
} from "./types.js";

/**
 * Normalizes a raw relay message event into the ClawPondInbound format
 * and delivers it to OpenClaw via emitMessage.
 */
export function handleInboundMessage(
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
    // peerId mirrors feishu's resolveFeishuGroupSession peerId = chatId ("group" scope).
    // Each room maps to one isolated session; different rooms never share context.
    peerId: roomId,
    peerKind: "group",
    messageId: data.message_id,
    senderId: data.sender_id,
    senderName: data.sender_name,
    text: data.text,
    isGroup: true,
    replyTo: data.reply_to ?? undefined,
    attachments: data.attachments,
    metadata: data.metadata,
    timestamp: new Date(data.created_at),
  };

  deps.logger.debug("clawpond_emit_inbound", {
    roomId,
    messageId: data.message_id,
    senderId: data.sender_id,
  });

  deps.emitMessage(inbound);
}
