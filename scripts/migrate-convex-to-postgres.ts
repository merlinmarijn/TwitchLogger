import "dotenv/config";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import type { PoolClient } from "pg";
import { extractImageUrls, IMAGE_INDEX_VERSION } from "../shared/imageUrls";
import { PostgresDatabase } from "../worker/database";

const tables = [
  "platforms", "channels", "chatTabs", "chatMessages", "chatTabMatches",
  "adminSettings", "adminJobs", "adminMetrics", "adminDatabaseStats",
  "maintenanceThrottle", "adminAuditLog",
] as const;
type ConvexTable = typeof tables[number];
type Document = Record<string, unknown> & { _id: string; _creationTime: number };

const exportPage = makeFunctionReference<
  "query",
  {
    ingestionSecret: string;
    table: ConvexTable;
    paginationOpts: { cursor: string | null; numItems: number };
  },
  { page: Document[]; continueCursor: string; isDone: boolean }
>("migration:exportPage");

const databaseUrl = required("DATABASE_URL");
const convexUrl = required("CONVEX_URL");
const ingestionSecret = required("INGESTION_SECRET");
const pageSize = readPageSize(process.env.MIGRATION_PAGE_SIZE);
const maxRetries = readInteger("MIGRATION_MAX_RETRIES", process.env.MIGRATION_MAX_RETRIES, 8, 0, 20);
const retryBaseDelayMs = readInteger(
  "MIGRATION_RETRY_BASE_MS",
  process.env.MIGRATION_RETRY_BASE_MS,
  1_000,
  100,
  60_000,
);
const database = new PostgresDatabase(databaseUrl);
const convex = new ConvexHttpClient(convexUrl, { skipConvexDeploymentUrlCheck: true });

try {
  await database.migrate();
  let total = 0;
  for (const table of tables) {
    let cursor: string | null = null;
    let count = 0;
    let tablePageSize = pageSize;
    do {
      const result = await queryExportPage(table, cursor, tablePageSize);
      tablePageSize = result.pageSize;
      await importPage(database, table, result.page);
      count += result.page.length;
      total += result.page.length;
      cursor = result.isDone ? null : result.continueCursor;
      process.stdout.write(`\r${table}: ${count} documents`);
      if (result.isDone) break;
    } while (cursor !== null);
    process.stdout.write("\n");
  }
  console.log(`Migration complete: ${total} Convex documents upserted into PostgreSQL.`);
} finally {
  await database.close();
}

async function queryExportPage(table: ConvexTable, cursor: string | null, initialPageSize: number) {
  let retry = 0;
  let requestedPageSize = initialPageSize;
  while (true) {
    try {
      const result = await convex.query(exportPage as FunctionReference<"query">, {
        ingestionSecret,
        table,
        paginationOpts: { cursor, numItems: requestedPageSize },
      }) as { page: Document[]; continueCursor: string; isDone: boolean };
      return { ...result, pageSize: requestedPageSize };
    } catch (error) {
      if (isQueryTimeout(error) && requestedPageSize > 1) {
        const reducedPageSize = Math.max(1, Math.floor(requestedPageSize / 2));
        process.stdout.write(
          `\n${table}: source query timed out; reducing page size from `
          + `${requestedPageSize} to ${reducedPageSize}\n`,
        );
        requestedPageSize = reducedPageSize;
        await wait(retryBaseDelayMs);
        continue;
      }
      if (!isRetryableSourceError(error) || retry >= maxRetries) throw error;

      retry += 1;
      const delayMs = Math.min(retryBaseDelayMs * (2 ** (retry - 1)), 30_000);
      process.stdout.write(
        `\n${table}: source temporarily unavailable (${describeSourceError(error)}); `
        + `retrying in ${formatDelay(delayMs)} (${retry}/${maxRetries})\n`,
      );
      await wait(delayMs);
    }
  }
}

