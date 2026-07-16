# Twitch Logs

A TypeScript chat-monitoring dashboard backed by Convex. Twitch messages arrive through the current `channel.chat.message` EventSub WebSocket subscription; the integration does not use IRC, deprecated chat APIs, or polling.

## Production container

The supplied image contains only the compiled dashboard and the always-on Node ingestion worker. It does **not** contain, start, provision, or emulate a Convex database. At runtime it connects to the existing deployment supplied through `CONVEX_URL`.

The same image can move between environments without rebuilding: `/runtime-config.js` exposes only the public Convex deployment URL and optional public worker URL to the browser at container startup. Twitch secrets, OAuth tokens, the ingestion secret, and the token-encryption key remain server-side.

Create the production environment file:

```powershell
Copy-Item .env.production.example .env.production
```

Set these values in `.env.production`:

- `CONVEX_URL`: your existing `https://*.convex.cloud` deployment.
- `INGESTION_SECRET`: the same value already configured for the Convex `channels:updateResolved`, `channels:updateConnectionStatus`, and `messages:insertIncoming` functions.
- `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`: your confidential Twitch application.
- `TWITCH_REDIRECT_URI`: the public callback, such as `https://chatlogs.example.com/auth/twitch/callback`.
- `TWITCH_FRONTEND_URL`: the public application origin, without a trailing slash.
- `TWITCH_TOKEN_ENCRYPTION_KEY`: a base64-encoded 32-byte random key.
- `PUBLIC_WORKER_URL`: leave empty when one container serves both UI and worker. Set it only if a proxy exposes worker routes on another origin.

Build and tag the image when you are ready:

```powershell
docker build -t your-registry.example.com/twitch-logs:latest .
docker push your-registry.example.com/twitch-logs:latest
```

Example production launch:

```powershell
docker run -d --name twitch-logs `
  --init `
  --restart unless-stopped `
  --read-only `
  --tmpfs /tmp:size=64m,mode=1777 `
  --cap-drop ALL `
  --security-opt no-new-privileges:true `
  --env-file .env.production `
  -p 8787:8787 `
  -v twitch-logs-tokens:/data `
  your-registry.example.com/twitch-logs:latest
```

Or copy `compose.example.yaml` to `compose.yaml` and change the image/build settings for your registry. The Compose file intentionally contains no Convex service.

The image:

- Uses a two-stage Node 22 build.
- Runs as the unprivileged `node` user.
- Listens on `0.0.0.0:8787` by default.
- Includes an HTTP health check at `/health`.
- Persists only the encrypted Twitch token file under `/data`.
- Accepts all configuration at runtime; no secrets are Docker build arguments.
- Remains online in setup mode when required configuration is missing or still contains example placeholders.

`GET /health` is a liveness endpoint and always returns HTTP 200 while the process is operating. Its JSON includes `ready`, `configured`, and safe `configurationIssues` fields. `GET /ready` returns HTTP 503 until configuration and integration initialization succeed. Missing credentials disable ingestion and OAuth but do not terminate the dashboard container.

Place TLS in front of port 8787 with your production ingress or reverse proxy. The public origin and Twitch callback must route to the same container endpoints. Run one ingestion-worker replica unless you add leader election and a shared OAuth-state/token-store implementation.

The image runs with UID/GID `1000:1000`. Docker named volumes are initialized from the image's writable `/data` directory. On Kubernetes or another orchestrator that mounts an empty volume with different ownership, set the pod security context `fsGroup: 1000` (or otherwise make `/data` writable by UID 1000).

Your existing Convex deployment must already contain the functions and schema in `convex/`. Those source files are deployment definitions for your external Convex project; they are not included in the final runtime image and do not create a local database.

## Architecture

```text
Twitch OAuth + Helix + EventSub WebSocket
                  │
                  ▼
        external Node worker
  Auth → API → EventSub → Chat service
                  │ normalized messages
                  ▼
        guarded Convex mutations
                  │
                  ▼
      Convex database + subscriptions
                  │
                  ▼
          React/Vite dashboard
```

The Node worker is an intentional deployment boundary. Convex actions have finite execution time and are not a suitable home for a permanent WebSocket. The worker watches the Convex channel query reactively, resolves new Twitch usernames with Helix, adds or removes EventSub subscriptions, and sends normalized messages back through an ingestion-secret-protected mutation.

Main components:

- `TwitchAuthService`: authorization-code OAuth, CSRF state checking, startup/hourly validation, serialized refresh, and revoked-authorization handling.
- `EncryptedTokenStore`: AES-256-GCM token storage. The encryption key stays in the worker environment or deployment secret manager.
- `TwitchApiClient`: username lookup and EventSub subscription management with automatic refresh-and-retry after a 401.
- `TwitchEventSubClient`: welcome/session handling, keepalive deadlines, Twitch-directed seamless reconnect, dropped-connection backoff, resubscription, and notification-ID deduplication.
- `TwitchChatService`: channel lifecycle and a reusable `onMessage` callback that emits normalized `TwitchChatMessage` values without depending on React or Convex UI code.
- `ConvexChatRepository`: the worker's storage boundary. Convex also deduplicates by Twitch message ID transactionally.

One WebSocket is shared by all configured channels. The service already models channels as a collection, so adding more channels does not require a new architecture. Twitch currently allows many subscriptions per socket; capacity sharding can be added inside `TwitchEventSubClient` later without changing the UI or database model.

## Twitch developer application setup

