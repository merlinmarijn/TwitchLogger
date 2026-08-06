import { describe, expect, it } from "vitest";
import {
  collectOldestImageOwners,
  deduplicateImageUrls,
  type ImageOwner,
  type IndexedImageRecord,
} from "../worker/imageDeduplication";

const url = "https://example.test/reposted.png";

describe("gallery image deduplication", () => {
  it("keeps the oldest message that references an image URL", () => {
    const owners = new Map<string, ImageOwner>();
    const newer: IndexedImageRecord = {
      id: "newer",
      imageUrls: [url, "https://example.test/unique.png"],
      storageTier: "hot",
      timestamp: 200,
    };
    const older: IndexedImageRecord = {
      id: "older",
      imageUrls: [url],
      storageTier: "cold",
      timestamp: 100,
    };
    collectOldestImageOwners(owners, newer);
    collectOldestImageOwners(owners, older);

    expect(deduplicateImageUrls(owners, older)).toEqual({
      imageUrls: [url],
      removedCount: 0,
      suppressedUrls: [],
    });
    expect(deduplicateImageUrls(owners, newer)).toEqual({
      imageUrls: ["https://example.test/unique.png"],
      removedCount: 1,
      suppressedUrls: [url],
    });
  });

  it("uses the message id as a stable tie-breaker", () => {
    const owners = new Map<string, ImageOwner>();
    const laterId: IndexedImageRecord = {
      id: "message-b",
      imageUrls: [url],
      storageTier: "cold",
      timestamp: 100,
    };
    const earlierId: IndexedImageRecord = {
      ...laterId,
      id: "message-a",
      storageTier: "hot",
    };
    collectOldestImageOwners(owners, laterId);
    collectOldestImageOwners(owners, earlierId);

    expect(deduplicateImageUrls(owners, earlierId).imageUrls).toEqual([url]);
    expect(deduplicateImageUrls(owners, laterId).imageUrls).toEqual([]);
  });

  it("collapses repeated URLs inside the owner without suppressing its link", () => {
    const record: IndexedImageRecord = {
      id: "owner",
      imageUrls: [url, url],
      storageTier: "hot",
      timestamp: 100,
    };
    const owners = new Map<string, ImageOwner>();
    collectOldestImageOwners(owners, record);

    expect(deduplicateImageUrls(owners, record)).toEqual({
      imageUrls: [url],
      removedCount: 1,
      suppressedUrls: [],
    });
  });
});
