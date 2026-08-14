# Hot and cold storage optimization plan

## Decision

The current design is already substantially normalized and the compact cold catalog is a good foundation, but it is not yet optimal. Local measurements on the production snapshot found several changes that improve space and speed together. This document is the only source change produced by the investigation; all benchmark schema objects and scripts were disposable.

The recommendations below deliberately exclude ideas that lost the local comparison: daily partitioning, a per-message cold UUID table, Brotli quality 11, Zstandard, and a new raw-event format.

## Dataset and baseline

Snapshot date: 2026-08-14. PostgreSQL source version: 18.4. Local test version: PostgreSQL 18.6.

- 209,212 chat messages across 4 channels and 3,072 sender profiles.
- Messages span 2026-07-17 through 2026-08-14.
- 283 messages have images; 6 messages are deleted.
- All 209,212 Twitch `external_message_id` values cast cleanly to `uuid`.
- 191,219 internal message IDs are UUIDs. The remaining 17,993 are legacy CUIDs from 2026-07-17 through 2026-07-20.
- The production snapshot has no cold-message chunks yet because it is younger than the 90-day cutoff. For cold tests, the local timestamps were shifted by 100 days and all 209,212 real messages were archived into 116 verified chunks.

### Current hot storage

| Relation | Heap/TOAST | Indexes | Total |
|---|---:|---:|---:|
| `chat_messages` | 48 MB | 84 MB | 132 MB |

The largest hot indexes are the channel page index (23 MB), message trigram index (17 MB), global page index (13 MB), external-message unique index (12 MB), and primary key (12 MB). Average tuple size is 229.9 bytes.

### Current cold storage after archiving the snapshot locally

| Component | Size |
|---|---:|
| Brotli payload and chunk rows | about 16 MB |
| Chunk UUID arrays plus GIN index | about 15 MB |
| Sender statistics and indexes | 3.7 MB |

The cold payload represents 152 MB of canonical JSON in 15.97 MB, a 10.0% ratio. The current cold design therefore reduces the live chat relation from 132 MB to roughly 35 MB, excluding reusable-but-not-returned hot relation pages.

## Recommended work

### 1. Compact hot identifiers and foreign keys

Implement this in staged, verified migrations rather than a single destructive rewrite.

1. Change `chat_messages.external_message_id` from `text` to native `uuid`. Apply the same type to active raw staging and any remaining relational cold/legacy external-message columns. All snapshot values passed `::uuid` validation.
2. Add a compact integer storage key to `channels`. Keep the existing text ID as the public/application identifier, but store the integer key in `chat_messages` and cold chunk metadata.
3. Stop repeating `chat_messages.channel_id`. It is already functionally determined by the channel/channel-profile dimensions. Backfill and index the compact channel key, update reads and inserts, verify equality, then drop the repeated text column and its foreign key.
4. Narrow `chat_senders.id`, `chat_sender_profiles.id`, `chat_channel_profiles.id`, and `chat_badge_sets.id` plus their referencing columns from `bigint` to `integer`. Current cardinalities are only 3,044, 3,072, 4, and 1,402 respectively; retain explicit preflight checks against the integer maximum.
5. Keep the current nullable JSONB strategy. `image_urls`, `hidden_image_urls`, and `native_emotes` are already stored as `NULL` for the overwhelmingly common empty case.
6. Keep the message trigram index and the four partial page/gallery indexes. They materially help the measured workload.

A shadow table with native external UUIDs, no repeated channel text, and integer dimension keys measured 105 MB versus 132 MB (20.1% smaller) while internal IDs remained text.

#### UUID internal-ID gate

Do not rewrite legacy CUIDs merely to save space. Once the 17,993 legacy rows have naturally crossed the 90-day boundary and moved to cold storage, require this precondition:

```sql
SELECT count(*)
FROM chat_messages
WHERE id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
```

Only when it returns zero, change the hot `id` to `uuid` and rebuild its dependent page indexes. PostgreSQL's Node driver will still expose UUIDs as strings, so API and cursor shapes need not change. The measured steady-state shadow layout was 88 MB (31 MB heap and 57 MB indexes), 33.2% smaller than today. Keeping the existing lean sender index rather than adding `id` to it should put the target near 84–88 MB.

