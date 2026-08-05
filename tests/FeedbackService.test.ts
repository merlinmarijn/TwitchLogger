import { describe, expect, it } from "vitest";
import {
  FeedbackService,
  parseFeedbackSubmission,
} from "../worker/FeedbackService";
import type { PostgresDatabase } from "../worker/database";

describe("feedback submissions", () => {
  it("requires a valid kind and non-empty description", () => {
    expect(() => parseFeedbackSubmission({ kind: "feedback", description: "   " }))
      .toThrow("Add a description");
    expect(() => parseFeedbackSubmission({ kind: "other", description: "A note" }))
      .toThrow("Choose feedback or issue report");
  });

  it("stores a trimmed report with a one-way IP hash", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      },
      release: () => undefined,
    };
    const database = {
      pool: { connect: async () => client },
    } as unknown as PostgresDatabase;
    const service = new FeedbackService(database, 15, "test-secret");

    await service.submit(
      { kind: "issue", description: "  The channel list is stuck.  " },
      "203.0.113.20",
    );

    const insert = queries.find((query) => query.text.includes("INSERT INTO feedback_reports"));
    expect(insert?.values?.[0]).toBe("issue");
    expect(insert?.values?.[1]).toBe("The channel list is stuck.");
    expect(insert?.values?.[2]).toMatch(/^[a-f0-9]{64}$/);
    expect(insert?.values?.[2]).not.toContain("203.0.113.20");
    expect(queries.at(-1)?.text).toBe("COMMIT");
  });

  it("returns a helpful cooldown error for a recent IP", async () => {
    const client = {
      query: async (text: string) => ({
        rows: text.includes("SELECT created_at")
          ? [{ retry_at: new Date(Date.now() + 90_000) }]
          : [],
      }),
      release: () => undefined,
    };
    const database = {
      pool: { connect: async () => client },
    } as unknown as PostgresDatabase;
    const service = new FeedbackService(database, 15, "test-secret");

    await expect(service.submit(
      { kind: "feedback", description: "A useful idea" },
      "203.0.113.20",
    )).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining("Please try again in 2 minutes"),
    });
  });
});
