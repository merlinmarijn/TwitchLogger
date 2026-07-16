import { describe, expect, it } from "vitest";
import { loadConfiguration } from "../worker/config";

const completeEnvironment = {
  CONVEX_URL: "https://convex.example.com",
  INGESTION_SECRET: "0123456789abcdef0123456789abcdef",
  TWITCH_CLIENT_ID: "real-client-id",
  TWITCH_CLIENT_SECRET: "real-client-secret",
  TWITCH_REDIRECT_URI: "https://logs.example.com/auth/twitch/callback",
  TWITCH_FRONTEND_URL: "https://logs.example.com",
  TWITCH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  TWITCH_TOKEN_STORE_PATH: "/data/twitch-tokens.enc",
};

describe("loadConfiguration", () => {
  it("reports missing values without throwing", () => {
    const configuration = loadConfiguration({});

    expect(configuration.options).toBeUndefined();
    expect(configuration.port).toBe(8787);
    expect(configuration.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CONVEX_URL"),
        expect.stringContaining("INGESTION_SECRET"),
        expect.stringContaining("TWITCH_CLIENT_ID"),
        expect.stringContaining("TWITCH_CLIENT_SECRET"),
        expect.stringContaining("TWITCH_REDIRECT_URI"),
        expect.stringContaining("TWITCH_TOKEN_ENCRYPTION_KEY"),
      ]),
    );
  });

  it("treats shipped example placeholders as incomplete configuration", () => {
    const configuration = loadConfiguration({
      ...completeEnvironment,
      TWITCH_CLIENT_SECRET: "your_twitch_client_secret",
      INGESTION_SECRET: "replace_with_a_long_random_value",
    });

    expect(configuration.options).toBeUndefined();
    expect(configuration.issues).toHaveLength(2);
  });

  it("returns usable options for complete configuration", () => {
    const configuration = loadConfiguration(completeEnvironment);

    expect(configuration.issues).toEqual([]);
    expect(configuration.options).toMatchObject({
      convexUrl: completeEnvironment.CONVEX_URL,
      ingestionSecret: completeEnvironment.INGESTION_SECRET,
      port: 8787,
      twitch: {
        clientId: completeEnvironment.TWITCH_CLIENT_ID,
        redirectUri: completeEnvironment.TWITCH_REDIRECT_URI,
      },
    });
  });

  it("ignores an incomplete optional bootstrap-token pair", () => {
    const configuration = loadConfiguration({
      ...completeEnvironment,
      TWITCH_ACCESS_TOKEN: "one-token-only",
    });

    expect(configuration.options?.twitch.initialAccessToken).toBeUndefined();
    expect(configuration.warnings).toHaveLength(1);
  });
});
