import {
  Component,
  lazy,
  Suspense,
  type ErrorInfo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  useMutation,
  usePaginatedQuery,
  useQuery,
  type PaginationStatus,
} from "./postgresReact";
import {
  api,
  type Channel,
  type ChatBadgeDefinition,
  type ChatMessage,
} from "./api";
import { ChatTabBar, ChatTabDialog } from "./ChatTabs";
import {
  CHAT_TABS_STORAGE_KEY,
  chatTabAsFilter,
  parseChatTabs,
  type ChatViewTab,
} from "./chatTabModel";
import {
  buildMessageParts,
  renderMessageParts,
  type ThirdPartyEmote,
} from "./emotes";
import { buildGalleryImages, type GalleryImage } from "./imageGallery";
import {
  FILTER_STORAGE_KEY,
  highlightedMessageIds,
  parseFilterState,
  serializeFilterState,
  type FilterMatchMode,
  type FilterState,
  type MessageFilter,
} from "./filters";
import { workerUrl } from "./runtimeConfig";
import SearchComposer from "./SearchComposer";
import {
  buildSmartSearchFilter,
  type SmartSearchToken,
} from "./smartSearch";

const FilterWorkspace = lazy(() => import("./FilterWorkspace"));
const GameScoreRoom = lazy(() => import("./GameScoreRoom"));
const INITIAL_MESSAGE_COUNT = 50;
const HISTORY_PAGE_SIZE = 100;
const MAX_BULK_ITEMS = 100;

interface TwitchAuthStatus {
  configured?: boolean;
  authenticated: boolean;
  login?: string;
  reason?: string;
}

interface AdminAccessStatus {
  configured: boolean;
  authenticated: boolean;
  totpEnabled: boolean;
  error?: string;
}

function loadSavedFilterState() {
  try {
    return parseFilterState(localStorage.getItem(FILTER_STORAGE_KEY));
  } catch {
    return { filters: [], activeIds: [] };
  }
}

function loadSavedChatTabs() {
  try {
    return parseChatTabs(localStorage.getItem(CHAT_TABS_STORAGE_KEY));
  } catch {
    return [];
  }
}

function tabInput(tab: ChatViewTab) {
  return {
    id: tab.id,
    name: tab.name,
    layout: tab.layout,
    match: tab.match,
    rules: tab.rules,
  };
}

