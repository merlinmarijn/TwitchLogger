import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfiguration } from "../worker/config";
import { createHttpServer } from "../worker/httpServer";
import { AdminAuthError, AdminService } from "../worker/AdminService";
import { createLogger } from "../worker/logger";
import type { PostgresDatabase } from "../worker/database";
import type { PostgresStore } from "../worker/PostgresStore";
import { FeedbackRequestError } from "../worker/FeedbackService";

const servers: Array<ReturnType<typeof createHttpServer> extends Promise<infer T> ? T : never> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("setup-mode HTTP server", () => {
  it("returns the feedback cooldown and retry header", async () => {
    const configuration = {
      ...loadConfiguration({
        INGESTION_SECRET: "feedback-test-secret",
        TWITCH_FRONTEND_URL: "http://localhost:5173",
      }),
      port: 0,
    };
    const server = await createHttpServer(
      configuration,
      { database: {} as PostgresDatabase },
      createLogger("silent"),
      {
        createFeedbackService: () => ({
          submit: async () => {
            throw new FeedbackRequestError(
              "You've recently sent a report. Please try again in 4 minutes.",
              429,
              240,
            );
          },
        }),
      },
    );
    servers.push(server);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
      body: JSON.stringify({ kind: "feedback", description: "A useful idea" }),
    });
    const body = await response.json() as { error: string; retryAfterSeconds: number };

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("240");
    expect(body.error).toContain("try again in 4 minutes");
    expect(body.retryAfterSeconds).toBe(240);
  });

  it("accepts the configured frontend origin when its URL has a trailing slash", async () => {
    const configuration = {
      ...loadConfiguration({ TWITCH_FRONTEND_URL: "http://localhost:5173/" }),
      port: 0,
    };
    const server = await createHttpServer(configuration, {}, createLogger("silent"));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/admin/auth/logout`, {
      method: "POST",
      headers: { Origin: "http://localhost:5173" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("continues to reject admin writes from an untrusted origin", async () => {
    const configuration = {
      ...loadConfiguration({ TWITCH_FRONTEND_URL: "http://localhost:5173/" }),
      port: 0,
    };
    const server = await createHttpServer(configuration, {}, createLogger("silent"));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/admin/auth/logout`, {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
    });

    expect(response.status).toBe(403);
  });

  it("rejects public data mutations before they reach PostgreSQL", async () => {
    let channelAdded = false;
    const configuration = {
      ...loadConfiguration({ TWITCH_FRONTEND_URL: "http://localhost:5173" }),
      port: 0,
      adminOptions: {
        setupSecret: "test-secret",
        encryptionKey: Buffer.alloc(32, 1),
      },
    };
    const server = await createHttpServer(
      configuration,
      {
        database: {} as PostgresDatabase,
        store: {
          addChannel: async () => {
            channelAdded = true;
            return "channel-id";
          },
        } as unknown as PostgresStore,
      },
      createLogger("silent"),
      {
        createAdminService: () => ({
          requireSession: async () => {
            throw new AdminAuthError("Your admin session has expired", 401);
          },
          recordMetric: async () => undefined,
        }) as unknown as AdminService,
      },
    );
    servers.push(server);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/data/channels/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
      body: JSON.stringify({ platform: "twitch", username: "public-user", loggingEnabled: true }),
    });

    expect(response.status).toBe(401);
    expect(channelAdded).toBe(false);
  });

  it("stays live and reports not-ready when configuration is missing", async () => {
    const configuration = { ...loadConfiguration({}), port: 0 };
    const server = await createHttpServer(configuration, {}, createLogger("silent"));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    const body = (await health.json()) as {
      ok: boolean;
      ready: boolean;
      configured: boolean;
      configurationIssues: string[];
    };

    expect(health.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.ready).toBe(false);
    expect(body.configured).toBe(false);
    expect(body.configurationIssues.some((issue) => issue.includes("DATABASE_URL"))).toBe(
      true,
    );
  });

  it("serves an allowed TouhouWiki image through the dedicated proxy", async () => {
    const configuration = { ...loadConfiguration({}), port: 0 };
    const requestedUrls: string[] = [];
    const server = await createHttpServer(
      configuration,
      {},
      createLogger("silent"),
      {
        fetchTouhouWikiImage: async (url) => {
          requestedUrls.push(url.href);
          return {
            body: Buffer.from([0xff, 0xd8, 0xff]),
            contentType: "image/jpeg",
            etag: "test-etag",
          };
        },
      },
    );
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const imageUrl = "https://en.touhouwiki.net/images/7/78/Th11SC159.jpg?20191126144715";

    const response = await fetch(
      `http://127.0.0.1:${port}/images/touhouwiki?url=${encodeURIComponent(imageUrl)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(requestedUrls).toEqual([imageUrl]);
  });

  it("rejects arbitrary image hosts without fetching them", async () => {
    const configuration = { ...loadConfiguration({}), port: 0 };
    let fetched = false;
    const server = await createHttpServer(configuration, {}, createLogger("silent"), {
      fetchTouhouWikiImage: async () => {
        fetched = true;
        throw new Error("should not be called");
      },
    });
    servers.push(server);
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(
      `http://127.0.0.1:${port}/images/touhouwiki?url=${encodeURIComponent("https://example.com/image.jpg")}`,
    );

    expect(response.status).toBe(400);
    expect(fetched).toBe(false);
  });

  it("resolves an allowed Imgur album to its CDN preview", async () => {
    const configuration = { ...loadConfiguration({}), port: 0 };
    const requestedUrls: string[] = [];
    const server = await createHttpServer(
      configuration,
      {},
      createLogger("silent"),
      {
        resolveImgurImageUrl: async (url) => {
          requestedUrls.push(url.href);
          return new URL("https://i.imgur.com/Fb1IWtG.png?fb");
        },
      },
    );
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const albumUrl = "https://imgur.com/a/I5kYHtp";

    const response = await fetch(
      `http://127.0.0.1:${port}/images/imgur?url=${encodeURIComponent(albumUrl)}`,
      { redirect: "manual" },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://i.imgur.com/Fb1IWtG.png?fb");
    expect(requestedUrls).toEqual([albumUrl]);
  });
});
