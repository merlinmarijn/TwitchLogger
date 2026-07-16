import "dotenv/config";
import { resolve } from "node:path";
import type { WorkerOptions } from "./types";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function encryptionKey(): Buffer {
  const key = Buffer.from(required("TWITCH_TOKEN_ENCRYPTION_KEY"), "base64");
  if (key.length !== 32) {
    throw new Error("TWITCH_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

export function loadOptions(): WorkerOptions {
  const port = Number.parseInt(process.env.WORKER_PORT ?? "8787", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("WORKER_PORT must be a valid TCP port");
  }

  return {
    convexUrl: required("CONVEX_URL"),
    publicWorkerUrl: process.env.PUBLIC_WORKER_URL?.replace(/\/$/, "") ?? "",
    ingestionSecret: required("INGESTION_SECRET"),
    port,
    logLevel: process.env.LOG_LEVEL ?? "info",
    twitch: {
      clientId: required("TWITCH_CLIENT_ID"),
      clientSecret: required("TWITCH_CLIENT_SECRET"),
      redirectUri: required("TWITCH_REDIRECT_URI"),
      frontendUrl: process.env.TWITCH_FRONTEND_URL ?? "http://localhost:5173",
      eventSubUrl:
        process.env.TWITCH_EVENTSUB_URL ??
        "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30",
      tokenEncryptionKey: encryptionKey(),
      tokenStorePath: resolve(
        process.env.TWITCH_TOKEN_STORE_PATH ?? "./data/twitch-tokens.enc",
      ),
      initialAccessToken: process.env.TWITCH_ACCESS_TOKEN || undefined,
      initialRefreshToken: process.env.TWITCH_REFRESH_TOKEN || undefined,
    },
  };
}