export default function App() {
  const channels = useQuery(api.channels.list, {}) ?? [];
  const serverChatTabs = useQuery(api.chatTabs.list, {});
  const [selectedChannelId, setSelectedChannelId] = useState<string>();
  const [filterDialogOpen, setFilterDialogOpen] = useState(false);
  const [querySearch, setQuerySearch] = useState("");
  const [searchTokens, setSearchTokens] = useState<SmartSearchToken[]>([]);
  const [searchMatch, setSearchMatch] = useState<FilterMatchMode>("all");
  const [filterState, setFilterState] = useState<FilterState>(loadSavedFilterState);
  const [legacyChatTabs, setLegacyChatTabs] = useState<ChatViewTab[]>(loadSavedChatTabs);
  const chatTabMigrationStartedRef = useRef(false);
  const [activeChatTabId, setActiveChatTabId] = useState("all");
  const [editingChatTab, setEditingChatTab] = useState<ChatViewTab | "new">();
  const [paused, setPaused] = useState(false);
  const [pausedMessages, setPausedMessages] = useState<ChatMessage[]>([]);
  const [pausedMessageKey, setPausedMessageKey] = useState("");
  const [clearBefore, setClearBefore] = useState(0);
  const [auth, setAuth] = useState<TwitchAuthStatus>();
  const [adminAccess, setAdminAccess] = useState<AdminAccessStatus>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [selectionMode, setSelectionMode] = useState(false);
  const chatTabs = serverChatTabs === undefined ||
      (serverChatTabs.length === 0 && legacyChatTabs.length > 0)
    ? legacyChatTabs
    : serverChatTabs;
  const selectedChannel = channels.find((channel) => channel._id === selectedChannelId);
  const activeChatTab = chatTabs.find((tab) => tab.id === activeChatTabId);
  const activeTabIndexRevision = activeChatTab?.indexStatus === "ready"
    ? activeChatTab.indexedRevision ?? 0
    : 0;
  const activeFilters = useMemo(() => {
    const activeIds = new Set(filterState.activeIds);
    return filterState.filters.filter((filter) => activeIds.has(filter.id));
  }, [filterState]);
  const viewFilters = useMemo(
    () => activeChatTab
      ? [...activeFilters, chatTabAsFilter(activeChatTab)]
      : activeFilters,
    [activeFilters, activeChatTab],
  );
  const selectionFilters = useMemo(
    () => activeFilters.filter((filter) => filter.action !== "highlight"),
    [activeFilters],
  );
  const smartSearchFilter = useMemo(
    () => buildSmartSearchFilter(searchTokens, searchMatch),
    [searchMatch, searchTokens],
  );
  const serverSelectionFilters = useMemo(
    () => smartSearchFilter
      ? [...selectionFilters, smartSearchFilter]
      : selectionFilters,
    [selectionFilters, smartSearchFilter],
  );
  const serverFiltering = Boolean(activeChatTab) || Boolean(querySearch.trim()) ||
    serverSelectionFilters.length > 0;
  const galleryActive = activeChatTab?.layout === "gallery";
  const scoresActive = activeChatTab?.layout === "scores";
  const queryArgs = useMemo(
    () => ({
      ...(selectedChannelId ? { channelId: selectedChannelId } : {}),
      ...(activeChatTab ? {
        tabId: activeChatTab.id,
        tabRevision: activeChatTab.revision ?? 0,
        tabIndexRevision: activeTabIndexRevision,
      } : {}),
      ...(querySearch.trim() ? { quickSearch: querySearch } : {}),
      ...(serverSelectionFilters.length > 0 ? { filters: serverSelectionFilters } : {}),
      ...(clearBefore > 0 ? { afterTimestamp: clearBefore } : {}),
    }),
    [
      activeChatTab,
      activeTabIndexRevision,
      selectedChannelId,
      querySearch,
      serverSelectionFilters,
      clearBefore,
    ],
  );
  const messageFeedKey = useMemo(() => JSON.stringify(queryArgs), [queryArgs]);
  const recentQuery = usePaginatedQuery(
    api.messages.page,
    !galleryActive && !scoresActive ? queryArgs : "skip",
    { initialNumItems: INITIAL_MESSAGE_COUNT },
  );
  const galleryQuery = usePaginatedQuery(
    api.messages.pageImages,
    galleryActive ? queryArgs : "skip",
    { initialNumItems: 50 },
  );
  const gameScoresQuery = usePaginatedQuery(
    api.messages.pageGameScores,
    scoresActive ? queryArgs : "skip",
    { initialNumItems: 250 },
  );
  const messages: ChatMessage[] = useMemo(
    () => galleryActive
      ? galleryQuery.results
      : scoresActive
        ? gameScoresQuery.results
        : [...recentQuery.results].reverse(),
    [
      galleryActive,
      galleryQuery.results,
      gameScoresQuery.results,
      recentQuery.results,
      scoresActive,
    ],
  );
  const sourceMessages = paused && pausedMessageKey === messageFeedKey
    ? pausedMessages
    : messages;
  const highlightedIds = useMemo(
    () => highlightedMessageIds(sourceMessages, viewFilters),
    [sourceMessages, viewFilters],
  );
  const filterMatchCountResults = useQuery(
    api.messages.filterMatchCounts,
    filterDialogOpen && filterState.filters.length > 0
      ? {
          filters: filterState.filters,
          ...(selectedChannelId ? { channelId: selectedChannelId } : {}),
          ...(clearBefore > 0 ? { afterTimestamp: clearBefore } : {}),
        }
      : "skip",
  );
  const filterMatchCounts = useMemo(
    () => new Map((filterMatchCountResults ?? []).map(({ id, count }) => [id, count])),
    [filterMatchCountResults],
  );
  const ensureSeeded = useMutation(api.platforms.ensureSeeded);
  const importLocalChatTabs = useMutation(api.chatTabs.importLocal);
  const saveChatTabMutation = useMutation(api.chatTabs.save);
  const removeChatTabMutation = useMutation(api.chatTabs.remove);
  const deleteMessagesMutation = useMutation(api.messages.delete);
  const hideImagesMutation = useMutation(api.messages.hideImages);
  const isAdmin = Boolean(adminAccess?.authenticated);
  const visibleChannelIds = useMemo(
    () => galleryActive || scoresActive
      ? []
      : [...new Set(messages.map((message) => message.externalChannelId))],
    [galleryActive, messages, scoresActive],
  );
  const emotesByChannel = useThirdPartyEmotes(visibleChannelIds);
  const badgesByChannel = useTwitchBadges(visibleChannelIds);

  const loadAdminAccess = useCallback(() => {
    void fetch(`${workerUrl}/api/admin/auth/status`, { credentials: "include" })
      .then(async (response) => {
        const status = await response.json() as AdminAccessStatus;
        setAdminAccess(status);
      })
      .catch(() => setAdminAccess({
        configured: false,
        authenticated: false,
        totpEnabled: false,
        error: "Admin service is offline",
      }));
  }, []);

  useEffect(() => {
    void fetch(`${workerUrl}/auth/twitch/status`)
      .then((response) => response.json())
      .then((status: TwitchAuthStatus) => setAuth(status))
      .catch(() => setAuth({ authenticated: false, reason: "Ingestion worker is offline" }));
    loadAdminAccess();
    const interval = window.setInterval(loadAdminAccess, 60_000);
    window.addEventListener("focus", loadAdminAccess);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", loadAdminAccess);
    };
  }, [loadAdminAccess]);

  useEffect(() => {
    if (isAdmin) void ensureSeeded({}).catch((error: Error) => setNotice(error.message));
  }, [ensureSeeded, isAdmin]);

  useEffect(() => {
    if (!filterDialogOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilterDialogOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [filterDialogOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, serializeFilterState(filterState));
    } catch (error) {
      console.warn("Could not persist filters", error);
    }
  }, [filterState]);

  useEffect(() => {
    if (!isAdmin || serverChatTabs === undefined || legacyChatTabs.length === 0 ||
        chatTabMigrationStartedRef.current) return;
    chatTabMigrationStartedRef.current = true;
    void importLocalChatTabs({ tabs: legacyChatTabs.map(tabInput) })
      .then(() => {
        setLegacyChatTabs([]);
        localStorage.removeItem(CHAT_TABS_STORAGE_KEY);
      })
      .catch((error: Error) => {
        chatTabMigrationStartedRef.current = false;
        setNotice(`Could not migrate chat tabs: ${error.message}`);
      });
  }, [importLocalChatTabs, isAdmin, legacyChatTabs, serverChatTabs]);

  const deleteMessages = async (messageIds: string[]) => {
    try {
      let deleted = 0;
      for (let offset = 0; offset < messageIds.length; offset += 200) {
        deleted += (await deleteMessagesMutation({
          messageIds: messageIds.slice(offset, offset + 200),
        })).deleted;
      }
      setNotice(`${deleted} ${deleted === 1 ? "message" : "messages"} removed permanently.`);
    } catch (error) {
      setNotice(`Could not remove messages: ${(error as Error).message}`);
      throw error;
    }
  };

  const hideImages = async (images: Array<{ messageId: string; url: string }>) => {
    try {
      let hidden = 0;
      for (let offset = 0; offset < images.length; offset += 100) {
        hidden += (await hideImagesMutation({
          images: images.slice(offset, offset + 100),
        })).hidden;
      }
      setNotice(`${hidden} ${hidden === 1 ? "image" : "images"} removed permanently.`);
    } catch (error) {
      setNotice(`Could not remove images: ${(error as Error).message}`);
      throw error;
    }
  };

  const saveFilter = (filter: MessageFilter, apply: boolean) => {
    setFilterState((current) => {
      const exists = current.filters.some((candidate) => candidate.id === filter.id);
      const filters = exists
        ? current.filters.map((candidate) => candidate.id === filter.id ? filter : candidate)
        : [...current.filters, filter];
      const activeIds = apply
        ? [...new Set([...current.activeIds, filter.id])]
        : current.activeIds;
      return { filters, activeIds };
    });
  };

  const toggleFilter = (id: string) => {
    setFilterState((current) => ({
      ...current,
      activeIds: current.activeIds.includes(id)
        ? current.activeIds.filter((candidate) => candidate !== id)
        : [...current.activeIds, id],
    }));
  };

  const deleteFilter = (id: string) => {
    setFilterState((current) => ({
      filters: current.filters.filter((filter) => filter.id !== id),
      activeIds: current.activeIds.filter((candidate) => candidate !== id),
    }));
  };

  const saveChatTab = (tab: ChatViewTab) => {
    setActiveChatTabId(tab.id);
    setEditingChatTab(undefined);
    void saveChatTabMutation({ tab: tabInput(tab) })
      .catch((error: Error) => setNotice(`Could not save chat tab: ${error.message}`));
  };

  const deleteChatTab = (id: string) => {
    if (activeChatTabId === id) setActiveChatTabId("all");
    setEditingChatTab(undefined);
    void removeChatTabMutation({ id })
      .catch((error: Error) => setNotice(`Could not delete chat tab: ${error.message}`));
  };

  return (
    <ErrorBoundary>
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <img alt="" className="brand-mark" src="/brand/twitch-logger-icon-64.png" />
            <div>
              <strong>Twitch Logs</strong>
              <small>EventSub live monitor</small>
            </div>
          </div>
          <div className="topbar-actions">
            {auth?.authenticated ? (
              <span className="auth-chip connected">Connected as {auth.login}</span>
            ) : auth?.configured === false ? (
              <span className="auth-chip setup" title={auth.reason}>
                Twitch setup required
              </span>
            ) : isAdmin ? (
              <a className="button primary" href={`${workerUrl}/auth/twitch/start`}>
                Connect Twitch
              </a>
            ) : null}
            <a
              className={`auth-chip admin-access ${isAdmin ? "active" : ""}`}
              href="/admin"
              title={adminAccess?.error}
            >
              {isAdmin ? "Admin mode" : "Admin sign in"}
            </a>
          </div>
        </header>

        {notice && (
          <button className="notice" onClick={() => setNotice(undefined)}>
            {notice}
          </button>
        )}

        <main className="dashboard">
          <ChannelSidebar
            channels={channels}
            selectedChannelId={selectedChannelId}
            isAdmin={isAdmin}
            onSelect={setSelectedChannelId}
            onAdd={() => setDialogOpen(true)}
            onError={setNotice}
          />

          <section className="feed-panel">
            <FeedToolbar
              activeFilterCount={activeFilters.length}
              channel={selectedChannel}
              channelId={selectedChannelId}
              channels={channels}
              paused={paused}
              filterText={querySearch}
              isAdmin={isAdmin}
              resultCount={sourceMessages.length}
              searchMatch={searchMatch}
              searchTokens={searchTokens}
              searching={
                Boolean(querySearch || searchTokens.length > 0) &&
                (galleryActive
                  ? galleryQuery.status === "LoadingFirstPage"
                  : scoresActive
                    ? gameScoresQuery.status === "LoadingFirstPage"
                    : recentQuery.status === "LoadingFirstPage")
              }
              allowBulkActions={!scoresActive}
              selectionMode={selectionMode}
              onSearchMatchChange={setSearchMatch}
              onSearchTokensChange={setSearchTokens}
              onTextChange={setQuerySearch}
              onOpenFilters={() => setFilterDialogOpen(true)}
              onPause={() => {
                if (!paused) {
                  setPausedMessages(messages);
                  setPausedMessageKey(messageFeedKey);
                }
                setPaused((value) => !value);
              }}
              onClear={() => setClearBefore(Date.now())}
              onToggleSelection={() => setSelectionMode((current) => !current)}
            />
            <ChatTabBar
              activeId={activeChatTab?.id ?? "all"}
              tabs={chatTabs}
              canEdit={isAdmin}
              onAdd={() => setEditingChatTab("new")}
              onEdit={setEditingChatTab}
              onSelect={setActiveChatTabId}
            />
            {activeChatTab?.layout === "gallery" ? (
              <ImageGallery
                historyEnabled={clearBefore === 0}
                key={`${messageFeedKey}:${selectionMode}`}
                loadMore={galleryQuery.loadMore}
                messages={sourceMessages}
                error={galleryQuery.error}
                isAdmin={isAdmin}
                onRetry={galleryQuery.retry}
                selectionMode={selectionMode}
                onDeleteMessages={deleteMessages}
                onHideImages={hideImages}
                paused={paused}
                serverFiltering={serverFiltering}
                status={galleryQuery.status}
              />
            ) : activeChatTab?.layout === "scores" ? (
              <Suspense fallback={<div className="empty">Opening the score room…</div>}>
                <GameScoreRoom
                  error={gameScoresQuery.error}
                  historyEnabled={clearBefore === 0}
                  isAdmin={isAdmin}
                  key={messageFeedKey}
                  loadMore={gameScoresQuery.loadMore}
                  messages={sourceMessages}
                  onDeleteMessage={(messageId) => deleteMessages([messageId])}
                  onRetry={gameScoresQuery.retry}
                  paused={paused}
                  status={gameScoresQuery.status}
                />
              </Suspense>
            ) : (
              <MessageFeed
                badgesByChannel={badgesByChannel}
                emotesByChannel={emotesByChannel}
                highlightedIds={highlightedIds}
                historyEnabled={clearBefore === 0}
                key={`${messageFeedKey}:${selectionMode}`}
                loadMore={recentQuery.loadMore}
                messages={sourceMessages}
                error={recentQuery.error}
                isAdmin={isAdmin}
                onRetry={recentQuery.retry}
                selectionMode={selectionMode}
                onDeleteMessages={deleteMessages}
                onHideImages={hideImages}
                paused={paused}
                serverFiltering={serverFiltering}
                status={recentQuery.status}
              />
            )}
          </section>
        </main>

        {dialogOpen && (
          <AddChannelDialog
            onClose={() => setDialogOpen(false)}
            onError={setNotice}
            authenticated={Boolean(auth?.authenticated)}
          />
        )}
        {editingChatTab && (
          <ChatTabDialog
            tab={editingChatTab === "new" ? undefined : editingChatTab}
            onClose={() => setEditingChatTab(undefined)}
            onDelete={deleteChatTab}
            onSave={saveChatTab}
          />
        )}
        {filterDialogOpen && (
          <div
            className="dialog-backdrop"
            onMouseDown={() => setFilterDialogOpen(false)}
            role="presentation"
          >
            <section
              aria-label="Filters"
              aria-modal="true"
              className="filter-dialog"
              onMouseDown={(event) => event.stopPropagation()}
              role="dialog"
            >
              <button
                aria-label="Close filters"
                autoFocus
                className="dialog-close filter-dialog-close"
                onClick={() => setFilterDialogOpen(false)}
              >
                ×
              </button>
              <Suspense fallback={<div className="empty">Loading filter tools…</div>}>
                <FilterWorkspace
                  activeIds={filterState.activeIds}
                  filters={filterState.filters}
                  matchCounts={filterMatchCounts}
                  onDelete={deleteFilter}
                  onSave={saveFilter}
                  onToggle={toggleFilter}
                />
              </Suspense>
            </section>
          </div>
        )}
      </div>
    </ErrorBoundary>
  );
}

