import "dotenv/config";
import { PostgresDatabase } from "../worker/database";

if (!process.argv.includes("--confirm")) {
  throw new Error(
    "Refusing to enable source cleanup without --confirm. Run archive:verify first.",
  );
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const database = new PostgresDatabase(databaseUrl);
try {
  const invalid = await database.query<{ count: string }>(`
    SELECT count(*)::bigint AS count
    FROM chat_raw_event_chunks
    WHERE source_cleared_at IS NULL
      AND (
        octet_length(payload) <> compressed_bytes OR
        message_count <= 0 OR
        uncompressed_bytes <= 0
      )
  `);
  if (Number(invalid.rows[0].count) !== 0) {
    throw new Error("Refusing to enable cleanup because an archive manifest is invalid");
  }
  const result = await database.query<{ enabled: boolean }>(`
    UPDATE archive_settings
    SET enabled = true, updated_at = $1
    WHERE key = 'raw_source_cleanup'
    RETURNING enabled
  `, [Date.now()]);
  if (result.rows[0]?.enabled !== true) {
    throw new Error("The raw_source_cleanup setting could not be enabled");
  }
  console.log("Raw-event source cleanup is enabled.");
} finally {
  await database.close();
}
