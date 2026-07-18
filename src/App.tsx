import {
  Component,
  lazy,
  Suspense,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useMutation,
  usePaginatedQuery,
  useQuery,
  type PaginationStatus,
} from "convex/react";
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
  serializeChatTabs,
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
  type FilterState,
  type MessageFilter,
} from "./filters";
import { workerUrl } from "./runtimeConfig";

const FilterWorkspace = lazy(() => import("./FilterWorkspace"));
const INITIAL_MESSAGE_COUNT = 50;
const HISTORY_PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 200;

interface AuthStatus {
  configured?: boolean;
  authenticated: boolean;
  login?: string;
  reason?: string;
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

export default function App() {
  const channels = useQuery(api.channels.list, {}) ?? [];
  const [selectedChannelId, setSelectedChannelId] = useState<string>();
  const [view, setView] = useState<"chat" | "filters">("chat");
  const [quickSearch, setQuickSearch] = useState("");
  const [querySearch, setQuerySearch] = useState("");
  const [filterState, setFilterState] = useState<FilterState>(loadSavedFilterState);
  const [chatTabs, setChatTabs] = useState<ChatViewTab[]>(loadSavedChatTabs);
  const [activeChatTabId, setActiveChatTabId] = useState("all");
  const [editingChatTab, setEditingChatTab] = useState<ChatViewTab | "new">();
  const [paused, setPaused] = useState(false);
  const [pausedMessages, setPausedMessages] = useState<ChatMessage[]>([]);
  const [pausedMessageKey, setPausedMessageKey] = useState("");
  const [clearBefore, setClearBefore] = useState(0);
  const [auth, setAuth] = useState<AuthStatus>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const selectedChannel = channels.find((channel) => channel._id === selectedChannelId);
  const activeChatTab = chatTabs.find((tab) => tab.id === activeChatTabId);
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
    () => viewFilters.filter((filter) => filter.action !== "highlight"),
    [viewFilters],
  );
  const galleryActive = view === "chat" && activeChatTab?.layout === "gallery";
  const queryArgs = useMemo(
    () => ({
      ...(selectedChannelId ? { channelId: selectedChannelId } : {}),
      ...(querySearch.trim() ? { quickSearch: querySearch } : {}),
      ...(selectionFilters.length > 0 ? { filters: selectionFilters } : {}),
      ...(clearBefore > 0 ? { afterTimestamp: clearBefore } : {}),
    }),
    [selectedChannelId, querySearch, selectionFilters, clearBefore],
  );
  const messageFeedKey = useMemo(() => JSON.stringify(queryArgs), [queryArgs]);
  const recentQuery = usePaginatedQuery(
    api.messages.page,
    view === "chat" && !galleryActive ? queryArgs : "skip",
    { initialNumItems: INITIAL_MESSAGE_COUNT },
  );
  const galleryQuery = usePaginatedQuery(
    api.messages.pageImages,
    galleryActive ? queryArgs : "skip",
    { initialNumItems: 50 },
  );
  const messages: ChatMessage[] = useMemo(
    () => galleryActive
      ? galleryQuery.results
      : [...recentQuery.results].reverse(),
    [galleryActive, galleryQuery.results, recentQuery.results],
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
    view === "filters" && filterState.filters.length > 0
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
  const visibleChannelIds = useMemo(
    () => galleryActive
      ? []
      : [...new Set(messages.map((message) => message.externalChannelId))],
    [galleryActive, messages],
  );
  const emotesByChannel = useThirdPartyEmotes(visibleChannelIds);
  const badgesByChannel = useTwitchBadges(visibleChannelIds);

  useEffect(() => {
    const timeout = window.setTimeout(() => setQuerySearch(quickSearch), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [quickSearch]);

  useEffect(() => {
    void ensureSeeded({});
    void fetch(`${workerUrl}/auth/twitch/status`)
      .then((response) => response.json())
      .then((status: AuthStatus) => setAuth(status))
      .catch(() => setAuth({ authenticated: false, reason: "Ingestion worker is offline" }));
  }, [ensureSeeded]);

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, serializeFilterState(filterState));
    } catch (error) {
      console.warn("Could not persist filters", error);
    }
  }, [filterState]);

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_TABS_STORAGE_KEY, serializeChatTabs(chatTabs));
    } catch (error) {
      console.warn("Could not persist chat tabs", error);
    }
  }, [chatTabs]);

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
    setChatTabs((current) => current.some((candidate) => candidate.id === tab.id)
      ? current.map((candidate) => candidate.id === tab.id ? tab : candidate)
      : [...current, tab]);
    setActiveChatTabId(tab.id);
    setEditingChatTab(undefined);
  };

  const deleteChatTab = (id: string) => {
    setChatTabs((current) => current.filter((tab) => tab.id !== id));
    if (activeChatTabId === id) setActiveChatTabId("all");
    setEditingChatTab(undefined);
  };

  return (
    <ErrorBoundary>
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark">TL</span>
            <div>
              <strong>Twitch Logs</strong>
              <small>EventSub live monitor</small>
            </div>
          </div>
          {auth?.authenticated ? (
            <span className="auth-chip connected">Connected as {auth.login}</span>
          ) : auth?.configured === false ? (
            <span className="auth-chip setup" title={auth.reason}>
              Twitch setup required
            </span>
          ) : (
            <a className="button primary" href={`${workerUrl}/auth/twitch/start`}>
              Connect Twitch
            </a>
          )}
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
            onSelect={setSelectedChannelId}
            onAdd={() => setDialogOpen(true)}
            onError={setNotice}
          />

          <section className={`feed-panel ${view === "filters" ? "filters-view" : ""}`}>
            <FeedToolbar
              activeFilterCount={activeFilters.length}
              channel={selectedChannel}
              paused={paused}
              filterText={quickSearch}
              view={view}
              onTextChange={setQuickSearch}
              onViewChange={setView}
              onPause={() => {
                if (!paused) {
                  setPausedMessages(messages);
                  setPausedMessageKey(messageFeedKey);
                }
                setPaused((value) => !value);
              }}
              onClear={() => setClearBefore(Date.now())}
            />
            {view === "chat" ? (
              <>
                <ChatTabBar
                  activeId={activeChatTabId}
                  tabs={chatTabs}
                  onAdd={() => setEditingChatTab("new")}
                  onEdit={setEditingChatTab}
                  onSelect={setActiveChatTabId}
                />
                {activeChatTab?.layout === "gallery" ? (
                  <ImageGallery
                    historyEnabled={clearBefore === 0}
                    key={messageFeedKey}
                    loadMore={galleryQuery.loadMore}
                    messages={sourceMessages}
                    paused={paused}
                    status={galleryQuery.status}
                  />
                ) : (
                  <MessageFeed
                    badgesByChannel={badgesByChannel}
                    emotesByChannel={emotesByChannel}
                    highlightedIds={highlightedIds}
                    historyEnabled={clearBefore === 0}
                    key={messageFeedKey}
                    loadMore={recentQuery.loadMore}
                    messages={sourceMessages}
                    paused={paused}
                    status={recentQuery.status}
                  />
                )}
              </>
            ) : (
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
      </div>
    </ErrorBoundary>
  );
}

function ChannelSidebar({
  channels,
  selectedChannelId,
  onSelect,
  onAdd,
  onError,
}: {
  channels: Channel[];
  selectedChannelId?: string;
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
            <div className="channel-actions">
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
            </div>
          </div>
        ))}
      </div>
      {channels.length === 0 && (
        <div className="empty compact"><strong>No channels yet</strong><span>Add one to begin logging.</span></div>
      )}
      <button className="button add-channel" onClick={onAdd}>+ Add channel</button>
    </aside>
  );
}