function ChannelSidebar({
  channels,
  selectedChannelId,
  isAdmin,
  onSelect,
  onAdd,
  onError,
}: {
  channels: Channel[];
  selectedChannelId?: string;
  isAdmin: boolean;
  onSelect: (id?: string) => void;
  onAdd: () => void;
  onError: (message: string) => void;
}) {
  const setLogging = useMutation(api.channels.setLogging);
  const reconnect = useMutation(api.channels.reconnect);
  const remove = useMutation(api.channels.remove);

  const run = (action: Promise<unknown>) => {
    void action.catch((error: Error) => onError(error.message));
  };

  return (
    <aside className="sidebar channels-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Following</span>
          <h2>Channels</h2>
        </div>
        <span className="count">{channels.length}</span>
      </div>
      <button
        className={`channel-card all ${selectedChannelId ? "" : "selected"}`}
        onClick={() => onSelect(undefined)}
      >
        <span className="platform-icon">∞</span>
        <span><strong>All channels</strong><small>Combined live feed</small></span>
      </button>
      <div className="channel-list">
        {channels.map((channel) => (
          <div
            key={channel._id}
            className={`channel-card ${selectedChannelId === channel._id ? "selected" : ""}`}
          >
            <button className="channel-main" onClick={() => onSelect(channel._id)}>
              <span className="platform-icon twitch">T</span>
              <span className="channel-copy">
                <strong>{channel.displayName}</strong>
                <small>@{channel.username}</small>
              </span>
              <span
                className={`status-dot ${channel.connectionStatus}`}
                title={channel.connectionError ?? channel.connectionStatus}
              />
            </button>
            {isAdmin && <div className="channel-actions">
              <button
                onClick={() =>
                  run(setLogging({ id: channel._id, enabled: !channel.loggingEnabled }))
                }
              >
                {channel.loggingEnabled ? "Pause" : "Log"}
              </button>
              {(channel.connectionStatus === "error" ||
                channel.connectionStatus === "disconnected") && (
                <button onClick={() => run(reconnect({ id: channel._id }))}>Reconnect</button>
              )}
              <button
                className="danger"
                onClick={() =>
                  run(remove({ id: channel._id }).then(() => {
                    if (selectedChannelId === channel._id) onSelect(undefined);
                  }))
                }
              >
                Remove
              </button>
            </div>}
          </div>
        ))}
      </div>
      {channels.length === 0 && (
        <div className="empty compact"><strong>No channels yet</strong><span>{isAdmin ? "Add one to begin logging." : "An admin can add the first channel."}</span></div>
      )}
      {isAdmin ? (
        <button className="button add-channel" onClick={onAdd}>+ Add channel</button>
      ) : (
        <a className="button add-channel" href="/admin">Admin sign in</a>
      )}
    </aside>
  );
}

