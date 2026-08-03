const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const LINK_PATTERN = /https?:\/\/[^\s<>"']+/iu;
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
const KAPPA_LOL_HOSTS = new Set(["kappa.lol", "www.kappa.lol"]);
const KAPPA_LOL_IMAGE_PATH_PATTERN = /^\/[a-z\d]+\/?$/i;
const BSKY_IMAGE_HOSTS = new Set(["cdn.bsky.app"]);
const BSKY_FEED_IMAGE_PATH_PATTERN =
  /^\/img\/feed_thumbnail\/plain\/[^/]+\/[^/]+\/?$/i;
const TOUHOU_WIKI_IMAGE_HOSTS = new Set(["en.touhouwiki.net"]);
const TRAILING_PUNCTUATION = /[),.!;:\]}]+$/;

export const IMAGE_INDEX_VERSION = 5;

export const LEGACY_IMAGE_GALLERY_FILTER_PATTERN =
  "/https?:\\/\\/[^\\s<>\"']+\\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp)(?:[?#][^\\s<>\"']*)?/i";
const OLDER_IMAGE_GALLERY_FILTER_PATTERN =
  "/(?:https?:\\/\\/[^\\s<>\"']+\\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp)(?:[?#][^\\s<>\"']*)?|https?:\\/\\/(?:www\\.)?imgur\\.com\\/(?:a|gallery)\\/[a-z\\d]+(?:[?#][^\\s<>\"']*)?)/i";
const PREVIOUS_IMAGE_GALLERY_FILTER_PATTERN =
  "/https?:\\/\\/(?:[^\\s<>\"']+\\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp)(?:[?#][^\\s<>\"']*)?|(?:www\\.)?(?:imgur\\.com\\/(?:a|gallery)\\/|kappa\\.lol\\/)[a-z\\d]+(?:[?#][^\\s<>\"']*)?)/i";
export const IMAGE_GALLERY_FILTER_PATTERN =
  "/https?:\\/\\/(?:[^\\s<>\"']+\\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp)(?:[?#]\\S*)?|(?:www\\.)?(?:imgur\\.com\\/(?:a|gallery)\\/|kappa\\.lol\\/)\\w+|cdn\\.bsky\\.app\\/img\\/feed_thumbnail\\/plain\\/\\S+)/i";

export function containsLink(messageText: string): boolean {
  return LINK_PATTERN.test(messageText);
}

export function extractHttpUrls(messageText: string): string[] {
  const urls = new Set<string>();
  for (const match of messageText.matchAll(URL_PATTERN)) {
    const candidate = match[0].replace(TRAILING_PUNCTUATION, "");
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        urls.add(parsed.href);
      }
    } catch {
      // Ignore malformed links copied into chat.
    }
  }
  return [...urls];
}

export function upgradeGalleryFilterPattern(value: string): string {
  return value === LEGACY_IMAGE_GALLERY_FILTER_PATTERN ||
      value === OLDER_IMAGE_GALLERY_FILTER_PATTERN ||
      value === PREVIOUS_IMAGE_GALLERY_FILTER_PATTERN
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

export function isKappaLolImage(url: URL): boolean {
  return (url.protocol === "http:" || url.protocol === "https:") &&
    KAPPA_LOL_HOSTS.has(url.hostname.toLowerCase()) &&
    KAPPA_LOL_IMAGE_PATH_PATTERN.test(url.pathname);
}

export function isBskyFeedImage(url: URL): boolean {
  return url.protocol === "https:" &&
    BSKY_IMAGE_HOSTS.has(url.hostname.toLowerCase()) &&
    BSKY_FEED_IMAGE_PATH_PATTERN.test(url.pathname);
}

export function isTouhouWikiImage(url: URL): boolean {
  return url.protocol === "https:" &&
    TOUHOU_WIKI_IMAGE_HOSTS.has(url.hostname.toLowerCase()) &&
    url.pathname.startsWith("/images/") &&
    IMAGE_PATH_PATTERN.test(url.pathname);
}

export function extractImageUrls(messageText: string): string[] {
  const urls = new Set<string>();
  for (const candidate of extractHttpUrls(messageText)) {
    try {
      const parsed = new URL(candidate);
      if (IMAGE_PATH_PATTERN.test(parsed.pathname) || pixivArtworkId(parsed) ||
          isImgurPost(parsed) || isKappaLolImage(parsed) || isBskyFeedImage(parsed)) {
        urls.add(parsed.href);
      }
    } catch {
      // Ignore malformed links copied into chat.
    }
  }
  return [...urls];
}

export function mergeIndexedImageUrls(
  messageText: string,
  indexedImageUrls: readonly string[] = [],
  hiddenImageUrls: readonly string[] = [],
): string[] {
  const linksInMessage = new Set(extractHttpUrls(messageText));
  const hidden = new Set(hiddenImageUrls);
  return [...new Set([
    ...extractImageUrls(messageText),
    ...indexedImageUrls.filter((url) => linksInMessage.has(url)),
  ])].filter((url) => !hidden.has(url));
}
