import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/api";
import { buildGalleryImages, extractImageUrls } from "../src/imageGallery";

describe("image gallery", () => {
  it("extracts supported direct image links with query strings and punctuation", () => {
    expect(extractImageUrls(
      "See (https://cdn.example/art.JPG?width=800), plus https://site.test/page and https://x.test/pic.webp#full!",
    )).toEqual([
      "https://cdn.example/art.JPG?width=800",
      "https://x.test/pic.webp#full",
    ]);
  });

  it("deduplicates links within a message and puts newest messages first", () => {
    const older = {
      _id: "older",
      messageText: "https://example.test/old.png https://example.test/old.png",
      timestamp: 1,
    } as ChatMessage;
    const newer = {
      _id: "newer",
      messageText: "https://example.test/new.gif",
      timestamp: 2,
    } as ChatMessage;

    expect(buildGalleryImages([older, newer]).map((image) => image.url)).toEqual([
      "https://example.test/new.gif",
      "https://example.test/old.png",
    ]);
  });
});
