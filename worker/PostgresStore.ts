import { randomUUID } from "node:crypto";
import { extractImageUrls, IMAGE_INDEX_VERSION, upgradeGalleryFilterPattern } from "../shared/imageUrls";
import {
  matchesMessageFilter,
  matchesMessageSelection,
  type FilterRule,
  type MessageFilter,
} from "../shared/messageFilters";
import type { ChatRepository, ChannelStatus } from "./ChatRepository";
import type { PostgresDatabase } from "./database";
import type { Logger } from "./logger";
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
  layout: "chat" | "gallery";
  match: "all" | "any";
  rules: FilterRule[];
}

interface MessageRow {
  id: string;
  external_channel_id: string;
  channel_name: string;
  sender_username: string;
  sender_display_name: string;
  message_text: string;
  timestamp: string;
  badges: Array<{ setId: string; id: string; info: string }>;
  user_color: string | null;
  is_broadcaster: boolean;
  is_moderator: boolean;
  is_subscriber: boolean;
  is_vip: boolean;
  message_type: string;
  image_urls: string[] | null;
  metadata: Record<string, unknown> | null;
}

export class PostgresStore implements ChatRepository {
  private poll?: ReturnType<typeof setInterval>;
  private channelSnapshot = "";

  constructor(
    private readonly database: PostgresDatabase,
    private readonly logger: Logger,
  ) {}

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
    const now = Date.now();
    const result = await this.database.query<{ id: string }>(`
      INSERT INTO chat_messages (
        id, channel_id, platform, external_message_id, event_notification_id,
        external_channel_id, channel_name, sender_id, sender_username,
        sender_display_name, message_text, has_images, image_urls,
        image_index_version, gallery_channel_id, timestamp, badges, user_color,
        is_broadcaster, is_moderator, is_subscriber, is_vip, message_type,
        metadata, raw_message_data, created_at
      ) VALUES (
        $1, $2, 'twitch', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
        $13, $14, $15, $16::jsonb, $17, $18, $19, $20, $21, $22,
        $23::jsonb, $24::jsonb, $25
      )
      ON CONFLICT (external_message_id) DO NOTHING
      RETURNING id
    `, [
      randomUUID(), channel.storageId, message.messageId, message.eventNotificationId,
      message.channelId, message.channelName, message.userId, message.username,
      message.displayName, message.messageText, imageUrls.length > 0,
      JSON.stringify(imageUrls), IMAGE_INDEX_VERSION,
      imageUrls.length > 0 ? channel.storageId : null, message.messageTimestamp.getTime(),
      JSON.stringify(message.badges), message.userColor ?? null, message.isBroadcaster,
      message.isModerator, message.isSubscriber, message.isVip, message.messageType,
      JSON.stringify(message.metadata), JSON.stringify(message.rawMessageData), now,
    ]);
    if (!result.rowCount) {
      this.logger.debug({ messageId: message.messageId }, "Ignored duplicate chat message");
      return;
    }
    await this.database.query(`
      UPDATE channels
      SET last_message_at = $2, connection_status = 'connected',
          connection_error = NULL, updated_at = $3
      WHERE id = $1
    `, [channel.storageId, message.messageTimestamp.getTime(), now]);
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
      client_id: string; name: string; layout: "chat" | "gallery";
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

  async pageMessages(args: MessagePageArgs, imagesOnly: boolean) {
    const requested = Math.max(1, Math.min(Math.floor(args.paginationOpts.numItems), MAX_MESSAGE_SCAN));
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (args.channelId) {
      values.push(args.channelId);
      conditions.push(`channel_id = $${values.length}`);
    }
    if (args.afterTimestamp && Number.isFinite(args.afterTimestamp)) {
      values.push(args.afterTimestamp);
      conditions.push(`timestamp > $${values.length}`);
    }
    if (imagesOnly) conditions.push("has_images = true");
    const tab = args.tabId ? await this.loadTab(args.tabId) : undefined;
    const filters = [...(args.filters ?? [])];
    if (tab) filters.push(tabAsFilter(tab));
    const selectionActive = Boolean(args.quickSearch?.trim()) || filters.some((filter) => filter.action !== "highlight");
    const scanLimit = selectionActive ? MAX_MESSAGE_SCAN : requested;
    values.push(scanLimit);
    const result = await this.database.query<MessageRow>(`
      SELECT id, external_channel_id, channel_name, sender_username,
        sender_display_name, message_text, timestamp, badges, user_color,
        is_broadcaster, is_moderator, is_subscriber, is_vip, message_type,
        image_urls, metadata
      FROM chat_messages
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY timestamp DESC, id DESC
      LIMIT $${values.length}
    `, values);
    const matching = result.rows
      .map(toClientMessage)
      .filter((message) => matchesMessageSelection(message, args.quickSearch ?? "", filters));
    const page = matching.slice(0, requested);
    return {
      page,
      isDone: result.rows.length < scanLimit || page.length < requested,
      continueCursor: String(page.length),
    };
  }

  async filterMatchCounts(args: {
    channelId?: string; filters: MessageFilter[]; afterTimestamp?: number;
  }) {
    const page = await this.pageMessages({
      channelId: args.channelId,
      afterTimestamp: args.afterTimestamp,
      paginationOpts: { numItems: 500 },
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
      client_id: string; name: string; layout: "chat" | "gallery";
      match: "all" | "any"; rules: FilterRule[];
    }>("SELECT client_id, name, layout, match, rules FROM chat_tabs WHERE client_id = $1", [clientId]);
    const row = result.rows[0];
    return row ? { id: row.client_id, name: row.name, layout: row.layout, match: row.match, rules: row.rules } : undefined;
  }
}

function toClientMessage(row: MessageRow) {
  const fragments = row.metadata?.fragments;
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
    ...(fragments === undefined ? {} : { metadata: { fragments } }),
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
  const name = tab.name.trim();
  if (!tab.id || tab.id.length > 100 || !name || name.length > 40 || tab.rules.length > 20) {
    throw new Error("Invalid chat tab");
  }
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
