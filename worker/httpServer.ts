import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import type { LoadedConfiguration } from "./config";
import type { Logger } from "./logger";
import type { ThirdPartyEmoteService } from "./emotes/ThirdPartyEmoteService";
import type { TwitchBadgeService } from "./twitch/TwitchBadgeService";
import type { TwitchAuthService } from "./twitch/TwitchAuthService";
import { isTouhouWikiImage } from "../shared/imageUrls";
import {
  fetchTouhouWikiImage,
  type ProxiedImage,
} from "./touhouWikiImage";

export interface ApplicationRuntimeState {
  auth?: TwitchAuthService;
  badges?: TwitchBadgeService;
  emotes?: ThirdPartyEmoteService;
  integrationError?: string;
}

export interface HttpServerDependencies {
  fetchTouhouWikiImage?: (url: URL) => Promise<ProxiedImage>;
}

export function createHttpServer(
  configuration: LoadedConfiguration,
  runtime: ApplicationRuntimeState,
  logger: Logger,
  dependencies: HttpServerDependencies = {},
): Promise<Server> {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: configuration.frontendUrl, methods: ["GET"] }));

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
    const emotes = await runtime.emotes.getCatalog(request.params.channelId);
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
      const badges = await runtime.badges.getCatalog(request.params.channelId);
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

  app.get("/runtime-config.js", (_request, response) => {
    const runtimeConfig = JSON.stringify({
      convexUrl: configuration.convexUrl,
      workerUrl: configuration.publicWorkerUrl,
      configurationIssues: configuration.issues,
    }).replace(/</g, "\\u003c");
    response
      .type("application/javascript")
      .set("Cache-Control", "no-store")
      .send(`window.__TWITCH_LOGS_CONFIG__ = ${runtimeConfig};`);
  });

  app.get("/auth/twitch/start", (_request, response) => {
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