function FeedToolbar({
  activeFilterCount,
  channel,
  paused,
  filterText,
  view,
  onTextChange,
  onViewChange,
  onPause,
  onClear,
}: {
  activeFilterCount: number;
  channel?: Channel;
  paused: boolean;
  filterText: string;
  view: "chat" | "filters";
  onTextChange: (text: string) => void;
  onViewChange: (view: "chat" | "filters") => void;
  onPause: () => void;
  onClear: () => void;
}) {
  return (
    <div className="feed-toolbar">
      <div>
        <span className="eyebrow">{view === "chat" ? "Live feed" : "Filter studio"}</span>
        <h1>{view === "chat" ? channel?.displayName ?? "All channels" : "Filters"}</h1>
      </div>
      <div className="feed-toolbar-right">
        <div className="view-tabs" role="tablist" aria-label="Feed view">
          <button
            aria-selected={view === "chat"}
            className={view === "chat" ? "selected" : ""}
            onClick={() => onViewChange("chat")}
            role="tab"
          >
            Chat
          </button>
          <button
            aria-selected={view === "filters"}
            className={view === "filters" ? "selected" : ""}
            onClick={() => onViewChange("filters")}
            role="tab"
          >
            Filters {activeFilterCount > 0 && <span>{activeFilterCount}</span>}
          </button>
        </div>
        {view === "chat" && (
          <div className="toolbar-actions">
            <label className="search-field">
              <span>⌕</span>
              <input
                value={filterText}
                onChange={(event) => onTextChange(event.target.value)}
                placeholder="Search messages, senders, or channels"
              />
            </label>
            <button className={`button ${paused ? "primary" : ""}`} onClick={onPause}>
              {paused ? "Resume" : "Pause"}
            </button>
            <button className="button" onClick={onClear}>Clear view</button>
          </div>
        )}
      </div>
    </div>
  );
}

