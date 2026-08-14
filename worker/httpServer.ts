import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import type { LoadedConfiguration } from "./config";
import type { PostgresDatabase } from "./database";
import type { Logger } from "./logger";
import type { ThirdPartyEmoteService } from "./emotes/ThirdPartyEmoteService";
import type { TwitchBadgeService } from "./twitch/TwitchBadgeService";
import type { TwitchAuthService } from "./twitch/TwitchAuthService";
import type {
  ChatTabInput,
  HiddenImageInput,
  MessagePageArgs,
  MessageSuggestionArgs,
  PostgresStore,
} from "./PostgresStore";
import {
  AdminAuthError,
  AdminService,
  type StartableAdminJobKind,
  type FeedbackListOptions,
} from "./AdminService";
import { isImgurPost, isTouhouWikiImage } from "../shared/imageUrls";
import { resolveImgurImageUrl } from "./imgurImage";
import {
  fetchTouhouWikiImage,
  type ProxiedImage,
} from "./touhouWikiImage";
import { FeedbackRequestError, FeedbackService } from "./FeedbackService";
import { ShareRequestError, ShareService } from "./ShareService";

export interface ApplicationRuntimeState {
  auth?: TwitchAuthService;
  badges?: TwitchBadgeService;
  emotes?: ThirdPartyEmoteService;
  integrationError?: string;
  store?: PostgresStore;
  database?: PostgresDatabase;
}

export interface HttpServerDependencies {
  fetchTouhouWikiImage?: (url: URL) => Promise<ProxiedImage>;
  resolveImgurImageUrl?: (url: URL) => Promise<URL>;
  createAdminService?: (
    database: PostgresDatabase,
    setupSecret: string,
    encryptionKey: Buffer,
  ) => AdminService;
  createFeedbackService?: (
    database: PostgresDatabase,
    rateLimitMinutes: number,
    ipHashSecret: string,
  ) => Pick<FeedbackService, "submit" | "status">;
  createShareService?: (database: PostgresDatabase) => Pick<
    ShareService,
    "availability" | "create" | "resolve"
  >;
}

