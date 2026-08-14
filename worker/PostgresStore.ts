import { randomUUID } from "node:crypto";
import { extractImageUrls, IMAGE_INDEX_VERSION, upgradeGalleryFilterPattern } from "../shared/imageUrls";
import { compactNativeEmotes, type NativeEmote } from "../shared/nativeEmotes";
import {
  filterRuleError,
  matchesMessageFilter,
  matchesMessageSelection,
  operatorsForField,
  type FilterRule,
  type MessageFilter,
} from "../shared/messageFilters";
import type { ChatRepository, ChannelStatus } from "./ChatRepository";
import {
  ColdMessageArchiveService,
  type ColdArchiveCursor,
} from "./ColdMessageArchiveService";
import type { PostgresDatabase } from "./database";
import type { Logger } from "./logger";
import {
  compileMessageSelectionSql,
  type ResolvedMessageDimensions,
} from "./messageSearchSql";
import {
  RemoteImageDetector,
  type RemoteImageDetectorLike,
} from "./RemoteImageDetector";
import type { FollowedChannel, ResolvedChannel, TwitchChatMessage } from "./types";

const twitchLoginPattern = /^[a-z0-9_]{1,25}$/;
const MAX_CHAT_TABS = 20;
const MAX_MESSAGE_SCAN = 1_000;

export interface MessagePageArgs {
  channelId?: string;
  tabId?: string;
  quickSearch?: string;
  filters?: MessageFilter[];
  afterTimestamp?: number;
  paginationOpts: { numItems: number; cursor?: string | null };
}

export interface ChatTabInput {
  id: string;
  name: string;
  layout: "chat" | "gallery" | "scores";
  match: "all" | "any";
  rules: FilterRule[];
}

export interface HiddenImageInput {
  messageId: string;
  url: string;
}

export interface MessageSuggestionArgs {
  text: string;
  channelId?: string;
  limit?: number;
}

interface MessageRow {
  id: string;
  external_channel_id: string;
  channel_name: string;
  sender_username: string;
  sender_display_name: string;
  message_text: string;
  timestamp: string | number;
  badges: Array<{ setId: string; id: string; info: string }>;
  user_color: string | null;
  is_broadcaster: boolean;
  is_moderator: boolean;
  is_subscriber: boolean;
  is_vip: boolean;
  message_type: string;
  image_urls: string[] | null;
  native_emotes?: NativeEmote[] | null;
  metadata?: Record<string, unknown> | null;
}

export class PostgresStore implements ChatRepository {
  private poll?: ReturnType<typeof setInterval>;
  private channelSnapshot = "";
  private readonly coldArchive: ColdMessageArchiveService;

  constructor(
    private readonly database: PostgresDatabase,
    private readonly logger: Logger,
    coldArchive?: ColdMessageArchiveService,
    private readonly remoteImageDetector: RemoteImageDetectorLike = new RemoteImageDetector(),
  ) {
    this.coldArchive = coldArchive ?? new ColdMessageArchiveService(database, logger);
  }

  watchLoggingChannels(
    onUpdate: (channels: FollowedChannel[]) => void,
    onError: (error: Error) => void,
  ) {
    let stopped = false;
    const refresh = async () => {
      try {
        const channels = await this.listLoggingChannels();
        const snapshot = JSON.stringify(channels);
        if (!stopped && snapshot !== this.channelSnapshot) {
          this.channelSnapshot = snapshot;
          onUpdate(channels);
        }
      } catch (error) {
        if (!stopped) onError(asError(error));
      }
    };
    void refresh();
    this.poll = setInterval(() => void refresh(), 2_000);
    this.poll.unref();
    return () => {
      stopped = true;
      if (this.poll) clearInterval(this.poll);
    };
  }

  async listLoggingChannels(): Promise<FollowedChannel[]> {
    const result = await this.database.query<{
      id: string;
      platform: string;
      external_channel_id: string | null;
      username: string;
      display_name: string;
      logging_enabled: boolean;
      connection_status: string;
    }>(`
      SELECT id, platform, external_channel_id, username, display_name,
             logging_enabled, connection_status
      FROM channels
      WHERE logging_enabled = true AND hidden_at IS NULL
      ORDER BY created_at
    `);
    return result.rows.map((row) => ({
      _id: row.id,
      platform: row.platform,
      ...(row.external_channel_id ? { externalChannelId: row.external_channel_id } : {}),
      username: row.username,
      displayName: row.display_name,
      loggingEnabled: row.logging_enabled,
      connectionStatus: row.connection_status,
    }));
  }

