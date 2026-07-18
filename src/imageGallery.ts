import type { ChatMessage } from "./api";
import {
  extractImageUrls,
  isTouhouWikiImage,
  pixivArtworkId,
} from "../shared/imageUrls";

export { extractImageUrls } from "../shared/imageUrls";

export interface GalleryImage {
  id: string;
  url: string;
  previewUrl: string;
  message: ChatMessage;
}

function galleryPreviewUrl(url: string, workerBaseUrl: string): string {
  const parsed = new URL(url);
  const artworkId = pixivArtworkId(parsed);
  if (isTouhouWikiImage(parsed)) {
    const baseUrl = workerBaseUrl.replace(/\/$/, "");
    return `${baseUrl}/images/touhouwiki?url=${encodeURIComponent(parsed.href)}`;
  }
  return artworkId
    ? `https://embed.pixiv.net/decorate.php?illust_id=${artworkId}`
    : url;
}

export function buildGalleryImages(
  messages: ChatMessage[],
  workerBaseUrl = "",
): GalleryImage[] {
  const images: GalleryImage[] = [];
  const newestFirst = [...messages].sort((left, right) => right.timestamp - left.timestamp);
  for (const message of newestFirst) {
    const urls = message.imageUrls ?? extractImageUrls(message.messageText);
    for (const [urlIndex, url] of urls.entries()) {
      images.push({
        id: `${message._id}:${urlIndex}`,
        message,
        previewUrl: galleryPreviewUrl(url, workerBaseUrl),
        url,
      });
    }
  }
  return images;
}
