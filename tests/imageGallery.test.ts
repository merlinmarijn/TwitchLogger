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

  it("extracts Pixiv artwork pages without treating other Pixiv pages as images", () => {
    expect(extractImageUrls(
      "Art: https://www.pixiv.net/en/artworks/147302096 and artist: https://www.pixiv.net/en/users/1234",
    )).toEqual(["https://www.pixiv.net/en/artworks/147302096"]);
  });

  it("uses the Pixiv share image as the preview and keeps the artwork page as the link", () => {
    const message = {
      _id: "pixiv",
      messageText: "https://www.pixiv.net/en/artworks/147302096",
      timestamp: 1,
    } as ChatMessage;

    expect(buildGalleryImages([message])[0]).toMatchObject({
      url: "https://www.pixiv.net/en/artworks/147302096",
      previewUrl: "https://embed.pixiv.net/decorate.php?illust_id=147302096",
    });
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

  it("extracts Imgur album and post pages without treating other Imgur pages as images", () => {
    expect(extractImageUrls(
      "Album: https://imgur.com/a/I5kYHtp post: https://imgur.com/Fb1IWtG search: https://imgur.com/search?q=cards",
    )).toEqual([
      "https://imgur.com/a/I5kYHtp",
      "https://imgur.com/Fb1IWtG",
    ]);
  });

  it("extracts extensionless kappa.lol image links", () => {
    expect(extractImageUrls(
      "Image: https://kappa.lol/SlNGUz, homepage: https://kappa.lol/",
    )).toEqual(["https://kappa.lol/SlNGUz"]);
  });

  it("extracts extensionless Bluesky CDN feed images for galleries and previews", () => {
    const url = "https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:23reh4wn7sc7wtcurl575tox/bafkreiefmuwe3ky6csho2szr4wsbllknenc6fl3pbaemwy3uyc2re7u5ma";
    const message = {
      _id: "bluesky",
      messageText: `Image: ${url}`,
      timestamp: 1,
    } as ChatMessage;

    expect(extractImageUrls(message.messageText)).toEqual([url]);
    expect(buildGalleryImages([message])[0]).toMatchObject({
      url,
      previewUrl: url,
    });
  });

  it("routes Imgur page previews through the worker and keeps the post as the link", () => {
    const url = "https://imgur.com/a/I5kYHtp";
    const message = {
      _id: "imgur",
      messageText: url,
      timestamp: 1,
    } as ChatMessage;

    expect(buildGalleryImages([message], "https://worker.example/")[0]).toMatchObject({
      url,
      previewUrl: `https://worker.example/images/imgur?url=${encodeURIComponent(url)}`,
    });
  });

  it("routes TouhouWiki previews through the HTTP/2 worker endpoint", () => {
    const url = "https://en.touhouwiki.net/images/7/78/Th11SC159.jpg?20191126144715";
    const message = {
      _id: "touhou-wiki",
      messageText: url,
      timestamp: 1,
    } as ChatMessage;

    expect(buildGalleryImages([message], "https://worker.example/")[0]).toMatchObject({
      url,
      previewUrl: `https://worker.example/images/touhouwiki?url=${encodeURIComponent(url)}`,
    });
  });

  it("uses image URLs precomputed by the gallery query", () => {
    const message = {
      _id: "indexed",
      imageUrls: ["https://example.test/from-query.png"],
      messageText: "This text no longer needs to be parsed in the browser",
      timestamp: 1,
    } as ChatMessage;

    expect(buildGalleryImages([message]).map((image) => image.url)).toEqual([
      "https://example.test/from-query.png",
    ]);
  });
});