### 2. Select and limit hot rows before dimension expansion

`chat_messages_expanded` currently allows selective filters to be applied after several dimension joins. Resolve small dimension matches first, select the page from the base `chat_messages` table, apply `ORDER BY timestamp DESC, id DESC` and `LIMIT`, and only then join the selected rows to channel, sender, badge, and message-type dimensions.

For quick search:

1. Query the small sender-profile and channel-profile dimensions using their trigram indexes.
2. Pass the matching integer profile/channel keys into the base message query.
3. Search `lower(message_text)` with the existing trigram GIN index, OR it with the pre-resolved profile/channel keys, and limit before expansion.
4. Preserve the exact existing browser/worker filter semantics and bounded JavaScript post-filter behavior.

Measured results on warm local storage:

| Query | Current | Revised shape | Improvement |
|---|---:|---:|---:|
| Rare combined quick search (`allegations`) | 199.1 ms | 5.2 ms | 38x |
| Exact/common sender through expanded view | 40.6 ms | 3.6 ms pre-resolved, 1.15 ms base scan | 11x or better |
| Latest global page | 3.8 ms | base page scan 0.07 ms before expansion | less join work |

Do not add `id` to `chat_messages_sender_profile_timestamp_idx`: it grew the shadow index from 6.3 MB to about 10 MB, while the existing index already returned a pre-resolved sender page in 1.15 ms using incremental sort.

### 3. Add cold codec v3 with dictionaries and positional rows

Keep Brotli quality 9, but replace repeated expanded JSON objects with a versioned canonical format:

- one channel header per chunk;
- immutable sender-profile dictionary;
- badge-set dictionary;
- message-type dictionary;
- positional message rows;
- timestamps stored as a base plus deltas;
- role booleans packed into the existing bit flags;
- `has_images` derived from image URLs;
- empty hidden-image arrays represented compactly.

The decoder must reconstruct the exact existing `ArchivedMessageRow` shape. Keep v1/v2 readers until every older chunk is verified and re-encoded by the existing resumable `archive_reencode` job.

On all 209,212 real messages, this format produced byte-for-byte equivalent decoded records and measured:

- uncompressed representation: 159,639,244 to 35,459,972 bytes (77.8% smaller);
- Brotli-9 payload: 15,972,186 to 14,989,090 bytes (6.2% smaller);
- decode/decompress/parse of all chunks: 1,685 ms to 394 ms (4.27x faster).

Use a maximum of 2,000 records per compressed block rather than the current effective maximum of 6,792. The measured 2,000-row variant produced:

- 186 blocks;
- 15,397,609 compressed bytes, still 3.6% smaller than the current v2 payload;
- maximum compressed block size of 156,868 bytes instead of 498,501 bytes;
- 17,653 sender-stat rows instead of 13,234.

This is the best measured space/latency balance. The 1,000-row variant made 280 blocks and 15,732,249 payload bytes, while raising sender-stat rows to 21,901; the extra metadata is not justified unless later production latency data requires it.

### 4. Add a sparse relational projection for cold image messages

Create a `chat_message_cold_images` projection containing only active image messages. Store the chunk ID, message ID, compact channel key, timestamp, and the reconstructed client record (or equivalently compact typed columns). Add global and channel keyset indexes on `(timestamp DESC, id DESC)`.

Update this projection transactionally when a chunk is written, re-encoded, deleted, image-hidden, reindexed, or deduplicated. Extend cold integrity verification to compare it with decoded chunks. Deleted messages should be removed from the active projection while remaining tombstoned in the canonical chunk.

On the snapshot, the projection held 277 active image messages and occupied 532,480 bytes including its primary key and two page indexes.

| Cold gallery query | Current chunk scan | Sparse projection |
|---|---:|---:|
| Global first 100 | 1,487.8 ms | 2.24 ms |
| Channel first 100 | comparable chunk scan | 2.03 ms |

This is a roughly 660x improvement for about half a megabyte at the observed 0.14% image-message density.

### 5. Keep the cold UUID-array GIN, but force the intended plan locally

Do not replace `chat_message_cold_chunk_keys` with one UUID row per message. The tested relational alternative occupied 21 MB versus 15 MB for the current array-plus-GIN design.

