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
import type { GameId, ScorePeriod } from "./gameScores";
import {
  buildPageUrl,
  mergeUrlFilters,
  parsePageUrl,
  type PageUrlState,
} from "./pageUrlState";
import SearchComposer from "./SearchComposer";
import {
  buildSmartSearchFilter,
  type SmartSearchToken,
} from "./smartSearch";
import {
  parseUserSettings,
  serializeUserSettings,
  USER_SETTINGS_STORAGE_KEY,
  type UserSettings,
} from "./userSettings";

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

function loadSavedUserSettings() {
  try {
    return parseUserSettings(localStorage.getItem(USER_SETTINGS_STORAGE_KEY));
  } catch {
    return parseUserSettings(null);
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
  const channelResults = useQuery(api.channels.list, {});
  const channels = useMemo(() => channelResults ?? [], [channelResults]);
  const serverChatTabs = useQuery(api.chatTabs.list, {});
  const [initialPageState] = useState(() => parsePageUrl(window.location.search));
  const [selectedChannelMarker, setSelectedChannelMarker] = useState<string | undefined>(
    initialPageState.channel,
  );
  const [filterDialogOpen, setFilterDialogOpen] = useState(false);
  const [querySearch, setQuerySearch] = useState(initialPageState.quickSearch);
  const [searchTokens, setSearchTokens] = useState<SmartSearchToken[]>(
    initialPageState.searchTokens,
  );
  const [searchMatch, setSearchMatch] = useState<FilterMatchMode>(initialPageState.searchMatch);
  const [filterState, setFilterState] = useState<FilterState>(() =>
    mergeUrlFilters(loadSavedFilterState(), initialPageState.filters),
  );
  const [legacyChatTabs, setLegacyChatTabs] = useState<ChatViewTab[]>(loadSavedChatTabs);
  const chatTabMigrationStartedRef = useRef(false);
  const [activeChatTabId, setActiveChatTabId] = useState(initialPageState.tabId ?? "all");
  const [editingChatTab, setEditingChatTab] = useState<ChatViewTab | "new">();
  const [paused, setPaused] = useState(false);
  const [pausedMessages, setPausedMessages] = useState<ChatMessage[]>([]);
  const [pausedMessageKey, setPausedMessageKey] = useState("");
  const [clearBefore, setClearBefore] = useState(0);
  const [auth, setAuth] = useState<TwitchAuthStatus>();
  const [adminAccess, setAdminAccess] = useState<AdminAccessStatus>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [userSettings, setUserSettings] = useState<UserSettings>(loadSavedUserSettings);
  const [notice, setNotice] = useState<string>();
  const [selectionMode, setSelectionMode] = useState(false);
  const [scoreGame, setScoreGame] = useState<GameId>(initialPageState.scoreGame ?? "rngdle");
  const [scorePeriod, setScorePeriod] = useState<ScorePeriod>(
    initialPageState.scorePeriod ?? "all",
  );
  const chatTabs = serverChatTabs === undefined ||
      (serverChatTabs.length === 0 && legacyChatTabs.length > 0)
    ? legacyChatTabs
    : serverChatTabs;
  const selectedChannel = resolveChannel(channels, selectedChannelMarker);
  const selectedChannelId = selectedChannel?._id;
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

  const urlStateReady = (!initialPageState.channel || channelResults !== undefined) &&
    (!initialPageState.tabId || serverChatTabs !== undefined ||
      chatTabs.some((tab) => tab.id === initialPageState.tabId));

  const applyPageUrlState = useCallback((pageState: PageUrlState) => {
    setSelectedChannelMarker(pageState.channel);
    setActiveChatTabId(
      pageState.tabId && chatTabs.some((tab) => tab.id === pageState.tabId)
        ? pageState.tabId
        : "all",
    );
    setQuerySearch(pageState.quickSearch);
    setSearchTokens(pageState.searchTokens);
    setSearchMatch(pageState.searchMatch);
    setFilterState((current) => mergeUrlFilters(current, pageState.filters));
    setScoreGame(pageState.scoreGame ?? "rngdle");
    setScorePeriod(pageState.scorePeriod ?? "all");
    setPaused(false);
    setPausedMessages([]);
    setPausedMessageKey("");
    setClearBefore(0);
    setSelectionMode(false);
    setFilterDialogOpen(false);
    setEditingChatTab(undefined);
  }, [chatTabs]);

  useEffect(() => {
    if (!urlStateReady) return;
    const restoreFromUrl = () => applyPageUrlState(parsePageUrl(window.location.search));
    window.addEventListener("popstate", restoreFromUrl);
    return () => window.removeEventListener("popstate", restoreFromUrl);
  }, [applyPageUrlState, urlStateReady]);

  useEffect(() => {
    if (!urlStateReady) return;
    const nextUrl = buildPageUrl(window.location.href, {
      channel: selectedChannel?.username,
      tabId: activeChatTab?.id,
      quickSearch: querySearch,
      searchTokens,
      searchMatch,
      filters: activeFilters,
      scoreGame: scoresActive ? scoreGame : undefined,
      scorePeriod: scoresActive ? scorePeriod : undefined,
    });
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl !== currentUrl) window.history.replaceState(window.history.state, "", nextUrl);
  }, [
    activeChatTab,
    activeFilters,
    querySearch,
    scoreGame,
    scorePeriod,
    scoresActive,
    searchMatch,
    searchTokens,
    selectedChannel,
    urlStateReady,
  ]);

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
    try {
      localStorage.setItem(USER_SETTINGS_STORAGE_KEY, serializeUserSettings(userSettings));
    } catch (error) {
      console.warn("Could not persist user settings", error);
    }
  }, [userSettings]);

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
            onSelect={setSelectedChannelMarker}
            onAdd={() => setDialogOpen(true)}
            onError={setNotice}
            onOpenFeedback={() => setFeedbackDialogOpen(true)}
            onOpenSettings={() => setSettingsDialogOpen(true)}
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
                  game={scoreGame}
                  historyEnabled={clearBefore === 0}
                  isAdmin={isAdmin}
                  key={messageFeedKey}
                  loadMore={gameScoresQuery.loadMore}
                  messages={sourceMessages}
                  onGameChange={setScoreGame}
                  onDeleteMessage={(messageId) => deleteMessages([messageId])}
                  onPeriodChange={setScorePeriod}
                  onRetry={gameScoresQuery.retry}
                  paused={paused}
                  period={scorePeriod}
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
                renderInlineImages={
                  activeChatTab === undefined && userSettings.inlineImagesInAllChat
                }
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
        {settingsDialogOpen && (
          <SettingsDialog
            onChange={setUserSettings}
            onClose={() => setSettingsDialogOpen(false)}
            settings={userSettings}
          />
        )}
        {feedbackDialogOpen && (
          <FeedbackDialog onClose={() => setFeedbackDialogOpen(false)} />
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

function resolveChannel(channels: Channel[], marker?: string) {
  if (!marker) return undefined;
  const normalized = marker.toLowerCase();
  return channels.find((channel) =>
    channel._id === marker ||
    channel.externalChannelId === marker ||
    channel.username.toLowerCase() === normalized
  );
}

const CHANNEL_STATUS_LABELS: Record<Channel["connectionStatus"], string> = {
  connected: "Connected",
  connecting: "Connecting",
  disconnected: "Disconnected",
  error: "Connection error",
  authorization_required: "Authorization required",
};

function channelInitials(displayName: string) {
  const words = displayName.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return "T";
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
}

function ChannelSidebar({
  channels,
  selectedChannelId,
  isAdmin,
  onSelect,
  onAdd,
  onError,
  onOpenFeedback,
  onOpenSettings,
}: {
  channels: Channel[];
  selectedChannelId?: string;
  isAdmin: boolean;
  onSelect: (id?: string) => void;
  onAdd: () => void;
  onError: (message: string) => void;
  onOpenFeedback: () => void;
  onOpenSettings: () => void;
}) {
  const setLogging = useMutation(api.channels.setLogging);
  const reconnect = useMutation(api.channels.reconnect);
  const remove = useMutation(api.channels.remove);
  const [channelQuery, setChannelQuery] = useState("");
  const channelSearchRef = useRef<HTMLInputElement>(null);

  const visibleChannels = useMemo(() => {
    const query = channelQuery.trim().toLocaleLowerCase();
    if (!query) return channels;
    return channels.filter((channel) =>
      channel.displayName.toLocaleLowerCase().includes(query) ||
      channel.username.toLocaleLowerCase().includes(query)
    );
  }, [channelQuery, channels]);

  useEffect(() => {
    const handleCommandShortcut = (event: KeyboardEvent) => {
      if (document.querySelector(".dialog-backdrop")) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        channelSearchRef.current?.focus();
        channelSearchRef.current?.select();
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || !/^[0-9]$/.test(event.key)) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;

      const shortcut = Number(event.key);
      if (shortcut === 0) {
        event.preventDefault();
        onSelect(undefined);
        return;
      }

      const channel = channels[shortcut - 1];
      if (!channel) return;
      event.preventDefault();
      onSelect(channel._id);
    };

    window.addEventListener("keydown", handleCommandShortcut);
    return () => window.removeEventListener("keydown", handleCommandShortcut);
  }, [channels, onSelect]);

  const run = (action: Promise<unknown>) => {
    void action.catch((error: Error) => onError(error.message));
  };

  return (
    <aside className="sidebar channels-panel command-sidebar">
      <div className="channel-command-search">
        <label htmlFor="channel-command-query">Find a channel</label>
        <div className="channel-command-field">
          <svg aria-hidden="true" viewBox="0 0 16 16">
            <circle cx="7" cy="7" r="4.4" />
            <path d="m10.4 10.4 3.1 3.1" />
          </svg>
          <input
            id="channel-command-query"
            ref={channelSearchRef}
            type="search"
            value={channelQuery}
            onChange={(event) => setChannelQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              setChannelQuery("");
              event.currentTarget.blur();
            }}
            placeholder="Name or username"
            autoComplete="off"
          />
          {channelQuery ? (
            <button type="button" onClick={() => setChannelQuery("")} aria-label="Clear channel search">×</button>
          ) : (
            <kbd>Ctrl K</kbd>
          )}
        </div>
      </div>

      <div className="command-group-heading"><span>Feeds</span><span>Shortcut</span></div>
      <button
        className={`command-feed-item all ${selectedChannelId ? "" : "selected"}`}
        onClick={() => onSelect(undefined)}
        aria-pressed={!selectedChannelId}
      >
        <span className="command-channel-avatar all">∞</span>
        <span className="command-channel-copy"><strong>All channels</strong><small>Combined live feed</small></span>
        <kbd>0</kbd>
      </button>

      <div className="command-group-heading channels"><span>Channels</span><span>{visibleChannels.length === channels.length ? channels.length : `${visibleChannels.length} / ${channels.length}`}</span></div>
      <div className="command-channel-list">
        {visibleChannels.map((channel) => {
          const shortcut = channels.indexOf(channel) + 1;
          const selected = selectedChannelId === channel._id;
          return (
            <div key={channel._id} className={`command-channel-item ${selected ? "selected" : ""}`}>
              <button
                className="command-channel-main"
                onClick={() => onSelect(channel._id)}
                aria-pressed={selected}
              >
                <span className="command-channel-avatar">{channelInitials(channel.displayName)}</span>
                <span className="command-channel-copy">
                  <strong>{channel.displayName}</strong>
                  <small>
                    {CHANNEL_STATUS_LABELS[channel.connectionStatus]}
                    <span aria-hidden="true"> · </span>
                    {channel.loggingEnabled ? "Logging" : "Paused"}
                  </small>
                </span>
                <span className="command-channel-trailing">
                  <span
                    className={`status-dot ${channel.connectionStatus}`}
                    title={channel.connectionError ?? CHANNEL_STATUS_LABELS[channel.connectionStatus]}
                  />
                  {shortcut <= 9 ? <kbd>{shortcut}</kbd> : null}
                </span>
              </button>
              {isAdmin && selected ? (
                <div className="command-channel-actions">
                  <button onClick={() => run(setLogging({ id: channel._id, enabled: !channel.loggingEnabled }))}>
                    {channel.loggingEnabled ? "Pause logging" : "Start logging"}
                  </button>
                  {(channel.connectionStatus === "error" || channel.connectionStatus === "disconnected") ? (
                    <button onClick={() => run(reconnect({ id: channel._id }))}>Reconnect</button>
                  ) : null}
                  <button
                    className="danger"
                    onClick={() => run(remove({ id: channel._id }).then(() => {
                      if (selectedChannelId === channel._id) onSelect(undefined);
                    }))}
                  >
                    Remove
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
        {channels.length === 0 ? (
          <div className="command-channel-empty"><strong>No channels yet</strong><span>{isAdmin ? "Add one to begin logging." : "An admin can add the first channel."}</span></div>
        ) : visibleChannels.length === 0 ? (
          <div className="command-channel-empty"><strong>No matching channels</strong><span>Try another name or username.</span><button type="button" onClick={() => setChannelQuery("")}>Clear search</button></div>
        ) : null}
      </div>

      <footer className="command-sidebar-footer">
        {isAdmin ? (
          <button className="command-footer-action primary" onClick={onAdd} type="button"><span>+</span>Add</button>
        ) : (
          <a className="command-footer-action primary" href="/admin">Admin</a>
        )}
        <button className="command-footer-action" onClick={onOpenFeedback} type="button">
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2.2 2.5h11.6v8.1H7l-3.7 2.9v-2.9H2.2V2.5Zm3 3.1h5.6M5.2 7.9h3.6" /></svg>
          Feedback
        </button>
        <button className="command-footer-action" onClick={onOpenSettings} type="button">
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M6.6 1.8h2.8l.4 1.6c.3.1.6.3.9.5l1.6-.5 1.4 2.4-1.2 1.1v1.2l1.2 1.1-1.4 2.4-1.6-.5-.9.5-.4 1.6H6.6l-.4-1.6-.9-.5-1.6.5-1.4-2.4 1.2-1.1V6.9L2.3 5.8l1.4-2.4 1.6.5.9-.5.4-1.6ZM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" /></svg>
          Settings
        </button>
      </footer>
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
  renderInlineImages,
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
  renderInlineImages: boolean;
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
              renderInlineImages={renderInlineImages}
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
          <span>Image links are detected automatically. Supported artwork pages, including Pixiv, appear here too.</span>
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
  renderInlineImages,
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
  renderInlineImages: boolean;
}) {
  const messageParts = buildMessageParts(
    message.messageText,
    message.nativeEmotes,
    emotes,
  );
  const postedAt = new Date(message.timestamp);
  const inlineImages = useMemo(
    () => renderInlineImages ? buildGalleryImages([message], workerUrl) : [],
    [message, renderInlineImages],
  );
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
        {inlineImages.length > 0 && (
          <div className="message-inline-images">
            {inlineImages.map((image) => (
              <InlineChatImage image={image} key={image.id} />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function InlineChatImage({ image }: { image: GalleryImage }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <a className="inline-image-fallback" href={image.url} rel="noreferrer" target="_blank">
        Image preview unavailable — open original
      </a>
    );
  }
  return (
    <a
      className="message-inline-image"
      href={image.url}
      rel="noreferrer"
      target="_blank"
      title="Open original image"
    >
      <img
        alt={`Image shared by ${image.message.senderDisplayName}`}
        decoding="async"
        loading="lazy"
        onError={() => setFailed(true)}
        src={image.previewUrl}
      />
    </a>
  );
}

const FEEDBACK_COOLDOWN_STORAGE_KEY = "twitch-logger-feedback-cooldown-until";

function readFeedbackCooldown() {
  if (typeof localStorage === "undefined") return 0;
  try {
    const value = Number(localStorage.getItem(FEEDBACK_COOLDOWN_STORAGE_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function rememberFeedbackCooldown(retryAt: number) {
  if (typeof localStorage === "undefined") return;
  try {
    if (retryAt > Date.now()) {
      localStorage.setItem(FEEDBACK_COOLDOWN_STORAGE_KEY, String(retryAt));
    } else {
      localStorage.removeItem(FEEDBACK_COOLDOWN_STORAGE_KEY);
    }
  } catch {
    // The server remains authoritative when browser storage is unavailable.
  }
}

function formatFeedbackCooldown(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${String(remainder).padStart(2, "0")}s` : `${remainder}s`;
}

function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const submitFeedback = useMutation(api.feedback.submit);
  const [kind, setKind] = useState<"feedback" | "issue">();
  const [description, setDescription] = useState("");
  const [contactUsername, setContactUsername] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [submitted, setSubmitted] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(readFeedbackCooldown);
  const [cooldownChecked, setCooldownChecked] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const retryAfterSeconds = Math.max(0, Math.ceil((cooldownUntil - clock) / 1_000));
  const limited = retryAfterSeconds > 0;
  const checkingCooldown = !cooldownChecked && !limited;

  const checkCooldown = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`${workerUrl}/api/feedback/status`, {
        credentials: "include",
        signal,
      });
      if (!response.ok) throw new Error("Cooldown status unavailable");
      const status = await response.json() as {
        limited: boolean;
        retryAfterSeconds: number;
        retryAt?: number;
      };
      const retryAt = status.limited
        ? status.retryAt ?? Date.now() + status.retryAfterSeconds * 1_000
        : 0;
      setCooldownUntil(retryAt);
      setClock(Date.now());
      rememberFeedbackCooldown(retryAt);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
    } finally {
      if (!signal?.aborted) setCooldownChecked(true);
    }
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void checkCooldown(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [checkCooldown]);

  useEffect(() => {
    if (!limited) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [limited]);

  const selectKind = (nextKind: "feedback" | "issue") => {
    setKind(nextKind);
    setError(undefined);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const message = description.trim();
    if (!kind) {
      setError("Choose feedback or issue report before submitting.");
      return;
    }
    if (!message) {
      setError("Add a description before submitting.");
      return;
    }
    const username = contactUsername.trim().replace(/^@/, "").toLowerCase();
    if (username && !/^[a-z0-9_]{1,25}$/.test(username)) {
      setError("Enter a valid Twitch username using letters, numbers, or underscores.");
      return;
    }

    setSaving(true);
    setError(undefined);
    try {
      const result = await submitFeedback({
        kind,
        description: message,
        ...(username ? { contactUsername: username } : {}),
      });
      setCooldownUntil(result.retryAt);
      setClock(Date.now());
      rememberFeedbackCooldown(result.retryAt);
      setSubmitted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your report could not be sent.");
      void checkCooldown();
    } finally {
      setSaving(false);
    }
  };

  const heading = kind === "feedback"
    ? "Give feedback"
    : kind === "issue"
      ? "Report an issue"
      : "Feedback & issues";

  return (
    <div className="dialog-backdrop" onMouseDown={onClose} role="presentation">
      <form
        aria-labelledby="feedback-dialog-title"
        aria-modal="true"
        className="dialog feedback-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
        role="dialog"
      >
        <div className="feedback-dialog-heading">
          <div>
            <span className="eyebrow">Help improve Twitch Logger</span>
            <h2 id="feedback-dialog-title">
              {submitted
                ? "Thanks for helping"
                : limited
                  ? "Submission cooldown active"
                  : checkingCooldown
                    ? "Checking availability"
                    : heading}
            </h2>
            <p>
              {submitted
                ? `Your ${kind === "issue" ? "issue report" : "feedback"} has been sent.`
                : limited
                  ? "You've already sent something recently. Your next submission will be available soon."
                  : checkingCooldown
                    ? "We're checking whether this IP address can send another submission."
                : kind === "issue"
                  ? "Tell us what went wrong and what you expected to happen."
                  : kind === "feedback"
                    ? "Share an idea, suggestion, or something that could work better."
                    : "Choose what you want to send, then add the details."}
            </p>
          </div>
          <button
            aria-label="Close feedback and issues"
            className="dialog-close"
            onClick={onClose}
            type="button"
          >
            {"\u00d7"}
          </button>
        </div>

        {submitted ? (
          <div className="feedback-success" role="status">
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="m5 12.5 4.2 4.2L19 7" />
            </svg>
            <span>We appreciate you taking the time.</span>
          </div>
        ) : limited ? (
          <div className="feedback-cooldown" role="status">
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="8.5" />
              <path d="M12 7.5v5l3.25 2" />
            </svg>
            <span className="feedback-cooldown-kicker">One submission per IP address</span>
            <strong>{formatFeedbackCooldown(retryAfterSeconds)}</strong>
            <p>You can give feedback or report another issue when this timer reaches zero.</p>
          </div>
        ) : checkingCooldown ? (
          <div className="feedback-cooldown checking" role="status">
            <span className="feedback-cooldown-spinner" />
            <strong>Checking your cooldown…</strong>
            <p>This should only take a moment.</p>
          </div>
        ) : (
          <>
            <fieldset className="feedback-kind-picker">
              <legend>What would you like to send?</legend>
              <div>
                <button
                  aria-pressed={kind === "feedback"}
                  className={kind === "feedback" ? "selected" : ""}
                  onClick={() => selectKind("feedback")}
                  type="button"
                >
                  <span className="feedback-kind-mark">01</span>
                  <span><strong>Give feedback</strong><small>Ideas and suggestions</small></span>
                </button>
                <button
                  aria-pressed={kind === "issue"}
                  className={kind === "issue" ? "selected" : ""}
                  onClick={() => selectKind("issue")}
                  type="button"
                >
                  <span className="feedback-kind-mark">02</span>
                  <span><strong>Report an issue</strong><small>Something isn't working</small></span>
                </button>
              </div>
            </fieldset>

            <label className="feedback-contact" htmlFor="feedback-contact-username">
              <span>
                <strong>Twitch username</strong>
                <small>Optional · so we can follow up</small>
              </span>
              <div>
                <span aria-hidden="true">@</span>
                <input
                  autoCapitalize="none"
                  autoComplete="username"
                  id="feedback-contact-username"
                  maxLength={25}
                  onChange={(event) => {
                    setContactUsername(event.target.value.replace(/^@/, ""));
                    setError(undefined);
                  }}
                  pattern="[A-Za-z0-9_]{1,25}"
                  placeholder="your_username"
                  spellCheck={false}
                  value={contactUsername}
                />
              </div>
            </label>

            <label className="feedback-description" htmlFor="feedback-description">
              <span>
                <strong>{kind === "issue" ? "What happened?" : "Your description"}</strong>
                <small>{description.length.toLocaleString()} / 4,000</small>
              </span>
              <textarea
                id="feedback-description"
                maxLength={4_000}
                onChange={(event) => {
                  setDescription(event.target.value);
                  setError(undefined);
                }}
                placeholder={kind === "issue"
                  ? "Describe the problem, where you saw it, and how to reproduce it…"
                  : "What would you like us to know?"}
                required
                rows={6}
                value={description}
              />
            </label>

            {error && <div className="feedback-error" role="alert">{error}</div>}
          </>
        )}

        <div className="dialog-actions">
          {submitted ? (
            <button autoFocus className="button primary" onClick={onClose} type="button">
              Done
            </button>
          ) : limited || checkingCooldown ? (
            <button autoFocus className="button primary" onClick={onClose} type="button">
              Close
            </button>
          ) : (
            <>
              <button className="button" onClick={onClose} type="button">Cancel</button>
              <button
                className="button primary"
                disabled={!kind || !description.trim() || saving}
                type="submit"
              >
                {saving ? "Sending…" : kind === "issue" ? "Send issue report" : "Send feedback"}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

function SettingsDialog({
  onChange,
  onClose,
  settings,
}: {
  onChange: (settings: UserSettings) => void;
  onClose: () => void;
  settings: UserSettings;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onMouseDown={onClose} role="presentation">
      <section
        aria-labelledby="settings-dialog-title"
        aria-modal="true"
        className="dialog settings-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="settings-dialog-heading">
          <div>
            <span className="eyebrow">This browser</span>
            <h2 id="settings-dialog-title">Settings</h2>
            <p>These preferences are saved only on this device.</p>
          </div>
          <button
            aria-label="Close settings"
            autoFocus
            className="dialog-close"
            onClick={onClose}
            type="button"
          >
            {"\u00d7"}
          </button>
        </div>
        <label className="settings-option">
          <span>
            <strong>Show images in All chat</strong>
            <small>
              Automatically load supported image links inside their chat message.
            </small>
          </span>
          <input
            checked={settings.inlineImagesInAllChat}
            onChange={(event) => onChange({
              ...settings,
              inlineImagesInAllChat: event.target.checked,
            })}
            type="checkbox"
          />
        </label>
        <div className="settings-privacy-note">
          When enabled, image hosts can receive your browser's request as previews load.
        </div>
        <div className="dialog-actions">
          <button className="button primary" onClick={onClose} type="button">Done</button>
        </div>
      </section>
    </div>
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

    const loadCatalogs = () => {
      void Promise.all(
        ids.map(async (id) => {
          const response = await fetch(`${workerUrl}/emotes/twitch/${encodeURIComponent(id)}`, {
            cache: "no-cache",
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
    };

    loadCatalogs();
    const interval = window.setInterval(loadCatalogs, 60_000);
    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
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
