import { anyApi } from "convex/server";
import { ConvexError, getDocumentSize, type Value, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./functions";
import { requireIngestionSecret } from "./lib/ingestionAuth";
import { extractImageUrls } from "../shared/imageUrls";
import { ensureTabMatch, indexMessageForTabs, tabAsMessageFilter } from "./chatTabs";
import { matchesMessageFilter } from "../shared/messageFilters";

const SETTINGS_KEY = "super-admin";
const METRICS_KEY = "global";
const STATS_KEY = "latest";
const BATCH_SIZE = 100;

const jobKindValidator = v.union(
  v.literal("image_reindex"),
  v.literal("view_reindex"),
  v.literal("integrity_scan"),
  v.literal("database_measurement"),
);

type JobKind = "image_reindex" | "view_reindex" | "integrity_scan" | "database_measurement";

const jobDefinitions: Record<JobKind, { title: string; detail: string; unit: string }> = {
  image_reindex: {
    title: "Re-index image links",
    detail: "Rebuilds extracted image metadata and gallery membership for every message.",
    unit: "messages",
  },
  view_reindex: {
    title: "Rebuild saved views",
    detail: "Recomputes the persistent match index for every saved chat and gallery view.",
    unit: "checks",
  },
  integrity_scan: {
    title: "Run integrity scan",
    detail: "Checks message references and ingestion identifiers without modifying source data.",
    unit: "messages",
  },
  database_measurement: {
    title: "Measure database",
    detail: "Measures document counts and payload sizes across every application table.",
    unit: "tables",
  },
};

const measuredTables = [
  "platforms",
  "channels",
  "chatTabs",
  "chatMessages",
  "chatTabMatches",
  "adminJobs",
  "adminAuditLog",
] as const;

export const authState = query({
  args: { ingestionSecret: v.string() },
  handler: async (ctx, args) => {
    requireIngestionSecret(args.ingestionSecret);
    const settings = await ctx.db
      .query("adminSettings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .unique();
    return settings
      ? {
          configured: true as const,
          passwordHash: settings.passwordHash,
          passwordSalt: settings.passwordSalt,
          passwordCost: settings.passwordCost,
          totpEnabled: settings.totpEnabled,
          totpSecretEncrypted: settings.totpSecretEncrypted,
          authRevision: settings.authRevision,
        }
      : { configured: false as const, totpEnabled: false, authRevision: 0 };
  },
});

export const initializeAuth = mutation({
  args: {
    ingestionSecret: v.string(),
    passwordHash: v.string(),
    passwordSalt: v.string(),
    passwordCost: v.number(),
  },
  handler: async (ctx, args) => {
    requireIngestionSecret(args.ingestionSecret);
    const existing = await ctx.db
      .query("adminSettings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .unique();
    if (existing) throw new ConvexError("The super admin is already configured");
    const now = Date.now();
    await ctx.db.insert("adminSettings", {
      key: SETTINGS_KEY,
      passwordHash: args.passwordHash,
      passwordSalt: args.passwordSalt,
      passwordCost: args.passwordCost,
      totpEnabled: false,
      authRevision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit(ctx, "admin.configured", "Super admin password created", "setup");
    return { authRevision: 1 };
  },
});

export const changePassword = mutation({
  args: {
    ingestionSecret: v.string(),
    passwordHash: v.string(),
    passwordSalt: v.string(),
    passwordCost: v.number(),
  },
  handler: async (ctx, args) => {
    requireIngestionSecret(args.ingestionSecret);
    const settings = await requireSettings(ctx);
    const authRevision = settings.authRevision + 1;
    await ctx.db.patch(settings._id, {
      passwordHash: args.passwordHash,
      passwordSalt: args.passwordSalt,
      passwordCost: args.passwordCost,
      authRevision,
      updatedAt: Date.now(),
    });
    await writeAudit(ctx, "admin.password_changed", "Super admin password changed", "super-admin");
    return { authRevision };
  },
});

export const enableTotp = mutation({
  args: { ingestionSecret: v.string(), encryptedSecret: v.string() },
  handler: async (ctx, args) => {
    requireIngestionSecret(args.ingestionSecret);
    const settings = await requireSettings(ctx);
    const authRevision = settings.authRevision + 1;
    await ctx.db.patch(settings._id, {
      totpSecretEncrypted: args.encryptedSecret,
      totpEnabled: true,
      authRevision,
      updatedAt: Date.now(),
    });
    await writeAudit(ctx, "admin.totp_enabled", "Authenticator sign-in enabled", "super-admin");
    return { authRevision };
  },
});

export const dashboard = query({
  args: { ingestionSecret: v.string() },
  handler: async (ctx, args) => {
    requireIngestionSecret(args.ingestionSecret);
    const [settings, jobs, metrics, databaseStats, channels, latestMessage, auditLog] =
      await Promise.all([
        ctx.db.query("adminSettings").withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY)).unique(),
        ctx.db.query("adminJobs").withIndex("by_created_at").order("desc").take(30),
        ctx.db.query("adminMetrics").withIndex("by_key", (q) => q.eq("key", METRICS_KEY)).unique(),
        ctx.db.query("adminDatabaseStats").withIndex("by_key", (q) => q.eq("key", STATS_KEY)).unique(),
        ctx.db.query("channels").collect(),
        ctx.db.query("chatMessages").withIndex("by_timestamp").order("desc").first(),
        ctx.db.query("adminAuditLog").withIndex("by_created_at").order("desc").take(12),
      ]);
    const activeChannels = channels.filter((channel) => channel.hiddenAt === undefined);
    return {
      generatedAt: Date.now(),
      auth: { totpEnabled: settings?.totpEnabled ?? false, authRevision: settings?.authRevision ?? 0 },
      jobs,
      metrics: metrics ?? {
        functionCalls: 0,
        errorCount: 0,
        totalExecutionMs: 0,
        cacheHits: 0,
        cacheMisses: 0,
        updatedAt: Date.now(),
      },
      databaseStats,
      channels: {
        total: activeChannels.length,
        logging: activeChannels.filter((channel) => channel.loggingEnabled).length,
        connected: activeChannels.filter((channel) => channel.connectionStatus === "connected").length,
        problems: activeChannels.filter((channel) =>
          channel.loggingEnabled && channel.connectionStatus !== "connected").length,
      },
      latestMessageAt: latestMessage?.timestamp,
      auditLog,
    };
  },
});

export const recordMetric = mutation({
  args: {
    ingestionSecret: v.string(),
    durationMs: v.number(),
    failed: v.boolean(),
    cache: v.optional(v.union(v.literal("hit"), v.literal("miss"))),
  },
  handler: async (ctx, args) => {
    requireIngestionSecret(args.ingestionSecret);
    const existing = await ctx.db
      .query("adminMetrics")
      .withIndex("by_key", (q) => q.eq("key", METRICS_KEY))
      .unique();
    const next = {
      key: METRICS_KEY,
      functionCalls: (existing?.functionCalls ?? 0) + 1,
      errorCount: (existing?.errorCount ?? 0) + (args.failed ? 1 : 0),
      totalExecutionMs: (existing?.totalExecutionMs ?? 0) + Math.max(0, args.durationMs),
      cacheHits: (existing?.cacheHits ?? 0) + (args.cache === "hit" ? 1 : 0),
      cacheMisses: (existing?.cacheMisses ?? 0) + (args.cache === "miss" ? 1 : 0),
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.replace(existing._id, next);
    else await ctx.db.insert("adminMetrics", next);
    return null;
  },
});

export const startJob = mutation({
  args: { ingestionSecret: v.string(), kind: jobKindValidator, requestedBy: v.string() },
  handler: async (ctx, args) => {
    requireIngestionSecret(args.ingestionSecret);
    const active = await ctx.db
      .query("adminJobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();
    const [queued, cancelling] = await Promise.all([
      ctx.db.query("adminJobs").withIndex("by_status", (q) => q.eq("status", "queued")).collect(),
      ctx.db.query("adminJobs").withIndex("by_status", (q) => q.eq("status", "cancelling")).collect(),
    ]);
    if ([...active, ...queued, ...cancelling].some((job) => job.kind === args.kind)) {
      throw new ConvexError("This operation is already active");
    }

    const definition = jobDefinitions[args.kind];
    const now = Date.now();
    const metadata = await initialJobMetadata(ctx, args.kind);
    const id = await ctx.db.insert("adminJobs", {
      kind: args.kind,
      status: "queued",
      title: definition.title,
      detail: definition.detail,
      current: 0,
      total: metadata.total,
      unit: definition.unit,
      cursor: null,
      metadata: metadata.value,
      requestedBy: args.requestedBy,
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit(ctx, "job.started", definition.title, args.requestedBy);
    await ctx.scheduler.runAfter(0, anyApi.admin.runJobBatch, { jobId: id });
    return id;
  },
});

export const cancelJob = mutation({
  args: { ingestionSecret: v.string(), jobId: v.id("adminJobs"), requestedBy: v.string() },
  handler: async (ctx, args) => {
    requireIngestionSecret(args.ingestionSecret);
    const job = await ctx.db.get(args.jobId);
    if (!job || !["queued", "running"].includes(job.status)) return null;
    await ctx.db.patch(job._id, { status: "cancelling", updatedAt: Date.now() });
    await writeAudit(ctx, "job.cancel_requested", job.title, args.requestedBy);
    return null;
  },
});

export const runJobBatch = internalMutation({
  args: { jobId: v.id("adminJobs") },
  handler: async (ctx, args) => {
    const started = Date.now();
    const job = await ctx.db.get(args.jobId);
    if (!job || ["completed", "cancelled", "failed"].includes(job.status)) return null;
    if (job.status === "cancelling") {
      await cancelRunningJob(ctx, job);
      await recordJobMetric(ctx, Date.now() - started, false);
      return null;
    }
    if (job.status === "queued") {
      await ctx.db.patch(job._id, { status: "running", startedAt: Date.now(), updatedAt: Date.now() });
    }
    try {
      const complete = job.kind === "image_reindex"
        ? await runImageBatch(ctx, job)
        : job.kind === "view_reindex"
          ? await runViewBatch(ctx, job)
          : job.kind === "integrity_scan"
            ? await runIntegrityBatch(ctx, job)
            : await runMeasurementBatch(ctx, job);
      if (!complete) await ctx.scheduler.runAfter(0, anyApi.admin.runJobBatch, { jobId: job._id });
      await recordJobMetric(ctx, Date.now() - started, false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unknown maintenance error";
      await ctx.db.patch(job._id, {
        status: "failed",
        error: message.slice(0, 500),
        updatedAt: Date.now(),
        finishedAt: Date.now(),
      });
      await writeAudit(ctx, "job.failed", `${job.title}: ${message}`, "system");
      await recordJobMetric(ctx, Date.now() - started, true);
    }
    return null;
  },
});

async function runImageBatch(ctx: MutationCtx, job: Doc<"adminJobs">) {
  const metadata = job.metadata as { stage?: "count" | "work"; count?: number } | undefined;
  if (metadata?.stage === "count") {
    return runMessageCountBatch(ctx, job, metadata.count ?? 0, async (count) => {
      await ctx.db.patch(job._id, {
        current: 0,
        total: count,
        cursor: null,
        metadata: { stage: "work" },
        detail: `Indexing ${count} saved messages`,
        updatedAt: Date.now(),
      });
    });
  }
  const page = await ctx.db.query("chatMessages").withIndex("by_timestamp").order("asc").paginate({
    cursor: job.cursor ?? null,
    numItems: BATCH_SIZE,
  });
  for (const message of page.page) {
    const imageUrls = extractImageUrls(message.messageText);
    const patched = {
      ...message,
      hasImages: imageUrls.length > 0,
      imageUrls,
      imageIndexVersion: 2,
      galleryChannelId: imageUrls.length > 0 ? message.channelId : undefined,
    };
    await ctx.db.patch(message._id, {
      hasImages: patched.hasImages,
      imageUrls,
      imageIndexVersion: 2,
      galleryChannelId: patched.galleryChannelId,
    });
    await indexMessageForTabs(ctx, patched);
  }
  return updatePageProgress(ctx, job, page.page.length, page.continueCursor, page.isDone);
}

async function runViewBatch(ctx: MutationCtx, job: Doc<"adminJobs">) {
  const metadata = job.metadata as {
    stage: "count" | "work";
    count?: number;
    tabIds: string[];
    tabIndex: number;
  };
  if (metadata.stage === "count") {
    return runMessageCountBatch(ctx, job, metadata.count ?? 0, async (count) => {
      for (const value of metadata.tabIds) {
        const tab = await ctx.db.get(value as Id<"chatTabs">);
        if (tab) {
          await ctx.db.patch(tab._id, {
            revision: tab.revision + 1,
            indexStatus: "building",
            updatedAt: Date.now(),
          });
        }
      }
      await ctx.db.patch(job._id, {
        current: 0,
        total: count * metadata.tabIds.length,
        cursor: null,
        metadata: { stage: "work", tabIds: metadata.tabIds, tabIndex: 0 },
        detail: `Rebuilding ${metadata.tabIds.length} saved view indexes`,
        updatedAt: Date.now(),
      });
    });
  }
  const tabId = metadata.tabIds[metadata.tabIndex] as Id<"chatTabs"> | undefined;
  if (!tabId) return completeJob(ctx, job, "All saved view indexes are current");
  const tab = await ctx.db.get(tabId);
  if (!tab) {
    await ctx.db.patch(job._id, {
      metadata: { ...metadata, tabIndex: metadata.tabIndex + 1 },
      cursor: null,
      updatedAt: Date.now(),
    });
    return false;
  }
  const page = await ctx.db.query("chatMessages").withIndex("by_timestamp").order("asc").paginate({
    cursor: job.cursor ?? null,
    numItems: BATCH_SIZE,
  });
  const filter = tabAsMessageFilter(tab);
  for (const message of page.page) {
    if (matchesMessageFilter(message, filter)) await ensureTabMatch(ctx, tab, message);
  }
  const nextCurrent = job.current + page.page.length;
  if (!page.isDone) {
    await ctx.db.patch(job._id, { current: nextCurrent, cursor: page.continueCursor, updatedAt: Date.now() });
    return false;
  }
  await ctx.db.patch(tab._id, {
    indexedRevision: tab.revision,
    indexStatus: "ready",
    updatedAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, anyApi.chatTabs.cleanupIndexBatch, {
    tabId: tab._id,
    keepRevision: tab.revision,
  });
  await ctx.db.patch(job._id, {
    current: nextCurrent,
    cursor: null,
    metadata: { ...metadata, tabIndex: metadata.tabIndex + 1 },
    updatedAt: Date.now(),
  });
  return metadata.tabIndex + 1 >= metadata.tabIds.length
    ? completeJob(ctx, { ...job, current: nextCurrent } as Doc<"adminJobs">, "All saved view indexes are current")
    : false;
}

async function runIntegrityBatch(ctx: MutationCtx, job: Doc<"adminJobs">) {
  const metadata = (job.metadata ?? { stage: "count", count: 0 }) as {
    stage: "count" | "work";
    count?: number;
    issues: number;
    samples: string[];
  };
  if (metadata.stage === "count") {
    return runMessageCountBatch(ctx, job, metadata.count ?? 0, async (count) => {
      await ctx.db.patch(job._id, {
        current: 0,
        total: count,
        cursor: null,
        metadata: { stage: "work", issues: 0, samples: [] },
        detail: `Checking ${count} saved messages`,
        updatedAt: Date.now(),
      });
    });
  }
  const page = await ctx.db.query("chatMessages").withIndex("by_timestamp").order("asc").paginate({
    cursor: job.cursor ?? null,
    numItems: BATCH_SIZE,
  });
  let issues = metadata.issues;
  const samples = [...metadata.samples];
  for (const message of page.page) {
    const channel = await ctx.db.get(message.channelId);
    if (!channel) {
      issues += 1;
      if (samples.length < 10) samples.push(`Missing channel for ${message.externalMessageId}`);
    }
  }
  await ctx.db.patch(job._id, { metadata: { issues, samples } });
  return updatePageProgress(
    ctx,
    job,
    page.page.length,
    page.continueCursor,
    page.isDone,
    page.isDone ? `Integrity scan complete · ${issues} ${issues === 1 ? "issue" : "issues"}` : undefined,
  );
}

async function runMeasurementBatch(ctx: MutationCtx, job: Doc<"adminJobs">) {
  const metadata = (job.metadata ?? { tableIndex: 0, tables: [] }) as {
    tableIndex: number;
    tables: Array<{ name: string; count: number; bytes: number }>;
    count?: number;
    bytes?: number;
  };
  const table = measuredTables[metadata.tableIndex];
  if (!table) return finalizeMeasurement(ctx, job, metadata.tables);
  const page = await queryMeasuredTable(ctx, table, job.cursor ?? null);
  const count = (metadata.count ?? 0) + page.page.length;
  let bytes = metadata.bytes ?? 0;
  for (const document of page.page) {
    bytes += getDocumentSize(document as Record<string, Value>);
  }
  if (!page.isDone) {
    await ctx.db.patch(job._id, {
      cursor: page.continueCursor,
      metadata: { ...metadata, count, bytes },
      updatedAt: Date.now(),
    });
    return false;
  }
  const tables = [...metadata.tables, { name: table, count, bytes }];
  if (metadata.tableIndex + 1 >= measuredTables.length) return finalizeMeasurement(ctx, job, tables);
  await ctx.db.patch(job._id, {
    current: metadata.tableIndex + 1,
    cursor: null,
    metadata: { tableIndex: metadata.tableIndex + 1, tables },
    updatedAt: Date.now(),
  });
  return false;
}

async function queryMeasuredTable(ctx: MutationCtx, table: typeof measuredTables[number], cursor: string | null) {
  const options = { cursor, numItems: BATCH_SIZE };
  switch (table) {
    case "platforms": return ctx.db.query("platforms").paginate(options);
    case "channels": return ctx.db.query("channels").paginate(options);
    case "chatTabs": return ctx.db.query("chatTabs").paginate(options);
    case "chatMessages": return ctx.db.query("chatMessages").paginate(options);
    case "chatTabMatches": return ctx.db.query("chatTabMatches").paginate(options);
    case "adminJobs": return ctx.db.query("adminJobs").paginate(options);
    case "adminAuditLog": return ctx.db.query("adminAuditLog").paginate(options);
  }
}

async function finalizeMeasurement(
  ctx: MutationCtx,
  job: Doc<"adminJobs">,
  tables: Array<{ name: string; count: number; bytes: number }>,
) {
  const existing = await ctx.db
    .query("adminDatabaseStats")
    .withIndex("by_key", (q) => q.eq("key", STATS_KEY))
    .unique();
  const snapshot = {
    key: STATS_KEY,
    generatedAt: Date.now(),
    documentCount: tables.reduce((sum, table) => sum + table.count, 0),
    documentBytes: tables.reduce((sum, table) => sum + table.bytes, 0),
    tables,
    scope: "Application document payloads; indexes, backups, file storage, and Convex platform overhead are excluded.",
  };
  if (existing) await ctx.db.replace(existing._id, snapshot);
  else await ctx.db.insert("adminDatabaseStats", snapshot);
  return completeJob(ctx, job, "Database measurement saved");
}

async function updatePageProgress(
  ctx: MutationCtx,
  job: Doc<"adminJobs">,
  increment: number,
  cursor: string,
  done: boolean,
  detail?: string,
) {
  const current = job.current + increment;
  if (done) return completeJob(ctx, { ...job, current } as Doc<"adminJobs">, detail);
  await ctx.db.patch(job._id, { current, cursor, updatedAt: Date.now() });
  return false;
}

async function runMessageCountBatch(
  ctx: MutationCtx,
  job: Doc<"adminJobs">,
  previousCount: number,
  onComplete: (count: number) => Promise<void>,
) {
  const page = await ctx.db.query("chatMessages").withIndex("by_timestamp").order("asc").paginate({
    cursor: job.cursor ?? null,
    numItems: BATCH_SIZE,
  });
  const count = previousCount + page.page.length;
  if (page.isDone) {
    await onComplete(count);
    return false;
  }
  await ctx.db.patch(job._id, {
    current: count,
    cursor: page.continueCursor,
    metadata: { ...(job.metadata as Record<string, unknown>), count },
    detail: `Counting source records · ${count} found`,
    updatedAt: Date.now(),
  });
  return false;
}

async function completeJob(ctx: MutationCtx, job: Doc<"adminJobs">, detail?: string) {
  await ctx.db.patch(job._id, {
    status: "completed",
    current: job.total ?? job.current,
    ...(detail ? { detail } : {}),
    cursor: null,
    updatedAt: Date.now(),
    finishedAt: Date.now(),
  });
  await writeAudit(ctx, "job.completed", job.title, "system");
  return true;
}

async function cancelRunningJob(ctx: MutationCtx, job: Doc<"adminJobs">) {
  if (job.kind === "view_reindex") {
    const metadata = job.metadata as { tabIds?: string[] } | undefined;
    for (const value of metadata?.tabIds ?? []) {
      const tab = await ctx.db.get(value as Id<"chatTabs">);
      if (tab && tab.indexedRevision !== undefined) {
        await ctx.db.patch(tab._id, { indexStatus: "ready", updatedAt: Date.now() });
      }
    }
  }
  await ctx.db.patch(job._id, {
    status: "cancelled",
    detail: `${job.title} was stopped before completion`,
    updatedAt: Date.now(),
    finishedAt: Date.now(),
  });
  await writeAudit(ctx, "job.cancelled", job.title, "system");
}

async function initialJobMetadata(ctx: MutationCtx, kind: JobKind) {
  if (kind === "view_reindex") {
    const tabs = await ctx.db.query("chatTabs").take(21);
    return {
      total: undefined,
      value: { stage: "count", count: 0, tabIds: tabs.map((tab) => tab._id), tabIndex: 0 },
    };
  }
  if (kind === "database_measurement") {
    return { total: measuredTables.length, value: { tableIndex: 0, tables: [] } };
  }
  return {
    total: undefined,
    value: kind === "integrity_scan"
      ? { stage: "count", count: 0, issues: 0, samples: [] }
      : { stage: "count", count: 0 },
  };
}

async function requireSettings(ctx: MutationCtx) {
  const settings = await ctx.db
    .query("adminSettings")
    .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
    .unique();
  if (!settings) throw new ConvexError("The super admin is not configured");
  return settings;
}

async function writeAudit(ctx: MutationCtx, event: string, detail: string, actor: string) {
  await ctx.db.insert("adminAuditLog", { event, detail: detail.slice(0, 500), actor, createdAt: Date.now() });
}

async function recordJobMetric(ctx: MutationCtx, durationMs: number, failed: boolean) {
  const existing = await ctx.db
    .query("adminMetrics")
    .withIndex("by_key", (q) => q.eq("key", METRICS_KEY))
    .unique();
  const value = {
    key: METRICS_KEY,
    functionCalls: (existing?.functionCalls ?? 0) + 1,
    errorCount: (existing?.errorCount ?? 0) + (failed ? 1 : 0),
    totalExecutionMs: (existing?.totalExecutionMs ?? 0) + durationMs,
    cacheHits: existing?.cacheHits ?? 0,
    cacheMisses: existing?.cacheMisses ?? 0,
    updatedAt: Date.now(),
  };
  if (existing) await ctx.db.replace(existing._id, value);
  else await ctx.db.insert("adminMetrics", value);
}
