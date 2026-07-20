# Twitch Logs

A TypeScript Twitch chat dashboard backed by PostgreSQL 18. Twitch messages arrive through Twitch EventSub WebSockets and are stored by the Node worker; the browser reads and mutates application data through the worker API.

## Storage cutover status

PostgreSQL is now the live store for:

- channels and logging state;
- chat messages, image metadata, and deduplication;
- saved chat/gallery tabs;
- dashboard queries, search, filtering, and pagination.

Convex is intentionally still present as a temporary compatibility dependency. The `/admin` control room continues to use Convex while its maintenance jobs are ported, and `convex/migration.ts` remains available so the migration can be rerun before the final decommission. All Convex tables, including admin data, are represented in PostgreSQL and copied by the migration command.

## Can this version be deployed before PostgreSQL is ready?

No. Committing and pushing the code is harmless by itself, but if merging or pushing to `main` automatically deploys this version, the production deployment will expect `DATABASE_URL` immediately.

Without a usable PostgreSQL connection:

- the HTTP process remains online so `/health` can report the configuration problem;
- the normal dashboard shows the setup-required screen;
- Twitch EventSub ingestion does not start;
- no new chat messages are written to Convex as a fallback;
- the existing Convex data is not deleted or changed.

In other words, deploying before PostgreSQL is prepared causes an ingestion outage even though the old data remains safe in Convex. This release does not automatically fall back to Convex for normal application traffic.

Use one of these approaches:

1. Commit and push to a feature branch, but do not merge to an auto-deployed production branch yet.
2. Provision PostgreSQL, migrate the Convex data, and configure `DATABASE_URL` in production before merging.
3. If production must receive intermediate commits, first add and test an explicit Convex/PostgreSQL backend feature flag. Do not rely on the presence or absence of `DATABASE_URL` as an implicit cutover switch.

The recommended approach for this repository is option 2. It has fewer moving parts and prevents the two databases from accepting competing writes during the cutover.

## Production with PostgreSQL 18

Copy the examples and change every placeholder:

```sh
cp .env.production.example .env.production
cp compose.example.yaml compose.yaml
docker compose up -d --build
```

The example Compose stack starts:

- `postgres:18-bookworm` with a persistent `postgres_data` volume;
- the Twitch Logs application with a persistent OAuth-token volume.

Keep the password in `DATABASE_URL` synchronized with `POSTGRES_PASSWORD`. For an existing PostgreSQL server, point `DATABASE_URL` at that server and remove the example `postgres` service if desired.

The application runs SQL migrations automatically at startup. They can also be applied explicitly:

```sh
npm run db:migrate
```

The first migration is [db/migrations/001_initial.sql](db/migrations/001_initial.sql). Migration execution is serialized with a PostgreSQL advisory lock and recorded in `schema_migrations`.

## Migrating all Convex data

Do the initial copy before opening the new dashboard or starting ingestion against an empty PostgreSQL database. This avoids creating rows that conflict with IDs from Convex.

1. Deploy the current `convex/` directory so `migration:exportPage` exists in the source deployment:

   ```sh
   npx convex deploy
   ```

   Use `npx convex dev` instead when migrating a development deployment.

2. Set these server-side values in `.env` or the shell:

   ```dotenv
   DATABASE_URL=postgresql://twitch_logs:password@localhost:5432/twitch_logs
   CONVEX_URL=https://your-deployment.convex.cloud
   INGESTION_SECRET=the-secret-also-configured-in-convex
   ```

3. Run the importer:

   ```sh
   npm run migrate:convex
   ```

The importer pages through and upserts these tables in dependency order:

1. `platforms`
2. `channels`
3. `chatTabs`
4. `chatMessages`
5. `chatTabMatches`
6. `adminSettings`
7. `adminJobs`
8. `adminMetrics`
9. `adminDatabaseStats`
10. `maintenanceThrottle`
11. `adminAuditLog`

Convex document IDs and creation times are preserved. Foreign-key relationships therefore remain intact. Each page is committed in one PostgreSQL transaction, and rows are upserted by their preserved ID, so an interrupted import or a final catch-up import can be safely rerun. Set `MIGRATION_PAGE_SIZE` from 1 to 500 to tune batches; the default is 250.