  async saveResolvedChannel(channel: ResolvedChannel) {
    await this.database.query(`
      UPDATE channels
      SET external_channel_id = $2, username = $3, display_name = $4, updated_at = $5
      WHERE id = $1
    `, [channel.storageId, channel.twitchId, channel.username, channel.displayName, Date.now()]);
  }

  async setConnectionStatus(id: string, status: ChannelStatus, error?: string) {
    const now = Date.now();
    await this.database.query(`
      UPDATE channels
      SET connection_status = $2,
          connection_error = $3,
          last_connected_at = CASE WHEN $2 = 'connected' THEN $4 ELSE last_connected_at END,
          updated_at = $4
      WHERE id = $1
    `, [id, status, error ?? null, now]);
  }

  async insertMessage(channel: ResolvedChannel, message: TwitchChatMessage) {
    const imageUrls = extractImageUrls(message.messageText);
    let insertedMessageId: string | undefined;
    const now = Date.now();
    const timestamp = message.messageTimestamp.getTime();
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const archived = await client.query(`
        SELECT 1
        FROM chat_message_cold_catalog
        WHERE external_message_id = $1::uuid
        UNION ALL
        SELECT 1
        FROM find_cold_message_chunk($1::uuid)
        LIMIT 1
      `, [message.messageId]);
      if (archived.rowCount) {
        await client.query("ROLLBACK");
        this.logger.debug({ messageId: message.messageId }, "Ignored archived duplicate chat message");
        return;
      }
      let messageTypeId = (await client.query<{ id: number }>(`
        SELECT id
        FROM chat_message_types
        WHERE name = $1
      `, [message.messageType])).rows[0]?.id;
      if (messageTypeId === undefined) {
        const messageType = await client.query<{ id: number }>(`
          INSERT INTO chat_message_types (name)
          VALUES ($1)
          ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
          RETURNING id
        `, [message.messageType]);
        messageTypeId = messageType.rows[0].id;
      }
      const roleFlags =
        (message.isBroadcaster ? 1 : 0) |
        (message.isModerator ? 2 : 0) |
        (message.isSubscriber ? 4 : 0) |
        (message.isVip ? 8 : 0);
      const result = await client.query<{ id: string }>(`
        WITH sender AS (
          INSERT INTO chat_senders (external_user_id)
          VALUES ($4)
          ON CONFLICT (external_user_id) DO UPDATE
          SET external_user_id = EXCLUDED.external_user_id
          RETURNING id
        ), sender_profile AS (
          INSERT INTO chat_sender_profiles (
            sender_id, username, display_name, user_color
          )
          SELECT id, $5, $6, $7 FROM sender
          ON CONFLICT ON CONSTRAINT chat_sender_profiles_identity_key DO UPDATE
          SET username = EXCLUDED.username
          RETURNING id
        ), channel_storage AS (
          SELECT storage_key FROM channels WHERE id = $2
        ), channel_profile AS (
          INSERT INTO chat_channel_profiles (
            channel_id, external_channel_id, username
          ) VALUES ($2, $9, $10)
          ON CONFLICT ON CONSTRAINT chat_channel_profiles_identity_key DO UPDATE
          SET username = EXCLUDED.username
          RETURNING id
        ), badge_set AS (
          INSERT INTO chat_badge_sets (badges)
          VALUES ($11::jsonb)
          ON CONFLICT (badges) DO UPDATE SET badges = EXCLUDED.badges
          RETURNING id
        ), message_kind AS (
          SELECT $12::integer AS id
        )
        INSERT INTO chat_messages (
          id, channel_key, external_message_id, sender_profile_id,
          channel_profile_id, badge_set_id, message_type_id, role_flags,
          message_text, has_images, image_urls, image_index_version,
          timestamp, native_emotes
        )
        SELECT $1, channel_storage.storage_key, $3, sender_profile.id, channel_profile.id,
          badge_set.id, message_kind.id, $13, $14, $15, $16::jsonb,
          $17, $8, $18::jsonb
        FROM sender_profile, channel_storage, channel_profile, badge_set, message_kind
        ON CONFLICT (external_message_id) DO NOTHING
        RETURNING id
      `, [
        randomUUID(), channel.storageId, message.messageId, message.userId,
        message.username, message.displayName, message.userColor ?? null, timestamp,
        message.channelId, message.channelName, JSON.stringify(message.badges),
        messageTypeId, roleFlags, message.messageText, imageUrls.length > 0,
        imageUrls.length > 0 ? JSON.stringify(imageUrls) : null, IMAGE_INDEX_VERSION,
        message.nativeEmotes.length > 0 ? JSON.stringify(message.nativeEmotes) : null,
      ]);
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        this.logger.debug({ messageId: message.messageId }, "Ignored duplicate chat message");
        return;
      }
      insertedMessageId = result.rows[0].id;
      await client.query(`
        INSERT INTO chat_raw_events (
          external_message_id, event_notification_id, channel_id,
          timestamp, raw_message_data, created_at
        ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      `, [
        message.messageId,
        message.eventNotificationId,
        channel.storageId,
        timestamp,
        JSON.stringify(message.rawMessageData),
        now,
      ]);
      await client.query(`
        UPDATE channels
        SET last_message_at = $2, connection_status = 'connected',
            connection_error = NULL, updated_at = $3
        WHERE id = $1
      `, [channel.storageId, timestamp, now]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (insertedMessageId) {
      void this.indexRemoteImages(
        insertedMessageId,
        message.messageText,
        imageUrls,
      );
    }
  }

