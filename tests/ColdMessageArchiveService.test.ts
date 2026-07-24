import { describe, expect, it } from "vitest";
import {
  encodeColdMessageChunk,
  verifyColdMessageChunk,
  type ArchivedMessageRow,
} from "../worker/ColdMessageArchiveService";

const record: ArchivedMessageRow = {
  id: "08f60902-e148-41c7-93e1-11a2f868c097",
  convex_creation_time: null,
  channel_id: "a143bc00-cf84-4b12-9bc1-f72b89fab131",
  platform: "twitch",
  external_message_id: "95125038-6137-4222-8920-3dbd8a7dce30",
  event_notification_id: "2c497447-cf8a-47bc-b5b4-f9fc23bfed5d",
  external_channel_id: "100",
  channel_name: "channel",
  sender_id: "200",
  sender_username: "viewer",
  sender_display_name: "Viewer",
  message_text: "hello archive",
  has_images: false,
  image_urls: [],
  image_index_version: 1,
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
};

describe("cold canonical message archives", () => {
  it("round-trips every canonical field through a verified chunk", async () => {
    const encoded = await encodeColdMessageChunk([record, {
      ...record,
      id: "58ac5380-00e3-4f9a-818b-e01a560fa79a",
      external_message_id: "b097dcb5-03ac-4f59-9975-928f9310a32f",
      message_text: "second message",
    }]);

    await expect(verifyColdMessageChunk(encoded.payload, {
      sha256: encoded.sha256,
      messageCount: 2,
      uncompressedBytes: encoded.uncompressedBytes,
    })).resolves.toEqual([
      record,
      expect.objectContaining({ message_text: "second message" }),
    ]);
    expect(encoded.compressedBytes).toBeLessThan(encoded.uncompressedBytes);
  });

  it("rejects corrupted canonical archive manifests", async () => {
    const encoded = await encodeColdMessageChunk([record]);

    await expect(verifyColdMessageChunk(encoded.payload, {
      sha256: "f".repeat(64),
      messageCount: 1,
      uncompressedBytes: encoded.uncompressedBytes,
    })).rejects.toThrow("checksum");
  });
});