The importer does not delete PostgreSQL rows that no longer exist in Convex. During the overlap period, prefer soft deletion and run the final import immediately before making Convex read-only.

## Recommended final-cutover sequence

1. Commit and push this work to a branch that does not automatically replace production.
2. Provision PostgreSQL 18 and configure backups and persistent storage.
3. Set `DATABASE_URL` for the migration environment and run `npm run db:migrate`.
4. Deploy `convex/migration.ts` to the current Convex deployment.
5. Stop the old Convex-writing worker or otherwise pause ingestion briefly.
6. Run `npm run migrate:convex` and verify the reported counts against Convex.
7. Add the tested `DATABASE_URL` to the production application environment.
8. Deploy this PostgreSQL-backed application version.
9. Verify `/health`, channels, recent history, filters, and a newly received Twitch message.
10. If verification fails, stop the new deployment and restart the old Convex-backed release; the migration does not delete Convex data.
11. Keep `CONVEX_URL` and `INGESTION_SECRET` while `/admin` still uses Convex.
12. After the admin service is ported, take a final Convex backup and remove the Convex dependency and environment values.

The brief ingestion pause between steps 5 and 8 prevents messages from arriving in Convex after the final copy. If avoiding any pause is mandatory, implement temporary dual-writing and reconciliation before attempting the production cutover.

## Local development

Prerequisites:

- Node.js 22 or newer;
- PostgreSQL 18 (the SQL is intentionally conventional and may also work on recent older versions, but 18 is the supported target);
- a Twitch application;
- the existing Convex deployment only while migrating or using `/admin`.

Install dependencies and configure the environment:

```sh
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

`npm run dev` starts Vite and the Node worker. It no longer starts `convex dev`. Use `npm run dev:convex` only when changing/deploying the temporary Convex migration or admin functions.

Important environment variables:

- `DATABASE_URL`: PostgreSQL connection string used by the worker and migration tools.
- `VITE_WORKER_URL`: browser-visible worker origin during split local development.
- `PUBLIC_WORKER_URL`: browser-visible worker origin injected into the production runtime config; leave empty when the dashboard and worker share an origin.
- `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_REDIRECT_URI`: Twitch OAuth application settings.
- `TWITCH_TOKEN_ENCRYPTION_KEY`: base64-encoded 32-byte key for the local encrypted OAuth-token store.
- `TWITCH_TOKEN_STORE_PATH`: encrypted token file location.
- `CONVEX_URL`, `INGESTION_SECRET`: temporary server-side values used by the Convex importer and the transitional admin console.

Never prefix secrets with `VITE_`; Vite exposes those variables to browser code.

## Runtime architecture

```text
React dashboard
  -> worker /api/data endpoints (2-second refresh)
      -> PostgreSQL 18

Twitch EventSub WebSocket
  -> TwitchChatService
      -> PostgresStore
          -> PostgreSQL 18

/admin (temporary compatibility path)
  -> AdminService
      -> Convex

Convex migration source
  -> migration:exportPage
      -> scripts/migrate-convex-to-postgres.ts
          -> PostgreSQL 18
```

Incoming messages are uniquely constrained by `external_message_id`, providing durable duplicate protection. Channel state is polled every two seconds so changes made in the dashboard update EventSub subscriptions without requiring PostgreSQL-specific extensions or an additional message broker.

## Commands

```sh
npm run dev                 # dashboard + PostgreSQL-backed worker
npm run build               # TypeScript and production frontend build
npm test                    # unit tests
npm run lint                # ESLint
npm run db:migrate          # apply PostgreSQL migrations
npm run migrate:convex      # upsert every Convex table into PostgreSQL
npm run dev:convex          # temporary Convex development command
```

## Verification boundary

The repository build, lint, and unit tests validate TypeScript and application behavior without a live database. Before production cutover, run the migration and smoke-test against an actual PostgreSQL 18 instance. In particular, verify counts for `channels`, `chat_messages`, and the admin tables, then confirm a newly received Twitch message appears in PostgreSQL and in the dashboard.
