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
import { api, type Channel, type ChatMessage } from "./api";
import { workerUrl } from "./runtimeConfig";

interface AuthStatus {
  authenticated: boolean;
  login?: string;
  reason?: string;
}

interface Filters {
  sender: string;
  text: string;
  hasBadges: boolean;
  rolesOnly: boolean;
}

const emptyFilters: Filters = { sender: "", text: "", hasBadges: false, rolesOnly: false };

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
  const [filters, setFilters] = useState(emptyFilters);
  const [paused, setPaused] = useState(false);
  const [pausedMessages, setPausedMessages] = useState<ChatMessage[]>([]);
  const [clearBefore, setClearBefore] = useState(0);
  const [auth, setAuth] = useState<AuthStatus>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    void ensureSeeded({});
    void fetch(`${workerUrl}/auth/twitch/status`)
      .then((response) => response.json())
      .then((status: AuthStatus) => setAuth(status))
      .catch(() => setAuth({ authenticated: false, reason: "Ingestion worker is offline" }));
  }, [ensureSeeded]);

  const displayedMessages = useMemo(() => {
    const source = paused ? pausedMessages : messages;
    const text = filters.text.trim().toLowerCase();
    const sender = filters.sender.trim().toLowerCase().replace(/^@/, "");
    return source.filter((message) => {
      if (message.timestamp <= clearBefore) return false;
      if (text && !message.messageText.toLowerCase().includes(text)) return false;
      if (sender && !message.senderUsername.toLowerCase().includes(sender)) return false;
      if (filters.hasBadges && message.badges.length === 0) return false;
      if (
        filters.rolesOnly &&
        !message.isBroadcaster &&
        !message.isModerator &&
        !message.isSubscriber &&
        !message.isVip
      )
        return false;
      return true;
    });
  }, [paused, pausedMessages, messages, filters, clearBefore]);

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

          <section className="feed-panel">
            <FeedToolbar
              channel={selectedChannel}
              paused={paused}
              filterText={filters.text}
              onTextChange={(text) => setFilters((current) => ({ ...current, text }))}
              onPause={() => {
                if (!paused) setPausedMessages(messages);
                setPaused((value) => !value);
              }}
              onClear={() => setClearBefore(Date.now())}
            />
            <MessageFeed
              messages={displayedMessages}
              loading={queriedMessages === undefined}
              paused={paused}
            />
          </section>

          <FilterSidebar filters={filters} onChange={setFilters} />
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
  channel,
  paused,
  filterText,
  onTextChange,
  onPause,
  onClear,
}: {
  channel?: Channel;
  paused: boolean;
  filterText: string;
  onTextChange: (text: string) => void;
  onPause: () => void;
  onClear: () => void;
}) {
  return (
    <div className="feed-toolbar">
      <div>
        <span className="eyebrow">Live feed</span>
        <h1>{channel?.displayName ?? "All channels"}</h1>
      </div>
      <div className="toolbar-actions">
        <label className="search-field">
          <span>⌕</span>
          <input
            value={filterText}
            onChange={(event) => onTextChange(event.target.value)}
            placeholder="Search recent messages"
          />
        </label>
        <button className={`button ${paused ? "primary" : ""}`} onClick={onPause}>
          {paused ? "Resume" : "Pause"}
        </button>
        <button className="button" onClick={onClear}>Clear view</button>
      </div>
    </div>
  );
}

function MessageFeed({
  messages,
  loading,
  paused,
}: {
  messages: ChatMessage[];
  loading: boolean;
  paused: boolean;
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
          messages.map((message) => <MessageRow key={message._id} message={message} />)
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

function MessageRow({ message }: { message: ChatMessage }) {
  const roles = [
    message.isBroadcaster && "Broadcaster",
    message.isModerator && "Mod",
    message.isVip && "VIP",
    message.isSubscriber && "Sub",
  ].filter(Boolean) as string[];
  return (
    <article className="message-row">
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
          <strong style={message.userColor ? { color: message.userColor } : undefined}>
            {message.senderDisplayName}
          </strong>
          {message.senderDisplayName.toLowerCase() !== message.senderUsername.toLowerCase() && (
            <small>@{message.senderUsername}</small>
          )}
          {roles.map((role) => <span className="role-badge" key={role}>{role}</span>)}
        </div>
        <p>{message.messageText}</p>
      </div>
    </article>
  );
}

function FilterSidebar({ filters, onChange }: { filters: Filters; onChange: (filters: Filters) => void }) {
  const count = [filters.sender, filters.text, filters.hasBadges, filters.rolesOnly].filter(Boolean).length;
  return (
    <aside className="sidebar filters-panel">
      <div className="panel-heading">
        <div><span className="eyebrow">Narrow results</span><h2>Filters</h2></div>
        <span className="count">{count}</span>
      </div>
      <label className="field"><span>Sender</span><input value={filters.sender} onChange={(event) => onChange({ ...filters, sender: event.target.value })} placeholder="Username" /></label>
      <label className="field"><span>Contains text</span><input value={filters.text} onChange={(event) => onChange({ ...filters, text: event.target.value })} placeholder="Search term" /></label>
      <label className="checkbox"><input type="checkbox" checked={filters.hasBadges} onChange={(event) => onChange({ ...filters, hasBadges: event.target.checked })} /><span>Has Twitch badges</span></label>
      <label className="checkbox"><input type="checkbox" checked={filters.rolesOnly} onChange={(event) => onChange({ ...filters, rolesOnly: event.target.checked })} /><span>Broadcaster, mod, sub, or VIP</span></label>
      <div className="filter-summary">
        <strong>{count ? `${count} active filter${count === 1 ? "" : "s"}` : "No active filters"}</strong>
        <span>Filters apply to the visible real-time window.</span>
      </div>
      <button className="button" onClick={() => onChange(emptyFilters)}>Clear filters</button>
    </aside>
  );
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
