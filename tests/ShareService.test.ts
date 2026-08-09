import { describe, expect, it } from "vitest";
import type { PostgresDatabase } from "../worker/database";
import { ShareService } from "../worker/ShareService";

function serviceWithQuery(
  query: (text: string, values: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>,
) {
  const database = { query } as unknown as PostgresDatabase;
  return new ShareService(database);
}

describe("ShareService", () => {
  it("checks aliases case-insensitively and only counts active links", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const service = serviceWithQuery(async (text, values) => {
      calls.push({ text, values });
      return { rows: [{ available: false }] };
    });

    await expect(service.availability("My-View")).resolves.toEqual({
      alias: "my-view",
      available: false,
    });
    expect(calls[0].values).toEqual(["my-view"]);
    expect(calls[0].text).toContain("expires_at > now()");
  });

  it("creates a temporary share using an allowed expiration", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const expiresAt = new Date("2026-08-10T12:00:00Z");
    const service = serviceWithQuery(async (text, values) => {
      calls.push({ text, values });
      if (text.includes("INSERT INTO shared_page_links")) {
        return { rows: [{ alias: "daily-chat", expires_at: expiresAt }] };
      }
      return { rows: [] };
    });

    await expect(service.create({
      alias: "daily-chat",
      pageSearch: "?channel=alice&q=hello",
      expiresInSeconds: 86_400,
    })).resolves.toEqual({
      alias: "daily-chat",
      expiresAt: expiresAt.getTime(),
    });
    expect(calls[0].text).toContain("DELETE FROM shared_page_links");
    expect(calls[1].values).toEqual(["daily-chat", "?channel=alice&q=hello", 86_400]);
  });

  it("rejects unsupported expiration times and duplicate aliases", async () => {
    const service = serviceWithQuery(async (text) => ({
      rows: text.includes("INSERT INTO shared_page_links") ? [] : [],
    }));

    await expect(service.create({
      alias: "too-long",
      pageSearch: "",
      expiresInSeconds: 31_536_000,
    })).rejects.toMatchObject({ status: 400 });

    await expect(service.create({
      alias: "already-used",
      pageSearch: "",
      expiresInSeconds: 300,
    })).rejects.toMatchObject({ status: 409 });
  });

  it("does not resolve expired or missing links", async () => {
    const service = serviceWithQuery(async () => ({ rows: [] }));

    await expect(service.resolve("old-view")).rejects.toMatchObject({
      status: 404,
      message: "This share link has expired or does not exist.",
    });
  });
});
