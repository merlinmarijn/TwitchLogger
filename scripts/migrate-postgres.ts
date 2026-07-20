import "dotenv/config";
import { PostgresDatabase } from "../worker/database";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const database = new PostgresDatabase(databaseUrl);
try {
  await database.migrate();
  console.log("PostgreSQL schema is current.");
} finally {
  await database.close();
}
