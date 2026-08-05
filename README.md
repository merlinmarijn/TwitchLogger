# Twitch Logs

A self-hosted TypeScript Twitch chat monitor backed by PostgreSQL. Twitch messages arrive through the current `channel.chat.message` EventSub WebSocket subscription; the integration does not use IRC, deprecated chat APIs, or polling.

The dashboard provides:

- a combined live feed for multiple Twitch channels;
- native Twitch emotes, BTTV, FrankerFaceZ, 7TV, and Twitch badges;
- reusable browser-local filters and shared PostgreSQL chat, gallery, and game-score tabs;
- image galleries for direct links, automatically detected extensionless images, and supported artwork pages;
- parsed RNGdle and FoodGuessr score cards with daily, weekly, monthly, and all-time rankings;
- an authenticated `/admin` control room for configuration and log moderation;
- admin-only single and bulk removal of messages and images.

PostgreSQL is the only live application database. Convex is not used by the worker, frontend, admin authentication, dashboard, or maintenance jobs. The old Convex source and importer remain only as optional one-time cutover tooling for deployments that have not completed their historical data migration.

## Production container

The supplied image contains the compiled React dashboard and the always-on Node ingestion worker. It connects directly to PostgreSQL through `DATABASE_URL`, applies pending SQL migrations at startup, and then starts Twitch ingestion.

Create the production environment file:

```powershell
Copy-Item .env.production.example .env.production
```

Configure:

- `DATABASE_URL`: PostgreSQL connection string.
- `INGESTION_SECRET`: long random server-side value used as the one-time `/admin` setup key.
- `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`: confidential Twitch application credentials.
- `TWITCH_REDIRECT_URI`: public callback URL such as `https://chatlogs.example.com/auth/twitch/callback`.
- `TWITCH_FRONTEND_URL`: public application origin without a trailing slash.
- `TWITCH_TOKEN_ENCRYPTION_KEY`: base64-encoded 32-byte key used for OAuth tokens, TOTP, and signed admin sessions.
- `PUBLIC_WORKER_URL`: leave empty when the container serves both UI and API; set it only for split-origin deployments.
- `FEEDBACK_RATE_LIMIT_MINUTES`: cooldown between feedback or issue reports from the same IP (defaults to `15`).
- `TRUST_PROXY_HOPS`: exact number of trusted reverse-proxy hops in front of the app (defaults to `0`). Set this correctly so feedback throttling uses the visitor IP without trusting spoofed forwarding headers.

Build and run:

```powershell
docker build -t twitch-logs:latest .
docker compose -f compose.example.yaml up -d --build
```

The container:

- runs as the unprivileged `node` user;
- listens on `0.0.0.0:8787` by default;
- exposes `/health` and `/ready` endpoints;
- stores the encrypted Twitch token file under `/data`;
- runs SQL migrations before opening the database-backed application;
- should run as a single replica unless shared OAuth state and leader election are added.

## Architecture

```text
React dashboard
  -> Node worker HTTP API
      -> PostgreSQL 18

Twitch OAuth + Helix + EventSub WebSocket
  -> TwitchChatService
      -> PostgresStore
          -> PostgreSQL 18

/admin
  -> AdminService
      -> PostgreSQL 18
```

Main components:

- `TwitchAuthService`: authorization-code OAuth, CSRF state checking, validation, and token refresh.
- `EncryptedTokenStore`: AES-256-GCM token storage.
- `TwitchApiClient`: username lookup and EventSub subscription management.
- `TwitchEventSubClient`: WebSocket lifecycle, keepalives, reconnects, and notification deduplication.
- `TwitchChatService`: channel lifecycle and normalized chat ingestion.
- `PostgresStore`: channels, messages, saved views, search, pagination, durable Twitch-message deduplication, and moderation tombstones.
- `AdminService`: PostgreSQL-backed authentication, TOTP, sessions, metrics, audit events, and maintenance jobs.

## Admin control room

