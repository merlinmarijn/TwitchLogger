import "dotenv/config";
import { resolve } from "node:path";
import type { WorkerOptions } from "./types";

type Environment = Record<string, string | undefined>;

export interface LoadedConfiguration {
  options?: WorkerOptions;
  adminOptions?: {
    convexUrl: string;
    ingestionSecret: string;
    encryptionKey: Buffer;
  };
  issues: string[];
  warnings: string[];
  port: number;
  logLevel: string;
  convexUrl?: string;
  publicWorkerUrl: string;
  frontendUrl: string;
}

const placeholderPatterns = [
  /^your[_-]/i,
  /^replace[_-]with[_-]/i,
  /^base64[_-]encoded/i,
];

function required(env: Environment, name: string, issues: string[]): string | undefined {
  const value = env[name]?.trim();
  if (!value || placeholderPatterns.some((pattern) => pattern.test(value))) {
    issues.push(`${name} is missing or still contains an example value`);
    return undefined;
  }
  return value;
}

function readEncryptionKey(
  env: Environment,
  issues: string[],
): Buffer | undefined {
  const encoded = required(env, "TWITCH_TOKEN_ENCRYPTION_KEY", issues);
  if (!encoded) return undefined;
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    issues.push("TWITCH_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
    return undefined;
  }
  return key;
}

export function loadConfiguration(env: Environment = process.env): LoadedConfiguration {
  const issues: string[] = [];
  const warnings: string[] = [];
  const configuredPort = Number.parseInt(env.WORKER_PORT ?? "8787", 10);
  const port =
    Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535
      ? configuredPort
      : 8787;
  if (port !== configuredPort) {
    warnings.push("WORKER_PORT is invalid; using port 8787");
  }

  const databaseUrl = required(env, "DATABASE_URL", issues);
  const convexUrl = optional(env, "CONVEX_URL");
  const ingestionSecret = optional(env, "INGESTION_SECRET");
  const clientId = required(env, "TWITCH_CLIENT_ID", issues);
  const clientSecret = required(env, "TWITCH_CLIENT_SECRET", issues);
  const redirectUri = required(env, "TWITCH_REDIRECT_URI", issues);
  const tokenEncryptionKey = readEncryptionKey(env, issues);
  const frontendUrl = env.TWITCH_FRONTEND_URL?.trim() || "http://localhost:5173";
  const publicWorkerUrl = env.PUBLIC_WORKER_URL?.trim().replace(/\/$/, "") ?? "";

  const hasInitialAccessToken = Boolean(env.TWITCH_ACCESS_TOKEN?.trim());
  const hasInitialRefreshToken = Boolean(env.TWITCH_REFRESH_TOKEN?.trim());
  if (hasInitialAccessToken !== hasInitialRefreshToken) {
    warnings.push(
      "TWITCH_ACCESS_TOKEN and TWITCH_REFRESH_TOKEN must both be set to bootstrap tokens; ignoring the incomplete pair",
    );
  }

  const options =
    databaseUrl &&
    clientId &&
    clientSecret &&
    redirectUri &&
    tokenEncryptionKey
      ? {
          databaseUrl,
          publicWorkerUrl,
          port,
          logLevel: env.LOG_LEVEL ?? "info",
          twitch: {
            clientId,
            clientSecret,
            redirectUri,
            frontendUrl,
            eventSubUrl:
              env.TWITCH_EVENTSUB_URL ??
              "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30",
            tokenEncryptionKey,
            tokenStorePath: resolve(
              env.TWITCH_TOKEN_STORE_PATH ?? "./data/twitch-tokens.enc",
            ),
            initialAccessToken:
              hasInitialAccessToken && hasInitialRefreshToken
                ? env.TWITCH_ACCESS_TOKEN!.trim()
                : undefined,
            initialRefreshToken:
              hasInitialAccessToken && hasInitialRefreshToken
                ? env.TWITCH_REFRESH_TOKEN!.trim()
                : undefined,
          },
        }
      : undefined;

  const adminOptions = convexUrl && ingestionSecret && tokenEncryptionKey
    ? { convexUrl, ingestionSecret, encryptionKey: tokenEncryptionKey }
    : undefined;

  return {
    options,
    adminOptions,
    issues,
    warnings,
    port,
    logLevel: env.LOG_LEVEL ?? "info",
    convexUrl,
    publicWorkerUrl,
    frontendUrl,
  };
}

function optional(env: Environment, name: string) {
  const value = env[name]?.trim();
  return value && !placeholderPatterns.some((pattern) => pattern.test(value))
    ? value
    : undefined;
}