  private async indexRemoteImages(
    messageId: string,
    messageText: string,
    knownImageUrls: readonly string[],
  ) {
    try {
      const detectedUrls = await this.remoteImageDetector.detectImageUrls(
        messageText,
        knownImageUrls,
      );
      for (const url of detectedUrls) {
        await this.database.query(`
          UPDATE chat_messages
          SET image_urls = COALESCE(image_urls, '[]'::jsonb) || jsonb_build_array($2::text),
              has_images = true
          WHERE id = $1 AND deleted_at IS NULL
            AND NOT (COALESCE(image_urls, '[]'::jsonb) ? $2::text)
            AND NOT (COALESCE(hidden_image_urls, '[]'::jsonb) ? $2::text)
        `, [messageId, url]);
      }
      if (detectedUrls.length > 0) {
        this.logger.debug(
          { messageId, imageUrls: detectedUrls },
          "Automatically indexed extensionless image links",
        );
      }
    } catch (error) {
      this.logger.debug(
        { err: error, messageId },
        "Could not inspect remote links for images",
      );
    }
  }

  async ensurePlatformSeeded() {
    const now = Date.now();
    await this.database.query(`
      INSERT INTO platforms (id, name, slug, enabled, created_at)
      VALUES ($1, 'Twitch', 'twitch', true, $2)
      ON CONFLICT (slug) DO NOTHING
    `, [randomUUID(), now]);
  }

  async listChannels() {
    const result = await this.database.query<{
      id: string; platform: "twitch"; external_channel_id: string | null;
      username: string; display_name: string; logging_enabled: boolean;
      connection_status: ChannelStatus; connection_error: string | null;
      last_message_at: string | null;
    }>(`
      SELECT id, platform, external_channel_id, username, display_name,
             logging_enabled, connection_status, connection_error, last_message_at
      FROM channels WHERE hidden_at IS NULL ORDER BY created_at
    `);
    return result.rows.map((row) => ({
      _id: row.id,
      platform: row.platform,
      ...(row.external_channel_id ? { externalChannelId: row.external_channel_id } : {}),
      username: row.username,
      displayName: row.display_name,
      loggingEnabled: row.logging_enabled,
      connectionStatus: row.connection_status,
      ...(row.connection_error ? { connectionError: row.connection_error } : {}),
      ...(row.last_message_at ? { lastMessageAt: Number(row.last_message_at) } : {}),
    }));
  }

  async addChannel(input: {
    platform: "twitch"; username: string; displayName?: string; loggingEnabled: boolean;
  }) {
    const username = input.username.trim().toLowerCase().replace(/^@/, "");
    if (!twitchLoginPattern.test(username)) throw new Error("Enter a valid Twitch username");
    const now = Date.now();
    const id = randomUUID();
    const result = await this.database.query<{ id: string }>(`
      INSERT INTO channels (
        id, platform, username, display_name, logging_enabled, connection_status,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
      ON CONFLICT (platform, username) DO UPDATE SET
        display_name = CASE WHEN channels.hidden_at IS NULL THEN channels.display_name ELSE EXCLUDED.display_name END,
        logging_enabled = CASE WHEN channels.hidden_at IS NULL THEN channels.logging_enabled ELSE EXCLUDED.logging_enabled END,
        connection_status = CASE WHEN channels.hidden_at IS NULL THEN channels.connection_status ELSE EXCLUDED.connection_status END,
        connection_error = CASE WHEN channels.hidden_at IS NULL THEN channels.connection_error ELSE NULL END,
        hidden_at = NULL,
        updated_at = EXCLUDED.updated_at
      WHERE channels.hidden_at IS NOT NULL
      RETURNING id
    `, [
      id, input.platform, username, input.displayName?.trim() || username,
      input.loggingEnabled, input.loggingEnabled ? "connecting" : "disconnected", now,
    ]);
    if (!result.rows[0]) throw new Error("That channel is already followed");
    this.channelSnapshot = "";
    return result.rows[0].id;
  }

