import { describe, expect, it } from "vitest";
import {
  encodeRawArchiveChunk,
  verifyRawArchiveChunk,
  type RawEventArchiveRecord,
} from "../worker/RawEventArchiveService";

const records: RawEventArchiveRecord[] = [
  {
    externalMessageId: "message-1",
    eventNotificationId: "notification-1",
    channelId: "channel-1",
    timestamp: 1_700_000_000_000,
    rawMessageData: {
      metadata: { message_id: "notification-1" },
      event: { message_id: "message-1", message: { text: "hello chat" } },
    },
  },
  {
    externalMessageId: "message-2",
    eventNotificationId: "notification-2",
    channelId: "channel-1",
    timestamp: 1_700_000_000_100,
    rawMessageData: {
      metadata: { message_id: "notification-2" },
      event: { message_id: "message-2", message: { text: "Kappa" } },
    },
  },
];

describe("raw Twitch event archives", () => {
  it("round-trips a verified compressed chunk without changing its records", async () => {
    const encoded = await encodeRawArchiveChunk(records);

    await expect(verifyRawArchiveChunk(encoded.payload, {
      sha256: encoded.sha256,
      messageCount: records.length,
      uncompressedBytes: encoded.uncompressedBytes,
    })).resolves.toEqual(records);
    expect(encoded.compressedBytes).toBeLessThan(encoded.uncompressedBytes);
  });

  it("rejects a chunk before cleanup when its checksum is wrong", async () => {
    const encoded = await encodeRawArchiveChunk(records);

    await expect(verifyRawArchiveChunk(encoded.payload, {
      sha256: "0".repeat(64),
      messageCount: records.length,
      uncompressedBytes: encoded.uncompressedBytes,
    })).rejects.toThrow("checksum");
  });

  it("rejects a chunk before cleanup when its record count is wrong", async () => {
    const encoded = await encodeRawArchiveChunk(records);

    await expect(verifyRawArchiveChunk(encoded.payload, {
      sha256: encoded.sha256,
      messageCount: records.length + 1,
      uncompressedBytes: encoded.uncompressedBytes,
    })).rejects.toThrow("record count");
  });
});