function FeedToolbar({
  activeFilterCount,
  allowBulkActions,
  channel,
  channelId,
  channels,
  paused,
  filterText,
  isAdmin,
  resultCount,
  searchMatch,
  searchTokens,
  searching,
  selectionMode,
  onSearchMatchChange,
  onSearchTokensChange,
  onTextChange,
  onOpenFilters,
  onPause,
  onClear,
  onToggleSelection,
}: {
  activeFilterCount: number;
  allowBulkActions: boolean;
  channel?: Channel;
  channelId?: string;
  channels: Channel[];
  paused: boolean;
  filterText: string;
  isAdmin: boolean;
  resultCount: number;
  searchMatch: FilterMatchMode;
  searchTokens: SmartSearchToken[];
  searching: boolean;
  selectionMode: boolean;
  onSearchMatchChange: (match: FilterMatchMode) => void;
  onSearchTokensChange: (tokens: SmartSearchToken[]) => void;
  onTextChange: (text: string) => void;
  onOpenFilters: () => void;
  onPause: () => void;
  onClear: () => void;
  onToggleSelection: () => void;
}) {
  return (
    <div className="feed-toolbar">
      <div>
        <span className="eyebrow">Live feed</span>
        <h1>{channel?.displayName ?? "All channels"}</h1>
      </div>
      <div className="feed-toolbar-right">
        <div className="toolbar-actions">
          <SearchComposer
            channelId={channelId}
            channels={channels}
            match={searchMatch}
            onChange={onTextChange}
            onMatchChange={onSearchMatchChange}
            onTokensChange={onSearchTokensChange}
            resultCount={resultCount}
            searching={searching}
            tokens={searchTokens}
            value={filterText}
          />
          <button className="button filter-trigger" onClick={onOpenFilters}>
            Filters
            {activeFilterCount > 0 && (
              <span className="filter-trigger-count">{activeFilterCount}</span>
            )}
          </button>
          <button className={`button ${paused ? "primary" : ""}`} onClick={onPause}>
            {paused ? "Resume" : "Pause"}
          </button>
          <button className="button" onClick={onClear}>Clear view</button>
          {isAdmin && allowBulkActions && (
            <button
              aria-pressed={selectionMode}
              className={`button ${selectionMode ? "selection-active" : ""}`}
              onClick={onToggleSelection}
            >
              {selectionMode ? "Done selecting" : "Bulk actions"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageFeed({
  messages,
  error,
  paused,
  isAdmin,
  onRetry,
  selectionMode,
  onDeleteMessages,
  onHideImages,
  highlightedIds,
  emotesByChannel,
  badgesByChannel,
  historyEnabled,
  loadMore,
  serverFiltering,
  status,
}: {
  messages: ChatMessage[];
  error?: string;
  paused: boolean;
  isAdmin: boolean;
  onRetry: () => void;
  selectionMode: boolean;
  onDeleteMessages: (messageIds: string[]) => Promise<void>;
  onHideImages: (images: Array<{ messageId: string; url: string }>) => Promise<void>;
  highlightedIds: ReadonlySet<string>;
  emotesByChannel: ReadonlyMap<string, ReadonlyMap<string, ThirdPartyEmote>>;
  badgesByChannel: ReadonlyMap<string, ReadonlyMap<string, ChatBadgeDefinition>>;
  historyEnabled: boolean;
  loadMore: (numItems: number) => void;
  serverFiltering: boolean;
  status: PaginationStatus;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const historyTriggerRef = useRef<HTMLDivElement>(null);
  const previousScrollHeightRef = useRef<number | undefined>(undefined);
  const [followNewest, setFollowNewest] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [moderationBusy, setModerationBusy] = useState(false);

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_BULK_ITEMS) next.add(id);
      return next;
    });
  };

  const runModeration = async (action: () => Promise<void>) => {
    setModerationBusy(true);
    try {
      await action();
      setSelectedIds(new Set());
    } catch {
      // The parent reports the actionable API error in the shared notice area.
    } finally {
      setModerationBusy(false);
    }
  };

  const selectedMessages = messages.filter((message) => selectedIds.has(message._id));
  const selectedImages = selectedMessages.flatMap((message) =>
    (message.imageUrls ?? []).map((url) => ({ messageId: message._id, url })),
  );

  useEffect(() => {
    if (followNewest && !paused) {
      viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight });
    }
  }, [messages, followNewest, paused]);

  useLayoutEffect(() => {
    if (status === "LoadingMore" || previousScrollHeightRef.current === undefined) return;
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollTop += viewport.scrollHeight - previousScrollHeightRef.current;
    }
    previousScrollHeightRef.current = undefined;
  }, [messages.length, status]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const trigger = historyTriggerRef.current;
    if (!viewport || !trigger || paused || !historyEnabled || status !== "CanLoadMore") return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting) ||
          previousScrollHeightRef.current !== undefined) return;
      previousScrollHeightRef.current = viewport.scrollHeight;
      loadMore(HISTORY_PAGE_SIZE);
    }, { root: viewport, rootMargin: "120px 0px 0px" });
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [historyEnabled, loadMore, paused, status]);

  const handleScroll = () => {
    const element = viewportRef.current;
    if (!element) return;
    setFollowNewest(element.scrollHeight - element.scrollTop - element.clientHeight < 100);
  };

  return (
    <div className="feed-wrap">
      {isAdmin && selectionMode && (
        <BulkActionBar
          busy={moderationBusy}
          count={selectedIds.size}
          limit={MAX_BULK_ITEMS}
          onSelectAll={() => setSelectedIds(new Set(
            messages.slice(0, MAX_BULK_ITEMS).map((message) => message._id),
          ))}
          onClear={() => setSelectedIds(new Set())}
          actions={[
            ...(selectedImages.length > 0 ? [{
              label: `Remove images (${selectedImages.length})`,
              run: () => {
                if (window.confirm(`Permanently remove ${selectedImages.length} selected images?`)) {
                  void runModeration(() => onHideImages(selectedImages));
                }
              },
            }] : []),
            {
              danger: true,
              label: `Delete messages (${selectedIds.size})`,
              run: () => {
                if (window.confirm(`Permanently delete ${selectedIds.size} selected messages?`)) {
                  void runModeration(() => onDeleteMessages([...selectedIds]));
                }
              },
            },
          ]}
        />
      )}
      <div className="message-feed" ref={viewportRef} onScroll={handleScroll}>
        <div className="history-loader" ref={historyTriggerRef}>
          {paused ? (
            <span>History loading paused</span>
          ) : status === "LoadingMore" ? (
            <span>Loading older messages…</span>
          ) : historyEnabled && status === "CanLoadMore" ? (
            <span>Searching older messages…</span>
          ) : null}
        </div>
        {status === "LoadingFirstPage" ? (
          <div className="empty">Loading messages…</div>
        ) : status === "Error" ? (
          <div className="empty" role="alert">
            <span aria-hidden="true" className="empty-icon">!</span>
            <strong>Could not load messages</strong>
            <span>{error ?? "The message service is unavailable."}</span>
            <button className="button" onClick={onRetry}>Try again</button>
          </div>
        ) : messages.length === 0 ? (
          <div className="empty">
            <span className="empty-icon">⌁</span>
            <strong>{!historyEnabled
              ? "No messages since clearing"
              : status === "Exhausted"
                ? serverFiltering ? "No matching messages" : "No messages to show"
                : "Searching history…"}</strong>
            <span>{!historyEnabled
              ? "New public chat messages will appear here."
              : status === "Exhausted"
                ? serverFiltering
                  ? "The server searched all saved messages for this filter."
                  : "New public chat messages appear here after the connection starts."
                : "The server is searching older messages for a match."}</span>
          </div>
        ) : (
          messages.map((message) => (
            <MessageRow
              badgeCatalog={badgesByChannel.get(message.externalChannelId)}
              emotes={emotesByChannel.get(message.externalChannelId)}
              highlighted={highlightedIds.has(message._id)}
              isAdmin={isAdmin}
              key={message._id}
              message={message}
              selectable={selectionMode}
              selected={selectedIds.has(message._id)}
              onSelect={() => toggleSelected(message._id)}
              onDelete={() => {
                if (window.confirm("Permanently delete this message from the logs?")) {
                  void runModeration(() => onDeleteMessages([message._id]));
                }
              }}
              onHideImages={() => {
                const images = (message.imageUrls ?? []).map((url) => ({
                  messageId: message._id,
                  url,
                }));
                if (images.length > 0 && window.confirm("Permanently remove every image from this message?")) {
                  void runModeration(() => onHideImages(images));
                }
              }}
            />
          ))
        )}
      </div>
      {!followNewest && (
        <button
          className="button jump-button primary"
          onClick={() => {
            setFollowNewest(true);
            viewportRef.current?.scrollTo({
              top: viewportRef.current.scrollHeight,
              behavior: "smooth",
            });
          }}
        >
          Jump to newest ↓
        </button>
      )}
    </div>
  );
}

