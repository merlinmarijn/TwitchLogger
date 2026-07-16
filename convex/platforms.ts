import { mutation, query } from "./functions";

export const list = query({
  args: {},
  handler: async (ctx) => ctx.db.query("platforms").collect(),
});

export const ensureSeeded = mutation({
  args: {},
  handler: async (ctx) => {
    const twitch = await ctx.db
      .query("platforms")
      .withIndex("by_slug", (q) => q.eq("slug", "twitch"))
      .unique();

    if (!twitch) {
      await ctx.db.insert("platforms", {
        name: "Twitch",
        slug: "twitch",
        enabled: true,
        createdAt: Date.now(),
      });
    }
  },
});
