const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const IMAGE_PATH_PATTERN = /\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp)$/i;
const PIXIV_HOSTS = new Set(["pixiv.net", "www.pixiv.net"]);
const PIXIV_ARTWORK_PATH_PATTERN = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?artworks\/([1-9]\d*)\/?$/i;
const IMGUR_HOSTS = new Set(["imgur.com", "www.imgur.com"]);
const IMGUR_POST_PATH_PATTERN = /^\/(?:a\/|gallery\/)?[a-z\d]+\/?$/i;
const IMGUR_RESERVED_PATHS = new Set([
  "about",
  "advertise",
  "blog",
  "register",
  "search",
  "signin",
  "t",
  "upload",
]);
const TOUHOU_WIKI_IMAGE_HOSTS = new Set(["en.touhouwiki.net"]);
const TRAILING_PUNCTUATION = /[),.!;:\]}]+$/;

export const LEGACY_IMAGE_GALLERY_FILTER_PATTERN =
  "/https?:\\/\\/[^\\s<>\"']+\\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp)(?:[?#][^\\s<>\"']*)?/i";
export const IMAGE_GALLERY_FILTER_PATTERN =
  "/(?:https?:\\/\\/[^\\s<>\"']+\\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp)(?:[?#][^\\s<>\"']*)?|https?:\\/\\/(?:www\\.)?imgur\\.com\\/(?:a|gallery)\\/[a-z\\d]+(?:[?#][^\\s<>\"']*)?)/i";

export function upgradeGalleryFilterPattern(value: string): string {
  return value === LEGACY_IMAGE_GALLERY_FILTER_PATTERN
    ? IMAGE_GALLERY_FILTER_PATTERN
    : value;
}

export function pixivArtworkId(url: URL): string | undefined {
  if (!PIXIV_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  return PIXIV_ARTWORK_PATH_PATTERN.exec(url.pathname)?.[1];
}

export function isImgurPost(url: URL): boolean {
  if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      !IMGUR_HOSTS.has(url.hostname.toLowerCase()) ||
      !IMGUR_POST_PATH_PATTERN.test(url.pathname)) return false;
  const pathParts = url.pathname.toLowerCase().split("/").filter(Boolean);
  return pathParts.length > 1 || !IMGUR_RESERVED_PATHS.has(pathParts[0]);
}

export function isTouhouWikiImage(url: URL): boolean {
  return url.protocol === "https:" &&
    TOUHOU_WIKI_IMAGE_HOSTS.has(url.hostname.toLowerCase()) &&
    url.pathname.startsWith("/images/") &&
    IMAGE_PATH_PATTERN.test(url.pathname);
}

export function extractImageUrls(messageText: string): string[] {
  const urls = new Set<string>();
  for (const match of messageText.matchAll(URL_PATTERN)) {
    const candidate = match[0].replace(TRAILING_PUNCTUATION, "");
    try {
      const parsed = new URL(candidate);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") &&
          (IMAGE_PATH_PATTERN.test(parsed.pathname) || pixivArtworkId(parsed) || isImgurPost(parsed))) {
        urls.add(parsed.href);
      }
    } catch {
      // Ignore malformed links copied into chat.
    }
  }
  return [...urls];
}
