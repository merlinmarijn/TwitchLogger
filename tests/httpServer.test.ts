import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfiguration } from "../worker/config";
import { createHttpServer } from "../worker/httpServer";
import { createLogger } from "../worker/logger";

const servers: Array<ReturnType<typeof createHttpServer> extends Promise<infer T> ? T : never> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("setup-mode HTTP server", () => {
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
    expect(body.configurationIssues.some((issue) => issue.includes("CONVEX_URL"))).toBe(
      true,
    );
  });
});
