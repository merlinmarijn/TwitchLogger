import "dotenv/config";
import { PostgresDatabase } from "../worker/database";

if (!process.argv.includes("--confirm")) {
  throw new Error(
    "Refusing to enable the 90-day cold archive without --confirm. Run archive:verify-cold first.",
  );
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const database = new PostgresDatabase(databaseUrl);
try {
  const rawPending = await database.query<{ count: string }>(`
    SELECT count(*)::bigint AS count
    FROM chat_raw_events
    WHERE timestamp < $1
  `, [Date.now() - 90 * 86_400_000]);
  if (Number(rawPending.rows[0].count) !== 0) {
    throw new Error(
      "Refusing to enable cold archival while eligible raw events are still staged",
    );
  }
  const result = await database.query<{ enabled: boolean }>(`
    UPDATE archive_settings
    SET enabled = true, updated_at = $1
    WHERE key = 'cold_message_archive'
    RETURNING enabled
  `, [Date.now()]);
  if (result.rows[0]?.enabled !== true) {
    throw new Error("The cold_message_archive setting could not be enabled");
  }
  console.log("The verified 90-day cold-message archive is enabled.");
} finally {
  await database.close();
}
