import { loadConfiguration } from "./config";
import { PostgresDatabase } from "./database";
import { ThirdPartyEmoteService } from "./emotes/ThirdPartyEmoteService";
import {
  createHttpServer,
  type ApplicationRuntimeState,
} from "./httpServer";
import { ColdMessageArchiveService } from "./ColdMessageArchiveService";
import { createLogger } from "./logger";
import { PostgresStore } from "./PostgresStore";
import { RawEventArchiveService } from "./RawEventArchiveService";
import { EncryptedTokenStore } from "./twitch/EncryptedTokenStore";
import { TwitchApiClient } from "./twitch/TwitchApiClient";
import { TwitchAuthService } from "./twitch/TwitchAuthService";
import { TwitchBadgeService } from "./twitch/TwitchBadgeService";
import { TwitchChatService } from "./twitch/TwitchChatService";
import { TwitchEventSubClient } from "./twitch/TwitchEventSubClient";

const configuration = loadConfiguration();
const logger = createLogger(configuration.logLevel);
const abortController = new AbortController();
const runtime: ApplicationRuntimeState = {
  emotes: new ThirdPartyEmoteService(logger),
};
let chat: TwitchChatService | undefined;
let database: PostgresDatabase | undefined;
let rawArchive: RawEventArchiveService | undefined;
let coldArchive: ColdMessageArchiveService | undefined;
let archiveReady = false;

for (const warning of configuration.warnings) logger.warn({ warning }, "Configuration warning");
if (configuration.issues.length > 0) {
  logger.warn(
    { configurationIssues: configuration.issues },
    "Integration configuration is incomplete; starting in setup mode",
  );
}

if (configuration.databaseUrl) {
  try {
    database = new PostgresDatabase(configuration.databaseUrl);
    await database.migrate();
    coldArchive = new ColdMessageArchiveService(database, logger);
    const repository = new PostgresStore(database, logger, coldArchive);
    runtime.database = database;
    runtime.store = repository;
  } catch (error) {
    runtime.integrationError = "PostgreSQL failed to initialize; inspect server logs";
    runtime.store = undefined;
    runtime.database = undefined;
    await database?.close().catch(() => undefined);
    database = undefined;
    logger.error({ err: error }, "PostgreSQL initialization failed; server remains online");
  }
}

if (database && runtime.store) {
  try {
    rawArchive = new RawEventArchiveService(database, logger);
    const rawResult = await rawArchive.runOnce();
    const coldResult = await coldArchive!.runOnce();
    archiveReady = true;
    logger.info(
      { raw: rawResult, cold: coldResult },
      "Archive verification completed before ingestion",
    );
  } catch (error) {
    runtime.integrationError =
      "Raw Twitch event archival failed verification; ingestion is paused to protect source data";
    logger.error({ err: error }, "Raw-event archive initialization failed");
  }
}

const server = await createHttpServer(configuration, runtime, logger);

if (configuration.options && runtime.store && archiveReady) {
  const options = configuration.options;
  try {
    const tokenStore = new EncryptedTokenStore(
      options.twitch.tokenStorePath,
      options.twitch.tokenEncryptionKey,
    );
    const auth = new TwitchAuthService(options.twitch, tokenStore, logger);
    runtime.auth = auth;
    const api = new TwitchApiClient(options.twitch.clientId, auth, logger);
    runtime.badges = new TwitchBadgeService(api, logger);
    const eventSub = new TwitchEventSubClient(options.twitch.eventSubUrl, api, logger);
    chat = new TwitchChatService(auth, api, eventSub, runtime.store, logger);
    await chat.start(abortController.signal);
    rawArchive?.start((error) => {
      chat?.pause();
      runtime.integrationError =
        "Raw Twitch event archival failed verification; ingestion is paused to protect source data";
      logger.error({ err: error }, "Twitch ingestion paused after archive verification failure");
    });
    coldArchive?.start((error) => {
      chat?.pause();
      runtime.integrationError =
        "Cold chat archive failed verification; ingestion is paused to protect source data";
      logger.error({ err: error }, "Twitch ingestion paused after cold archive failure");
    });
  } catch (error) {
    runtime.integrationError = "Twitch integration failed to initialize; inspect server logs";
    runtime.auth = undefined;
    chat?.stop();
    logger.error({ err: error }, "Twitch integration initialization failed; database remains online");
  }
}

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down Twitch worker");
  rawArchive?.stop();
  coldArchive?.stop();
  abortController.abort();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database?.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => {
  logger.error({ err: error }, "Unhandled worker rejection");
});
