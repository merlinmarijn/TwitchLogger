import { describe, expect, it, vi } from "vitest";
import { extractHttpUrls, mergeIndexedImageUrls } from "../shared/imageUrls";
import {
  createPinnedLookup,
  isImageContentType,
  isPublicInternetAddress,
  RemoteImageDetector,
  resolveImageIndexes,
} from "../worker/RemoteImageDetector";

describe("remote image detection", () => {
  it("extracts and normalizes every HTTP link as a detection candidate", () => {
    expect(extractHttpUrls(
      "Image (https://files.example.test/abc), page http://example.test/read and duplicate https://files.example.test/abc",
    )).toEqual([
      "https://files.example.test/abc",
      "http://example.test/read",
    ]);
  });

  it("accepts image media types regardless of case or parameters", () => {
    expect(isImageContentType("image/webp")).toBe(true);
    expect(isImageContentType("IMAGE/JPEG; charset=binary")).toBe(true);
    expect(isImageContentType("text/html")).toBe(false);
    expect(isImageContentType(undefined)).toBe(false);
  });

  it("preserves detected links during maintenance unless they were hidden", () => {
    const extensionless = "https://files.example.test/extensionless";
    const message = `Known https://files.example.test/known.png and detected ${extensionless}`;

    expect(mergeIndexedImageUrls(message, [extensionless])).toEqual([
      "https://files.example.test/known.png",
      extensionless,
    ]);
    expect(mergeIndexedImageUrls(message, [extensionless], [extensionless])).toEqual([
      "https://files.example.test/known.png",
    ]);
  });

  it("blocks local and reserved network destinations", () => {
    expect(isPublicInternetAddress("127.0.0.1")).toBe(false);
    expect(isPublicInternetAddress("192.168.1.2")).toBe(false);
    expect(isPublicInternetAddress("::1")).toBe(false);
    expect(isPublicInternetAddress("2001:db8::1")).toBe(false);
    expect(isPublicInternetAddress("1.1.1.1")).toBe(true);
    expect(isPublicInternetAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("probes unknown links, skips known images, and caches the result", async () => {
    const probe = vi.fn(async (url: URL) => url.pathname === "/extensionless");
    const detector = new RemoteImageDetector(probe);
    const message = [
      "https://cdn.example/known.png",
      "https://cdn.example/extensionless",
      "https://example.test/article",
    ].join(" ");

    await expect(detector.detectImageUrls(message, ["https://cdn.example/known.png"]))
      .resolves.toEqual(["https://cdn.example/extensionless"]);
    await expect(detector.detectImageUrls(message, ["https://cdn.example/known.png"]))
      .resolves.toEqual(["https://cdn.example/extensionless"]);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("returns the pinned address in Node's single and all-address lookup modes", async () => {
    const lookup = createPinnedLookup("1.1.1.1", 4);
    await expect(new Promise((resolve, reject) => lookup(
      "example.test",
      { all: true },
      (error, address) => error ? reject(error) : resolve(address),
    ))).resolves.toEqual([{ address: "1.1.1.1", family: 4 }]);
    await expect(new Promise((resolve, reject) => lookup(
      "example.test",
      { all: false },
      (error, address, family) => error ? reject(error) : resolve({ address, family }),
    ))).resolves.toEqual({ address: "1.1.1.1", family: 4 });
  });

  it("backfills extensionless image links while preserving hidden-image moderation", async () => {
    const imageUrl = "https://segs.lol/i7Ekz1";
    const detector = {
      detectImageUrls: vi.fn(async () => [imageUrl]),
    };

    await expect(resolveImageIndexes(detector, [
      { messageText: imageUrl },
      { messageText: imageUrl, hiddenImageUrls: [imageUrl] },
    ])).resolves.toEqual([[imageUrl], []]);
    expect(detector.detectImageUrls).toHaveBeenCalledTimes(2);
  });

  it("reports progress after each bounded reindex wave", async () => {
    const progress: number[] = [];
    const detector = { detectImageUrls: vi.fn(async () => []) };
    const candidates = Array.from({ length: 5 }, (_value, index) => ({
      messageText: `message ${index}`,
    }));

    await resolveImageIndexes(detector, candidates, 2, (completed) => {
      progress.push(completed);
    });

    expect(progress).toEqual([2, 4, 5]);
  });
});