async function importPage(database: PostgresDatabase, table: ConvexTable, documents: Document[]) {
  if (documents.length === 0) return;
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    for (const document of documents) await upsertDocument(client, table, document);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function upsertDocument(client: PoolClient, sourceTable: ConvexTable, document: Document) {
  const mapped = mapDocument(sourceTable, document);
  const columns = Object.keys(mapped.values);
  const parameters = columns.map((_, index) => `$${index + 1}`);
  const updates = columns.filter((column) => column !== "id")
    .map((column) => `${column} = EXCLUDED.${column}`);
  await client.query(`
    INSERT INTO ${mapped.table} (${columns.join(", ")})
    VALUES (${parameters.join(", ")})
    ON CONFLICT (id) DO UPDATE SET ${updates.join(", ")}
  `, columns.map((column) => mapped.values[column]));
}

function mapDocument(sourceTable: ConvexTable, d: Document) {
  const base = { id: d._id, convex_creation_time: d._creationTime };
  switch (sourceTable) {
    case "platforms": return mapped("platforms", base, d, {
      name: "name", slug: "slug", enabled: "enabled", created_at: "createdAt",
    });
    case "channels": return mapped("channels", base, d, {
      platform: "platform", external_channel_id: "externalChannelId", username: "username",
      display_name: "displayName", logging_enabled: "loggingEnabled",
      connection_status: "connectionStatus", connection_error: "connectionError",
      hidden_at: "hiddenAt", last_connected_at: "lastConnectedAt",
      last_message_at: "lastMessageAt", created_at: "createdAt", updated_at: "updatedAt",
    });
    case "chatTabs": return mapped("chat_tabs", base, d, {
      client_id: "clientId", name: "name", layout: "layout", match: "match",
      rules: json("rules"), revision: "revision", indexed_revision: "indexedRevision",
      index_status: "indexStatus", created_at: "createdAt", updated_at: "updatedAt",
    });
    case "chatMessages": {
      const imageUrls = Array.isArray(d.imageUrls)
        ? d.imageUrls
        : extractImageUrls(String(d.messageText ?? ""));
      const message = {
        ...d,
        hasImages: d.hasImages ?? imageUrls.length > 0,
        imageUrls,
        imageIndexVersion: d.imageIndexVersion ?? IMAGE_INDEX_VERSION,
        galleryChannelId: (d.hasImages ?? imageUrls.length > 0) ? d.channelId : undefined,
      };
      return mapped("chat_messages", base, message, {
        channel_id: "channelId", platform: "platform", external_message_id: "externalMessageId",
        event_notification_id: "eventNotificationId", external_channel_id: "externalChannelId",
        channel_name: "channelName", sender_id: "senderId", sender_username: "senderUsername",
        sender_display_name: "senderDisplayName", message_text: "messageText",
        has_images: "hasImages", image_urls: json("imageUrls"),
        image_index_version: "imageIndexVersion", gallery_channel_id: "galleryChannelId",
        timestamp: "timestamp", badges: json("badges"), user_color: "userColor",
        is_broadcaster: "isBroadcaster", is_moderator: "isModerator",
        is_subscriber: "isSubscriber", is_vip: "isVip", message_type: "messageType",
        metadata: json("metadata"), raw_message_data: json("rawMessageData"), created_at: "createdAt",
      });
    }
    case "chatTabMatches": return mapped("chat_tab_matches", base, d, {
      tab_id: "tabId", revision: "revision", message_id: "messageId",
      channel_id: "channelId", timestamp: "timestamp", has_images: "hasImages",
    });
    case "adminSettings": return mapped("admin_settings", base, d, {
      key: "key", password_hash: "passwordHash", password_salt: "passwordSalt",
      password_cost: "passwordCost", totp_secret_encrypted: "totpSecretEncrypted",
      totp_enabled: "totpEnabled", auth_revision: "authRevision",
      created_at: "createdAt", updated_at: "updatedAt",
    });
    case "adminJobs": return mapped("admin_jobs", base, d, {
      kind: "kind", status: "status", title: "title", detail: "detail", current: "current",
      total: "total", unit: "unit", cursor: "cursor", metadata: json("metadata"), error: "error",
      requested_by: "requestedBy", created_at: "createdAt", started_at: "startedAt",
      updated_at: "updatedAt", finished_at: "finishedAt",
    });
    case "adminMetrics": return mapped("admin_metrics", base, d, {
      key: "key", function_calls: "functionCalls", error_count: "errorCount",
      total_execution_ms: "totalExecutionMs", cache_hits: "cacheHits",
      cache_misses: "cacheMisses", updated_at: "updatedAt",
    });
    case "adminDatabaseStats": return mapped("admin_database_stats", base, d, {
      key: "key", generated_at: "generatedAt", document_count: "documentCount",
      document_bytes: "documentBytes", tables: json("tables"), scope: "scope",
    });
    case "maintenanceThrottle": return mapped("maintenance_throttle", base, d, {
      key: "key", next_batch_at: "nextBatchAt", updated_at: "updatedAt",
    });
    case "adminAuditLog": return mapped("admin_audit_log", base, d, {
      event: "event", detail: "detail", actor: "actor", created_at: "createdAt",
    });
  }
}

type FieldMapping = Record<string, string | { json: string }>;
function mapped(
  table: string,
  base: Record<string, unknown>,
  document: Document,
  fields: FieldMapping,
) {
  const values: Record<string, unknown> = { ...base };
  for (const [column, source] of Object.entries(fields)) {
    const value = document[typeof source === "string" ? source : source.json];
    values[column] = typeof source === "string"
      ? value ?? null
      : value === undefined ? null : JSON.stringify(value);
  }
  return { table, values };
}

function json(source: string) {
  return { json: source };
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readPageSize(value?: string) {
  const parsed = Number.parseInt(value ?? "250", 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error("MIGRATION_PAGE_SIZE must be between 1 and 500");
  }
  return parsed;
}

function readInteger(name: string, value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function isRetryableSourceError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /404 page not found|function execution timed out|\b(?:429|500|502|503|504)\b|bad gateway|service unavailable|gateway timeout|fetch failed|econnreset|etimedout|socket hang up/i
    .test(message);
}

function isQueryTimeout(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /function execution timed out/i.test(message);
}

function describeSourceError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (isQueryTimeout(error)) return "source query timed out";
  if (/404 page not found/i.test(message)) return "HTTP 404 while source restarts";
  if (/\b502\b|bad gateway/i.test(message)) return "HTTP 502 Bad Gateway";
  if (/\b503\b|service unavailable/i.test(message)) return "HTTP 503 Service Unavailable";
  if (/\b504\b|gateway timeout/i.test(message)) return "HTTP 504 Gateway Timeout";
  if (/\b429\b/.test(message)) return "HTTP 429 Too Many Requests";
  if (/\b500\b/.test(message)) return "HTTP 500 Internal Server Error";
  if (/econnreset|socket hang up/i.test(message)) return "connection reset";
  if (/etimedout/i.test(message)) return "connection timed out";
  return "network request failed";
}

function formatDelay(delayMs: number) {
  return delayMs < 1_000 ? `${delayMs}ms` : `${delayMs / 1_000}s`;
}

function wait(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
