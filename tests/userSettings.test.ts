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
    const saved = serializeUserSettings({ inlineImagesInAllChat: true });
    expect(parseUserSettings(saved)).toEqual({ inlineImagesInAllChat: true });
  });

  it("falls back safely for malformed or unknown values", () => {
    expect(parseUserSettings("{")).toEqual(DEFAULT_USER_SETTINGS);
    expect(parseUserSettings('{"inlineImagesInAllChat":"yes"}')).toEqual(
      DEFAULT_USER_SETTINGS,
    );
  });
});
