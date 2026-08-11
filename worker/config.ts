import "dotenv/config";
import { resolve } from "node:path";
import type { WorkerOptions } from "./types";

type Environment = Record<string, string | undefined>;

export interface LoadedConfiguration {
  options?: WorkerOptions;
  adminOptions?: {
    setupSecret: string;
    encryptionKey: Buffer;
  };
  feedbackOptions?: {
    ipHashSecret: string;
    rateLimitMinutes: number;
  };
  databaseUrl?: string;
  clickHouseOptions?: {
    url: string;
    database: string;
    username: string;
    password: string;
    batchSize: number;
    pollIntervalMs: number;
  };
  issues: string[];
  warnings: string[];
  port: number;
  logLevel: string;
  publicWorkerUrl: string;
  frontendUrl: string;
  trustedProxyHops: number;
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
  const clickHouseUrl = env.CLICKHOUSE_URL?.trim().replace(/\/$/, "");
  const ingestionSecret = required(env, "INGESTION_SECRET", issues);
  const clientId = required(env, "TWITCH_CLIENT_ID", issues);
  const clientSecret = required(env, "TWITCH_CLIENT_SECRET", issues);
  const redirectUri = required(env, "TWITCH_REDIRECT_URI", issues);
  const tokenEncryptionKey = readEncryptionKey(env, issues);
  const frontendUrl = env.TWITCH_FRONTEND_URL?.trim() || "http://localhost:5173";
  const publicWorkerUrl = env.PUBLIC_WORKER_URL?.trim().replace(/\/$/, "") ?? "";
  const feedbackRateLimitMinutes = readIntegerSetting(
    env.FEEDBACK_RATE_LIMIT_MINUTES,
    15,
    1,
    1_440,
    "FEEDBACK_RATE_LIMIT_MINUTES",
    warnings,
  );
  const trustedProxyHops = readIntegerSetting(
    env.TRUST_PROXY_HOPS,
    0,
    0,
    10,
    "TRUST_PROXY_HOPS",
    warnings,
  );
  const clickHouseBatchSize = readIntegerSetting(
    env.CLICKHOUSE_MIRROR_BATCH_SIZE,
    1_000,
    1,
    10_000,
    "CLICKHOUSE_MIRROR_BATCH_SIZE",
    warnings,
  );
  const clickHousePollIntervalMs = readIntegerSetting(
    env.CLICKHOUSE_MIRROR_INTERVAL_MS,
    1_000,
    100,
    60_000,
    "CLICKHOUSE_MIRROR_INTERVAL_MS",
    warnings,
  );

  const hasInitialAccessToken = Boolean(env.TWITCH_ACCESS_TOKEN?.trim());
  const hasInitialRefreshToken = Boolean(env.TWITCH_REFRESH_TOKEN?.trim());
  if (hasInitialAccessToken !== hasInitialRefreshToken) {
    warnings.push(
      "TWITCH_ACCESS_TOKEN and TWITCH_REFRESH_TOKEN must both be set to bootstrap tokens; ignoring the incomplete pair",
    );
  }

  const options =
    databaseUrl &&
    ingestionSecret &&
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

  const adminOptions = ingestionSecret && tokenEncryptionKey
    ? { setupSecret: ingestionSecret, encryptionKey: tokenEncryptionKey }
    : undefined;
  const feedbackOptions = ingestionSecret
    ? { ipHashSecret: ingestionSecret, rateLimitMinutes: feedbackRateLimitMinutes }
    : undefined;
  const clickHouseOptions = clickHouseUrl
    ? {
        url: clickHouseUrl,
        database: env.CLICKHOUSE_DATABASE?.trim() || "twitch_logs",
        username: env.CLICKHOUSE_USERNAME?.trim() || "default",
        password: env.CLICKHOUSE_PASSWORD ?? "",
        batchSize: clickHouseBatchSize,
        pollIntervalMs: clickHousePollIntervalMs,
      }
    : undefined;

  return {
    options,
    adminOptions,
    feedbackOptions,
    databaseUrl,
    clickHouseOptions,
    issues,
    warnings,
    port,
    logLevel: env.LOG_LEVEL ?? "info",
    publicWorkerUrl,
    frontendUrl,
    trustedProxyHops,
  };
}

function readIntegerSetting(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
  warnings: string[],
) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum) return parsed;
  warnings.push(`${name} must be a whole number between ${minimum} and ${maximum}; using ${fallback}`);
  return fallback;
}