function ImageGallery({
  messages,
  error,
  isAdmin,
  onRetry,
  selectionMode,
  onDeleteMessages,
  onHideImages,
  historyEnabled,
  loadMore,
  paused,
  serverFiltering,
  status,
}: {
  messages: ChatMessage[];
  error?: string;
  isAdmin: boolean;
  onRetry: () => void;
  selectionMode: boolean;
  onDeleteMessages: (messageIds: string[]) => Promise<void>;
  onHideImages: (images: Array<{ messageId: string; url: string }>) => Promise<void>;
  historyEnabled: boolean;
  loadMore: (numItems: number) => void;
  paused: boolean;
  serverFiltering: boolean;
  status: PaginationStatus;
}) {
  const images = useMemo(
    () => buildGalleryImages(messages, workerUrl),
    [messages],
  );
  const viewportRef = useRef<HTMLDivElement>(null);
  const historyTriggerRef = useRef<HTMLDivElement>(null);
  const historyLoadPendingRef = useRef(false);
  const [selectedImageIds, setSelectedImageIds] = useState<Set<string>>(() => new Set());
  const [moderationBusy, setModerationBusy] = useState(false);

  const toggleSelected = (id: string) => {
    setSelectedImageIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_BULK_ITEMS) next.add(id);
      return next;
    });
  };

  const runModeration = async (action: () => Promise<void>) => {
    setModerationBusy(true);
    try {
      await action();
      setSelectedImageIds(new Set());
    } catch {
      // The parent reports the actionable API error in the shared notice area.
    } finally {
      setModerationBusy(false);
    }
  };

  const selectedImages = images.filter((image) => selectedImageIds.has(image.id));

  useEffect(() => {
    const viewport = viewportRef.current;
    const trigger = historyTriggerRef.current;
    if (!viewport || !trigger || paused || !historyEnabled || status !== "CanLoadMore") return;

    historyLoadPendingRef.current = false;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || historyLoadPendingRef.current) return;
      historyLoadPendingRef.current = true;
      loadMore(HISTORY_PAGE_SIZE);
    }, { root: viewport, rootMargin: "0px 0px 500px" });
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [historyEnabled, loadMore, paused, status]);

  return (
    <div className="image-gallery-wrap" ref={viewportRef}>
      {isAdmin && selectionMode && (
        <BulkActionBar
          busy={moderationBusy}
          count={selectedImageIds.size}
          limit={MAX_BULK_ITEMS}
          onSelectAll={() => setSelectedImageIds(new Set(
            images.slice(0, MAX_BULK_ITEMS).map((image) => image.id),
          ))}
          onClear={() => setSelectedImageIds(new Set())}
          actions={[
            {
              label: `Remove images (${selectedImageIds.size})`,
              run: () => {
                if (window.confirm(`Permanently remove ${selectedImageIds.size} selected images?`)) {
                  void runModeration(() => onHideImages(selectedImages.map((image) => ({
                    messageId: image.message._id,
                    url: image.url,
                  }))));
                }
              },
            },
            {
              danger: true,
              label: "Delete source messages",
              run: () => {
                const messageIds = [...new Set(selectedImages.map((image) => image.message._id))];
                if (window.confirm(`Permanently delete ${messageIds.length} source messages?`)) {
                  void runModeration(() => onDeleteMessages(messageIds));
                }
              },
            },
          ]}
        />
      )}
      {status === "LoadingFirstPage" ? (
        <div className="empty">Loading artwork…</div>
      ) : status === "Error" ? (
        <div className="empty gallery-empty" role="alert">
          <span aria-hidden="true" className="empty-icon gallery-empty-icon">!</span>
          <strong>Could not load the gallery</strong>
          <span>{error ?? "The message service is unavailable."}</span>
          <button className="button" onClick={onRetry}>Try again</button>
        </div>
      ) : images.length === 0 &&
          (!historyEnabled || status === "Exhausted") ? (
        <div className="empty gallery-empty">
          <span aria-hidden="true" className="empty-icon gallery-empty-icon">+</span>
          <strong>{serverFiltering
            ? "No matching images in searched history"
            : "No images found"}</strong>
          <span>Direct image links and supported artwork pages, including Pixiv, will appear here.</span>
        </div>
      ) : (
        <>
          <div className="gallery-summary">
            <strong>{images.length} {images.length === 1 ? "image" : "images"}</strong>
            <span>{paused
              ? "Paused"
              : status === "Exhausted"
                ? "Complete history"
                : "Newest first · loading history"}</span>
          </div>
          <div className="image-gallery">
            {images.map((image) => (
              <GalleryCard
                image={image}
                isAdmin={isAdmin}
                key={image.id}
                selectable={selectionMode}
                selected={selectedImageIds.has(image.id)}
                onSelect={() => toggleSelected(image.id)}
                onDeleteMessage={() => {
                  if (window.confirm("Permanently delete the message that contains this image?")) {
                    void runModeration(() => onDeleteMessages([image.message._id]));
                  }
                }}
                onHideImage={() => {
                  if (window.confirm("Permanently remove this image from the gallery?")) {
                    void runModeration(() => onHideImages([{
                      messageId: image.message._id,
                      url: image.url,
                    }]));
                  }
                }}
              />
            ))}
          </div>
        </>
      )}
      <div className="gallery-history-loader" ref={historyTriggerRef}>
        {paused ? (
          <span>History loading paused</span>
        ) : status === "LoadingMore" ? (
          <span>Loading older images…</span>
        ) : historyEnabled && status === "CanLoadMore" ? (
          <span>Searching older images…</span>
        ) : images.length > 0 ? (
          <span>All saved images loaded</span>
        ) : null}
      </div>
    </div>
  );
}