PostgreSQL currently underprices sequential scans because it ignores the cost of detoasting the large arrays. With 116 chunk rows it chose a 2.1–2.6 ms sequential scan even though the GIN path ran in 0.03 ms.

Add narrowly scoped SQL functions for cold external-ID lookup/overlap with `SET enable_seqscan = off` on the function, and call those functions from ingestion, mutation, and archive duplicate checks. Do not change the session/global planner setting. A function-scoped GIN lookup completed 200 missing-ID checks in 4.49 ms versus 427.7 ms for the current query (95x faster) without adding storage.

Keep exact UUID arrays so collisions remain impossible. Hash arrays saved only 2.5–3.4 MB because the GIN index remained about 11 MB, while adding collision-verification complexity.

### 6. Simplify compact cold sender statistics

After all legacy chunks have been converted and verified:

- change chunk IDs from text UUIDs to native `uuid`;
- remove the unnecessary surrogate `id` and its primary-key index;
- remove legacy nullable username/display-name columns and their empty trigram indexes;
- narrow `sender_profile_id` to `integer`;
- use `(chunk_id, sender_profile_id)` as the primary key;
- retain `(sender_profile_id, last_timestamp DESC)` for suggestions.

The same 13,234 sender-stat rows measured 2.024 MB in this layout versus 3.712 MB currently (45.5% smaller). With 2,000-message blocks the row count rises, but the simplified layout remains smaller than the existing schema.

If production has acquired legacy cold chunks before implementation, migrate and verify them before dropping compatibility columns or tables. Never assume they are empty without a transactionally consistent check.

### 7. Bound the decoded cold cache

`ColdMessageArchiveService.decodedChunks` is currently an unbounded `Map`. Replace it with an LRU cache governed by both a chunk count and approximate byte budget. Start with 32 decoded blocks and 64 MB, expose hit/miss/eviction metrics, and make the limits configurable. Cache compact parsed blocks and reconstruct only returned records where practical.

This prevents a long-running worker from retaining the entire archive after users browse old pages while preserving the measured 2–4 ms warm-page behavior.

### 8. Reclaim hot index bloat by threshold, not partitioning

Archival deletes old timestamp ranges while ingestion adds new ranges. In a local half-retention cycle, the time-ordered indexes grew despite `VACUUM`:

- channel page index: 33.1 MB to 48.5 MB;
- global page index: 19.8 MB to 29.1 MB;
- sender/timestamp index: 9.1 MB to 12.3 MB.

A reindex returned the test relation from 190 MB to 132 MB in 2.54 seconds. Add an admin maintenance operation that measures these indexes and runs `REINDEX INDEX CONCURRENTLY` individually when reclaimable space exceeds both 25% and a useful absolute threshold such as 16 MB. It must be resumable, cancellable between indexes, and must check available disk space before each concurrent rebuild.

Do not partition the hot table now. The measured daily-partition prototype used 150 MB instead of 132 MB before cycling, reached 209 MB with incrementally built replacement partitions, and raised planning to about 5–7 ms. Revisit monthly partitioning only if the hot set becomes large enough that concurrent reindexing no longer fits the maintenance window.

## Explicit non-recommendations

- Keep Brotli quality 9. Quality 11 saved about 6–10% of payload bytes but took 26–50x more compression CPU. Zstandard was larger at comparable settings.
- Keep raw archive codec v1. A positional raw wrapper saved only 0.99% compressed space and improved decode/parse by only 13%, which does not justify another compatibility codec.
- Keep the message trigram GIN index. It turned a representative message-only substring query into a roughly 6 ms indexed query and is essential after the quick-search rewrite.
- Do not add a full per-message cold catalog again.
- Do not use lossy 32/64-bit hashes when exact UUID arrays already work.

## Required migration and verification gates