  async setLogging(id: string, enabled: boolean) {
    await this.requireChannelUpdate(id, `
      UPDATE channels SET logging_enabled = $2, connection_status = $3,
        connection_error = NULL, updated_at = $4 WHERE id = $1 RETURNING id
    `, [id, enabled, enabled ? "connecting" : "disconnected", Date.now()]);
  }

  async reconnect(id: string) {
    await this.setLogging(id, true);
  }

  async removeChannel(id: string) {
    await this.requireChannelUpdate(id,
      "UPDATE channels SET hidden_at = $2, updated_at = $2 WHERE id = $1 RETURNING id",
      [id, Date.now()],
    );
  }

  async listChatTabs() {
    const result = await this.database.query<{
      client_id: string; name: string; layout: "chat" | "gallery" | "scores";
      match: "all" | "any"; rules: FilterRule[]; revision: string;
      indexed_revision: string | null; index_status: "building" | "ready";
    }>(`
      SELECT client_id, name, layout, match, rules, revision,
             indexed_revision, index_status
      FROM chat_tabs ORDER BY created_at LIMIT $1
    `, [MAX_CHAT_TABS]);
    return result.rows.map((row) => ({
      id: row.client_id,
      name: row.name,
      layout: row.layout,
      match: row.match,
      rules: row.rules,
      revision: Number(row.revision),
      indexedRevision: Number(row.indexed_revision ?? row.revision),
      indexStatus: "ready" as const,
    }));
  }

  async saveChatTab(tab: ChatTabInput) {
    validateTab(tab);
    const now = Date.now();
    const existing = await this.database.query<{
      id: string; match: string; rules: FilterRule[]; revision: string;
    }>("SELECT id, match, rules, revision FROM chat_tabs WHERE client_id = $1", [tab.id]);
    if (!existing.rows[0]) {
      const count = await this.database.query<{ count: string }>("SELECT count(*) FROM chat_tabs");
      if (Number(count.rows[0].count) >= MAX_CHAT_TABS) {
        throw new Error(`Chat tabs are limited to ${MAX_CHAT_TABS}`);
      }
      await this.database.query(`
        INSERT INTO chat_tabs (
          id, client_id, name, layout, match, rules, revision, indexed_revision,
          index_status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1, 1, 'ready', $7, $7)
      `, [randomUUID(), tab.id, tab.name.trim(), tab.layout, tab.match, JSON.stringify(tab.rules), now]);
      return;
    }
    const row = existing.rows[0];
    const changed = JSON.stringify({ match: row.match, rules: row.rules }) !==
      JSON.stringify({ match: tab.match, rules: tab.rules });
    const revision = Number(row.revision) + (changed ? 1 : 0);
    await this.database.query(`
      UPDATE chat_tabs SET name = $2, layout = $3, match = $4, rules = $5::jsonb,
        revision = $6, indexed_revision = $6, index_status = 'ready', updated_at = $7
      WHERE id = $1
    `, [row.id, tab.name.trim(), tab.layout, tab.match, JSON.stringify(tab.rules), revision, now]);
  }

  async importChatTabs(tabs: ChatTabInput[]) {
    for (const tab of tabs.slice(0, MAX_CHAT_TABS)) {
      const existing = await this.database.query("SELECT 1 FROM chat_tabs WHERE client_id = $1", [tab.id]);
      if (!existing.rowCount) await this.saveChatTab(tab);
    }
  }

  async removeChatTab(clientId: string) {
    await this.database.query("DELETE FROM chat_tabs WHERE client_id = $1", [clientId]);
  }

  async deleteMessages(messageIds: string[]) {
    if (messageIds.length === 0) return 0;
    const deletedAt = Date.now();
    const result = await this.database.query<{ id: string }>(`
      UPDATE chat_messages
      SET deleted_at = $2
      WHERE id = ANY($1::text[]) AND deleted_at IS NULL
      RETURNING id
    `, [messageIds, deletedAt]);
    if ((result.rowCount ?? 0) === messageIds.length) return result.rowCount ?? 0;
    const hotIds = new Set(result.rows.map((row) => row.id));
    const coldDeleted = await this.coldArchive.deleteMessages(
      messageIds.filter((id) => !hotIds.has(id)),
      deletedAt,
    );
    return (result.rowCount ?? 0) + coldDeleted;
  }