Open `/admin` on the frontend origin. On a new database, first-time setup requires `INGESTION_SECRET` before creating the sole super-admin password. Existing admin settings imported into PostgreSQL continue to work with the same password and authenticator.

Admin security includes:

- scrypt password hashing;
- AES-256-GCM encrypted TOTP secrets;
- signed, HttpOnly admin sessions with a twelve-hour expiry;
- origin checks and rate limiting for authentication;
- server-enforced authorization on every shared mutation;
- persistent PostgreSQL audit events.

The control room provides cancellable PostgreSQL maintenance operations for image reindexing, saved-view refresh, integrity scanning, and relation-size measurement. Jobs, progress, results, and audit history survive browser refreshes and unfinished work resumes when the worker restarts.

## Twitch developer application

1. Register a confidential application in the Twitch Developer Console.
2. Add `http://localhost:8787/auth/twitch/callback` for local development, or the matching production callback.
3. Put the Client ID and Client Secret only in the worker environment.
4. The OAuth flow requests `user:read:chat` for `channel.chat.message` EventSub subscriptions.

## Local development

Prerequisites: Node.js 22, PostgreSQL, and a Twitch application.

```powershell
npm install
Copy-Item .env.example .env
npm run db:migrate
npm run dev
```

Generate the two independent server secrets:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

Use the base64 value for `TWITCH_TOKEN_ENCRYPTION_KEY` and the hex value for `INGESTION_SECRET`. Never prefix secrets with `VITE_`; Vite exposes such values to browser code.

`npm run dev` starts Vite and the Node worker. The worker opens PostgreSQL, applies pending migrations, and begins ingestion when Twitch configuration is complete.

## Runtime behavior

- EventSub reconnects recreate desired subscriptions after a new welcome message.
- Twitch-directed session reconnects preserve subscriptions without duplication.
- PostgreSQL uniquely constrains `external_message_id` for durable deduplication.
- Original Twitch EventSub envelopes are copied into sealed daily Brotli archive
  chunks. Every chunk is decompressed and checked against its SHA-256 manifest
  before its staging rows can be removed.
- Raw source cleanup is fail-closed and disabled by default. If archival later
  fails verification, Twitch ingestion pauses while existing chat reads remain
  available.
- Removed messages remain hidden tombstones so retried Twitch events cannot restore them.
- Removed image URLs remain suppressed during later image reindex operations.
- OAuth 401 responses trigger serialized refresh and one retry.
- Shutdown closes the WebSocket, HTTP server, and PostgreSQL pool.

## Historical Convex cutover tooling

Deployments with data still in Convex can use the isolated importer described in [MIGRATION.md](MIGRATION.md):

```powershell
npm run migrate:convex
```

`CONVEX_URL` is needed only by that one-time command. It is not read by the live application and is intentionally absent from the production environment example.

## Useful commands

```powershell
npm run dev
npm run build
npm test
npm run lint
npm run db:migrate
npm run archive:verify
npm run archive:verify-cold
npm run start:worker
```

After a new archival deployment, leave source cleanup disabled until
`npm run archive:verify` reports `"verified": true` in production. Enable it
explicitly only after taking a database backup:

```powershell
npm run archive:enable-cleanup -- --confirm
```

Cleanup only nulls redundant `raw_message_data` values after their verified
archive chunk is committed. Canonical message columns used by chat, search,
filters, galleries, scores, and moderation are not changed.

Legacy timestamp indexes and the unused `chat_tab_matches` cache are removed
after the archive rollout. The retained partial keyset indexes cover live chat,
channel, gallery, and score pagination while the trigram indexes continue to
serve text and sender search.

Canonical messages remain in the indexed hot table for 90 days. After the
separate cold-archive gate is enabled, older complete UTC days are moved in the
same transaction into verified Brotli chunks plus a small pagination catalog.
The API transparently reads those chunks when hot results are exhausted, and
archived moderation rewrites and re-verifies the affected chunk.

Enable this tier only after its verification command succeeds:

```powershell
npm run archive:verify-cold
npm run archive:enable-cold -- --confirm
```
