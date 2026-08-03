import { lookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { BlockList, isIP } from "node:net";
import { extractHttpUrls } from "../shared/imageUrls";

const MAX_CANDIDATES_PER_MESSAGE = 4;
const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT_MS = 5_000;
const POSITIVE_CACHE_MS = 24 * 60 * 60 * 1_000;
const NEGATIVE_CACHE_MS = 15 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 2_000;

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

export interface RemoteImageDetectorLike {
  detectImageUrls(messageText: string, knownImageUrls?: readonly string[]): Promise<string[]>;
}

type ImageProbe = (url: URL) => Promise<boolean>;

interface CacheEntry {
  expiresAt: number;
  result: Promise<boolean>;
}

export class RemoteImageDetector implements RemoteImageDetectorLike {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly probe: ImageProbe = probeImageUrl) {}

  async detectImageUrls(
    messageText: string,
    knownImageUrls: readonly string[] = [],
  ): Promise<string[]> {
    const known = new Set(knownImageUrls);
    const candidates = extractHttpUrls(messageText)
      .filter((url) => !known.has(url))
      .slice(0, MAX_CANDIDATES_PER_MESSAGE);
    const results = await Promise.all(candidates.map((url) => this.isImage(url)));
    return candidates.filter((_url, index) => results[index]);
  }

  private isImage(url: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.cache.get(url);
    if (cached && cached.expiresAt > now) return cached.result;
    if (cached) this.cache.delete(url);

    const result = this.probe(new URL(url))
      .catch(() => false)
      .then((isImage) => {
        const entry = this.cache.get(url);
        if (entry) {
          entry.expiresAt = Date.now() + (isImage ? POSITIVE_CACHE_MS : NEGATIVE_CACHE_MS);
        }
        return isImage;
      });
    this.cache.set(url, { expiresAt: now + NEGATIVE_CACHE_MS, result });
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return result;
  }
}

export function isImageContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0].trim().toLowerCase().startsWith("image/") ?? false;
}

export function isPublicInternetAddress(address: string): boolean {
  const normalized = address.startsWith("[") && address.endsWith("]")
    ? address.slice(1, -1)
    : address;
  const family = isIP(normalized);
  return family !== 0 && !blockedAddresses.check(
    normalized,
    family === 4 ? "ipv4" : "ipv6",
  );
}

async function probeImageUrl(url: URL): Promise<boolean> {
  validateUrl(url);
  const head = await requestHeaders(url, "HEAD", 0);
  if (head.status >= 200 && head.status < 300 && isImageContentType(head.contentType)) return true;
  if (head.contentType && head.status >= 200 && head.status < 400) return false;

  const get = await requestHeaders(url, "GET", 0);
  return get.status >= 200 && get.status < 400 && isImageContentType(get.contentType);
}

interface HeaderResult {
  status: number;
  contentType?: string;
}

async function requestHeaders(
  url: URL,
  method: "HEAD" | "GET",
  redirectCount: number,
): Promise<HeaderResult> {
  validateUrl(url);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicInternetAddress(address))) {
    throw new Error("Image URL resolves to a private or reserved network");
  }
  const selected = addresses[0];
  const request = url.protocol === "https:" ? requestHttps : requestHttp;

  const result = await new Promise<HeaderResult & { location?: string }>((resolve, reject) => {
    let settled = false;
    const outbound = request(url, {
      method,
      headers: {
        accept: "image/*,*/*;q=0.1",
        ...(method === "GET" ? { range: "bytes=0-0" } : {}),
        "user-agent": "TwitchLogger/0.1 image-detector",
      },
      lookup: (_hostname, _options, callback) => {
        callback(null, selected.address, selected.family);
      },
    }, (response) => {
      if (settled) return;
      settled = true;
      const location = Array.isArray(response.headers.location)
        ? response.headers.location[0]
        : response.headers.location;
      const contentType = Array.isArray(response.headers["content-type"])
        ? response.headers["content-type"][0]
        : response.headers["content-type"];
      resolve({ status: response.statusCode ?? 0, contentType, location });
      response.destroy();
    });
    outbound.setTimeout(REQUEST_TIMEOUT_MS, () => {
      outbound.destroy(new Error("Image detection request timed out"));
    });
    outbound.once("error", (error) => {
      if (!settled) reject(error);
    });
    outbound.end();
  });

  if (result.status >= 300 && result.status < 400 && result.location) {
    if (redirectCount >= MAX_REDIRECTS) throw new Error("Image URL redirected too many times");
    return requestHeaders(new URL(result.location, url), method, redirectCount + 1);
  }
  return result;
}

function validateUrl(url: URL) {
  if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username || url.password || !url.hostname) {
    throw new Error("Only public HTTP image URLs are supported");
  }
}
