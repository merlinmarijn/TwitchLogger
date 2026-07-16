import { ConvexChatRepository } from "./ConvexChatRepository";
import { loadOptions } from "./config";
import { createHttpServer } from "./httpServer";
import { createLogger } from "./logger";
import { EncryptedTokenStore } from "./twitch/EncryptedTokenStore";
import { TwitchApiClient } from "./twitch/TwitchApiClient";
import { TwitchAuthService } from "./twitch/TwitchAuthService";
import { TwitchChatService } from "./twitch/TwitchChatService";
import { TwitchEventSubClient } from "./twitch/TwitchEventSubClient";

const options = loadOptions();
const logger = createLogger(options.logLevel);
const abortController = new AbortController();

const tokenStore = new EncryptedTokenStore(
  options.twitch.tokenStorePath,
  options.twitch.tokenEncryptionKey,
);
const auth = new TwitchAuthService(options.twitch, tokenStore, logger);
const api = new TwitchApiClient(options.twitch.clientId, auth, logger);
const eventSub = new TwitchEventSubClient(options.twitch.eventSubUrl, api, logger);
const repository = new ConvexChatRepository(
  options.convexUrl,
  options.ingestionSecret,
  logger,
);
const chat = new TwitchChatService(auth, api, eventSub, repository, logger);

const server = await createHttpServer(options, auth, logger);
await chat.start(abortController.signal);

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
