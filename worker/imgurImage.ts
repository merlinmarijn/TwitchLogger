import { isImgurPost } from "../shared/imageUrls";

const IMGUR_CDN_HOST = "i.imgur.com";
const IMAGE_PATH_PATTERN = /\.(?:avif|gif|jpe?g|png|webp)$/i;
const MAX_PAGE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)));
}

function metaAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of tag.matchAll(pattern)) {
    attributes.set(match[1].toLowerCase(), decodeHtmlAttribute(match[2] ?? match[3] ?? match[4]));
  }
  return attributes;
}

export function extractImgurPreviewUrl(html: string, pageUrl: URL): URL | undefined {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = metaAttributes(match[0]);
    const key = (attributes.get("property") ?? attributes.get("name"))?.toLowerCase();
    if (key !== "og:image" && key !== "twitter:image") continue;
    const content = attributes.get("content");
    if (!content) continue;

    const imageUrl = new URL(content, pageUrl);
    if (imageUrl.protocol === "https:" &&
        imageUrl.hostname.toLowerCase() === IMGUR_CDN_HOST &&
        IMAGE_PATH_PATTERN.test(imageUrl.pathname)) {
      return imageUrl;
    }
  }
  return undefined;
}

async function readLimitedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_PAGE_BYTES) {
    throw new Error("Imgur page exceeds the size limit");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_PAGE_BYTES) {
      await reader.cancel();
      throw new Error("Imgur page exceeds the size limit");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function resolveImgurImageUrl(pageUrl: URL): Promise<URL> {
  if (!isImgurPost(pageUrl) || pageUrl.protocol !== "https:") {
    throw new Error("Unsupported Imgur page URL");
  }

  const response = await fetch(pageUrl, {
    headers: {
      accept: "text/html",
      "user-agent": "TwitchLogger/0.1",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Imgur returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type");
  if (!contentType?.toLowerCase().includes("text/html")) {
    throw new Error("Imgur returned a non-HTML response");
  }

  const imageUrl = extractImgurPreviewUrl(await readLimitedText(response), pageUrl);
  if (!imageUrl) throw new Error("Imgur page did not contain a supported preview image");
  return imageUrl;
}
