import { extractHttpUrls } from "./imageUrls";

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;

export function extractYouTubeVideoIds(messageText: string): string[] {
  const ids = new Set<string>();
  for (const candidate of extractHttpUrls(messageText)) {
    const url = new URL(candidate);
    let id: string | null | undefined;
    if (url.hostname === "youtu.be" || url.hostname === "www.youtu.be") {
      id = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    } else if (YOUTUBE_HOSTS.has(url.hostname)) {
      id = url.pathname === "/watch"
        ? url.searchParams.get("v")
        : /^\/(?:shorts|embed|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    }
    if (id && VIDEO_ID.test(id)) ids.add(id);
  }
  return [...ids];
}
