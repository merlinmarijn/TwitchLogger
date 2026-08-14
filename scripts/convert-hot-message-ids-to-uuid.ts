import "dotenv/config";
import { PostgresDatabase } from "../worker/database";

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const parsed = new URL(databaseUrl);
const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
if (!local && process.env.ALLOW_REMOTE_HOT_ID_UUID_MIGRATION !== "convert-verified-hot-ids") {
  throw new Error(
    "Refusing a remote ID conversion. Set ALLOW_REMOTE_HOT_ID_UUID_MIGRATION=convert-verified-hot-ids only during an authorized maintenance window.",
  );
}

const database = new PostgresDatabase(databaseUrl);
const client = await database.pool.connect();
try {
  const type = await client.query<{ type: string }>(`
    SELECT atttypid::regtype::text AS type
    FROM pg_attribute
    WHERE attrelid='chat_messages'::regclass AND attname='id' AND NOT attisdropped
  `);
  if (type.rows[0]?.type === "uuid") {
    console.log("chat_messages.id is already uuid.");
    process.exitCode = 0;
  } else {
    const invalid = await client.query<{ count: string }>(`
      SELECT count(*) AS count FROM chat_messages WHERE id !~* $1
    `, [UUID_PATTERN]);
    const invalidCount = Number(invalid.rows[0]?.count ?? 0);
    if (invalidCount > 0) {
      throw new Error(
        `UUID gate is closed: ${invalidCount} hot message IDs are still legacy CUIDs. Archive them naturally; do not rewrite them.`,
      );
    }
    const view = await client.query<{ definition: string }>(`
      SELECT pg_get_viewdef('chat_messages_expanded'::regclass, true) AS definition
    `);
    await client.query("BEGIN");
    await client.query("LOCK TABLE chat_messages IN ACCESS EXCLUSIVE MODE");
    await client.query("DROP VIEW chat_messages_expanded");
    await client.query("ALTER TABLE chat_messages ALTER COLUMN id TYPE uuid USING id::uuid");
    await client.query(`CREATE VIEW chat_messages_expanded AS ${view.rows[0].definition}`);
    await client.query("COMMIT");
    console.log("Converted chat_messages.id to uuid after the zero-legacy-ID gate passed.");
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await database.close();
}