  async hideMessageImages(images: HiddenImageInput[]) {
    let hidden = 0;
    const coldCandidates: HiddenImageInput[] = [];
    for (const image of images) {
      const result = await this.database.query<{ id: string }>(`
        UPDATE chat_messages
        SET image_urls = NULLIF(
              COALESCE(image_urls, '[]'::jsonb) - $2::text,
              '[]'::jsonb
            ),
            hidden_image_urls = CASE
              WHEN COALESCE(hidden_image_urls, '[]'::jsonb) ? $2::text
                THEN hidden_image_urls
              ELSE COALESCE(hidden_image_urls, '[]'::jsonb) || jsonb_build_array($2::text)
            END,
            has_images = jsonb_array_length(COALESCE(image_urls, '[]'::jsonb) - $2::text) > 0
        WHERE id = $1
          AND deleted_at IS NULL
          AND COALESCE(image_urls, '[]'::jsonb) ? $2::text
        RETURNING id
      `, [image.messageId, image.url]);
      if (result.rowCount) hidden += result.rowCount;
      else coldCandidates.push(image);
    }
    return hidden + await this.coldArchive.hideMessageImages(coldCandidates);
  }

  async pageMessages(args: MessagePageArgs, imagesOnly: boolean, gameScoresOnly = false) {
    const normalized = validateMessagePageArgs(args);
    const requested = normalized.paginationOpts.numItems;
    const values: unknown[] = [];
    const conditions: string[] = ["deleted_at IS NULL"];
    if (normalized.channelId) {
      values.push(normalized.channelId);
      conditions.push(`channel_key = (SELECT storage_key FROM channels WHERE id = $${values.length})`);
    }
    if (normalized.afterTimestamp) {
      values.push(normalized.afterTimestamp);
      conditions.push(`timestamp > $${values.length}`);
    }
    if (imagesOnly) conditions.push("has_images = true");
    if (gameScoresOnly) {
      conditions.push("(message_text ILIKE '%RNGdle%' OR message_text ILIKE '%FoodGuessr%')");
    }
    const cursor = decodeMessageCursor(normalized.paginationOpts.cursor);
    if (cursor) {
      values.push(cursor.timestamp, cursor.id);
      conditions.push(`(timestamp, id) < ($${values.length - 1}, $${values.length})`);
    }
    const tab = normalized.tabId ? await this.loadTab(normalized.tabId) : undefined;
    if (normalized.tabId && !tab) throw new Error("Unknown chat tab");
    const filters = [...normalized.filters];
    if (tab) filters.push(tabAsFilter(tab));
    const senderEquals = [...new Set(filters.flatMap((filter) =>
      filter.rules
        .filter((rule) => rule.field === "sender" &&
          (rule.operator === "equals" || rule.operator === "notEquals"))
        .map((rule) => rule.value.trim().toLowerCase())
        .filter(Boolean),
    ))];
    let resolvedDimensions: ResolvedMessageDimensions | undefined;
    if (normalized.quickSearch) {
      const pattern = `%${escapeLikeValue(normalized.quickSearch.toLowerCase())}%`;
      const dimensions = await this.database.query<{
        sender_ids: number[];
        channel_ids: number[];
      }>(`
        SELECT
          ARRAY(SELECT id FROM chat_sender_profiles
                WHERE lower(username) LIKE $1 ESCAPE '\\'
                   OR lower(display_name) LIKE $1 ESCAPE '\\') AS sender_ids,
          ARRAY(SELECT id FROM chat_channel_profiles
                WHERE lower(username) LIKE $1 ESCAPE '\\') AS channel_ids
      `, [pattern]);
      resolvedDimensions = {
        quickSenderProfileIds: dimensions.rows[0]?.sender_ids ?? [],
        quickChannelProfileIds: dimensions.rows[0]?.channel_ids ?? [],
        senderEquals: {},
      };
    }
    if (senderEquals.length > 0) {
      const exact = await this.database.query<{ value: string; ids: number[] }>(`
        SELECT search.value, ARRAY(
          SELECT id FROM chat_sender_profiles
          WHERE lower(username) = search.value OR lower(display_name) = search.value
        ) AS ids
        FROM unnest($1::text[]) AS search(value)
      `, [senderEquals]);
      resolvedDimensions ??= {
        quickSenderProfileIds: [],
        quickChannelProfileIds: [],
        senderEquals: {},
      };
      resolvedDimensions.senderEquals = Object.fromEntries(
        exact.rows.map((row) => [row.value, row.ids]),
      );
    }
    const selection = compileMessageSelectionSql(
      normalized.quickSearch,
      filters,
      values.length,
      resolvedDimensions,
    );
    conditions.push(...selection.sql);
    values.push(...selection.values);
    const scanLimit = selection.requiresPostFilter ? MAX_MESSAGE_SCAN : requested + 1;
    values.push(scanLimit);
    const result = await this.database.query<MessageRow>(`
      WITH selected_message AS MATERIALIZED (
        SELECT id, timestamp
        FROM chat_messages
        ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY timestamp DESC, id DESC
        LIMIT $${values.length}
      )
      SELECT expanded.id, expanded.external_channel_id, expanded.channel_name,
        expanded.sender_username, expanded.sender_display_name,
        expanded.message_text, expanded.timestamp, expanded.badges,
        expanded.user_color, expanded.is_broadcaster, expanded.is_moderator,
        expanded.is_subscriber, expanded.is_vip, expanded.message_type,
        expanded.image_urls, expanded.native_emotes
      FROM selected_message
      JOIN chat_messages_expanded AS expanded ON expanded.id = selected_message.id
      ORDER BY selected_message.timestamp DESC, selected_message.id DESC
    `, values);

    const page = [];
    let consumedRow: MessageRow | undefined;
    for (const row of result.rows) {
      const message = toClientMessage(row);
      if (!selection.requiresPostFilter ||
          matchesMessageSelection(message, normalized.quickSearch, filters)) {
        page.push(message);
        consumedRow = row;
        if (page.length === requested) break;
      }
    }
    if (page.length < requested) consumedRow = result.rows.at(-1);
    const consumedIndex = consumedRow ? result.rows.indexOf(consumedRow) : -1;
    const hasMore = consumedIndex >= 0 && (
      consumedIndex < result.rows.length - 1 || result.rows.length === scanLimit
    );
    if (hasMore) {
      return {
        page,
        isDone: false,
        continueCursor: consumedRow
          ? encodeMessageCursor(consumedRow)
          : normalized.paginationOpts.cursor ?? "",
      };
    }

    const coldCursor: ColdArchiveCursor | undefined = consumedRow
      ? { timestamp: Number(consumedRow.timestamp), id: consumedRow.id }
      : cursor;
    const remaining = requested - page.length;
    const cold = await this.coldArchive.pageRows({
      ...(normalized.channelId ? { channelId: normalized.channelId } : {}),
      ...(normalized.afterTimestamp ? { afterTimestamp: normalized.afterTimestamp } : {}),
      ...(coldCursor ? { cursor: coldCursor } : {}),
      imagesOnly,
      limit: Math.max(1, remaining),
      matches: (row) => {
        if (gameScoresOnly) {
          const text = row.message_text.toLowerCase();
          if (!text.includes("rngdle") && !text.includes("foodguessr")) return false;
        }
        return matchesMessageSelection(
          toClientMessage(row),
          normalized.quickSearch,
          filters,
        );
      },
    });
    if (remaining <= 0) {
      return {
        page,
        isDone: cold.rows.length === 0 && !cold.hasMore,
        continueCursor: consumedRow
          ? encodeMessageCursor(consumedRow)
          : normalized.paginationOpts.cursor ?? "",
      };
    }

    const archivedRows = cold.rows.slice(0, remaining);
    page.push(...archivedRows.map(toClientMessage));
    const archivedCursor = archivedRows.at(-1) ??
      (cold.rows.length === 0 ? cold.consumed : undefined);
    return {
      page,
      isDone: !cold.hasMore,
      continueCursor: archivedCursor
        ? encodeMessageCursor(archivedCursor)
        : consumedRow
          ? encodeMessageCursor(consumedRow)
          : normalized.paginationOpts.cursor ?? "",
    };
  }

