import {
  connect,
  constants,
  type IncomingHttpHeaders,
} from "node:http2";

const TOUHOU_WIKI_ORIGIN = "https://en.touhouwiki.net";
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export interface ProxiedImage {
  body: Buffer;
  contentType: string;
  etag?: string;
  lastModified?: string;
}

function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function fetchTouhouWikiImage(url: URL): Promise<ProxiedImage> {
  return new Promise((resolve, reject) => {
    const client = connect(TOUHOU_WIKI_ORIGIN);
    const request = client.request({
      [constants.HTTP2_HEADER_METHOD]: "GET",
      [constants.HTTP2_HEADER_PATH]: `${url.pathname}${url.search}`,
      accept: "image/*",
      "user-agent": "TwitchLogger/0.1",
    });
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let responseHeaders: IncomingHttpHeaders | undefined;
    let settled = false;

    const finish = (error?: Error, image?: ProxiedImage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        client.destroy();
        reject(error);
      } else {
        client.close();
        resolve(image!);
      }
    };

    const timeout = setTimeout(() => {
      finish(new Error("TouhouWiki image request timed out"));
    }, REQUEST_TIMEOUT_MS);

    client.once("error", (cause) => finish(cause));
    request.once("error", (cause) => finish(cause));
    request.on("response", (headers) => {
      responseHeaders = headers;
      const status = Number(headers[constants.HTTP2_HEADER_STATUS]);
      const contentType = headerValue(headers, "content-type");
      const contentLength = Number(headerValue(headers, "content-length"));
      if (status !== 200) {
        finish(new Error(`TouhouWiki returned HTTP ${status}`));
      } else if (!contentType?.toLowerCase().startsWith("image/")) {
        finish(new Error("TouhouWiki returned a non-image response"));
      } else if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
        finish(new Error("TouhouWiki image exceeds the size limit"));
      }
    });
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      byteLength += chunk.length;
      if (byteLength > MAX_IMAGE_BYTES) {
        finish(new Error("TouhouWiki image exceeds the size limit"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      const contentType = responseHeaders && headerValue(responseHeaders, "content-type");
      if (!responseHeaders || !contentType) {
        finish(new Error("TouhouWiki returned an incomplete response"));
        return;
      }
      finish(undefined, {
        body: Buffer.concat(chunks, byteLength),
        contentType,
        etag: headerValue(responseHeaders, "etag"),
        lastModified: headerValue(responseHeaders, "last-modified"),
      });
    });
    request.end();
  });
}
