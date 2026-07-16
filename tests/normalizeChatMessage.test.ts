import { describe, expect, it } from "vitest";
import { normalizeChatMessage } from "../worker/twitch/normalizeChatMessage";

describe("normalizeChatMessage", () => {
  it("maps EventSub fields and badge roles into the reusable model", () => {
    const raw = { source: "eventsub" };
    const message = normalizeChatMessage({
      metadata: {
        message_id: "notification-1",
        message_type: "notification",
        message_timestamp: "2026-07-16T12:34:56.123Z",
        subscription_type: "channel.chat.message",
      },
      event: {
        broadcaster_user_id: "100",
        broadcaster_user_login: "channel",
        broadcaster_user_name: "Channel",
        chatter_user_id: "200",
        chatter_user_login: "viewer",
        chatter_user_name: "Viewer",
        message_id: "message-1",
        message: { text: "Hello chat", fragments: [{ type: "text", text: "Hello chat" }] },
        color: "#00FF7F",
        badges: [
          { set_id: "moderator", id: "1", info: "" },
          { set_id: "subscriber", id: "12", info: "16" },
        ],
        message_type: "text",
      },
      raw,
    });

    expect(message).toMatchObject({
      messageId: "message-1",
      eventNotificationId: "notification-1",
      channelId: "100",
      channelName: "channel",
      userId: "200",
      username: "viewer",
      displayName: "Viewer",
      messageText: "Hello chat",
      userColor: "#00FF7F",
      isBroadcaster: false,
      isModerator: true,
      isSubscriber: true,
      isVip: false,
      rawMessageData: raw,
    });
    expect(message.messageTimestamp.toISOString()).toBe("2026-07-16T12:34:56.123Z");
  });

  it("recognizes the broadcaster by matching Twitch user IDs", () => {
    const message = normalizeChatMessage({
      metadata: {
        message_id: "notification-2",
        message_type: "notification",
        message_timestamp: "2026-07-16T12:34:56Z",
      },
      event: {
        broadcaster_user_id: "100",
        broadcaster_user_login: "channel",
        broadcaster_user_name: "Channel",
        chatter_user_id: "100",
        chatter_user_login: "channel",
        chatter_user_name: "Channel",
        message_id: "message-2",
        message: { text: "Hi", fragments: [] },
        color: "",
        badges: [],
        message_type: "text",
      },
      raw: {},
    });

    expect(message.isBroadcaster).toBe(true);
    expect(message.userColor).toBeUndefined();
  });
});