function MessageFeed({
  messages,
  paused,
  highlightedIds,
  emotesByChannel,
  badgesByChannel,
  historyEnabled,
  loadMore,
  status,
}: {
  messages: ChatMessage[];
  paused: boolean;
  highlightedIds: ReadonlySet<string>;
  emotesByChannel: ReadonlyMap<string, ReadonlyMap<string, ThirdPartyEmote>>;
  badgesByChannel: ReadonlyMap<string, ReadonlyMap<string, ChatBadgeDefinition>>;
  historyEnabled: boolean;
  loadMore: (numItems: number) => void;
  status: PaginationStatus;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const historyTriggerRef = useRef<HTMLDivElement>(null);
  const previousScrollHeightRef = useRef<number | undefined>(undefined);
  // A rare filter keeps the loader visible; only continue automatically while pages add matches.
  const visibleCountBeforeLoadRef = useRef<number | undefined>(undefined);
  const [followNewest, setFollowNewest] = useState(true);
  const [automaticSearchStopped, setAutomaticSearchStopped] = useState(false);

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

    const visibleCountBeforeLoad = visibleCountBeforeLoadRef.current;
    if (visibleCountBeforeLoad !== undefined) {
      setAutomaticSearchStopped(messages.length <= visibleCountBeforeLoad);
      visibleCountBeforeLoadRef.current = undefined;
    }
  }, [messages.length, status]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const trigger = historyTriggerRef.current;
    if (!viewport || !trigger || paused || !historyEnabled || automaticSearchStopped ||
        status !== "CanLoadMore") return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting) ||
          previousScrollHeightRef.current !== undefined) return;
      previousScrollHeightRef.current = viewport.scrollHeight;
      visibleCountBeforeLoadRef.current = messages.length;
      loadMore(HISTORY_PAGE_SIZE);
    }, { root: viewport, rootMargin: "120px 0px 0px" });
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [automaticSearchStopped, historyEnabled, loadMore, messages.length, paused, status]);

  const loadNextHistoryPage = () => {
    previousScrollHeightRef.current = viewportRef.current?.scrollHeight;
    visibleCountBeforeLoadRef.current = messages.length;
    loadMore(HISTORY_PAGE_SIZE);
  };

  const handleScroll = () => {
    const element = viewportRef.current;
    if (!element) return;
    setFollowNewest(element.scrollHeight - element.scrollTop - element.clientHeight < 100);
  };

  return (
    <div className="feed-wrap">
      <div className="message-feed" ref={viewportRef} onScroll={handleScroll}>
        <div className="history-loader" ref={historyTriggerRef}>
          {paused ? (
            <span>History loading paused</span>
          ) : status === "LoadingMore" ? (
            <span>Loading older messages…</span>
          ) : historyEnabled && status === "CanLoadMore" ? (
            <button
              className="button"
              onClick={loadNextHistoryPage}
            >
              {automaticSearchStopped
                ? `Search next ${HISTORY_PAGE_SIZE} older messages`
                : "Load older messages"}
            </button>
          ) : null}
        </div>
        {status === "LoadingFirstPage" ? (
          <div className="empty">Loading messages…</div>
        ) : messages.length === 0 ? (
          <div className="empty">
            <span className="empty-icon">⌁</span>
            <strong>{!historyEnabled
              ? "No messages since clearing"
              : status === "Exhausted"
                ? "No messages to show"
                : automaticSearchStopped
                  ? "No matches in loaded history"
                  : "Searching history…"}</strong>
            <span>{!historyEnabled
              ? "New public chat messages will appear here."
              : status === "Exhausted"
                ? "New public chat messages appear here after the connection starts."
                : automaticSearchStopped
                  ? `Search another ${HISTORY_PAGE_SIZE} older messages to look further back.`
                  : "Checking one older page for a match."}</span>
          </div>
        ) : (
          messages.map((message) => (
            <MessageRow
              badgeCatalog={badgesByChannel.get(message.externalChannelId)}
              emotes={emotesByChannel.get(message.externalChannelId)}
              highlighted={highlightedIds.has(message._id)}
              key={message._id}
              message={message}
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
  historyEnabled,
  loadMore,
  paused,
  status,
}: {
  messages: ChatMessage[];
  historyEnabled: boolean;
  loadMore: (numItems: number) => void;
  paused: boolean;
  status: PaginationStatus;
}) {
  const images = useMemo(
    () => buildGalleryImages(messages, workerUrl),
    [messages],
  );
  const viewportRef = useRef<HTMLDivElement>(null);
  const historyTriggerRef = useRef<HTMLDivElement>(null);
  const visibleCountBeforeLoadRef = useRef<number | undefined>(undefined);
  const [automaticSearchStopped, setAutomaticSearchStopped] = useState(false);

  useEffect(() => {
    if (status === "LoadingMore" || visibleCountBeforeLoadRef.current === undefined) return;
    setAutomaticSearchStopped(messages.length <= visibleCountBeforeLoadRef.current);
    visibleCountBeforeLoadRef.current = undefined;
  }, [messages.length, status]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const trigger = historyTriggerRef.current;
    if (!viewport || !trigger || paused || !historyEnabled || automaticSearchStopped ||
        status !== "CanLoadMore") return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      visibleCountBeforeLoadRef.current = messages.length;
      loadMore(HISTORY_PAGE_SIZE);
    }, { root: viewport, rootMargin: "0px 0px 500px" });
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [automaticSearchStopped, historyEnabled, loadMore, messages.length, paused, status]);

  const loadNextHistoryPage = () => {
    visibleCountBeforeLoadRef.current = messages.length;
    loadMore(HISTORY_PAGE_SIZE);
  };

  return (
    <div className="image-gallery-wrap" ref={viewportRef}>
      {status === "LoadingFirstPage" ? (
        <div className="empty">Loading artwork…</div>
      ) : images.length === 0 &&
          (!historyEnabled || automaticSearchStopped || status === "Exhausted") ? (
        <div className="empty gallery-empty">
          <span aria-hidden="true" className="empty-icon gallery-empty-icon">+</span>
          <strong>{automaticSearchStopped ? "No matching images in loaded history" : "No images found"}</strong>
          <span>{automaticSearchStopped
            ? `Search another ${HISTORY_PAGE_SIZE} older images to look further back.`
            : "Direct image links and supported artwork pages, including Pixiv, will appear here."}</span>
        </div>
      ) : (
        <>
          <div className="gallery-summary">
            <strong>{images.length} {images.length === 1 ? "image" : "images"}</strong>
            <span>{paused
              ? "Paused"
              : status === "Exhausted"
                ? "Complete history"
                : automaticSearchStopped
                  ? "Newest first · history search paused"
                  : "Newest first · loading history"}</span>
          </div>
          <div className="image-gallery">
            {images.map((image) => <GalleryCard image={image} key={image.id} />)}
          </div>
        </>
      )}
      <div className="gallery-history-loader" ref={historyTriggerRef}>
        {paused ? (
          <span>History loading paused</span>
        ) : status === "LoadingMore" ? (
          <span>Loading older images…</span>
        ) : historyEnabled && status === "CanLoadMore" ? (
          <button className="button" onClick={loadNextHistoryPage}>
            {automaticSearchStopped
              ? `Search next ${HISTORY_PAGE_SIZE} older images`
              : "Load older images"}
          </button>
        ) : images.length > 0 ? (
          <span>All saved images loaded</span>
        ) : null}
      </div>
    </div>
  );
}

function GalleryCard({ image }: { image: GalleryImage }) {
  const [failed, setFailed] = useState(false);
  const postedAt = new Date(image.message.timestamp);

  return (
    <article className="gallery-card">
      <a
        aria-label={`Open image posted by ${image.message.senderDisplayName}`}
        href={image.url}
        rel="noreferrer"
        target="_blank"
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
        <span className="gallery-open-hint">Open original ↗</span>
      </a>
      <footer>
        <span>
          <strong>{image.message.senderDisplayName}</strong>
          <small>#{image.message.channelName}</small>
        </span>
        <time dateTime={postedAt.toISOString()} title={postedAt.toLocaleString()}>
          {postedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </time>
      </footer>
    </article>
  );
}

function MessageRow({
  message,
  emotes = new Map(),
  badgeCatalog = new Map(),
  highlighted = false,
}: {
  message: ChatMessage;
  emotes?: ReadonlyMap<string, ThirdPartyEmote>;
  badgeCatalog?: ReadonlyMap<string, ChatBadgeDefinition>;
  highlighted?: boolean;
}) {
  const messageParts = buildMessageParts(
    message.messageText,
    message.metadata?.fragments,
    emotes,
  );
  return (
    <article className={`message-row ${highlighted ? "filter-highlighted" : ""}`}>
      <time dateTime={new Date(message.timestamp).toISOString()}>
        {new Date(message.timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}
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
