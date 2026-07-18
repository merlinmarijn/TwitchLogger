import { ConvexChatRepository } from "./ConvexChatRepository";
import { loadConfiguration } from "./config";
import { ThirdPartyEmoteService } from "./emotes/ThirdPartyEmoteService";
import {
  createHttpServer,
  type ApplicationRuntimeState,
} from "./httpServer";
import { createLogger } from "./logger";
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

for (const warning of configuration.warnings) logger.warn({ warning }, "Configuration warning");
if (configuration.issues.length > 0) {
  logger.warn(
    { configurationIssues: configuration.issues },
    "Integration configuration is incomplete; starting in setup mode",
  );
}

const server = await createHttpServer(configuration, runtime, logger);

if (configuration.options) {
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
    const repository = new ConvexChatRepository(
      options.convexUrl,
      options.ingestionSecret,
      logger,
    );
    void repository.startImageIndexBackfill()
      .then(({ scheduled }) => {
        if (scheduled) logger.info("Started the one-time gallery image index backfill");
      })
      .catch((error) => logger.warn(
        { err: error },
        "Could not start the gallery image index backfill",
      ));
    chat = new TwitchChatService(auth, api, eventSub, repository, logger);
    await chat.start(abortController.signal);
  } catch (error) {
    runtime.integrationError = "Twitch integration failed to initialize; inspect server logs";
    runtime.auth = undefined;
    chat?.stop();
    logger.error({ err: error }, "Twitch integration initialization failed; server remains online");
  }
}

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down Twitch worker");
  abortController.abort();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => {
  logger.error({ err: error }, "Unhandled worker rejection");
});