1. Refuse every destructive benchmark or migration unless `DATABASE_URL` resolves to localhost during development.
2. Record row counts, minimum/maximum timestamps, relation/index sizes, and the archive verification results before migration.
3. Backfill in bounded batches with durable progress; verify each old/new representation before swapping reads.
4. Preserve old cold decoders until every chunk has been checksum-verified after re-encoding.
5. Compare old and new API results for randomized global, channel, cursor, gallery, sender, quick-search, saved-filter, deletion, image-hide, and suggestion cases.
6. Run `archive:verify`, `archive:verify-cold`, migrations from an empty database and from the copied production database, `npm test`, `npm run lint`, and `npm run build`.
7. Re-run `EXPLAIN (ANALYZE, BUFFERS)` and storage measurements. Treat these as minimum acceptance targets on the copied snapshot:
   - compact hot table at or below 105 MB before the internal UUID gate;
   - steady-state UUID hot table at or below 90 MB;
   - rare combined quick search below 10 ms warm;
   - cold codec round-trip equality for every record and at least 3x faster full decode/parse;
   - cold global/channel gallery first page below 10 ms warm;
   - 200 missing cold duplicate checks below 15 ms;
   - no row-count, tombstone, image-suppression, archive-checksum, or pagination-order changes.
8. Reset the local database from `production-baseline.dump` after destructive tests.
9. Do not deploy or mutate production as part of implementation unless separately and explicitly authorized.

## One-shot implementation prompt

```text
Implement the complete, evidence-backed database optimization described in optimization-plan.md in this TwitchLogger repository. Work autonomously and do not stop at a partial refactor.

Safety and scope:
- Use only the Docker-backed local PostgreSQL copy. Assert DATABASE_URL is localhost before any destructive command. Do not connect to, migrate, re-encode, or write to production.
- Preserve existing behavior and public API/cursor shapes. All migrations and archive conversions must be restartable, idempotent, and integrity-checked.
- Use the existing production-baseline dump to reset between destructive benchmarks.
- Do not implement the rejected alternatives: daily partitioning, a per-message cold UUID catalog, hash-only cold IDs, Brotli 11, Zstandard, a new raw-event codec, or an id-expanded sender index.

Implement all of these items:
1. Stage hot-schema compaction: native UUID external message IDs, compact integer channel storage keys, removal of repeated chat_messages.channel_id, and integer dimension/FK keys. Backfill and verify before swapping reads or dropping old columns.
2. Add the guarded hot internal-ID UUID migration path, but execute the type swap only when the non-UUID hot-ID preflight count is zero. Until then, leave the gate and operational instructions in place without rewriting legacy CUIDs.
3. Refactor hot paging/search so matching sender/channel dimension keys and base message rows are selected and limited before joining the expanded dimensions. Preserve every filter semantic and post-filter bound.
4. Implement versioned cold codec v3 using chunk dictionaries, positional rows, timestamp deltas, packed roles, and derived booleans. Support old codecs, use Brotli quality 9, cap new compressed blocks at 2,000 messages, and extend the resumable archive_reencode job to convert and verify old chunks.
5. Add and transactionally maintain the sparse chat_message_cold_images projection with global/channel keyset indexes and integrity verification. Use it for cold gallery pagination.
6. Keep UUID arrays plus GIN for cold external-ID membership, but route lookup/overlap through narrowly scoped SQL functions whose function-local planner setting forces the GIN path. Never change global/session planner behavior.
7. Simplify compact cold sender stats after verified legacy conversion: UUID chunk IDs, integer sender profile IDs, no surrogate ID, no legacy text columns/indexes, composite primary key, and the retained sender/timestamp suggestion index.
8. Replace the unbounded decoded-chunk Map with a configurable byte-and-count-bounded LRU cache and metrics.
9. Add a cancellable admin maintenance job that measures the time-ordered hot indexes and runs REINDEX INDEX CONCURRENTLY one index at a time only above the documented percentage and absolute thresholds, with disk-space checks.

Testing and evidence:
- Add migration, codec round-trip, legacy compatibility, crash/restart, pagination equivalence, mutation/projection consistency, LRU, and planner-function tests.
- Run both empty-database and copied-production-database migrations.
- Run archive:verify, archive:verify-cold, npm test, npm run lint, and npm run build.
- Reproduce the acceptance measurements in optimization-plan.md with EXPLAIN (ANALYZE, BUFFERS), exact relation sizes, and archive byte counts. If a proposed implementation misses a gate, keep iterating rather than weakening the requirement.
- Finish with a concise report of changed files, migration order, measured before/after results, remaining internal-UUID gate status, and the exact safe production rollout/rollback procedure. Do not deploy it.
```