export function createHttpServer(
  configuration: LoadedConfiguration,
  runtime: ApplicationRuntimeState,
  logger: Logger,
  dependencies: HttpServerDependencies = {},
): Promise<Server> {
  const app = express();
  if (configuration.trustedProxyHops > 0) {
    app.set("trust proxy", configuration.trustedProxyHops);
  }
  const frontendOrigin = normalizeOrigin(configuration.frontendUrl);
  const trustedWriteOrigins = new Set([
    frontendOrigin,
    normalizeOrigin(configuration.publicWorkerUrl),
  ].filter((origin): origin is string => Boolean(origin)));
  const admin = configuration.adminOptions && runtime.database
    ? (dependencies.createAdminService ?? ((database, setupSecret, encryptionKey) =>
        new AdminService(database, setupSecret, encryptionKey)))(
        runtime.database,
        configuration.adminOptions.setupSecret,
        configuration.adminOptions.encryptionKey,
      )
    : undefined;
  const feedback = configuration.feedbackOptions && runtime.database
    ? (dependencies.createFeedbackService ?? ((database, rateLimitMinutes, ipHashSecret) =>
        new FeedbackService(database, rateLimitMinutes, ipHashSecret)))(
        runtime.database,
        configuration.feedbackOptions.rateLimitMinutes,
        configuration.feedbackOptions.ipHashSecret,
      )
    : undefined;
  const shares = runtime.database
    ? (dependencies.createShareService ?? ((database) => new ShareService(database)))(
        runtime.database,
      )
    : undefined;
  const failedAdminAttempts = new Map<string, { count: number; resetsAt: number }>();
  app.disable("x-powered-by");
  app.use(cors({
    origin: frontendOrigin ?? configuration.frontendUrl,
    methods: ["GET", "POST"],
    credentials: true,
  }));
  app.use(express.json({ limit: "256kb" }));
  if (admin) {
    app.use((request, response, next) => {
      const startedAt = performance.now();
      response.once("finish", () => {
        const cacheHeader = response.getHeader("X-Cache");
        const cache = cacheHeader === "HIT" ? "hit" : cacheHeader === "MISS" ? "miss" : undefined;
        void admin.recordMetric(performance.now() - startedAt, response.statusCode >= 400, cache)
          .catch((error) => logger.debug({ err: error }, "Could not persist request metric"));
      });
      next();
    });
  }

  app.use("/api/admin", (request, response, next) => {
    response.set("Cache-Control", "no-store");
    if (request.method === "POST") {
      const origin = request.get("origin");
      if (origin && !trustedWriteOrigins.has(origin)) {
        response.status(403).json({ error: "This admin request came from an untrusted origin" });
        return;
      }
    }
    next();
  });

  const requireAdminSession: express.RequestHandler = async (request, response, next) => {
    response.set("Cache-Control", "no-store");
    const origin = request.get("origin");
    if (origin && !trustedWriteOrigins.has(origin)) {
      response.status(403).json({ error: "This admin request came from an untrusted origin" });
      return;
    }
    if (!admin) {
      sendAdminUnavailable(response);
      return;
    }
    try {
      await admin.requireSession(readAdminCookie(request.headers.cookie));
      next();
    } catch (error) {
      sendAdminError(response, error, logger);
    }
  };

  app.get("/api/admin/auth/status", async (request, response) => {
    if (!admin) {
      response.status(503).json({
        configured: false,
        authenticated: false,
        totpEnabled: false,
        error: "Admin storage is unavailable until PostgreSQL, INGESTION_SECRET, and the encryption key are configured",
      });
      return;
    }
    try {
      response.json(await admin.status(readAdminCookie(request.headers.cookie)));
    } catch (error) {
      sendAdminError(response, error, logger);
    }
  });

  app.post("/api/admin/auth/setup", async (request, response) => {
    if (!admin) return sendAdminUnavailable(response);
    if (!allowAdminAttempt(failedAdminAttempts, request.ip)) {
      response.status(429).json({ error: "Too many attempts; wait fifteen minutes and try again" });
      return;
    }
    try {
      const password = typeof request.body?.password === "string" ? request.body.password : "";
      const setupKey = typeof request.body?.setupKey === "string" ? request.body.setupKey : "";
      const session = await admin.setup(password, setupKey);
      clearAdminAttempts(failedAdminAttempts, request.ip);
      setAdminCookie(response, session, configuration);
      response.status(201).json({ authenticated: true });
    } catch (error) {
      registerAdminFailure(failedAdminAttempts, request.ip);
      sendAdminError(response, error, logger);
    }
  });

  app.post("/api/admin/auth/login", async (request, response) => {
    if (!admin) return sendAdminUnavailable(response);
    if (!allowAdminAttempt(failedAdminAttempts, request.ip)) {
      response.status(429).json({ error: "Too many attempts; wait fifteen minutes and try again" });
      return;
    }
    try {
      const password = typeof request.body?.password === "string" ? request.body.password : undefined;
      const code = typeof request.body?.code === "string" ? request.body.code.replace(/\s/g, "") : undefined;
      const session = password !== undefined
        ? await admin.loginWithPassword(password)
        : await admin.loginWithTotp(code ?? "");
      clearAdminAttempts(failedAdminAttempts, request.ip);
      setAdminCookie(response, session, configuration);
      response.json({ authenticated: true });
    } catch (error) {
      registerAdminFailure(failedAdminAttempts, request.ip);
      sendAdminError(response, error, logger);
    }
  });

  app.post("/api/admin/auth/logout", (_request, response) => {
    response.clearCookie("twitch_admin_session", { path: "/" });
    response.json({ authenticated: false });
  });

  app.post("/api/admin/auth/totp/begin", async (request, response) => {
    if (!admin) return sendAdminUnavailable(response);
    try {
      response.json(await admin.beginTotp(readAdminCookie(request.headers.cookie)));
    } catch (error) {
      sendAdminError(response, error, logger);
    }
  });

  app.post("/api/admin/auth/totp/confirm", async (request, response) => {
    if (!admin) return sendAdminUnavailable(response);
    try {
      const enrollmentToken = typeof request.body?.enrollmentToken === "string"
        ? request.body.enrollmentToken
        : "";
      const code = typeof request.body?.code === "string" ? request.body.code.replace(/\s/g, "") : "";
      const session = await admin.confirmTotp(
        readAdminCookie(request.headers.cookie),
        enrollmentToken,
        code,
      );
      setAdminCookie(response, session, configuration);
      response.json({ enabled: true });
    } catch (error) {
      sendAdminError(response, error, logger);
    }
  });

  app.post("/api/admin/auth/password", async (request, response) => {
    if (!admin) return sendAdminUnavailable(response);
    try {
      const currentPassword = typeof request.body?.currentPassword === "string"
        ? request.body.currentPassword
        : "";
      const newPassword = typeof request.body?.newPassword === "string"
        ? request.body.newPassword
        : "";
      const session = await admin.changePassword(
        readAdminCookie(request.headers.cookie),
        currentPassword,
        newPassword,
      );
      setAdminCookie(response, session, configuration);
      response.json({ changed: true });
    } catch (error) {
      sendAdminError(response, error, logger);
    }
  });

  app.get("/api/admin/dashboard", async (request, response) => {
    if (!admin) return sendAdminUnavailable(response);
    try {
      response.json(await admin.dashboard(readAdminCookie(request.headers.cookie)));
    } catch (error) {
      sendAdminError(response, error, logger);
    }
  });

  app.get("/api/admin/feedback", async (request, response) => {
    if (!admin) return sendAdminUnavailable(response);
    const options: FeedbackListOptions = {
      ...(typeof request.query.kind === "string"
        ? { kind: request.query.kind as FeedbackListOptions["kind"] }
        : {}),
      ...(typeof request.query.status === "string"
        ? { status: request.query.status as FeedbackListOptions["status"] }
        : {}),
      ...(typeof request.query.flag === "string"
        ? { flag: request.query.flag as FeedbackListOptions["flag"] }
        : {}),
      ...(typeof request.query.search === "string" ? { search: request.query.search } : {}),
      page: parseNonNegativeInteger(request.query.page, 0),
      pageSize: parseNonNegativeInteger(request.query.pageSize, 50),
    };
    try {
      response.json(await admin.listFeedback(readAdminCookie(request.headers.cookie), options));
    } catch (error) {
      sendAdminError(response, error, logger);
    }
  });

  app.post("/api/admin/feedback/:reportId", async (request, response) => {
    if (!admin) return sendAdminUnavailable(response);
    try {
      response.json(await admin.classifyFeedback(
        readAdminCookie(request.headers.cookie),
        request.params.reportId,
        request.body?.status,
        request.body?.flags,
      ));
    } catch (error) {
      sendAdminError(response, error, logger);
    }
  });

  app.post("/api/admin/jobs", async (request, response) => {
    if (!admin) return sendAdminUnavailable(response);
    const validKinds = new Set<StartableAdminJobKind>([
      "image_reindex",
      "view_reindex",
      "integrity_scan",
      "database_measurement",
      "archive_reencode",
      "index_reindex",
    ]);
    const kind = request.body?.kind as StartableAdminJobKind;
    if (!validKinds.has(kind)) {
      response.status(400).json({ error: "Unknown maintenance operation" });
      return;
    }
    try {
      const jobId = await admin.startJob(readAdminCookie(request.headers.cookie), kind);
      response.status(202).json({ jobId });
    } catch (error) {
      sendAdminError(response, error, logger);
    }
  });

  app.post("/api/admin/jobs/:jobId/cancel", async (request, response) => {
    if (!admin) return sendAdminUnavailable(response);
    try {
      await admin.cancelJob(readAdminCookie(request.headers.cookie), request.params.jobId);
      response.status(202).json({ cancelling: true });
    } catch (error) {
      sendAdminError(response, error, logger);
    }
  });

  app.get("/api/feedback/status", async (request, response) => {
    response.set("Cache-Control", "no-store");
    if (!feedback) {
      response.status(503).json({ error: "Feedback is temporarily unavailable. Please try again later." });
      return;
    }

    try {
      response.json(await feedback.status(
        request.ip ?? request.socket.remoteAddress ?? "unknown",
      ));
    } catch (error) {
      logger.warn({ err: error }, "Feedback cooldown status failed");
      response.status(500).json({ error: "The feedback cooldown could not be checked." });
    }
  });

  app.post("/api/feedback", async (request, response) => {
    response.set("Cache-Control", "no-store");
    const origin = request.get("origin");
    if (origin && !trustedWriteOrigins.has(origin)) {
      response.status(403).json({ error: "This report came from an untrusted origin" });
      return;
    }
    if (!feedback) {
      response.status(503).json({ error: "Feedback is temporarily unavailable. Please try again later." });
      return;
    }

    try {
      const result = await feedback.submit(
        request.body,
        request.ip ?? request.socket.remoteAddress ?? "unknown",
      );
      response.status(201).json({ submitted: true, ...result });
    } catch (error) {
      if (error instanceof FeedbackRequestError) {
        if (error.retryAfterSeconds) {
          response.set("Retry-After", String(error.retryAfterSeconds));
        }
        response.status(error.status).json({
          error: error.message,
          retryAfterSeconds: error.retryAfterSeconds,
        });
        return;
      }
      logger.warn({ err: error }, "Feedback submission failed");
      response.status(500).json({ error: "Your report could not be sent. Please try again later." });
    }
  });

  app.post("/api/shares/availability", async (request, response) => {
    response.set("Cache-Control", "no-store");
    if (!shares) return sendShareUnavailable(response);
    try {
      response.json(await shares.availability(request.body?.alias));
    } catch (error) {
      sendShareError(response, error, logger);
    }
  });

  app.post("/api/shares", async (request, response) => {
    response.set("Cache-Control", "no-store");
    const origin = request.get("origin");
    if (origin && !trustedWriteOrigins.has(origin)) {
      response.status(403).json({ error: "This share came from an untrusted origin" });
      return;
    }
    if (!shares) return sendShareUnavailable(response);
    try {
      response.status(201).json(await shares.create(request.body));
    } catch (error) {
      sendShareError(response, error, logger);
    }
  });

  app.get("/api/shares/:alias", async (request, response) => {
    response.set("Cache-Control", "no-store");
    if (!shares) return sendShareUnavailable(response);
    try {
      response.json(await shares.resolve(request.params.alias));
    } catch (error) {
      sendShareError(response, error, logger);
    }
  });

  app.get("/api/data/channels", async (_request, response) => {
    await sendData(response, runtime, () => runtime.store!.listChannels(), logger);
  });

  app.post("/api/data/platforms/ensure-seeded", requireAdminSession, async (_request, response) => {
    await sendData(response, runtime, async () => {
      await runtime.store!.ensurePlatformSeeded();
      return null;
    }, logger);
  });

  app.post("/api/data/channels/add", requireAdminSession, async (request, response) => {
    await sendData(response, runtime, () => runtime.store!.addChannel(request.body), logger);
  });

  app.post("/api/data/channels/set-logging", requireAdminSession, async (request, response) => {
    await sendData(response, runtime, async () => {
      await runtime.store!.setLogging(String(request.body?.id ?? ""), Boolean(request.body?.enabled));
      return null;
    }, logger);
  });

  app.post("/api/data/channels/reconnect", requireAdminSession, async (request, response) => {
    await sendData(response, runtime, async () => {
      await runtime.store!.reconnect(String(request.body?.id ?? ""));
      return null;
    }, logger);
  });

  app.post("/api/data/channels/remove", requireAdminSession, async (request, response) => {
    await sendData(response, runtime, async () => {
      await runtime.store!.removeChannel(String(request.body?.id ?? ""));
      return null;
    }, logger);
  });

  app.get("/api/data/chat-tabs", async (_request, response) => {
    await sendData(response, runtime, () => runtime.store!.listChatTabs(), logger);
  });

  app.post("/api/data/chat-tabs/save", requireAdminSession, async (request, response) => {
    await sendData(response, runtime, async () => {
      await runtime.store!.saveChatTab(request.body?.tab as ChatTabInput);
      return null;
    }, logger);
  });

  app.post("/api/data/chat-tabs/import", requireAdminSession, async (request, response) => {
    await sendData(response, runtime, async () => {
      await runtime.store!.importChatTabs((request.body?.tabs ?? []) as ChatTabInput[]);
      return null;
    }, logger);
  });

  app.post("/api/data/chat-tabs/remove", requireAdminSession, async (request, response) => {
    await sendData(response, runtime, async () => {
      await runtime.store!.removeChatTab(String(request.body?.id ?? ""));
      return null;
    }, logger);
  });

  app.post("/api/data/messages/page", async (request, response) => {
    await sendData(response, runtime, () =>
      runtime.store!.pageMessages(request.body as MessagePageArgs, false), logger);
  });

  app.post("/api/data/messages/page-images", async (request, response) => {
    await sendData(response, runtime, () =>
      runtime.store!.pageMessages(request.body as MessagePageArgs, true), logger);
  });

  app.post("/api/data/messages/page-game-scores", async (request, response) => {
    await sendData(response, runtime, () =>
      runtime.store!.pageMessages(request.body as MessagePageArgs, false, true), logger);
  });

  app.post("/api/data/messages/suggestions", async (request, response) => {
    await sendData(response, runtime, () =>
      runtime.store!.suggestMessageFilters(request.body as MessageSuggestionArgs), logger);
  });

  app.post("/api/data/messages/filter-counts", async (request, response) => {
    await sendData(response, runtime, () => runtime.store!.filterMatchCounts(request.body), logger);
  });

  app.post("/api/data/messages/delete", requireAdminSession, async (request, response) => {
    const messageIds = parseMessageIds(request.body?.messageIds);
    if (!messageIds) {
      response.status(400).json({ error: "Choose between 1 and 200 valid messages" });
      return;
    }
    await sendData(response, runtime, async () => ({
      deleted: await runtime.store!.deleteMessages(messageIds),
    }), logger);
  });

  app.post("/api/data/messages/hide-images", requireAdminSession, async (request, response) => {
    const images = parseHiddenImages(request.body?.images);
    if (!images) {
      response.status(400).json({ error: "Choose between 1 and 100 valid images" });
      return;
    }
    await sendData(response, runtime, async () => ({
      hidden: await runtime.store!.hideMessageImages(images),
    }), logger);
  });

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      ready: Boolean(configuration.options) && !runtime.integrationError,
      configured: Boolean(configuration.options),
      configurationIssues: configuration.issues,
      integrationError: runtime.integrationError,
      twitchAuthenticated: runtime.auth?.getStatus().authenticated ?? false,
    });
  });

  app.get("/ready", (_request, response) => {
    const ready = Boolean(configuration.options) && !runtime.integrationError;
    response.status(ready ? 200 : 503).json({
      ready,
      configurationIssues: configuration.issues,
      integrationError: runtime.integrationError,
    });
  });

  app.get("/auth/twitch/status", (_request, response) => {
    const status = runtime.auth?.getStatus();
    response.set("Cache-Control", "no-store").json({
      configured: Boolean(configuration.options),
      authenticated: status?.authenticated ?? false,
      login: status?.login,
      scopes: status?.scopes ?? [],
      reason:
        status?.reason ??
        runtime.integrationError ??
        (configuration.issues.length > 0
          ? `Configuration required: ${configuration.issues.join("; ")}`
          : undefined),
    });
  });

  app.get("/emotes/twitch/:channelId", async (request, response) => {
    if (!/^\d+$/.test(request.params.channelId)) {
      response.status(400).json({ error: "A numeric Twitch channel ID is required" });
      return;
    }
    if (!runtime.emotes) {
      response.status(503).json({ error: "Third-party emotes are unavailable" });
      return;
    }
    const cacheHit = runtime.emotes.hasFreshCatalog(request.params.channelId);
    const emotes = await runtime.emotes.getCatalog(request.params.channelId);
    response.set("X-Cache", cacheHit ? "HIT" : "MISS");
    response.set("Cache-Control", "public, max-age=300").json({ emotes });
  });

  app.get("/badges/twitch/:channelId", async (request, response) => {
    if (!/^\d+$/.test(request.params.channelId)) {
      response.status(400).json({ error: "A numeric Twitch channel ID is required" });
      return;
    }
    if (!runtime.badges) {
      response.status(503).json({ error: "Twitch badges are unavailable" });
      return;
    }
    try {
      const cacheHit = runtime.badges.hasFreshCatalog(request.params.channelId);
      const badges = await runtime.badges.getCatalog(request.params.channelId);
      response.set("X-Cache", cacheHit ? "HIT" : "MISS");
      response.set("Cache-Control", "public, max-age=300").json({ badges });
    } catch (cause) {
      logger.warn(
        { err: cause, channelId: request.params.channelId },
        "Could not serve Twitch chat badges",
      );
      response.status(503).json({ error: "Twitch badges are temporarily unavailable" });
    }
  });

  app.get("/images/touhouwiki", async (request, response) => {
    const rawUrl = typeof request.query.url === "string" ? request.query.url : "";
    let imageUrl: URL;
    try {
      imageUrl = new URL(rawUrl);
    } catch {
      response.status(400).json({ error: "A valid TouhouWiki image URL is required" });
      return;
    }
    if (!isTouhouWikiImage(imageUrl)) {
      response.status(400).json({ error: "Only en.touhouwiki.net image URLs are supported" });
      return;
    }

    try {
      const image = await (dependencies.fetchTouhouWikiImage ?? fetchTouhouWikiImage)(imageUrl);
      response.set("Content-Type", image.contentType);
      response.set("Cache-Control", "public, max-age=86400");
      if (image.etag) response.set("ETag", image.etag);
      if (image.lastModified) response.set("Last-Modified", image.lastModified);
      response.send(image.body);
    } catch (cause) {
      logger.warn({ err: cause, url: imageUrl.href }, "Could not proxy TouhouWiki image");
      response.status(502).json({ error: "TouhouWiki image is temporarily unavailable" });
    }
  });

  app.get("/images/imgur", async (request, response) => {
    const rawUrl = typeof request.query.url === "string" ? request.query.url : "";
    let pageUrl: URL;
    try {
      pageUrl = new URL(rawUrl);
    } catch {
      response.status(400).json({ error: "A valid Imgur page URL is required" });
      return;
    }
    if (!isImgurPost(pageUrl) || pageUrl.protocol !== "https:") {
      response.status(400).json({ error: "Only HTTPS imgur.com post URLs are supported" });
      return;
    }

    try {
      const imageUrl = await (dependencies.resolveImgurImageUrl ?? resolveImgurImageUrl)(pageUrl);
      response
        .set("Cache-Control", "public, max-age=86400")
        .redirect(302, imageUrl.href);
    } catch (cause) {
      logger.warn({ err: cause, url: pageUrl.href }, "Could not resolve Imgur image");
      response.status(502).json({ error: "Imgur image is temporarily unavailable" });
    }
  });

  app.get("/runtime-config.js", (_request, response) => {
    const runtimeConfig = JSON.stringify({
      workerUrl: configuration.publicWorkerUrl,
      configurationIssues: configuration.issues,
    }).replace(/</g, "\\u003c");
    response
      .type("application/javascript")
      .set("Cache-Control", "no-store")
      .send(`window.__TWITCH_LOGS_CONFIG__ = ${runtimeConfig};`);
  });

  app.get("/auth/twitch/start", requireAdminSession, (_request, response) => {
    if (!runtime.auth) {
      response
        .status(503)
        .type("text/plain")
        .send("Twitch integration is not configured. Check /health for missing settings.");
      return;
    }
    response.redirect(runtime.auth.createAuthorizationUrl());
  });

  app.get("/auth/twitch/callback", async (request, response) => {
    if (!runtime.auth) {
      response
        .status(503)
        .type("text/plain")
        .send("Twitch integration is not configured. Check /health for missing settings.");
      return;
    }
    const error = typeof request.query.error === "string" ? request.query.error : undefined;
    const code = typeof request.query.code === "string" ? request.query.code : undefined;
    const state = typeof request.query.state === "string" ? request.query.state : undefined;
    if (error) {
      logger.warn({ error }, "Twitch OAuth authorization was denied");
      response.redirect(`${configuration.frontendUrl}/?twitch=denied`);
      return;
    }
    if (!code || !state) {
      response.status(400).send("Missing Twitch OAuth code or state");
      return;
    }
    try {
      await runtime.auth.exchangeAuthorizationCode(code, state);
      response.redirect(`${configuration.frontendUrl}/?twitch=connected`);
    } catch (cause) {
      logger.error({ err: cause }, "Twitch OAuth callback failed");
      response.redirect(`${configuration.frontendUrl}/?twitch=error`);
    }
  });

  const staticDirectory = resolve(process.cwd(), "dist");
  if (existsSync(staticDirectory)) {
    app.use(
      express.static(staticDirectory, {
        index: false,
        immutable: true,
        maxAge: "1y",
        setHeaders: (response, filePath) => {
          if (filePath.endsWith("index.html")) {
            response.setHeader("Cache-Control", "no-cache");
          }
        },
      }),
    );
    app.use((request, response, next) => {
      if (request.method === "GET" && request.accepts("html")) {
        response.set("Cache-Control", "no-cache").sendFile(resolve(staticDirectory, "index.html"));
        return;
      }
      next();
    });
  }

  return new Promise((resolveServer, reject) => {
    const server = app.listen(configuration.port, "0.0.0.0", () => {
      logger.info(
        {
          port: configuration.port,
          servesFrontend: existsSync(staticDirectory),
          configured: Boolean(configuration.options),
        },
        "Twitch application server listening",
      );
      resolveServer(server);
    });
    server.once("error", reject);
  });
}

