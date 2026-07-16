import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import type { Logger } from "./logger";
import type { TwitchOptions, WorkerOptions } from "./types";
import type { TwitchAuthService } from "./twitch/TwitchAuthService";

export function createHttpServer(
  options: WorkerOptions,
  auth: TwitchAuthService,
  logger: Logger,
): Promise<Server> {
  const app = express();
  const twitchOptions: TwitchOptions = options.twitch;
  app.disable("x-powered-by");
  app.use(cors({ origin: twitchOptions.frontendUrl, methods: ["GET"] }));

  app.get("/health", (_request, response) => {
    response.json({ ok: true, twitchAuthenticated: auth.getStatus().authenticated });
  });

  app.get("/auth/twitch/status", (_request, response) => {
    const status = auth.getStatus();
    response.set("Cache-Control", "no-store").json({
      authenticated: status.authenticated,
      login: status.login,
      scopes: status.scopes,
      reason: status.reason,
    });
  });

  app.get("/runtime-config.js", (_request, response) => {
    const runtimeConfig = JSON.stringify({
      convexUrl: options.convexUrl,
      workerUrl: options.publicWorkerUrl,
    }).replace(/</g, "\\u003c");
    response
      .type("application/javascript")
      .set("Cache-Control", "no-store")
      .send(`window.__TWITCH_LOGS_CONFIG__ = ${runtimeConfig};`);
  });

  app.get("/auth/twitch/start", (_request, response) => {
    response.redirect(auth.createAuthorizationUrl());
  });

  app.get("/auth/twitch/callback", async (request, response) => {
    const error = typeof request.query.error === "string" ? request.query.error : undefined;
    const code = typeof request.query.code === "string" ? request.query.code : undefined;
    const state = typeof request.query.state === "string" ? request.query.state : undefined;
    if (error) {
      logger.warn({ error }, "Twitch OAuth authorization was denied");
      response.redirect(`${twitchOptions.frontendUrl}/?twitch=denied`);
      return;
    }
    if (!code || !state) {
      response.status(400).send("Missing Twitch OAuth code or state");
      return;
    }
    try {
      await auth.exchangeAuthorizationCode(code, state);
      response.redirect(`${twitchOptions.frontendUrl}/?twitch=connected`);
    } catch (cause) {
      logger.error({ err: cause }, "Twitch OAuth callback failed");
      response.redirect(`${twitchOptions.frontendUrl}/?twitch=error`);
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

  return new Promise((resolve, reject) => {
    const server = app.listen(options.port, "0.0.0.0", () => {
      logger.info(
        { port: options.port, servesFrontend: existsSync(staticDirectory) },
        "Twitch application server listening",
      );
      resolve(server);
    });
    server.once("error", reject);
  });
}
