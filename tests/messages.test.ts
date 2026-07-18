import { describe, expect, it } from "vitest";
import type { Doc } from "../convex/_generated/dataModel";
import { toClientMessage } from "../convex/lib/clientMessage";

describe("message client projection", () => {
  it("keeps renderable fields and omits large ingestion-only data", () => {
    const message = {
      _id: "message-id",
      _creationTime: 1,
      channelId: "channel-id",
      platform: "twitch",
      externalMessageId: "external-message",
      eventNotificationId: "notification-id",
      externalChannelId: "external-channel",
      channelName: "channel",
      senderId: "sender-id",
      senderUsername: "sender",
      senderDisplayName: "Sender",
      messageText: "Hello",
      timestamp: 123,
      badges: [{ setId: "moderator", id: "1", info: "" }],
      userColor: "#ffffff",
      isBroadcaster: false,
      isModerator: true,
      isSubscriber: false,
      isVip: false,
      messageType: "text",
      metadata: { fragments: [{ type: "text", text: "Hello" }], extra: "unused" },
      rawMessageData: { repeated: "large payload" },
      createdAt: 123,
    } as unknown as Doc<"chatMessages">;

    const projected = toClientMessage(message);

    expect(projected).toMatchObject({
      _id: "message-id",
      externalChannelId: "external-channel",
      messageText: "Hello",
      metadata: { fragments: [{ type: "text", text: "Hello" }] },
    });
    expect(projected).not.toHaveProperty("rawMessageData");
    expect(projected).not.toHaveProperty("eventNotificationId");
    expect(projected).not.toHaveProperty("createdAt");
    expect(projected).not.toHaveProperty("channelId");
    expect(projected.metadata).not.toHaveProperty("extra");
  });
});
