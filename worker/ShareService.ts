import { randomUUID } from "node:crypto";
import type { PostgresDatabase } from "./database";

export const SHARE_EXPIRATION_SECONDS = [
  300,
  3_600,
  14_400,
  28_800,
  57_600,
  86_400,
  604_800,
  2_592_000,
] as const;

const expirationSet = new Set<number>(SHARE_EXPIRATION_SECONDS);
const aliasPattern = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;
const MAX_PAGE_SEARCH_LENGTH = 50_000;

export class ShareRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class ShareService {
  constructor(private readonly database: PostgresDatabase) {}

  async availability(rawAlias: unknown) {
    const alias = parseAlias(rawAlias);
    const result = await this.database.query<{ available: boolean }>(`
      SELECT NOT EXISTS (
        SELECT 1
        FROM shared_page_links
        WHERE alias = $1 AND expires_at > now()
      ) AS available
    `, [alias]);
    return { alias, available: result.rows[0]?.available ?? true };
  }

  async create(input: unknown) {
    const value = isRecord(input) ? input : {};
    const alias = value.alias === undefined || value.alias === null || value.alias === ""
      ? randomUUID()
      : parseAlias(value.alias);
    const pageSearch = parsePageSearch(value.pageSearch);
    const expiresInSeconds = Number(value.expiresInSeconds);
    if (!expirationSet.has(expiresInSeconds)) {
      throw new ShareRequestError("Choose one of the available expiration times", 400);
    }

    await this.database.query("DELETE FROM shared_page_links WHERE expires_at <= now()");
    const result = await this.database.query<{ alias: string; expires_at: Date | string }>(`
      INSERT INTO shared_page_links (alias, page_search, expires_at)
      VALUES ($1, $2, now() + make_interval(secs => $3::integer))
      ON CONFLICT (alias) DO NOTHING
      RETURNING alias, expires_at
    `, [alias, pageSearch, expiresInSeconds]);
    const created = result.rows[0];
    if (!created) {
      throw new ShareRequestError("That custom link is already in use. Choose another one.", 409);
    }
    return {
      alias: created.alias,
      expiresAt: new Date(created.expires_at).getTime(),
    };
  }

  async resolve(rawAlias: unknown) {
    const alias = parseAlias(rawAlias);
    const result = await this.database.query<{
      page_search: string;
      expires_at: Date | string;
    }>(`
      SELECT page_search, expires_at
      FROM shared_page_links
      WHERE alias = $1 AND expires_at > now()
    `, [alias]);
    const share = result.rows[0];
    if (!share) {
      throw new ShareRequestError("This share link has expired or does not exist.", 404);
    }
    return {
      pageSearch: share.page_search,
      expiresAt: new Date(share.expires_at).getTime(),
    };
  }
}

function parseAlias(value: unknown) {
  const alias = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!aliasPattern.test(alias)) {
    throw new ShareRequestError(
      "Use 3–48 lowercase letters, numbers, or hyphens, without a hyphen at either end.",
      400,
    );
  }
  return alias;
}

function parsePageSearch(value: unknown) {
  if (typeof value !== "string" || value.length > MAX_PAGE_SEARCH_LENGTH ||
      (value !== "" && !value.startsWith("?"))) {
    throw new ShareRequestError("The page settings are too large or invalid", 400);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
