import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants } from "node:zlib";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  reencodeColdArchiveChunk,
  reencodeRawArchiveChunk,
} from "../worker/ArchiveReencodingService";
import {
  type ArchivedMessageRow,
  verifyColdMessageChunk,
} from "../worker/ColdMessageArchiveService";
import {
  type RawEventArchiveRecord,
  verifyRawArchiveChunk,
} from "../worker/RawEventArchiveService";

const compress = promisify(brotliCompress);

const rawRecords: RawEventArchiveRecord[] = [
  {
    externalMessageId: "message-1",
    eventNotificationId: "notification-1",
    channelId: "channel-1",
    timestamp: 1_700_000_000_000,
    rawMessageData: {
      metadata: { message_id: "notification-1" },
      event: { message_id: "message-1", message: { text: "hello archive" } },
    },
  },
  {
    externalMessageId: "message-2",
    eventNotificationId: "notification-2",
    channelId: "channel-1",
    timestamp: 1_700_000_000_100,
    rawMessageData: {
      metadata: { message_id: "notification-2" },
      event: { message_id: "message-2", message: { text: "second archive message" } },
    },
  },
];

const coldRecords: ArchivedMessageRow[] = [
  {
    id: "message-row-1",
    channel_id: "channel-1",
    platform: "twitch",
    external_message_id: "message-1",
    event_notification_id: "notification-1",
    external_channel_id: "external-channel-1",
    channel_name: "example",
    sender_id: "sender-1",
    sender_username: "viewer",
    sender_display_name: "Viewer",
    message_text: "hello archive",
    has_images: false,
    image_urls: null,
    image_index_version: null,
    gallery_channel_id: null,
    timestamp: 1_700_000_000_000,
    badges: [],
    user_color: null,
    is_broadcaster: false,
    is_moderator: false,
    is_subscriber: false,
    is_vip: false,
    message_type: "text",
    metadata: { fragments: [{ type: "text", text: "hello archive" }] },
    hidden_image_urls: [],
    deleted_at: null,
    created_at: 1_700_000_000_010,
  },
];

describe("archive re-encoding", () => {
  it("verifies and replaces a legacy raw-event chunk", async () => {
    const legacy = await encodeLegacy(rawRecords);
    const { client, updatedPayload } = fakeClient("raw-chunk", rawRecords.length, legacy);

    const result = await reencodeRawArchiveChunk(client, "raw-chunk");
    const payload = updatedPayload();

    expect(result).toMatchObject({
      beforeBytes: legacy.payload.length,
      afterBytes: payload.length,
      messageCount: rawRecords.length,
    });
    expect(payload.equals(legacy.payload)).toBe(false);
    await expect(verifyRawArchiveChunk(payload, {
      sha256: legacy.sha256,
      messageCount: rawRecords.length,
      uncompressedBytes: legacy.uncompressedBytes,
    })).resolves.toEqual(rawRecords);
  });

  it("verifies and replaces a legacy cold-message chunk", async () => {
    const legacy = await encodeLegacy(coldRecords);
    const { client, updatedPayload } = fakeClient("cold-chunk", coldRecords.length, legacy);

    const result = await reencodeColdArchiveChunk(client, "cold-chunk");
    const payload = updatedPayload();

    expect(result).toMatchObject({
      beforeBytes: legacy.payload.length,
      afterBytes: payload.length,
      messageCount: coldRecords.length,
    });
    expect(payload.equals(legacy.payload)).toBe(false);
    await expect(verifyColdMessageChunk(payload, {
      sha256: legacy.sha256,
      messageCount: coldRecords.length,
      uncompressedBytes: legacy.uncompressedBytes,
    })).resolves.toEqual(coldRecords);
  });
});

async function encodeLegacy(records: unknown[]) {
  const uncompressed = Buffer.from(records.map((record) => JSON.stringify(record)).join("\n"));
  const payload = await compress(uncompressed, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
    },
  });
  return {
    payload,
    sha256: createHash("sha256").update(uncompressed).digest("hex"),
    uncompressedBytes: uncompressed.length,
  };
}

function fakeClient(
  id: string,
  messageCount: number,
  legacy: { payload: Buffer; sha256: string; uncompressedBytes: number },
) {
  let replacement: Buffer | undefined;
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    if (text.includes("SELECT id, message_count")) {
      return {
        rows: [{
          id,
          message_count: String(messageCount),
          uncompressed_bytes: String(legacy.uncompressedBytes),
          compressed_bytes: String(legacy.payload.length),
          sha256: legacy.sha256,
          payload: legacy.payload,
        }],
      };
    }
    if (text.includes("SET compressed_bytes")) {
      replacement = values?.[2] as Buffer;
      expect(values?.[1]).toBe(replacement.length);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${text}`);
  });
  return {
    client: { query } as unknown as PoolClient,
    updatedPayload: () => {
      expect(replacement).toBeInstanceOf(Buffer);
      return replacement!;
    },
  };
}
