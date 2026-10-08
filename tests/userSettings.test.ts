import { describe, expect, it } from "vitest";
import {
  DEFAULT_USER_SETTINGS,
  parseUserSettings,
  serializeUserSettings,
} from "../src/userSettings";

describe("user settings", () => {
  it("keeps inline images off when settings have not been saved", () => {
    expect(parseUserSettings(null)).toEqual(DEFAULT_USER_SETTINGS);
  });

  it("round-trips the inline image preference", () => {
    const settings = { inlineImagesInAllChat: true, inlineYouTubeVideos: true };
    expect(parseUserSettings(serializeUserSettings(settings))).toEqual(settings);
  });

  it("keeps YouTube embeds off for existing settings and non-boolean values", () => {
    expect(parseUserSettings('{"inlineImagesInAllChat":true}')).toEqual({
      inlineImagesInAllChat: true, inlineYouTubeVideos: false,
    });
    expect(parseUserSettings('{"inlineYouTubeVideos":"yes"}')).toEqual(DEFAULT_USER_SETTINGS);
  });

  it("falls back safely for malformed or unknown values", () => {
    expect(parseUserSettings("{")).toEqual(DEFAULT_USER_SETTINGS);
    expect(parseUserSettings('{"inlineImagesInAllChat":"yes"}')).toEqual(
      DEFAULT_USER_SETTINGS,
    );
  });
});
