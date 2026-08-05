import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminService, totp } from "../worker/AdminService";
import { loadConfiguration } from "../worker/config";
import { PostgresDatabase } from "../worker/database";
import { createHttpServer } from "../worker/httpServer";
import { createLogger } from "../worker/logger";
import { FeedbackService } from "../worker/FeedbackService";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgreSQL admin control room", () => {
  let database: PostgresDatabase;
  let admin: AdminService;
  let server: Server | undefined;

  beforeAll(async () => {
    database = new PostgresDatabase(databaseUrl!);
    await database.migrate();
    admin = new AdminService(database, "integration-setup-secret", Buffer.alloc(32, 7));
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await database.close();
  });

  it("supports setup, authentication, TOTP, dashboard data, and maintenance jobs", async () => {
    await expect(admin.status()).resolves.toMatchObject({
      configured: false,
      authenticated: false,
    });

    let session = await admin.setup("correct horse battery", "integration-setup-secret");
    await expect(admin.status(session)).resolves.toMatchObject({
      configured: true,
      authenticated: true,
    });
    await expect(admin.loginWithPassword("incorrect password")).rejects.toMatchObject({ status: 401 });
    session = await admin.loginWithPassword("correct horse battery");

    const enrollment = await admin.beginTotp(session);
    session = await admin.confirmTotp(
      session,
      enrollment.enrollmentToken,
      totp(enrollment.secret, Math.floor(Date.now() / 30_000)),
    );
    await expect(admin.status(session)).resolves.toMatchObject({
      authenticated: true,
      totpEnabled: true,
    });

    await admin.recordMetric(12, false, "hit");
    const jobId = await admin.startJob(session, "database_measurement");
    const job = await waitForJob(admin, session, jobId);
    expect(job.status).toBe("completed");

    const dashboard = await admin.dashboard(session) as {
      databaseStats?: { tables: Array<{ name: string }> };
      metrics: { functionCalls: number; cacheHits: number };
    };
    expect(dashboard.databaseStats?.tables.map((table) => table.name)).toContain("chat_messages");
    expect(dashboard.metrics.functionCalls).toBeGreaterThan(0);
    expect(dashboard.metrics.cacheHits).toBeGreaterThan(0);

    const feedback = new FeedbackService(database, 15, "integration-feedback-secret");
    const description = `Integration issue ${Date.now()}`;
    await feedback.submit({ kind: "issue", description }, `integration-${Date.now()}`);
    const inbox = await admin.listFeedback(session, { search: description });
    expect(inbox.submissions).toHaveLength(1);
    expect(inbox.submissions[0]).toMatchObject({ kind: "issue", status: "open", flags: [] });
    const classified = await admin.classifyFeedback(
      session,
      inbox.submissions[0]!._id,
      "closed",
      ["non-issue"],
    );
    expect(classified).toMatchObject({ status: "closed", flags: ["non-issue"] });

    const configuration = {
      ...loadConfiguration({ TWITCH_FRONTEND_URL: "http://localhost:5173" }),
      port: 0,
      adminOptions: {
        setupSecret: "integration-setup-secret",
        encryptionKey: Buffer.alloc(32, 7),
      },
    };
    server = await createHttpServer(
      configuration,
      { database },
      createLogger("silent"),
    );
    const port = (server.address() as AddressInfo).port;
    const login = await fetch(`http://127.0.0.1:${port}/api/admin/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
      body: JSON.stringify({ password: "correct horse battery" }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie()[0]?.split(";", 1)[0];
    expect(cookie).toContain("twitch_admin_session=");
    const dashboardResponse = await fetch(`http://127.0.0.1:${port}/api/admin/dashboard`, {
      headers: { Cookie: cookie },
    });
    expect(dashboardResponse.status).toBe(200);
    await expect(dashboardResponse.json()).resolves.toMatchObject({
      auth: { totpEnabled: true },
      databaseStats: { scope: expect.stringContaining("PostgreSQL") },
    });
  });
});

async function waitForJob(admin: AdminService, session: string, jobId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const dashboard = await admin.dashboard(session) as {
      jobs: Array<{ _id: string; status: string }>;
    };
    const job = dashboard.jobs.find((candidate) => candidate._id === jobId);
    if (job && ["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("PostgreSQL admin job did not finish in time");
}
