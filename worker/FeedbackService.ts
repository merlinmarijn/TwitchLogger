import { createHmac } from "node:crypto";
import type { PoolClient } from "pg";
import type { FeedbackKind } from "../shared/feedback";
import type { PostgresDatabase } from "./database";

export interface FeedbackSubmission {
  kind: FeedbackKind;
  description: string;
  contactUsername?: string;
}

export class FeedbackRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export class FeedbackService {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly rateLimitMinutes: number,
    private readonly ipHashSecret: string,
  ) {}

  async submit(input: unknown, ipAddress: string) {
    const submission = parseFeedbackSubmission(input);
    const ipHash = this.hashIpAddress(ipAddress);
    const client = await this.database.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ipHash]);
      const recent = await client.query<{ retry_at: Date }>(`
        SELECT created_at + ($2 * interval '1 minute') AS retry_at
        FROM feedback_reports
        WHERE ip_hash = $1
          AND created_at > now() - ($2 * interval '1 minute')
        ORDER BY created_at DESC
        LIMIT 1
      `, [ipHash, this.rateLimitMinutes]);

      if (recent.rows[0]) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((recent.rows[0].retry_at.getTime() - Date.now()) / 1_000),
        );
        await client.query("ROLLBACK");
        throw new FeedbackRequestError(
          formatRateLimitMessage(retryAfterSeconds),
          429,
          retryAfterSeconds,
        );
      }

      await client.query(`
        INSERT INTO feedback_reports (kind, description, contact_username, ip_hash)
        VALUES ($1, $2, $3, $4)
      `, [submission.kind, submission.description, submission.contactUsername ?? null, ipHash]);
      await client.query("COMMIT");
      const retryAfterSeconds = this.rateLimitMinutes * 60;
      return {
        retryAfterSeconds,
        retryAt: Date.now() + retryAfterSeconds * 1_000,
      };
    } catch (error) {
      if (!(error instanceof FeedbackRequestError)) {
        await rollback(client);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async status(ipAddress: string) {
    const recent = await this.database.query<{ retry_at: Date }>(`
      SELECT created_at + ($2 * interval '1 minute') AS retry_at
      FROM feedback_reports
      WHERE ip_hash = $1
        AND created_at > now() - ($2 * interval '1 minute')
      ORDER BY created_at DESC
      LIMIT 1
    `, [this.hashIpAddress(ipAddress), this.rateLimitMinutes]);
    const retryAt = recent.rows[0]?.retry_at.getTime();
    const retryAfterSeconds = retryAt === undefined
      ? 0
      : Math.max(1, Math.ceil((retryAt - Date.now()) / 1_000));
    return {
      limited: retryAfterSeconds > 0,
      retryAfterSeconds,
      ...(retryAt === undefined ? {} : { retryAt }),
    };
  }

  private hashIpAddress(ipAddress: string) {
    return createHmac("sha256", this.ipHashSecret)
      .update(ipAddress)
      .digest("hex");
  }
}

export function parseFeedbackSubmission(input: unknown): FeedbackSubmission {
  const record = input && typeof input === "object"
    ? input as Record<string, unknown>
    : undefined;
  const kind = record?.kind;
  const description = typeof record?.description === "string"
    ? record.description.trim()
    : "";
  const rawContactUsername = typeof record?.contactUsername === "string"
    ? record.contactUsername.trim().replace(/^@/, "")
    : "";
  const contactUsername = rawContactUsername.toLowerCase();

  if (kind !== "feedback" && kind !== "issue") {
    throw new FeedbackRequestError("Choose feedback or issue report before submitting", 400);
  }
  if (!description) {
    throw new FeedbackRequestError("Add a description before submitting", 400);
  }
  if (description.length > 4_000) {
    throw new FeedbackRequestError("Keep the description under 4,000 characters", 400);
  }
  if (contactUsername && !/^[a-z0-9_]{1,25}$/.test(contactUsername)) {
    throw new FeedbackRequestError(
      "Enter a valid Twitch username using letters, numbers, or underscores",
      400,
    );
  }

  return {
    kind,
    description,
    ...(contactUsername ? { contactUsername } : {}),
  };
}

function formatRateLimitMessage(seconds: number) {
  if (seconds < 60) {
    return `You've recently sent a report. Please try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `You've recently sent a report. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

async function rollback(client: PoolClient) {
  await client.query("ROLLBACK").catch(() => undefined);
}
