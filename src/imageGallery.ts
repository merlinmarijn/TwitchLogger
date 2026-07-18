import type { ChatMessage } from "./api";

export interface GalleryImage {
  id: string;
  url: string;
  previewUrl: string;
  message: ChatMessage;
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const IMAGE_PATH_PATTERN = /\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp)$/i;
const PIXIV_HOSTS = new Set(["pixiv.net", "www.pixiv.net"]);
const PIXIV_ARTWORK_PATH_PATTERN = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?artworks\/([1-9]\d*)\/?$/i;
const TRAILING_PUNCTUATION = /[),.!;:\]}]+$/;

function pixivArtworkId(url: URL): string | undefined {
  if (!PIXIV_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  return PIXIV_ARTWORK_PATH_PATTERN.exec(url.pathname)?.[1];
}

function galleryPreviewUrl(url: string): string {
  const artworkId = pixivArtworkId(new URL(url));
  return artworkId
    ? `https://embed.pixiv.net/decorate.php?illust_id=${artworkId}`
    : url;
}

export function extractImageUrls(messageText: string): string[] {
  const urls = new Set<string>();
  for (const match of messageText.matchAll(URL_PATTERN)) {
    const candidate = match[0].replace(TRAILING_PUNCTUATION, "");
    try {
      const parsed = new URL(candidate);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") &&
          (IMAGE_PATH_PATTERN.test(parsed.pathname) || pixivArtworkId(parsed))) {
        urls.add(parsed.href);
      }
    } catch {
      // Ignore malformed links copied into chat.
    }
  }
  return [...urls];
}

export function buildGalleryImages(messages: ChatMessage[]): GalleryImage[] {
  const images: GalleryImage[] = [];
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    for (const [urlIndex, url] of extractImageUrls(message.messageText).entries()) {
      images.push({
        id: `${message._id}:${urlIndex}`,
        message,
        previewUrl: galleryPreviewUrl(url),
        url,
      });
    }
  }
  return images;
}