1. Sign in to the [Twitch Developer Console](https://dev.twitch.tv/console/apps) and register an application.
2. Add `http://localhost:8787/auth/twitch/callback` as an OAuth redirect URL. It must exactly match `TWITCH_REDIRECT_URI`.
3. Use a **Confidential** client type because the worker keeps a client secret and refresh token server-side.
4. Copy the Client ID and generate a Client Secret. Put both only in the worker environment.
5. The OAuth flow requests only `user:read:chat`, the scope Twitch documents for [`channel.chat.message`](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage). The authorized user ID becomes the subscription's `user_id`; each configured broadcaster becomes its `broadcaster_user_id`.

The worker uses Twitch's [authorization-code grant](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#authorization-code-grant-flow), which returns refreshable user tokens. It validates them at startup and hourly as required by Twitch's [token-validation guidance](https://dev.twitch.tv/docs/authentication/validate-tokens/), and follows Twitch's [WebSocket reconnect and keepalive rules](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/).

## Local setup

Prerequisites for local development: Node.js 22, npm, an existing Convex project, and the Twitch application above.

```powershell
npm install
Copy-Item .env.example .env.local
```

Generate the two independent secrets:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

Use the base64 value for `TWITCH_TOKEN_ENCRYPTION_KEY` and the hex value for `INGESTION_SECRET`. Complete `.env.local`:

```dotenv
VITE_CONVEX_URL=https://your-deployment.convex.cloud
VITE_WORKER_URL=http://localhost:8787

CONVEX_URL=https://your-deployment.convex.cloud
TWITCH_CLIENT_ID=your_client_id
TWITCH_CLIENT_SECRET=your_client_secret
TWITCH_REDIRECT_URI=http://localhost:8787/auth/twitch/callback
TWITCH_FRONTEND_URL=http://localhost:5173
TWITCH_TOKEN_ENCRYPTION_KEY=your_base64_32_byte_key
TWITCH_TOKEN_STORE_PATH=./data/twitch-tokens.enc
INGESTION_SECRET=your_random_hex_secret
WORKER_PORT=8787
LOG_LEVEL=info
```

Do not add `VITE_` to any secret. Vite deliberately exposes `VITE_*` values to browser code. `VITE_CONVEX_URL` and `VITE_WORKER_URL` are public service locations, not credentials.

Initialize/deploy the Convex development backend:

```powershell
npx convex dev
```

Set the same ingestion secret in the Convex deployment. Omitting the value from the command keeps it out of shell history:

```powershell
npx convex env set INGESTION_SECRET
```

Then start all three local processes:

```powershell
npm run dev
```

Open `http://localhost:5173`, choose **Connect Twitch**, authorize the single read-chat scope, and add a Twitch username. The worker resolves it to a stable Twitch user ID before subscribing.

If `npx convex dev` rewrites the Convex URL in `.env.local`, make sure both `VITE_CONVEX_URL` and `CONVEX_URL` point to that deployment before restarting the worker.

## Token storage and deployment

- Client ID, client secret, redirect URL, token encryption key, ingestion secret, and optional bootstrap tokens are read only by the worker from environment variables/application secrets.
- Access and refresh tokens are stored in an AES-256-GCM encrypted file. `data/` is ignored by Git. Use a persistent volume for that file in production, or replace the small `TwitchTokenStore` interface with your cloud secret manager.
- `TWITCH_ACCESS_TOKEN` and `TWITCH_REFRESH_TOKEN` are optional one-time bootstrap variables. When both are present and the encrypted store is empty, the worker encrypts them immediately. Remove them from the environment afterward.
- Token responses and authorization headers are redacted from structured logs. The worker logs message IDs and routing metadata, not OAuth credentials.
- Run exactly one worker instance per encrypted token store/authorization unless you add leader election. A single worker already handles multiple channels.
- Deploy the worker to an always-on Node host with outbound HTTPS and WebSocket access. Deploy the Vite build independently and set `TWITCH_FRONTEND_URL`/`VITE_WORKER_URL` to their public HTTPS URLs.

## Runtime behavior

- A normal connection loss creates a new EventSub session and recreates every desired subscription after the welcome message.
- A Twitch `session_reconnect` uses the supplied URL unchanged, waits for the new welcome, then closes the old socket. Twitch carries the subscriptions in this path, so the worker does not duplicate them.
- Notifications are deduplicated in memory by EventSub notification ID. Convex provides the durable second line of defense by checking Twitch message ID in the insertion transaction.
- Missing keepalives terminate the socket and enter capped exponential reconnect backoff.
- API 401 responses trigger one serialized token refresh and retry. Invalid refresh tokens, revoked authorization, missing scope, and EventSub revocations surface as `authorization_required` or `error` channel states without leaking credentials.
- Shutdown uses an `AbortSignal`, closes the socket and Convex subscription, and stops the HTTP server.
- Messages sent before the EventSub subscription became active are intentionally unavailable. Twitch does not expose general chat history through this integration, and the app never attempts to fetch it.

## Data model and extension points

`channels` and `chatMessages` keep portable fields such as platform, external IDs, usernames, text, timestamp, and role flags at the top level. Twitch-specific fragments and raw data live in flexible metadata fields. Adding another platform means implementing another ingestion adapter that produces the same normalized message shape, then adding its platform option in channel management; the feed and most Convex queries remain unchanged.

Useful commands:

```powershell
npm test
npm run build
npm run start:worker
```