async function sendData(
  response: express.Response,
  runtime: ApplicationRuntimeState,
  operation: () => Promise<unknown>,
  logger: Logger,
) {
  if (!runtime.store) {
    response.status(503).json({ error: "PostgreSQL storage is unavailable" });
    return;
  }
  try {
    response.json(await operation());
  } catch (error) {
    logger.warn({ err: error }, "PostgreSQL API request failed");
    response.status(400).json({
      error: error instanceof Error ? error.message : "Database request failed",
    });
  }
}

function readAdminCookie(header?: string) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === "twitch_admin_session") return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function normalizeOrigin(value: string) {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function setAdminCookie(
  response: express.Response,
  token: string,
  configuration: LoadedConfiguration,
) {
  const frontendOrigin = normalizeOrigin(configuration.frontendUrl);
  const workerOrigin = normalizeOrigin(configuration.publicWorkerUrl);
  const crossOriginHttps = Boolean(
    workerOrigin?.startsWith("https://") && frontendOrigin && workerOrigin !== frontendOrigin,
  );
  response.cookie("twitch_admin_session", token, {
    httpOnly: true,
    sameSite: crossOriginHttps ? "none" : "strict",
    secure: crossOriginHttps || configuration.frontendUrl.startsWith("https://"),
    path: "/",
    maxAge: 12 * 60 * 60 * 1_000,
  });
}

function sendAdminUnavailable(response: express.Response) {
  response.status(503).json({ error: "Admin storage is unavailable" });
}

function sendAdminError(response: express.Response, error: unknown, logger: Logger) {
  if (error instanceof AdminAuthError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  const message = error instanceof Error && /already active|already configured/i.test(error.message)
    ? error.message.replace(/^.*?:\s*/, "")
    : "The admin request could not be completed";
  logger.warn({ err: error }, "Admin request failed");
  response.status(/already active|already configured/i.test(message) ? 409 : 500).json({ error: message });
}

function allowAdminAttempt(
  attempts: Map<string, { count: number; resetsAt: number }>,
  address: string | undefined,
) {
  const key = address ?? "unknown";
  const entry = attempts.get(key);
  if (!entry || entry.resetsAt <= Date.now()) return true;
  return entry.count < 8;
}

function registerAdminFailure(
  attempts: Map<string, { count: number; resetsAt: number }>,
  address: string | undefined,
) {
  const key = address ?? "unknown";
  const current = attempts.get(key);
  attempts.set(key, {
    count: current && current.resetsAt > Date.now() ? current.count + 1 : 1,
    resetsAt: Date.now() + 15 * 60 * 1_000,
  });
}

function clearAdminAttempts(
  attempts: Map<string, { count: number; resetsAt: number }>,
  address: string | undefined,
) {
  attempts.delete(address ?? "unknown");
}

function sendShareUnavailable(response: express.Response) {
  response.status(503).json({ error: "Share links are temporarily unavailable" });
}

function sendShareError(response: express.Response, error: unknown, logger: Logger) {
  if (error instanceof ShareRequestError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  logger.warn({ err: error }, "Share link request failed");
  response.status(500).json({ error: "The share link service is temporarily unavailable" });
}

function parseMessageIds(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) return undefined;
  const ids = [...new Set(value.filter(
    (id): id is string => typeof id === "string" && id.length > 0 && id.length <= 128,
  ))];
  return ids.length === value.length ? ids : undefined;
}

function parseHiddenImages(value: unknown): HiddenImageInput[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return undefined;
  const unique = new Map<string, HiddenImageInput>();
  for (const item of value) {
    const messageId = item && typeof item === "object" && "messageId" in item
      ? (item as { messageId?: unknown }).messageId
      : undefined;
    const url = item && typeof item === "object" && "url" in item
      ? (item as { url?: unknown }).url
      : undefined;
    if (
      typeof messageId !== "string" || messageId.length === 0 || messageId.length > 128 ||
      typeof url !== "string" || url.length === 0 || url.length > 2_048
    ) return undefined;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    } catch {
      return undefined;
    }
    unique.set(`${messageId}\u0000${url}`, { messageId, url });
  }
  return [...unique.values()];
}

function parseNonNegativeInteger(value: unknown, fallback: number) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}
