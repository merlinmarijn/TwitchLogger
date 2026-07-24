import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import QRCode from "qrcode";
import { extractImageUrls, IMAGE_INDEX_VERSION } from "../shared/imageUrls";
import type { PostgresDatabase } from "./database";

const PASSWORD_COST = 16_384;
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1_000;
const ENROLLMENT_LIFETIME_MS = 10 * 60 * 1_000;
const SETTINGS_KEY = "super-admin";
const METRICS_KEY = "global";
const STATS_KEY = "latest";
const JOB_BATCH_SIZE = 100;

type AuthState =
  | { configured: false; totpEnabled: false; authRevision: 0 }
  | {
      configured: true;
      passwordHash: string;
      passwordSalt: string;
      passwordCost: number;
      totpEnabled: boolean;
      totpSecretEncrypted?: string;
      authRevision: number;
    };

type SessionPayload = { type: "session"; revision: number; expiresAt: number };
type EnrollmentPayload = {
  type: "enrollment";
  secret: string;
  revision: number;
  expiresAt: number;
};

export type AdminJobKind =
  | "image_reindex"
  | "view_reindex"
  | "integrity_scan"
  | "database_measurement";

type AdminJobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

const jobDefinitions: Record<AdminJobKind, { title: string; detail: string; unit: string }> = {
  image_reindex: {
    title: "Re-index image links",
    detail: "Rebuilds extracted image metadata and gallery membership for every visible message.",
    unit: "messages",
  },
  view_reindex: {
    title: "Refresh saved views",
    detail: "Refreshes PostgreSQL saved-view revisions and removes obsolete legacy match rows.",
    unit: "views",
  },
  integrity_scan: {
    title: "Run integrity scan",
    detail: "Checks message references and image metadata without changing source data.",
    unit: "messages",
  },
  database_measurement: {
    title: "Measure database",
    detail: "Measures PostgreSQL row counts and relation sizes for application tables.",
    unit: "tables",
  },
};

const measuredTables = [
  "platforms",
  "channels",
  "chat_tabs",
  "chat_messages",
  "chat_raw_events",
  "chat_raw_event_chunks",
  "admin_jobs",
  "admin_audit_log",
] as const;

export class AdminService {
  private readonly signingKey: Buffer;
  private readonly runningJobs = new Set<string>();

  constructor(
    private readonly database: PostgresDatabase,
    private readonly setupSecret: string,
    private readonly encryptionKey: Buffer,
  ) {
    this.signingKey = createHmac("sha256", encryptionKey)
      .update("twitch-logger/admin/session/v1")
      .digest();
    queueMicrotask(() => void this.resumeJobs());
  }

  async status(sessionToken?: string) {
    const state = await this.authState();
    return {
      configured: state.configured,
      totpEnabled: state.totpEnabled,
      authenticated: state.configured && this.sessionMatches(sessionToken, state.authRevision),
    };
  }

  async setup(password: string, setupKey: string) {
    validatePassword(password);
    const state = await this.authState();
    if (state.configured) throw new AdminAuthError("The super admin is already configured", 409);
    if (!secretMatches(setupKey, this.setupSecret)) {
      throw new AdminAuthError("The setup key is incorrect", 401);
    }
    const credentials = await hashPassword(password);
    const now = Date.now();
    const result = await this.database.query<{ auth_revision: string }>(`
      INSERT INTO admin_settings (
        id, key, password_hash, password_salt, password_cost, totp_enabled,
        auth_revision, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, false, 1, $6, $6)
      ON CONFLICT (key) DO NOTHING
      RETURNING auth_revision
    `, [randomUUID(), SETTINGS_KEY, credentials.passwordHash, credentials.passwordSalt,
      credentials.passwordCost, now]);
    if (!result.rows[0]) throw new AdminAuthError("The super admin is already configured", 409);
    await this.writeAudit("admin.configured", "Super admin password created", "setup");
    return this.createSession(Number(result.rows[0].auth_revision));
  }