  async suggestMessageFilters(args: MessageSuggestionArgs) {
    const query = typeof args?.text === "string" ? args.text.trim().toLowerCase() : "";
    if (query.length < 3) {
      return {
        query,
        ...(args?.channelId ? { channelId: args.channelId } : {}),
        users: [],
      };
    }
    if (query.length > 80) throw new Error("Suggestion text is limited to 80 characters");
    if (args?.channelId !== undefined &&
        (typeof args.channelId !== "string" || args.channelId.length > 200)) {
      throw new Error("Invalid channel");
    }
    const requestedLimit = args?.limit ?? 5;
    if (!Number.isFinite(requestedLimit)) throw new Error("Invalid suggestion limit");
    const limit = Math.max(1, Math.min(Math.floor(requestedLimit), 10));
    const contains = `%${escapeLikeValue(query)}%`;
    const prefix = `${escapeLikeValue(query)}%`;
    const values: unknown[] = [contains, query, prefix];
    const conditions = [
      "sender.deleted_at IS NULL",
      `(lower(sender_username) LIKE $1 ESCAPE '\\' OR ` +
        `lower(sender_display_name) LIKE $1 ESCAPE '\\')`,
    ];
    if (args.channelId) {
      values.push(args.channelId);
      conditions.push(`channel_id = $${values.length}`);
    }
    values.push(limit);
    const result = await this.database.query<{
      sender_username: string;
      sender_display_name: string;
      message_count: string;
    }>(`
      WITH sender AS (
        SELECT profile.username AS sender_username,
               profile.display_name AS sender_display_name,
               channel.id AS channel_id, message.timestamp, message.deleted_at,
               1::bigint AS message_count
        FROM chat_messages AS message
        JOIN chat_sender_profiles AS profile ON profile.id = message.sender_profile_id
        JOIN channels AS channel ON channel.storage_key = message.channel_key
        UNION ALL
        SELECT COALESCE(profile.username, catalog.sender_username),
               COALESCE(profile.display_name, catalog.sender_display_name),
               channel.id, catalog.timestamp, catalog.deleted_at,
               1::bigint AS message_count
        FROM chat_message_cold_catalog AS catalog
        JOIN chat_message_cold_chunks AS legacy_chunk
          ON legacy_chunk.id = catalog.chunk_id
        LEFT JOIN chat_sender_profiles AS profile ON profile.id = catalog.sender_profile_id
        JOIN channels AS channel ON channel.storage_key = catalog.channel_key
        WHERE legacy_chunk.compact_indexed = false AND (
          profile.id IS NOT NULL OR
          (catalog.sender_username IS NOT NULL AND catalog.sender_display_name IS NOT NULL)
        )
        UNION ALL
        SELECT COALESCE(profile.username, stats.sender_username),
               COALESCE(profile.display_name, stats.sender_display_name),
               channel.id, stats.last_timestamp, NULL::bigint,
               stats.message_count::bigint
        FROM chat_message_cold_sender_stats_legacy AS stats
        JOIN chat_message_cold_chunks AS chunk ON chunk.id = stats.chunk_id
        LEFT JOIN chat_sender_profiles AS profile ON profile.id = stats.sender_profile_id
        JOIN channels AS channel ON channel.storage_key = chunk.channel_key
        WHERE chunk.compact_indexed = true AND (
          profile.id IS NOT NULL OR
          (stats.sender_username IS NOT NULL AND stats.sender_display_name IS NOT NULL)
        )
        UNION ALL
        SELECT profile.username, profile.display_name, channel.id,
               stats.last_timestamp, NULL::bigint, stats.message_count::bigint
        FROM chat_message_cold_sender_stats AS stats
        JOIN chat_message_cold_chunks AS chunk ON chunk.id = stats.chunk_id
        JOIN chat_sender_profiles AS profile ON profile.id = stats.sender_profile_id
        JOIN channels AS channel ON channel.storage_key = chunk.channel_key
      )
      SELECT
        sender_username,
        max(sender_display_name) AS sender_display_name,
        sum(message_count) AS message_count
      FROM sender
      WHERE ${conditions.join(" AND ")}
      GROUP BY sender_username
      ORDER BY
        CASE
          WHEN lower(sender_username) = $2 THEN 0
          WHEN lower(sender_username) LIKE $3 ESCAPE '\\' THEN 1
          ELSE 2
        END,
        sum(message_count) DESC,
        max(timestamp) DESC
      LIMIT $${values.length}
    `, values);

    return {
      query,
      ...(args.channelId ? { channelId: args.channelId } : {}),
      users: result.rows.map((row) => ({
        username: row.sender_username,
        displayName: row.sender_display_name,
        messageCount: Number(row.message_count),
      })),
    };
  }

