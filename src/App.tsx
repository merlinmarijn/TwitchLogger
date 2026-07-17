import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery } from "convex/react";
import {
  api,
  type Channel,
  type ChatBadgeDefinition,
  type ChatMessage,
} from "./api";
import {
  buildMessageParts,
  renderMessageParts,
  type ThirdPartyEmote,
} from "./emotes";
import FilterWorkspace from "./FilterWorkspace";
import {
  applyMessageFilters,
  FILTER_STORAGE_KEY,
  parseFilterState,
  serializeFilterState,
  type FilterState,
  type MessageFilter,
} from "./filters";
import { workerUrl } from "./runtimeConfig";

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

export default function App() {
  const channels = useQuery(api.channels.list, {}) ?? [];
  const [selectedChannelId, setSelectedChannelId] = useState<string>();
  const selectedChannel = channels.find((channel) => channel._id === selectedChannelId);
  const queriedMessages = useQuery(api.messages.listRecent, {
    ...(selectedChannelId ? { channelId: selectedChannelId } : {}),
    limit: 350,
  });
  const messages = useMemo(() => queriedMessages ?? [], [queriedMessages]);
  const ensureSeeded = useMutation(api.platforms.ensureSeeded);
  const [view, setView] = useState<"chat" | "filters">("chat");
  const [quickSearch, setQuickSearch] = useState("");
  const [filterState, setFilterState] = useState<FilterState>(loadSavedFilterState);
  const [paused, setPaused] = useState(false);
  const [pausedMessages, setPausedMessages] = useState<ChatMessage[]>([]);
  const [clearBefore, setClearBefore] = useState(0);
  const [auth, setAuth] = useState<AuthStatus>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const emotesByChannel = useThirdPartyEmotes(channels);
  const badgesByChannel = useTwitchBadges(channels);

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

  const sourceMessages = useMemo(() => {
    const source = paused ? pausedMessages : messages;
    return source.filter((message) => message.timestamp > clearBefore);
  }, [paused, pausedMessages, messages, clearBefore]);
  const activeFilters = useMemo(() => {
    const activeIds = new Set(filterState.activeIds);
    return filterState.filters.filter((filter) => activeIds.has(filter.id));
  }, [filterState]);
  const filtered = useMemo(
    () => applyMessageFilters(sourceMessages, quickSearch, activeFilters),
    [sourceMessages, quickSearch, activeFilters],
  );

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
                if (!paused) setPausedMessages(messages);
                setPaused((value) => !value);
              }}
              onClear={() => setClearBefore(Date.now())}
            />
            {view === "chat" ? (
              <MessageFeed
                badgesByChannel={badgesByChannel}
                emotesByChannel={emotesByChannel}
                highlightedIds={filtered.highlightedIds}
                loading={queriedMessages === undefined}
                messages={filtered.messages}
                paused={paused}
              />
            ) : (
              <FilterWorkspace
                activeIds={filterState.activeIds}
                filters={filterState.filters}
                messages={sourceMessages}
                onDelete={deleteFilter}
                onSave={saveFilter}
                onToggle={toggleFilter}
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
              <button className="danger" onClick={() => run(remove({ id: channel._id }))}>
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
  loading,
  paused,
  highlightedIds,
  emotesByChannel,
  badgesByChannel,
}: {
  messages: ChatMessage[];
  loading: boolean;
  paused: boolean;
  highlightedIds: ReadonlySet<string>;
  emotesByChannel: ReadonlyMap<string, ReadonlyMap<string, ThirdPartyEmote>>;
  badgesByChannel: ReadonlyMap<string, ReadonlyMap<string, ChatBadgeDefinition>>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [followNewest, setFollowNewest] = useState(true);

  useEffect(() => {
    if (followNewest && !paused) {
      viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight });
    }
  }, [messages, followNewest, paused]);

  const handleScroll = () => {
    const element = viewportRef.current;
    if (!element) return;
    setFollowNewest(element.scrollHeight - element.scrollTop - element.clientHeight < 100);
  };

  return (
    <div className="feed-wrap">
      <div className="message-feed" ref={viewportRef} onScroll={handleScroll}>
        {loading ? (
          <div className="empty">Loading messages…</div>
        ) : messages.length === 0 ? (
          <div className="empty">
            <span className="empty-icon">⌁</span>
            <strong>No messages to show</strong>
            <span>New public chat messages appear here after the connection starts.</span>
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

function useThirdPartyEmotes(channels: Channel[]) {
  const [catalogs, setCatalogs] = useState(
    () => new Map<string, ReadonlyMap<string, ThirdPartyEmote>>(),
  );
  const channelIds = channels
    .flatMap((channel) => channel.externalChannelId ?? [])
    .sort()
    .join(",");

  useEffect(() => {
    const ids = channelIds ? channelIds.split(",") : [];
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
      .then((entries) => setCatalogs(new Map(entries)))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.warn("Third-party emotes are unavailable; showing message text", error);
        }
      });
    return () => controller.abort();
  }, [channelIds]);

  return catalogs;
}

function useTwitchBadges(channels: Channel[]) {
  const [catalogs, setCatalogs] = useState(
    () => new Map<string, ReadonlyMap<string, ChatBadgeDefinition>>(),
  );
  const channelIds = channels
    .flatMap((channel) => channel.externalChannelId ?? [])
    .sort()
    .join(",");

  useEffect(() => {
    const ids = channelIds ? channelIds.split(",") : [];
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
  }, [channelIds]);

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