  async loginWithPassword(password: string) {
    const state = await this.authState();
    if (!state.configured) throw new AdminAuthError("Complete super admin setup first", 409);
    if (!(await verifyPassword(password, state))) {
      throw new AdminAuthError("The password or authenticator code is incorrect", 401);
    }
    return this.createSession(state.authRevision);
  }

  async loginWithTotp(code: string) {
    const state = await this.authState();
    if (!state.configured || !state.totpEnabled || !state.totpSecretEncrypted) {
      throw new AdminAuthError("Authenticator sign-in is not enabled", 409);
    }
    if (!verifyTotp(this.decrypt(state.totpSecretEncrypted), code)) {
      throw new AdminAuthError("The password or authenticator code is incorrect", 401);
    }
    return this.createSession(state.authRevision);
  }

  async requireSession(sessionToken?: string) {
    const state = await this.authState();
    if (!state.configured || !this.sessionMatches(sessionToken, state.authRevision)) {
      throw new AdminAuthError("Your admin session has expired", 401);
    }
    return state;
  }

  async beginTotp(sessionToken?: string) {
    const state = await this.requireSession(sessionToken);
    const secret = base32Encode(randomBytes(20));
    const enrollmentToken = this.sign({
      type: "enrollment",
      secret,
      revision: state.authRevision,
      expiresAt: Date.now() + ENROLLMENT_LIFETIME_MS,
    } satisfies EnrollmentPayload);
    const issuer = "Twitch Logger";
    const uri = `otpauth://totp/${encodeURIComponent(`${issuer}:super-admin`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    const qrCode = await QRCode.toDataURL(uri, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 256,
      color: { dark: "#17201d", light: "#f4f0e6" },
    });
    return { enrollmentToken, qrCode, secret, expiresInSeconds: ENROLLMENT_LIFETIME_MS / 1_000 };
  }

  async confirmTotp(sessionToken: string | undefined, enrollmentToken: string, code: string) {
    const state = await this.requireSession(sessionToken);
    const payload = this.verifySigned<EnrollmentPayload>(enrollmentToken);
    if (!payload || payload.type !== "enrollment" || payload.expiresAt < Date.now() ||
        payload.revision !== state.authRevision) {
      throw new AdminAuthError("This QR code has expired; generate a new one", 400);
    }
    if (!verifyTotp(payload.secret, code)) {
      throw new AdminAuthError("That code does not match the QR code", 400);
    }
    const result = await this.database.query<{ auth_revision: string }>(`
      UPDATE admin_settings
      SET totp_secret_encrypted = $2, totp_enabled = true,
          auth_revision = auth_revision + 1, updated_at = $3
      WHERE key = $1
      RETURNING auth_revision
    `, [SETTINGS_KEY, this.encrypt(payload.secret), Date.now()]);
    const revision = result.rows[0];
    if (!revision) throw new AdminAuthError("The super admin is not configured", 409);
    await this.writeAudit("admin.totp_enabled", "Authenticator sign-in enabled", "super-admin");
    return this.createSession(Number(revision.auth_revision));
  }

  async changePassword(sessionToken: string | undefined, currentPassword: string, newPassword: string) {
    const state = await this.requireSession(sessionToken);
    if (!(await verifyPassword(currentPassword, state))) {
      throw new AdminAuthError("The current password is incorrect", 401);
    }
    validatePassword(newPassword);
    const credentials = await hashPassword(newPassword);
    const result = await this.database.query<{ auth_revision: string }>(`
      UPDATE admin_settings
      SET password_hash = $2, password_salt = $3, password_cost = $4,
          auth_revision = auth_revision + 1, updated_at = $5
      WHERE key = $1
      RETURNING auth_revision
    `, [SETTINGS_KEY, credentials.passwordHash, credentials.passwordSalt,
      credentials.passwordCost, Date.now()]);
    const revision = result.rows[0];
    if (!revision) throw new AdminAuthError("The super admin is not configured", 409);
    await this.writeAudit("admin.password_changed", "Super admin password changed", "super-admin");
    return this.createSession(Number(revision.auth_revision));
  }

  async dashboard(sessionToken?: string) {
    const state = await this.requireSession(sessionToken);
    const [jobs, metrics, stats, channels, latestMessage, auditLog] = await Promise.all([
      this.database.query<AdminJobRow>(`
        SELECT * FROM admin_jobs ORDER BY created_at DESC LIMIT 30
      `),
      this.database.query<AdminMetricRow>(`
        SELECT * FROM admin_metrics WHERE key = $1
      `, [METRICS_KEY]),
      this.database.query<AdminStatsRow>(`
        SELECT * FROM admin_database_stats WHERE key = $1
      `, [STATS_KEY]),
      this.database.query<ChannelSummaryRow>(`
        SELECT
          count(*) FILTER (WHERE hidden_at IS NULL)::bigint AS total,
          count(*) FILTER (WHERE hidden_at IS NULL AND logging_enabled)::bigint AS logging,
          count(*) FILTER (WHERE hidden_at IS NULL AND connection_status = 'connected')::bigint AS connected,
          count(*) FILTER (
            WHERE hidden_at IS NULL AND logging_enabled AND connection_status <> 'connected'
          )::bigint AS problems
        FROM channels
      `),
      this.database.query<{ timestamp: string }>(`
        SELECT timestamp FROM chat_messages
        WHERE deleted_at IS NULL ORDER BY timestamp DESC LIMIT 1
      `),
      this.database.query<AuditRow>(`
        SELECT id, event, detail, actor, created_at
        FROM admin_audit_log ORDER BY created_at DESC LIMIT 12
      `),
    ]);
    const metric = metrics.rows[0];
    const databaseStats = stats.rows[0];
    const channel = channels.rows[0];
    return {
      generatedAt: Date.now(),
      auth: { totpEnabled: state.totpEnabled, authRevision: state.authRevision },
      jobs: jobs.rows.map(toAdminJob),
      metrics: metric ? {
        functionCalls: Number(metric.function_calls),
        errorCount: Number(metric.error_count),
        totalExecutionMs: Number(metric.total_execution_ms),
        cacheHits: Number(metric.cache_hits),
        cacheMisses: Number(metric.cache_misses),
        updatedAt: Number(metric.updated_at),
      } : emptyMetrics(),
      databaseStats: databaseStats ? {
        generatedAt: Number(databaseStats.generated_at),
        documentCount: Number(databaseStats.document_count),
        documentBytes: Number(databaseStats.document_bytes),
        tables: databaseStats.tables,
        scope: databaseStats.scope,
      } : undefined,
      channels: {
        total: Number(channel?.total ?? 0),
        logging: Number(channel?.logging ?? 0),
        connected: Number(channel?.connected ?? 0),
        problems: Number(channel?.problems ?? 0),
      },
      latestMessageAt: latestMessage.rows[0] ? Number(latestMessage.rows[0].timestamp) : undefined,
      auditLog: auditLog.rows.map((entry) => ({
        _id: entry.id,
        event: entry.event,
        detail: entry.detail,
        actor: entry.actor,
        createdAt: Number(entry.created_at),
      })),
    };
  }

  async startJob(sessionToken: string | undefined, kind: AdminJobKind) {
    await this.requireSession(sessionToken);
    const definition = jobDefinitions[kind];
    const client = await this.database.pool.connect();
    const id = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [1_987_042_019]);
      const active = await client.query(`
        SELECT 1 FROM admin_jobs
        WHERE status IN ('queued', 'running', 'cancelling') LIMIT 1
      `);
      if (active.rowCount) {
        throw new AdminAuthError("Wait for the active maintenance operation to finish", 409);
      }
      const now = Date.now();
      await client.query(`
        INSERT INTO admin_jobs (
          id, kind, status, title, detail, current, total, unit, cursor,
          metadata, requested_by, created_at, updated_at
        ) VALUES ($1, $2, 'queued', $3, $4, 0, NULL, $5, NULL, $6::jsonb, $7, $8, $8)
      `, [id, kind, definition.title, definition.detail, definition.unit,
        JSON.stringify({}), "super-admin", now]);
      await insertAudit(client, "job.started", definition.title, "super-admin");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    this.dispatchJob(id);
    return id;
  }

  async cancelJob(sessionToken: string | undefined, jobId: string) {
    await this.requireSession(sessionToken);
    const result = await this.database.query<{ title: string }>(`
      UPDATE admin_jobs SET status = 'cancelling', updated_at = $2
      WHERE id = $1 AND status IN ('queued', 'running')
      RETURNING title
    `, [jobId, Date.now()]);
    if (result.rows[0]) {
      await this.writeAudit("job.cancel_requested", result.rows[0].title, "super-admin");
      this.dispatchJob(jobId);
    }
  }

  async recordMetric(durationMs: number, failed: boolean, cache?: "hit" | "miss") {
    await this.database.query(`
      INSERT INTO admin_metrics (
        id, key, function_calls, error_count, total_execution_ms,
        cache_hits, cache_misses, updated_at
      ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7)
      ON CONFLICT (key) DO UPDATE SET
        function_calls = admin_metrics.function_calls + 1,
        error_count = admin_metrics.error_count + EXCLUDED.error_count,
        total_execution_ms = admin_metrics.total_execution_ms + EXCLUDED.total_execution_ms,
        cache_hits = admin_metrics.cache_hits + EXCLUDED.cache_hits,
        cache_misses = admin_metrics.cache_misses + EXCLUDED.cache_misses,
        updated_at = EXCLUDED.updated_at
    `, [randomUUID(), METRICS_KEY, failed ? 1 : 0, Math.max(0, durationMs),
      cache === "hit" ? 1 : 0, cache === "miss" ? 1 : 0, Date.now()]);
  }

  private async authState(): Promise<AuthState> {
    const result = await this.database.query<AdminSettingsRow>(`
      SELECT password_hash, password_salt, password_cost, totp_secret_encrypted,
             totp_enabled, auth_revision
      FROM admin_settings WHERE key = $1
    `, [SETTINGS_KEY]);
    const row = result.rows[0];
    return row ? {
      configured: true,
      passwordHash: row.password_hash,
      passwordSalt: row.password_salt,
      passwordCost: Number(row.password_cost),
      totpEnabled: row.totp_enabled,
      ...(row.totp_secret_encrypted ? { totpSecretEncrypted: row.totp_secret_encrypted } : {}),
      authRevision: Number(row.auth_revision),
    } : { configured: false, totpEnabled: false, authRevision: 0 };
  }

  private async resumeJobs() {
    const result = await this.database.query<{ id: string }>(`
      SELECT id FROM admin_jobs
      WHERE status IN ('queued', 'running', 'cancelling')
      ORDER BY created_at LIMIT 1
    `).catch(() => undefined);
    if (result?.rows[0]) this.dispatchJob(result.rows[0].id);
  }

  private dispatchJob(id: string) {
    if (this.runningJobs.has(id)) return;
    this.runningJobs.add(id);
    setImmediate(() => void this.runJob(id).finally(() => this.runningJobs.delete(id)));
  }

  private async runJob(id: string) {
    const started = performance.now();
    try {
      const result = await this.database.query<{ kind: AdminJobKind; status: AdminJobStatus }>(`
        UPDATE admin_jobs
        SET status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
            started_at = CASE WHEN status = 'queued' THEN $2 ELSE started_at END,
            updated_at = $2
        WHERE id = $1 AND status IN ('queued', 'running', 'cancelling')
        RETURNING kind, status
      `, [id, Date.now()]);
      const job = result.rows[0];
      if (!job) return;
      if (job.status === "cancelling") return this.finishCancelled(id);
      if (job.kind === "image_reindex") await this.runImageReindex(id);
      else if (job.kind === "view_reindex") await this.runViewRefresh(id);
      else if (job.kind === "integrity_scan") await this.runIntegrityScan(id);
      else await this.runDatabaseMeasurement(id);
      if (await this.isCancelling(id)) await this.finishCancelled(id);
      else await this.completeJob(id);
      await this.recordMetric(performance.now() - started, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.database.query(`
        UPDATE admin_jobs SET status = 'failed', error = $2, updated_at = $3, finished_at = $3
        WHERE id = $1
      `, [id, message.slice(0, 500), Date.now()]).catch(() => undefined);
      await this.writeAudit("job.failed", message.slice(0, 500), "system").catch(() => undefined);
      await this.recordMetric(performance.now() - started, true).catch(() => undefined);
    }
  }

  private async runImageReindex(id: string) {
    const count = await this.database.query<{ count: string }>(`
      SELECT count(*) FROM chat_messages WHERE deleted_at IS NULL
    `);
    const total = Number(count.rows[0]?.count ?? 0);
    await this.database.query(`
      UPDATE admin_jobs SET total = $2, current = 0, cursor = NULL,
        detail = $3, updated_at = $4 WHERE id = $1
    `, [id, total, `Indexing ${total} saved messages`, Date.now()]);
    let cursor = "";
    let current = 0;
    while (true) {
      if (await this.isCancelling(id)) return;
      const page = await this.database.query<ImageReindexRow>(`
        SELECT id, channel_id, message_text, hidden_image_urls
        FROM chat_messages
        WHERE deleted_at IS NULL AND id > $1
        ORDER BY id LIMIT $2
      `, [cursor, JOB_BATCH_SIZE]);
      if (page.rows.length === 0) break;
      const client = await this.database.pool.connect();
      try {
        await client.query("BEGIN");
        for (const message of page.rows) {
          const hidden = new Set(message.hidden_image_urls ?? []);
          const imageUrls = extractImageUrls(message.message_text)
            .filter((url) => !hidden.has(url));
          await client.query(`
            UPDATE chat_messages
            SET has_images = $2, image_urls = $3::jsonb, image_index_version = $4,
                gallery_channel_id = CASE WHEN $2 THEN channel_id ELSE NULL END
            WHERE id = $1 AND deleted_at IS NULL
          `, [message.id, imageUrls.length > 0, JSON.stringify(imageUrls), IMAGE_INDEX_VERSION]);
        }
        cursor = page.rows[page.rows.length - 1].id;
        current += page.rows.length;
        await client.query(`
          UPDATE admin_jobs SET current = $2, cursor = $3, updated_at = $4 WHERE id = $1
        `, [id, current, cursor, Date.now()]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      await yieldToEventLoop();
    }
  }

  private async runViewRefresh(id: string) {
    const count = await this.database.query<{ count: string }>("SELECT count(*) FROM chat_tabs");
    const total = Number(count.rows[0]?.count ?? 0);
    await this.database.query(`
      UPDATE chat_tabs SET indexed_revision = revision, index_status = 'ready', updated_at = $1
    `, [Date.now()]);
    await this.database.query(`
      UPDATE admin_jobs SET total = $2, current = $2, detail = $3, updated_at = $4 WHERE id = $1
    `, [id, total, `${total} saved views refreshed`, Date.now()]);
  }

  private async runIntegrityScan(id: string) {
    const totalResult = await this.database.query<{ count: string }>(`
      SELECT count(*) FROM chat_messages WHERE deleted_at IS NULL
    `);
    const total = Number(totalResult.rows[0]?.count ?? 0);
    const issues = await this.database.query<{ id: string; issue: string }>(`
      SELECT m.id,
        CASE WHEN c.id IS NULL THEN 'Missing channel reference'
             ELSE 'Image metadata does not match indexed URLs' END AS issue
      FROM chat_messages m
      LEFT JOIN channels c ON c.id = m.channel_id
      WHERE m.deleted_at IS NULL AND (
        c.id IS NULL OR
        COALESCE(m.has_images, false) <>
          (jsonb_array_length(COALESCE(m.image_urls, '[]'::jsonb)) > 0)
      )
      LIMIT 100
    `);
    const samples = issues.rows.slice(0, 10).map((row) => `${row.issue}: ${row.id}`);
    await this.database.query(`
      UPDATE admin_jobs SET total = $2, current = $2, metadata = $3::jsonb,
        detail = $4, updated_at = $5 WHERE id = $1
    `, [id, total, JSON.stringify({ issues: issues.rows.length, samples }),
      `Integrity scan complete · ${issues.rows.length} ${issues.rows.length === 1 ? "issue" : "issues"}`,
      Date.now()]);
  }

  private async runDatabaseMeasurement(id: string) {
    const tables: Array<{ name: string; count: number; bytes: number }> = [];
    await this.database.query(`
      UPDATE admin_jobs SET total = $2, current = 0, updated_at = $3 WHERE id = $1
    `, [id, measuredTables.length, Date.now()]);
    for (const [index, table] of measuredTables.entries()) {
      if (await this.isCancelling(id)) return;
      const result = await this.database.query<{ count: string; bytes: string }>(`
        SELECT count(*)::bigint AS count,
               pg_total_relation_size($1::regclass)::bigint AS bytes
        FROM ${table}
      `, [table]);
      tables.push({
        name: table,
        count: Number(result.rows[0]?.count ?? 0),
        bytes: Number(result.rows[0]?.bytes ?? 0),
      });
      await this.database.query(`
        UPDATE admin_jobs SET current = $2, updated_at = $3 WHERE id = $1
      `, [id, index + 1, Date.now()]);
      await yieldToEventLoop();
    }
    const generatedAt = Date.now();
    const documentCount = tables.reduce((sum, table) => sum + table.count, 0);
    const documentBytes = tables.reduce((sum, table) => sum + table.bytes, 0);
    await this.database.query(`
      INSERT INTO admin_database_stats (
        id, key, generated_at, document_count, document_bytes, tables, scope
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      ON CONFLICT (key) DO UPDATE SET
        generated_at = EXCLUDED.generated_at,
        document_count = EXCLUDED.document_count,
        document_bytes = EXCLUDED.document_bytes,
        tables = EXCLUDED.tables,
        scope = EXCLUDED.scope
    `, [randomUUID(), STATS_KEY, generatedAt, documentCount, documentBytes,
      JSON.stringify(tables),
      "PostgreSQL relation sizes, including table data, indexes, and TOAST storage."]);
  }

  private async isCancelling(id: string) {
    const result = await this.database.query<{ status: AdminJobStatus }>(`
      SELECT status FROM admin_jobs WHERE id = $1
    `, [id]);
    return result.rows[0]?.status === "cancelling";
  }

  private async finishCancelled(id: string) {
    const result = await this.database.query<{ title: string }>(`
      UPDATE admin_jobs SET status = 'cancelled', detail = title || ' was stopped before completion',
        updated_at = $2, finished_at = $2 WHERE id = $1 RETURNING title
    `, [id, Date.now()]);
    if (result.rows[0]) await this.writeAudit("job.cancelled", result.rows[0].title, "system");
  }

  private async completeJob(id: string) {
    const result = await this.database.query<{ title: string }>(`
      UPDATE admin_jobs SET status = 'completed', current = COALESCE(total, current),
        cursor = NULL, updated_at = $2, finished_at = $2
      WHERE id = $1 RETURNING title
    `, [id, Date.now()]);
    if (result.rows[0]) await this.writeAudit("job.completed", result.rows[0].title, "system");
  }

  private writeAudit(event: string, detail: string, actor: string) {
    return this.database.query(`
      INSERT INTO admin_audit_log (id, event, detail, actor, created_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [randomUUID(), event, detail.slice(0, 500), actor, Date.now()]);
  }

  private createSession(revision: number) {
    return this.sign({
      type: "session",
      revision,
      expiresAt: Date.now() + SESSION_LIFETIME_MS,
    } satisfies SessionPayload);
  }

  private sessionMatches(token: string | undefined, revision: number) {
    if (!token) return false;
    const payload = this.verifySigned<SessionPayload>(token);
    return Boolean(payload && payload.type === "session" && payload.revision === revision &&
      payload.expiresAt >= Date.now());
  }

  private sign(payload: SessionPayload | EnrollmentPayload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", this.signingKey).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  private verifySigned<T>(token: string): T | undefined {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) return undefined;
    const expected = createHmac("sha256", this.signingKey).update(body).digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signature, "base64url");
    } catch {
      return undefined;
    }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
    try {
      return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    } catch {
      return undefined;
    }
  }

  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url")].join(".");
  }

  private decrypt(envelope: string) {
    const [version, iv, tag, ciphertext] = envelope.split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Invalid TOTP envelope");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

interface AdminSettingsRow {
  password_hash: string;
  password_salt: string;
  password_cost: string;
  totp_secret_encrypted: string | null;
  totp_enabled: boolean;
  auth_revision: string;
}

interface AdminJobRow {
  id: string;
  kind: AdminJobKind;
  status: AdminJobStatus;
  title: string;
  detail: string;
  current: string;
  total: string | null;
  unit: string;
  metadata: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface AdminMetricRow {
  function_calls: string;
  error_count: string;
  total_execution_ms: string;
  cache_hits: string;
  cache_misses: string;
  updated_at: string;
}

interface AdminStatsRow {
  generated_at: string;
  document_count: string;
  document_bytes: string;
  tables: Array<{ name: string; count: number; bytes: number }>;
  scope: string;
}

interface ChannelSummaryRow {
  total: string;
  logging: string;
  connected: string;
  problems: string;
}

interface AuditRow {
  id: string;
  event: string;
  detail: string;
  actor: string;
  created_at: string;
}

interface ImageReindexRow {
  id: string;
  channel_id: string;
  message_text: string;
  hidden_image_urls: string[];
}

function toAdminJob(job: AdminJobRow) {
  return {
    _id: job.id,
    kind: job.kind,
    status: job.status,
    title: job.title,
    detail: job.detail,
    current: Number(job.current),
    ...(job.total === null ? {} : { total: Number(job.total) }),
    unit: job.unit,
    ...(job.metadata ? { metadata: job.metadata } : {}),
    ...(job.error ? { error: job.error } : {}),
    createdAt: Number(job.created_at),
    updatedAt: Number(job.updated_at),
    ...(job.finished_at === null ? {} : { finishedAt: Number(job.finished_at) }),
  };
}

function emptyMetrics() {
  return {
    functionCalls: 0,
    errorCount: 0,
    totalExecutionMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    updatedAt: Date.now(),
  };
}

async function insertAudit(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  event: string,
  detail: string,
  actor: string,
) {
  await client.query(`
    INSERT INTO admin_audit_log (id, event, detail, actor, created_at)
    VALUES ($1, $2, $3, $4, $5)
  `, [randomUUID(), event, detail.slice(0, 500), actor, Date.now()]);
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function secretMatches(supplied: string, expected: string) {
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes);
}

export class AdminAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function validatePassword(password: string) {
  if (password.length < 12 || password.length > 128) {
    throw new AdminAuthError("Use a password between 12 and 128 characters", 400);
  }
}

async function hashPassword(password: string) {
  const passwordSalt = randomBytes(16).toString("base64url");
  const derived = await derivePassword(password, passwordSalt, PASSWORD_COST);
  return {
    passwordHash: derived.toString("base64url"),
    passwordSalt,
    passwordCost: PASSWORD_COST,
  };
}

async function verifyPassword(
  password: string,
  credentials: { passwordHash: string; passwordSalt: string; passwordCost: number },
) {
  const expected = Buffer.from(credentials.passwordHash, "base64url");
  const actual = await derivePassword(password, credentials.passwordSalt, credentials.passwordCost);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function derivePassword(password: string, salt: string, cost: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: Math.max(16_384, Math.min(cost, 131_072)), r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
      (error, derived) => error ? reject(error) : resolve(derived),
    );
  });
}

export function verifyTotp(secret: string, candidate: string, now = Date.now()) {
  if (!/^\d{6}$/.test(candidate)) return false;
  const expected = Buffer.from(candidate);
  for (let offset = -1; offset <= 1; offset += 1) {
    const code = Buffer.from(totp(secret, Math.floor(now / 30_000) + offset));
    if (timingSafeEqual(code, expected)) return true;
  }
  return false;
}

export function totp(secret: string, counter: number) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return value.toString().padStart(6, "0");
}

function base32Encode(value: Buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let buffer = 0;
  let output = "";
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

function base32Decode(value: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let buffer = 0;
  const output: number[] = [];
  for (const character of value.toUpperCase().replace(/=+$/, "")) {
    const index = alphabet.indexOf(character);
    if (index < 0) continue;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}