function GalleryCard({
  image,
  isAdmin,
  selectable,
  selected,
  onSelect,
  onDeleteMessage,
  onHideImage,
}: {
  image: GalleryImage;
  isAdmin: boolean;
  selectable: boolean;
  selected: boolean;
  onSelect: () => void;
  onDeleteMessage: () => void;
  onHideImage: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [failed, setFailed] = useState(false);
  const [viewerOriginRect, setViewerOriginRect] = useState<DOMRect>();
  const postedAt = new Date(image.message.timestamp);

  const closeImageViewer = useCallback(() => {
    setViewerOriginRect(undefined);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  return (
    <article className={`gallery-card ${selectable ? "moderation-selectable" : ""} ${selected ? "moderation-selected" : ""}`}>
      {selectable && (
        <label className="moderation-check gallery-check">
          <input
            aria-label={`Select image shared by ${image.message.senderDisplayName}`}
            checked={selected}
            onChange={onSelect}
            type="checkbox"
          />
        </label>
      )}
      {isAdmin && (
        <ItemActionMenu label="Image actions" actions={[
          { label: "Remove image", onClick: onHideImage },
          { label: "Delete source message", danger: true, onClick: onDeleteMessage },
        ]} />
      )}
      <button
        aria-haspopup="dialog"
        aria-label={`View full-size image posted by ${image.message.senderDisplayName}`}
        className="gallery-image-trigger"
        onClick={(event) => setViewerOriginRect(event.currentTarget.getBoundingClientRect())}
        ref={triggerRef}
        type="button"
      >
        {failed ? (
          <span className="gallery-image-failed">Image unavailable</span>
        ) : (
          <img
            alt={`Shared by ${image.message.senderDisplayName} in ${image.message.channelName}`}
            decoding="async"
            loading="lazy"
            onError={() => setFailed(true)}
            src={image.previewUrl}
          />
        )}
        <span className="gallery-open-hint">View image</span>
      </button>
      <footer>
        <span>
          <strong>{image.message.senderDisplayName}</strong>
          <small>#{image.message.channelName}</small>
        </span>
        <time dateTime={postedAt.toISOString()} title={postedAt.toLocaleString()}>
          {postedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </time>
      </footer>
      {viewerOriginRect && createPortal(
        <GalleryImageViewer
          image={image}
          originRect={viewerOriginRect}
          onDismiss={closeImageViewer}
        />,
        document.body,
      )}
    </article>
  );
}

function GalleryImageViewer({
  image,
  originRect,
  onDismiss,
}: {
  image: GalleryImage;
  originRect: DOMRect;
  onDismiss: () => void;
}) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closingRef = useRef(false);
  const [failed, setFailed] = useState(false);

  const transitionTransform = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface) return "none";
    const targetRect = surface.getBoundingClientRect();
    const sourceCenterX = originRect.left + originRect.width / 2;
    const sourceCenterY = originRect.top + originRect.height / 2;
    const targetCenterX = targetRect.left + targetRect.width / 2;
    const targetCenterY = targetRect.top + targetRect.height / 2;
    const scale = Math.max(0.08, Math.min(1, originRect.width / targetRect.width));
    return `translate3d(${sourceCenterX - targetCenterX}px, ${sourceCenterY - targetCenterY}px, 0) scale(${scale})`;
  }, [originRect]);

  const closeViewer = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onDismiss();
      return;
    }

    const animations: Promise<unknown>[] = [];
    const surfaceAnimation = surfaceRef.current?.animate([
      { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
      { opacity: 0, transform: transitionTransform() },
    ], {
      duration: 240,
      easing: "cubic-bezier(.7, 0, .84, 0)",
      fill: "forwards",
    });
    if (surfaceAnimation) animations.push(surfaceAnimation.finished);

    const backdropAnimation = backdropRef.current?.animate([
      { opacity: 1 },
      { opacity: 0 },
    ], {
      duration: 160,
      easing: "cubic-bezier(.7, 0, .84, 0)",
      fill: "forwards",
    });
    if (backdropAnimation) animations.push(backdropAnimation.finished);

    void Promise.allSettled(animations).then(onDismiss);
  }, [onDismiss, transitionTransform]);

  useLayoutEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    surfaceRef.current?.animate([
      { opacity: 0.55, transform: transitionTransform() },
      { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
    ], {
      duration: 360,
      easing: "cubic-bezier(.16, 1, .3, 1)",
      fill: "both",
    });
    backdropRef.current?.animate([
      { opacity: 0 },
      { opacity: 1 },
    ], {
      duration: 180,
      easing: "cubic-bezier(.16, 1, .3, 1)",
      fill: "both",
    });
  }, [transitionTransform]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeViewer();
        return;
      }
      if (event.key !== "Tab") return;

      const focusableElements = viewerRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href]",
      );
      if (!focusableElements?.length) return;
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeViewer]);

  return (
    <div
      aria-label={`Image shared by ${image.message.senderDisplayName}`}
      aria-modal="true"
      className="gallery-viewer"
      onMouseDown={(event) => {
        if (!surfaceRef.current?.contains(event.target as Node)) closeViewer();
      }}
      ref={viewerRef}
      role="dialog"
    >
      <div className="gallery-viewer-backdrop" ref={backdropRef} />
      <article className="gallery-viewer-surface" ref={surfaceRef}>
        <button
          aria-label="Close image viewer"
          className="gallery-viewer-close"
          onClick={closeViewer}
          ref={closeButtonRef}
          type="button"
        >
          <span aria-hidden="true">×</span>
        </button>
        <div className="gallery-viewer-canvas">
          {failed ? (
            <span className="gallery-viewer-failed">Full-size image unavailable</span>
          ) : (
            <img
              alt={`Shared by ${image.message.senderDisplayName} in ${image.message.channelName}`}
              decoding="async"
              onError={() => setFailed(true)}
              src={image.previewUrl}
            />
          )}
        </div>
        <footer className="gallery-viewer-footer">
          <span>
            <strong>{image.message.senderDisplayName}</strong>
            <small>#{image.message.channelName}</small>
          </span>
          <a href={image.url} rel="noreferrer" target="_blank">
            Open original <span aria-hidden="true">↗</span>
          </a>
        </footer>
      </article>
    </div>
  );
}

