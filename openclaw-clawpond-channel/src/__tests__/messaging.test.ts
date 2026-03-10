import { handleInboundMessage } from "../messaging";
import { MessagingDeps, RelayMessageData } from "../types";

const makeLogger = () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

const makeDeps = (): MessagingDeps & { emitMessage: jest.Mock } => ({
  logger: makeLogger(),
  emitMessage: jest.fn(),
});

const baseData: RelayMessageData = {
  id: "msg-uuid-001",
  message_id: 42,
  room_id: "room-abc",
  sender_id: "user-xyz",
  sender_name: "Alice",
  text: "Hello @Bot",
  type: "text",
  mentions: [],
  created_at: "2024-01-15T10:30:00.000Z",
};

describe("handleInboundMessage", () => {
  describe("field mapping", () => {
    it("maps data.id to inbound.id", () => {
      const deps = makeDeps();
      handleInboundMessage(baseData, "room-abc", "default", deps);
      expect(deps.emitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: "msg-uuid-001" })
      );
    });

    it("falls back to '{room_id}-{message_id}' when data.id is falsy", () => {
      const deps = makeDeps();
      handleInboundMessage(
        { ...baseData, id: undefined as unknown as string },
        "room-abc",
        "default",
        deps
      );
      expect(deps.emitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: "room-abc-42" })
      );
    });

    it("maps data.message_id to inbound.messageId", () => {
      const deps = makeDeps();
      handleInboundMessage(baseData, "room-abc", "default", deps);
      expect(deps.emitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 42 })
      );
    });

    it("maps roomId parameter to inbound.roomId", () => {
      const deps = makeDeps();
      handleInboundMessage(baseData, "custom-room", "default", deps);
      expect(deps.emitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ roomId: "custom-room" })
      );
    });

    it("maps accountId parameter to inbound.accountId", () => {
      const deps = makeDeps();
      handleInboundMessage(baseData, "room-abc", "acct-99", deps);
      expect(deps.emitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "acct-99" })
      );
    });

    it("maps data.sender_id to inbound.senderId", () => {
      const deps = makeDeps();
      handleInboundMessage(baseData, "room-abc", "default", deps);
      expect(deps.emitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ senderId: "user-xyz" })
      );
    });

    it("maps data.sender_name to inbound.senderName", () => {
      const deps = makeDeps();
      handleInboundMessage(baseData, "room-abc", "default", deps);
      expect(deps.emitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ senderName: "Alice" })
      );
    });

    it("maps data.text to inbound.text", () => {
      const deps = makeDeps();
      handleInboundMessage(baseData, "room-abc", "default", deps);
      expect(deps.emitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Hello @Bot" })
      );
    });

    it("sets inbound.channel to 'clawpond'", () => {
      const deps = makeDeps();
      handleInboundMessage(baseData, "room-abc", "default", deps);
      expect(deps.emitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "clawpond" })
      );
    });

    it("sets inbound.isGroup to true", () => {
      const deps = makeDeps();
      handleInboundMessage(baseData, "room-abc", "default", deps);
      expect(deps.emitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ isGroup: true })
      );
    });

    it("parses data.created_at to a Date object", () => {
      const deps = makeDeps();
      handleInboundMessage(baseData, "room-abc", "default", deps);
      const emitted = deps.emitMessage.mock.calls[0][0];
      expect(emitted.timestamp).toBeInstanceOf(Date);
      expect(emitted.timestamp.toISOString()).toBe("2024-01-15T10:30:00.000Z");
    });

    it("maps data.reply_to to inbound.replyTo", () => {
      const deps = makeDeps();
      handleInboundMessage({ ...baseData, reply_to: 10 }, "room-abc", "default", deps);
      expect(deps.emitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ replyTo: 10 })
      );
    });

    it("sets inbound.replyTo to undefined when data.reply_to is null", () => {
      const deps = makeDeps();
      handleInboundMessage({ ...baseData, reply_to: null }, "room-abc", "default", deps);
      const emitted = deps.emitMessage.mock.calls[0][0];
      expect(emitted.replyTo).toBeUndefined();
    });

    it("passes through attachments", () => {
      const deps = makeDeps();
      const attachments = [{ url: "http://x.com/file.png", filename: "file.png" }];
      handleInboundMessage({ ...baseData, attachments }, "room-abc", "default", deps);
      expect(deps.emitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ attachments })
      );
    });

    it("passes through metadata", () => {
      const deps = makeDeps();
      const metadata = { source: "test" };
      handleInboundMessage({ ...baseData, metadata }, "room-abc", "default", deps);
      expect(deps.emitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ metadata })
      );
    });
  });

  describe("session isolation fields (peerId / peerKind)", () => {
    it("sets peerId equal to the roomId parameter for group session isolation", () => {
      const deps = makeDeps();
      handleInboundMessage(baseData, "room-abc", "default", deps);
      expect(deps.emitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: "room-abc" })
      );
    });

    it("peerId mirrors a different roomId when called with a different room", () => {
      const deps = makeDeps();
      handleInboundMessage(baseData, "room-xyz", "default", deps);
      expect(deps.emitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: "room-xyz" })
      );
    });

    it("sets peerKind to 'group'", () => {
      const deps = makeDeps();
      handleInboundMessage(baseData, "room-abc", "default", deps);
      expect(deps.emitMessage).toHaveBeenCalledWith(
        expect.objectContaining({ peerKind: "group" })
      );
    });
  });

  describe("emitMessage invocation", () => {
    it("calls deps.emitMessage exactly once", () => {
      const deps = makeDeps();
      handleInboundMessage(baseData, "room-abc", "default", deps);
      expect(deps.emitMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe("logger usage", () => {
    it("calls deps.logger.debug with roomId and messageId", () => {
      const deps = makeDeps();
      handleInboundMessage(baseData, "room-abc", "default", deps);
      expect(deps.logger.debug).toHaveBeenCalledWith(
        "clawpond_emit_inbound",
        expect.objectContaining({ roomId: "room-abc", messageId: 42 })
      );
    });
  });
});
