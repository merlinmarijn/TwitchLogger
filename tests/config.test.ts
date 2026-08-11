import { describe, expect, it } from "vitest";
import { loadConfiguration } from "../worker/config";

const completeEnvironment = {
  DATABASE_URL: "postgresql://twitch_logs:secret@postgres:5432/twitch_logs",
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
        expect.stringContaining("DATABASE_URL"),
        expect.stringContaining("TWITCH_CLIENT_ID"),
        expect.stringContaining("TWITCH_CLIENT_SECRET"),
        expect.stringContaining("TWITCH_REDIRECT_URI"),
        expect.stringContaining("TWITCH_TOKEN_ENCRYPTION_KEY"),
        expect.stringContaining("INGESTION_SECRET"),
      ]),
    );
  });

  it("treats shipped example placeholders as incomplete configuration", () => {
    const configuration = loadConfiguration({
      ...completeEnvironment,
      DATABASE_URL: "your_database_url",
      TWITCH_CLIENT_SECRET: "your_twitch_client_secret",
    });

    expect(configuration.options).toBeUndefined();
    expect(configuration.issues).toHaveLength(2);
  });

  it("returns usable options for complete configuration", () => {
    const configuration = loadConfiguration(completeEnvironment);

    expect(configuration.issues).toEqual([]);
    expect(configuration.options).toMatchObject({
      databaseUrl: completeEnvironment.DATABASE_URL,
      port: 8787,
      twitch: {
        clientId: completeEnvironment.TWITCH_CLIENT_ID,
        redirectUri: completeEnvironment.TWITCH_REDIRECT_URI,
      },
    });
    expect(configuration.adminOptions).toMatchObject({
      setupSecret: completeEnvironment.INGESTION_SECRET,
    });
    expect(configuration.feedbackOptions).toEqual({
      ipHashSecret: completeEnvironment.INGESTION_SECRET,
      rateLimitMinutes: 15,
    });
    expect(configuration.trustedProxyHops).toBe(0);
  });

  it("configures the feedback cooldown and trusted proxy hops", () => {
    const configuration = loadConfiguration({
      ...completeEnvironment,
      FEEDBACK_RATE_LIMIT_MINUTES: "30",
      TRUST_PROXY_HOPS: "1",
    });

    expect(configuration.feedbackOptions?.rateLimitMinutes).toBe(30);
    expect(configuration.trustedProxyHops).toBe(1);
  });

  it("configures the optional write-only ClickHouse mirror", () => {
    const configuration = loadConfiguration({
      ...completeEnvironment,
      CLICKHOUSE_URL: "http://clickhouse:8123/",
      CLICKHOUSE_DATABASE: "analytics",
      CLICKHOUSE_USERNAME: "mirror",
      CLICKHOUSE_PASSWORD: "secret",
      CLICKHOUSE_MIRROR_BATCH_SIZE: "2500",
      CLICKHOUSE_MIRROR_INTERVAL_MS: "500",
    });

    expect(configuration.clickHouseOptions).toEqual({
      url: "http://clickhouse:8123",
      database: "analytics",
      username: "mirror",
      password: "secret",
      batchSize: 2500,
      pollIntervalMs: 500,
    });
  });

  it("leaves ClickHouse disabled when its URL is absent", () => {
    const configuration = loadConfiguration(completeEnvironment);

    expect(configuration.clickHouseOptions).toBeUndefined();
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
