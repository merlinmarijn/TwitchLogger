import { describe, expect, it } from "vitest";
import { extractImgurPreviewUrl } from "../worker/imgurImage";

describe("Imgur image resolution", () => {
  it("extracts the supplied album preview from Open Graph metadata", () => {
    const html = '<meta property="og:image" content="https://i.imgur.com/Fb1IWtG.png?fb">';

    expect(extractImgurPreviewUrl(html, new URL("https://imgur.com/a/I5kYHtp"))?.href)
      .toBe("https://i.imgur.com/Fb1IWtG.png?fb");
  });

  it("accepts reversed metadata attributes and decodes escaped query strings", () => {
    const html = '<meta content="https://i.imgur.com/example.jpg?one=1&amp;two=2" name="twitter:image">';

    expect(extractImgurPreviewUrl(html, new URL("https://imgur.com/example"))?.href)
      .toBe("https://i.imgur.com/example.jpg?one=1&two=2");
  });

  it("rejects preview metadata outside the Imgur image CDN", () => {
    const html = '<meta property="og:image" content="https://example.com/image.jpg">';

    expect(extractImgurPreviewUrl(html, new URL("https://imgur.com/example"))).toBeUndefined();
  });
});