function MessageRow({
  message,
  emotes = new Map(),
  badgeCatalog = new Map(),
  highlighted = false,
  isAdmin,
  selectable,
  selected,
  onSelect,
  onDelete,
  onHideImages,
}: {
  message: ChatMessage;
  emotes?: ReadonlyMap<string, ThirdPartyEmote>;
  badgeCatalog?: ReadonlyMap<string, ChatBadgeDefinition>;
  highlighted?: boolean;
  isAdmin: boolean;
  selectable: boolean;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onHideImages: () => void;
}) {
  const messageParts = buildMessageParts(
    message.messageText,
    message.metadata?.fragments,
    emotes,
  );
  const postedAt = new Date(message.timestamp);
  return (
    <article className={`message-row ${highlighted ? "filter-highlighted" : ""} ${selectable ? "moderation-selectable" : ""} ${selected ? "moderation-selected" : ""}`}>
      {selectable && (
        <label className="moderation-check message-check">
          <input
            aria-label={`Select message from ${message.senderDisplayName}`}
            checked={selected}
            onChange={onSelect}
            type="checkbox"
          />
        </label>
      )}
      {isAdmin && (
        <ItemActionMenu label="Message actions" actions={[
          ...((message.imageUrls?.length ?? 0) > 0
            ? [{ label: "Remove all images", onClick: onHideImages }]
            : []),
          { label: "Delete message", danger: true, onClick: onDelete },
        ]} />
      )}
      <time
        className="message-timestamp"
        dateTime={postedAt.toISOString()}
        title={postedAt.toLocaleString()}
      >
        <span>{postedAt.toLocaleDateString([], {
          day: "2-digit",
          month: "2-digit",
          year: "2-digit",
        })}</span>
        <span>{postedAt.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}</span>
      </time>
      <span className="channel-tag">#{message.channelName}</span>
      <div className="message-content">
        <div className="sender-line">
          {message.badges.map((badge) => {
            const definition = badgeCatalog.get(`${badge.setId}/${badge.id}`);
            return definition ? (
              <img
                alt={definition.title}
                className="chat-badge"
                key={`${badge.setId}/${badge.id}`}
                src={definition.imageUrl}
                title={definition.description || definition.title}
              />
            ) : (
              <span
                className="role-badge"
                key={`${badge.setId}/${badge.id}`}
                title={`${badge.setId} ${badge.id}`}
              >
                {badgeLabel(badge.setId)}
              </span>
            );
          })}
          <strong style={message.userColor ? { color: message.userColor } : undefined}>
            {message.senderDisplayName}
          </strong>
          {message.senderDisplayName.toLowerCase() !== message.senderUsername.toLowerCase() && (
            <small>@{message.senderUsername}</small>
          )}
        </div>
        <p>{renderMessageParts(messageParts)}</p>
      </div>
    </article>
  );
}

