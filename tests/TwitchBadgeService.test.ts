import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../worker/logger";
import {
  badgeKey,
  TwitchBadgeService,
} from "../worker/twitch/TwitchBadgeService";

const globalBadge = {
  setId: "moderator",
  id: "1",
  imageUrl: "https://example.test/global-mod.png",
  title: "Moderator",
  description: "Moderator",
};

describe("TwitchBadgeService", () => {
  it("combines cached global badges with channel-specific badge artwork", async () => {
    const channelBadge = {
      setId: "subscriber",
      id: "6",
      imageUrl: "https://example.test/channel-sub.png",
      title: "6-Month Subscriber",
      description: "6-Month Subscriber",
    };
    const api = {
      getGlobalChatBadges: vi.fn().mockResolvedValue([globalBadge]),
      getChannelChatBadges: vi.fn().mockResolvedValue([channelBadge]),
    };
    const service = new TwitchBadgeService(api, createLogger("silent"));

    await expect(service.getCatalog("100")).resolves.toEqual([
      globalBadge,
      channelBadge,
    ]);
    await service.getCatalog("200");

    expect(api.getGlobalChatBadges).toHaveBeenCalledTimes(1);
    expect(api.getChannelChatBadges).toHaveBeenCalledTimes(2);
    expect(badgeKey(channelBadge)).toBe("subscriber/6");
  });
});
