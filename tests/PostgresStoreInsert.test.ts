import { describe, expect, it, vi } from "vitest";
import type { PostgresDatabase } from "../worker/database";
import type { Logger } from "../worker/logger";
import { PostgresStore } from "../worker/PostgresStore";
import type { ResolvedChannel, TwitchChatMessage } from "../worker/types";

describe("PostgreSQL message insertion", () => {
  it("reuses an existing message type without advancing its identity sequence", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values: unknown[] = []) => {
        calls.push({ text, values });
        if (text.includes("FROM chat_message_cold_catalog")) return { rowCount: 0, rows: [] };
        if (text.includes("FROM chat_message_types")) return { rowCount: 1, rows: [{ id: 7 }] };
        if (text.includes("INSERT INTO chat_messages")) {
          return { rowCount: 1, rows: [{ id: "stored-message" }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const database = {
      pool: { connect: async () => client },
      query: vi.fn(async () => ({ rowCount: 0, rows: [] })),
    } as unknown as PostgresDatabase;
    const logger = { debug: vi.fn() } as unknown as Logger;
    const remoteImageDetector = { detectImageUrls: vi.fn(async () => []) };
    const store = new PostgresStore(database, logger, undefined, remoteImageDetector);

    await store.insertMessage(channel, message);

    const messageTypeCalls = calls.filter((call) => call.text.includes("chat_message_types"));
    expect(messageTypeCalls).toHaveLength(1);
    expect(messageTypeCalls[0].text).toContain("SELECT id");
    expect(messageTypeCalls[0].text).not.toContain("INSERT INTO");

    const insert = calls.find((call) => call.text.includes("INSERT INTO chat_messages"));
    expect(insert?.text).toContain("SELECT $12::integer AS id");
    expect(insert?.values[11]).toBe(7);
  });
});

const channel: ResolvedChannel = {
  storageId: "channel-id",
  twitchId: "123",
  username: "channel",
  displayName: "Channel",
};

const message: TwitchChatMessage = {
  messageId: "message-id",
  eventNotificationId: "notification-id",
  channelId: "123",
  channelName: "channel",
  userId: "viewer-id",
  username: "viewer",
  displayName: "Viewer",
  messageText: "hello",
  messageTimestamp: new Date("2026-08-14T12:00:00Z"),
  badges: [],
  isBroadcaster: false,
  isModerator: false,
  isSubscriber: false,
  isVip: false,
  messageType: "text",
  nativeEmotes: [],
  rawMessageData: {},
};