function ItemActionMenu({
  label,
  actions,
}: {
  label: string;
  actions: Array<{ label: string; danger?: boolean; onClick: () => void }>;
}) {
  return (
    <details className="item-action-menu">
      <summary aria-label={label} title={label}>•••</summary>
      <div role="menu">
        {actions.map((action) => (
          <button
            className={action.danger ? "danger" : ""}
            key={action.label}
            onClick={(event) => {
              const details = event.currentTarget.closest("details");
              if (details) details.open = false;
              action.onClick();
            }}
            role="menuitem"
            type="button"
          >
            {action.label}
          </button>
        ))}
      </div>
    </details>
  );
}

function BulkActionBar({
  count,
  limit,
  busy,
  onSelectAll,
  onClear,
  actions,
}: {
  count: number;
  limit: number;
  busy: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  actions: Array<{ label: string; danger?: boolean; run: () => void }>;
}) {
  return (
    <div className="bulk-action-bar" aria-label="Bulk moderation actions">
      <strong>{count} selected</strong>
      <span>Up to {limit} at once</span>
      <button disabled={busy} onClick={onSelectAll} type="button">Select visible</button>
      {count > 0 && <button disabled={busy} onClick={onClear} type="button">Clear</button>}
      <div>
        {actions.map((action) => (
          <button
            className={action.danger ? "danger" : ""}
            disabled={busy || count === 0}
            key={action.label}
            onClick={action.run}
            type="button"
          >
            {busy ? "Working…" : action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function badgeLabel(setId: string) {
  const labels: Record<string, string> = {
    broadcaster: "Broadcaster",
    moderator: "Mod",
    vip: "VIP",
    subscriber: "Sub",
    founder: "Founder",
  };
  return labels[setId] ?? setId.replaceAll("-", " ");
}

function useThirdPartyEmotes(channelIds: string[]) {
  const [catalogs, setCatalogs] = useState(
    () => new Map<string, ReadonlyMap<string, ThirdPartyEmote>>(),
  );
  const channelIdKey = [...channelIds].sort().join(",");

  useEffect(() => {
    const ids = channelIdKey ? channelIdKey.split(",") : [];
    if (ids.length === 0) return;
    const controller = new AbortController();
    void Promise.all(
      ids.map(async (id) => {
        const response = await fetch(`${workerUrl}/emotes/twitch/${encodeURIComponent(id)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Could not load emotes for Twitch channel ${id}`);
        const body = (await response.json()) as { emotes?: ThirdPartyEmote[] };
        return [id, new Map((body.emotes ?? []).map((emote) => [emote.name, emote]))] as const;
      }),
    )
      .then((entries) => setCatalogs((current) => new Map([...current, ...entries])))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.warn("Third-party emotes are unavailable; showing message text", error);
        }
      });
    return () => controller.abort();
  }, [channelIdKey]);

  return catalogs;
}

function useTwitchBadges(channelIds: string[]) {
  const [catalogs, setCatalogs] = useState(
    () => new Map<string, ReadonlyMap<string, ChatBadgeDefinition>>(),
  );
  const channelIdKey = [...channelIds].sort().join(",");

  useEffect(() => {
    const ids = channelIdKey ? channelIdKey.split(",") : [];
    if (ids.length === 0) return;
    const controller = new AbortController();
    const load = async () => {
      const entries = await Promise.all(
        ids.map(async (id) => {
          try {
            const response = await fetch(
              `${workerUrl}/badges/twitch/${encodeURIComponent(id)}`,
              { signal: controller.signal },
            );
            if (!response.ok) throw new Error(`Could not load badges for Twitch channel ${id}`);
            const body = (await response.json()) as { badges?: ChatBadgeDefinition[] };
            return [
              id,
              new Map(
                (body.badges ?? []).map((badge) => [`${badge.setId}/${badge.id}`, badge]),
              ),
            ] as const;
          } catch (error) {
            if (!(error instanceof DOMException && error.name === "AbortError")) {
              console.warn("Twitch badges are unavailable; showing text labels", error);
            }
            return undefined;
          }
        }),
      );
      if (controller.signal.aborted) return;
      const loaded = entries.filter((entry) => entry !== undefined);
      if (loaded.length > 0) {
        setCatalogs((current) => new Map([...current, ...loaded]));
      }
    };
    void load();
    const retry = window.setTimeout(() => void load(), 5_000);
    return () => {
      controller.abort();
      window.clearTimeout(retry);
    };
  }, [channelIdKey]);

  return catalogs;
}

function AddChannelDialog({
  onClose,
  onError,
  authenticated,
}: {
  onClose: () => void;
  onError: (message: string) => void;
  authenticated: boolean;
}) {
  const add = useMutation(api.channels.add);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loggingEnabled, setLoggingEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await add({
        platform: "twitch",
        username,
        ...(displayName.trim() ? { displayName } : {}),
        loggingEnabled,
      });
      onClose();
    } catch (error) {
      onError((error as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="dialog" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div><span className="eyebrow">New source</span><h2>Add a channel</h2><p>Messages begin logging only after this worker subscribes. Twitch does not provide earlier chat history.</p></div>
        {!authenticated && <div className="warning">Connect Twitch before enabling live logging.</div>}
        <label className="field"><span>Platform</span><select disabled value="twitch"><option value="twitch">Twitch</option></select></label>
        <label className="field"><span>Channel username</span><input autoFocus required value={username} onChange={(event) => setUsername(event.target.value)} placeholder="twitchdev" /></label>
        <label className="field"><span>Display name (optional)</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Resolved automatically" /></label>
        <label className="checkbox"><input type="checkbox" checked={loggingEnabled} onChange={(event) => setLoggingEnabled(event.target.checked)} /><span>Enable logging immediately</span></label>
        <div className="dialog-actions"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={saving}>{saving ? "Adding…" : "Add channel"}</button></div>
      </form>
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(error, info); }
  render() {
    if (this.state.error) {
      return <div className="fatal"><h1>Something went wrong</h1><p>{this.state.error.message}</p><button className="button primary" onClick={() => location.reload()}>Reload</button></div>;
    }
    return this.props.children;
  }
}