  async filterMatchCounts(args: {
    channelId?: string; filters: MessageFilter[]; afterTimestamp?: number;
  }) {
    const page = await this.pageMessages({
      channelId: args.channelId,
      afterTimestamp: args.afterTimestamp,
      paginationOpts: { numItems: 250 },
    }, false);
    return args.filters.map((filter) => ({
      id: filter.id,
      count: page.page.filter((message) => matchesMessageFilter(message, filter)).length,
    }));
  }

  close() {
    if (this.poll) clearInterval(this.poll);
  }

  private async requireChannelUpdate(id: string, sql: string, values: unknown[]) {
    const result = await this.database.query(sql, values);
    if (!result.rowCount) throw new Error("Channel not found");
    this.channelSnapshot = "";
  }

  private async loadTab(clientId: string): Promise<ChatTabInput | undefined> {
    const result = await this.database.query<{
      client_id: string; name: string; layout: "chat" | "gallery" | "scores";
      match: "all" | "any"; rules: FilterRule[];
    }>("SELECT client_id, name, layout, match, rules FROM chat_tabs WHERE client_id = $1", [clientId]);
    const row = result.rows[0];
    return row ? { id: row.client_id, name: row.name, layout: row.layout, match: row.match, rules: row.rules } : undefined;
  }
}

