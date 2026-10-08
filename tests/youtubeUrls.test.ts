import { describe, expect, it } from "vitest";
import { extractYouTubeVideoIds } from "../shared/youtubeUrls";

describe("YouTube video links", () => {
  it.each([
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share",
    "https://youtu.be/dQw4w9WgXcQ?t=30",
    "https://m.youtube.com/shorts/dQw4w9WgXcQ",
    "http://youtube.com/live/dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
  ])("recognizes %s", (url) => {
    expect(extractYouTubeVideoIds(`Watch (${url}).`)).toEqual(["dQw4w9WgXcQ"]);
  });

  it("deduplicates videos across URL formats and preserves message order", () => {
    expect(extractYouTubeVideoIds(
      "https://youtu.be/dQw4w9WgXcQ https://youtube.com/watch?v=dQw4w9WgXcQ https://youtube.com/shorts/abcdefgh_-1",
    )).toEqual(["dQw4w9WgXcQ", "abcdefgh_-1"]);
  });

  it.each([
    "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
    "https://youtube.com@evil.test/watch?v=dQw4w9WgXcQ",
    "https://evil.test/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ/extra",
    "https://youtube.com/watch?v=short",
    "https://youtube.com/watch?v=dQw4w9WgXcQEXTRA",
    "https://youtube.com/playlist?list=dQw4w9WgXcQ",
    "javascript:alert(1)",
    "https://",
  ])("ignores non-video or untrusted link %s", (url) => {
    expect(extractYouTubeVideoIds(url)).toEqual([]);
  });
});