function toClientMessage(row: MessageRow) {
  const nativeEmotes = row.native_emotes ?? compactNativeEmotes(row.metadata?.fragments);
  return {
    _id: row.id,
    externalChannelId: row.external_channel_id,
    channelName: row.channel_name,
    senderUsername: row.sender_username,
    senderDisplayName: row.sender_display_name,
    messageText: row.message_text,
    timestamp: Number(row.timestamp),
    badges: row.badges,
    ...(row.user_color ? { userColor: row.user_color } : {}),
    isBroadcaster: row.is_broadcaster,
    isModerator: row.is_moderator,
    isSubscriber: row.is_subscriber,
    isVip: row.is_vip,
    messageType: row.message_type,
    ...(row.image_urls ? { imageUrls: row.image_urls } : {}),
    ...(nativeEmotes.length > 0 ? { nativeEmotes } : {}),
  };
}

function tabAsFilter(tab: ChatTabInput): MessageFilter {
  return {
    id: tab.id,
    name: tab.name,
    action: "show",
    match: tab.match,
    rules: tab.layout === "gallery"
      ? tab.rules.map((rule) => ({ ...rule, value: upgradeGalleryFilterPattern(rule.value) }))
      : tab.rules,
  };
}

function validateTab(tab: ChatTabInput) {
  if (!tab || !Array.isArray(tab.rules)) throw new Error("Invalid chat tab");
  const name = tab.name.trim();
  if (!["chat", "gallery", "scores"].includes(tab.layout) ||
      !tab.id || tab.id.length > 100 || !name || name.length > 40 || tab.rules.length > 20) {
    throw new Error("Invalid chat tab");
  }
  validateMessageFilters([{
    id: tab.id,
    name,
    action: "show",
    match: tab.match,
    rules: tab.rules,
  }]);
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function escapeLikeValue(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function validateMessagePageArgs(args: MessagePageArgs) {
  if (!args || !args.paginationOpts) throw new Error("Message pagination is required");
  const numItems = Number(args.paginationOpts.numItems);
  if (!Number.isInteger(numItems) || numItems < 1 || numItems > 250) {
    throw new Error("Message pages are limited to 250 items");
  }
  const quickSearch = typeof args.quickSearch === "string" ? args.quickSearch.trim() : "";
  if (quickSearch.length > 200) throw new Error("Search text is limited to 200 characters");
  const filters = args.filters ?? [];
  validateMessageFilters(filters);
  if (args.channelId !== undefined &&
      (typeof args.channelId !== "string" || args.channelId.length > 200)) {
    throw new Error("Invalid channel");
  }
  if (args.tabId !== undefined &&
      (typeof args.tabId !== "string" || args.tabId.length > 100)) {
    throw new Error("Invalid chat tab");
  }
  if (args.afterTimestamp !== undefined &&
      (!Number.isFinite(args.afterTimestamp) || args.afterTimestamp < 0)) {
    throw new Error("Invalid message timestamp cutoff");
  }
  return {
    ...(args.channelId ? { channelId: args.channelId } : {}),
    ...(args.tabId ? { tabId: args.tabId } : {}),
    quickSearch,
    filters,
    ...(args.afterTimestamp ? { afterTimestamp: args.afterTimestamp } : {}),
    paginationOpts: {
      numItems,
      ...(args.paginationOpts.cursor ? { cursor: args.paginationOpts.cursor } : {}),
    },
  };
}

function validateMessageFilters(filters: MessageFilter[]) {
  if (!Array.isArray(filters) || filters.length > 100) {
    throw new Error("Too many message filters");
  }
  for (const filter of filters) {
    if (!filter || typeof filter.id !== "string" || filter.id.length > 100 ||
        typeof filter.name !== "string" || filter.name.length > 80 ||
        !["show", "hide", "highlight"].includes(filter.action) ||
        !["all", "any"].includes(filter.match) ||
        !Array.isArray(filter.rules) || filter.rules.length > 20) {
      throw new Error("Invalid message filter");
    }
    for (const rule of filter.rules) {
      if (!rule || typeof rule.id !== "string" || rule.id.length > 100 ||
          typeof rule.value !== "string" || rule.value.length > 200 ||
          !operatorsForField(rule.field).includes(rule.operator) ||
          filterRuleError(rule)) {
        throw new Error("Invalid message filter rule");
      }
    }
  }
}

interface MessageCursor {
  timestamp: number;
  id: string;
}

function encodeMessageCursor(row: Pick<MessageRow, "timestamp" | "id">) {
  return Buffer.from(JSON.stringify({
    timestamp: Number(row.timestamp),
    id: row.id,
  } satisfies MessageCursor)).toString("base64url");
}

function decodeMessageCursor(value?: string | null): MessageCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as MessageCursor;
    if (!Number.isFinite(parsed.timestamp) || parsed.timestamp < 0 ||
        typeof parsed.id !== "string" || parsed.id.length > 200) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new Error("Invalid message cursor");
  }
}
