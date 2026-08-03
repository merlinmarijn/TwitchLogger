import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  FilterField,
  FilterMatchMode,
  FilterOperator,
} from "../shared/messageFilters";
import { api, type Channel } from "./api";
import { useQuery } from "./postgresReact";
import {
  buildSmartSearchSuggestions,
  createSmartSearchToken,
  guidedSmartSearchSuggestions,
  isSmartSearchPending,
  SMART_SEARCH_BADGE_OPTIONS,
  SMART_SEARCH_MESSAGE_TYPE_OPTIONS,
  SMART_SEARCH_ROLE_OPTIONS,
  type SmartSearchSuggestion,
  type SmartSearchToken,
} from "./smartSearch";

const SEARCH_DEBOUNCE_MS = 180;
const MIN_USER_SUGGESTION_LENGTH = 3;
const compactNumberFormatter = new Intl.NumberFormat(undefined, { notation: "compact" });

type FilterMenuView = "all" | "channel" | "role" | "badge" | "messageType";

interface ValueFilterDraft {
  field: FilterField;
  operator: FilterOperator;
  label: string;
  placeholder: string;
}

export default function SearchComposer({
  value,
  tokens,
  match,
  channels,
  channelId,
  searching,
  resultCount,
  onChange,
  onTokensChange,
  onMatchChange,
}: {
  value: string;
  tokens: SmartSearchToken[];
  match: FilterMatchMode;
  channels: Channel[];
  channelId?: string;
  searching: boolean;
  resultCount: number;
  onChange: (value: string) => void;
  onTokensChange: (tokens: SmartSearchToken[]) => void;
  onMatchChange: (match: FilterMatchMode) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [suggestionText, setSuggestionText] = useState("");
  const [open, setOpen] = useState(false);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [filterMenuView, setFilterMenuView] = useState<FilterMenuView>("all");
  const [valueFilterDraft, setValueFilterDraft] = useState<ValueFilterDraft>();
  const [activeIndex, setActiveIndex] = useState(0);
  const [activeSide, setActiveSide] = useState<"filter" | "exclude">("filter");
  const isSenderValueDraft = valueFilterDraft?.field === "sender";
  const inputId = useId();
  const listboxId = useId();
  const filterMenuId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const pending = isSmartSearchPending({
    draft,
    editingFilterValue: Boolean(valueFilterDraft),
    searching,
    value,
  });
  const trimmedSuggestionText = suggestionText.trim();
  const serverSuggestions = useQuery(
    api.messages.suggestions,
    trimmedSuggestionText.length >= MIN_USER_SUGGESTION_LENGTH
      ? {
          text: trimmedSuggestionText,
          ...(channelId ? { channelId } : {}),
          limit: 5,
        }
      : "skip",
  );
  const suggestions = useMemo(
    () => buildSmartSearchSuggestions({
      text: draft,
      users: serverSuggestions?.query === trimmedSuggestionText.toLowerCase() &&
          serverSuggestions.channelId === channelId
        ? serverSuggestions.users
        : [],
      channels,
    }),
    [channelId, channels, draft, serverSuggestions, trimmedSuggestionText],
  );
  const availableSuggestions = useMemo(
    () => guidedSmartSearchSuggestions(suggestions, valueFilterDraft?.field),
    [suggestions, valueFilterDraft?.field],
  );
  const visibleSuggestions = open && draft.trim().length > 0
    ? availableSuggestions
    : [];
  const safeActiveIndex = visibleSuggestions.length > 0
    ? Math.min(activeIndex, visibleSuggestions.length - 1)
    : 0;

  useEffect(() => {
    if (valueFilterDraft) return;
    if (draft === value && draft.trim() === suggestionText) return;
    const timeout = window.setTimeout(() => {
      onChange(draft);
      setSuggestionText(draft.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [draft, onChange, suggestionText, value, valueFilterDraft]);

  useEffect(() => {
    if (!isSenderValueDraft || draft.trim() === suggestionText) return;
    const timeout = window.setTimeout(() => {
      setSuggestionText(draft.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [draft, isSenderValueDraft, suggestionText]);

  useEffect(() => {
    const focusSearch = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey ||
          isEditableTarget(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
      setOpen(true);
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const addSuggestion = (token: SmartSearchToken) => {
    if (!tokens.some((candidate) => candidate.id === token.id)) {
      onTokensChange([...tokens, token]);
    }
    setDraft("");
    setSuggestionText("");
    onChange("");
    setOpen(false);
    setFilterMenuOpen(false);
    setFilterMenuView("all");
    setValueFilterDraft(undefined);
    setActiveIndex(0);
    setActiveSide("filter");
    inputRef.current?.focus();
  };

  const beginValueFilter = (filterDraft: ValueFilterDraft) => {
    setDraft("");
    setSuggestionText("");
    onChange("");
    setValueFilterDraft(filterDraft);
    setFilterMenuOpen(false);
    setFilterMenuView("all");
    setOpen(false);
    setActiveSide(filterDraft.operator === "notEquals" ? "exclude" : "filter");
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const removeToken = (id: string) => {
    onTokensChange(tokens.filter((token) => token.id !== id));
    inputRef.current?.focus();
  };

  const clearDraft = () => {
    setDraft("");
    setSuggestionText("");
    onChange("");
    setOpen(false);
    setFilterMenuOpen(false);
    setFilterMenuView("all");
    setValueFilterDraft(undefined);
    setActiveIndex(0);
    setActiveSide("filter");
  };

  const clear = () => {
    clearDraft();
    onTokensChange([]);
    onMatchChange("all");
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && visibleSuggestions.length > 0) {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % visibleSuggestions.length);
      return;
    }
    if (event.key === "ArrowUp" && visibleSuggestions.length > 0) {
      event.preventDefault();
      setActiveIndex((current) =>
        (current - 1 + visibleSuggestions.length) % visibleSuggestions.length);
      return;
    }
    if (event.key === "ArrowLeft" && visibleSuggestions.length > 0) {
      event.preventDefault();
      setActiveSide("filter");
      return;
    }
    if (event.key === "ArrowRight" && visibleSuggestions.length > 0) {
      event.preventDefault();
      setActiveSide("exclude");
      return;
    }
    if (event.key === "Enter" && visibleSuggestions.length > 0) {
      event.preventDefault();
      const suggestion = visibleSuggestions[safeActiveIndex];
      addSuggestion(activeSide === "filter" ? suggestion.token : suggestion.excludeToken);
      return;
    }
    if (event.key === "Enter" && valueFilterDraft && draft.trim()) {
      event.preventDefault();
      addSuggestion(createSmartSearchToken(
        valueFilterDraft.field,
        valueFilterDraft.operator,
        draft,
        `${valueFilterDraft.label}: ${draft.trim()}`,
      ));
      return;
    }
    if (event.key === "Backspace" && !draft && tokens.length > 0) {
      event.preventDefault();
      onTokensChange(tokens.slice(0, -1));
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
      } else if (draft) {
        clearDraft();
      } else if (valueFilterDraft) {
        setValueFilterDraft(undefined);
      }
    }
  };

  return (
    <div
      className="search-group smart-search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
          setFilterMenuOpen(false);
          setFilterMenuView("all");
        }
      }}
    >
      <div className="search-field smart-search-field">
        <button
          aria-controls={filterMenuOpen ? filterMenuId : undefined}
          aria-expanded={filterMenuOpen}
          aria-label="Browse search filters"
          className={`search-icon ${filterMenuOpen ? "active" : ""}`}
          onClick={() => {
            setFilterMenuOpen((current) => !current);
            setFilterMenuView("all");
            setOpen(false);
          }}
          title="Browse search filters"
          type="button"
        >
          ⌕
        </button>
        <div className="search-token-track">
          {tokens.map((token) => (
            <span className={`search-token ${token.field}`} key={token.id}>
              <span>{token.label}</span>
              <button
                aria-label={`Remove ${token.label}`}
                onClick={() => removeToken(token.id)}
                type="button"
              >
                ×
              </button>
            </span>
          ))}
          {valueFilterDraft ? (
            <span className={`search-token-draft ${valueFilterDraft.field}`}>
              {valueFilterDraft.label}
            </span>
          ) : null}
          <label className="visually-hidden" htmlFor={inputId}>Search or add a filter</label>
          <input
            aria-activedescendant={
              visibleSuggestions.length > 0
                ? `${listboxId}-option-${safeActiveIndex}-${activeSide}`
                : undefined
            }
            aria-autocomplete="list"
            aria-busy={pending}
            aria-controls={visibleSuggestions.length > 0 ? listboxId : undefined}
            aria-expanded={visibleSuggestions.length > 0}
            autoComplete="off"
            id={inputId}
            maxLength={200}
            onChange={(event) => {
              setDraft(event.target.value);
              if (!valueFilterDraft || isSenderValueDraft) setOpen(true);
              setActiveIndex(0);
              setActiveSide(valueFilterDraft?.operator === "notEquals" ? "exclude" : "filter");
            }}
            onFocus={() => {
              if (!valueFilterDraft || isSenderValueDraft) setOpen(true);
            }}
            onKeyDown={handleKeyDown}
            placeholder={valueFilterDraft?.placeholder ?? (
              tokens.length > 0 ? "Add another filter…" : "Search or add a filter…"
            )}
            ref={inputRef}
            role="combobox"
            type="search"
            value={draft}
          />
        </div>
        {draft || tokens.length > 0 || valueFilterDraft ? (
          <button aria-label="Clear search and filters" className="search-clear" onClick={clear} type="button">
            ×
          </button>
        ) : (
          <kbd aria-hidden="true">/</kbd>
        )}
      </div>

      {filterMenuOpen ? (
        <FilterMenu
          channels={channels}
          id={filterMenuId}
          onAdd={addSuggestion}
          onBeginValueFilter={beginValueFilter}
          onClose={() => {
            setFilterMenuOpen(false);
            setFilterMenuView("all");
            inputRef.current?.focus();
          }}
          onViewChange={setFilterMenuView}
          view={filterMenuView}
        />
      ) : null}

      <div className="search-meta">
        <span aria-live="polite" className="search-status">
          {valueFilterDraft
            ? isSenderValueDraft
              ? draft.trim().length < MIN_USER_SUGGESTION_LENGTH
                ? `Type ${MIN_USER_SUGGESTION_LENGTH} characters to find matching senders`
                : visibleSuggestions.length > 0
                  ? `${visibleSuggestions.length} matching ${visibleSuggestions.length === 1 ? "sender" : "senders"} · choose one or press Enter`
                  : "Choose a matching sender, or press Enter to use the exact name"
              : "Press Enter to apply this filter"
            : pending
              ? "Searching…"
              : value || tokens.length > 0
                ? `${resultCount} loaded ${resultCount === 1 ? "match" : "matches"}`
                : "Search all saved history"}
        </span>
        {tokens.length > 1 ? (
          <span className="search-match" aria-label="Search filter matching">
            Match
            <button
              aria-pressed={match === "all"}
              className={match === "all" ? "selected" : ""}
              onClick={() => onMatchChange("all")}
              type="button"
            >
              all
            </button>
            <button
              aria-pressed={match === "any"}
              className={match === "any" ? "selected" : ""}
              onClick={() => onMatchChange("any")}
              type="button"
            >
              any
            </button>
          </span>
        ) : null}
      </div>

      {visibleSuggestions.length > 0 ? (
        <div className="search-suggestions" id={listboxId} role="listbox">
          {groupSuggestions(visibleSuggestions).map(([group, groupItems]) => (
            <div className="search-suggestion-group" key={group} role="group" aria-label={group}>
              <div className="search-suggestion-heading">{group}</div>
              {groupItems.map((suggestion) => {
                const index = visibleSuggestions.indexOf(suggestion);
                return (
                  <div className="search-suggestion-row" key={suggestion.id} role="presentation">
                    <button
                      aria-label={`Filter by ${suggestion.title}`}
                      aria-selected={index === safeActiveIndex && activeSide === "filter"}
                      className={`search-suggestion-filter ${
                        index === safeActiveIndex && activeSide === "filter" ? "selected" : ""
                      }`}
                      id={`${listboxId}-option-${index}-filter`}
                      onClick={() => addSuggestion(suggestion.token)}
                      onMouseEnter={() => {
                        setActiveIndex(index);
                        setActiveSide("filter");
                      }}
                      role="option"
                      type="button"
                    >
                      <span className="search-suggestion-type">
                        {suggestion.group === "People"
                          ? "@"
                          : suggestion.group === "Channels"
                            ? "#"
                            : suggestion.group === "Tags"
                              ? "TAG"
                              : suggestion.group === "Message types"
                                ? "TYPE"
                                : "⌕"}
                      </span>
                      <span className="search-suggestion-copy">
                        <strong>{suggestion.title}</strong>
                        <small>{suggestion.description}</small>
                      </span>
                      {suggestion.count !== undefined ? (
                        <span className="search-suggestion-count">
                          {formatCount(suggestion.count)}
                        </span>
                      ) : null}
                      <span aria-hidden="true" className="search-suggestion-action">Filter ＋</span>
                    </button>
                    <button
                      aria-label={suggestion.excludeToken.label}
                      aria-selected={index === safeActiveIndex && activeSide === "exclude"}
                      className={`search-suggestion-exclude ${
                        index === safeActiveIndex && activeSide === "exclude" ? "selected" : ""
                      }`}
                      id={`${listboxId}-option-${index}-exclude`}
                      onClick={() => addSuggestion(suggestion.excludeToken)}
                      onMouseEnter={() => {
                        setActiveIndex(index);
                        setActiveSide("exclude");
                      }}
                      role="option"
                      title={suggestion.excludeToken.label}
                      type="button"
                    >
                      Exclude <span aria-hidden="true">−</span>
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FilterMenu({
  channels,
  id,
  view,
  onAdd,
  onBeginValueFilter,
  onClose,
  onViewChange,
}: {
  channels: Channel[];
  id: string;
  view: FilterMenuView;
  onAdd: (token: SmartSearchToken) => void;
  onBeginValueFilter: (draft: ValueFilterDraft) => void;
  onClose: () => void;
  onViewChange: (view: FilterMenuView) => void;
}) {
  const viewLabels: Record<Exclude<FilterMenuView, "all">, string> = {
    channel: "Channel",
    role: "Twitch role",
    badge: "Twitch badge",
    messageType: "Message type",
  };

  const addFixedFilter = (
    field: FilterField,
    operator: FilterOperator,
    value: string,
    label: string,
  ) => onAdd(createSmartSearchToken(field, operator, value, label));

  const beginTextFilter = (
    field: FilterField,
    operator: FilterOperator,
    label: string,
    placeholder: string,
  ) => onBeginValueFilter({ field, operator, label, placeholder });

  const nestedOptions = view === "channel"
    ? channels.map((channel) => ({
        value: channel.displayName,
        label: channel.displayName,
        description: `#${channel.username}`,
      }))
    : view === "role"
      ? SMART_SEARCH_ROLE_OPTIONS.map((option) => ({
          ...option,
          description: "Twitch role",
        }))
      : view === "badge"
        ? SMART_SEARCH_BADGE_OPTIONS.map((option) => ({
            ...option,
            description: "Twitch badge",
          }))
        : view === "messageType"
          ? SMART_SEARCH_MESSAGE_TYPE_OPTIONS.map((option) => ({
              ...option,
              description: "Twitch message type",
            }))
          : [];

  const nestedField: FilterField = view === "channel"
    ? "channel"
    : view === "role"
      ? "role"
      : view === "badge"
        ? "badge"
        : "messageType";
  const nestedOperator: FilterOperator = view === "badge" ? "has" : "equals";
  const nestedExcludeOperator: FilterOperator = view === "badge" ? "notHas" : "notEquals";

  return (
    <div
      aria-label="Available search filters"
      className="search-filter-menu"
      id={id}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      role="dialog"
    >
      <div className="search-filter-menu-header">
        {view === "all" ? (
          <span className="search-filter-menu-mark" aria-hidden="true">⌕</span>
        ) : (
          <button
            aria-label="Back to all filters"
            className="search-filter-back"
            onClick={() => onViewChange("all")}
            type="button"
          >
            ←
          </button>
        )}
        <span>
          <strong>{view === "all" ? "Add a search filter" : viewLabels[view]}</strong>
          <small>{view === "all" ? "Choose what the feed should match" : "Add or exclude a value"}</small>
        </span>
        <button aria-label="Close filter menu" className="search-filter-close" onClick={onClose} type="button">
          ×
        </button>
      </div>

      {view === "all" ? (
        <div className="search-filter-catalog">
          <div className="search-filter-section">
            <span className="search-filter-section-label">Type a value</span>
            <FilterCatalogRow
              description="Words or a phrase in chat"
              marker="Aa"
              onAdd={() => beginTextFilter("message", "contains", "Message includes", "Type message text, then press Enter")}
              onExclude={() => beginTextFilter("message", "notContains", "Message excludes", "Type message text, then press Enter")}
              title="Message text"
            />
            <FilterCatalogRow
              description="Username or display name"
              marker="@"
              onAdd={() => beginTextFilter("sender", "equals", "Sender is", "Type a username, then press Enter")}
              onExclude={() => beginTextFilter("sender", "notEquals", "Sender is not", "Type a username, then press Enter")}
              title="Sender"
            />
          </div>

          <div className="search-filter-section">
            <span className="search-filter-section-label">Choose a value</span>
            <FilterCatalogLink
              description={`${channels.length} ${channels.length === 1 ? "logged channel" : "logged channels"}`}
              marker="#"
              onClick={() => onViewChange("channel")}
              title="Channel"
            />
            <FilterCatalogLink description="Broadcaster, moderator, subscriber or VIP" marker="★" onClick={() => onViewChange("role")} title="Twitch role" />
            <FilterCatalogLink description="Founder, bits, Prime and more" marker="◇" onClick={() => onViewChange("badge")} title="Twitch badge" />
            <FilterCatalogLink description="Normal, highlighted, first-time and power-ups" marker="T" onClick={() => onViewChange("messageType")} title="Message type" />
          </div>

          <div className="search-filter-section">
            <span className="search-filter-section-label">One click</span>
            <FilterCatalogRow
              description="Supported image links"
              marker="▧"
              onAdd={() => addFixedFilter("image", "has", "image", "Has image")}
              onExclude={() => addFixedFilter("image", "notHas", "image", "Without images")}
              title="Image"
            />
            <FilterCatalogRow
              description="Any HTTP or HTTPS link"
              marker="↗"
              onAdd={() => addFixedFilter("link", "has", "link", "Has link")}
              onExclude={() => addFixedFilter("link", "notHas", "link", "Without links")}
              title="Link"
            />
          </div>

          <p className="search-filter-tip">Combine filters, then choose whether to match all or any.</p>
        </div>
      ) : (
        <div className="search-filter-values">
          {nestedOptions.length > 0 ? nestedOptions.map((option) => (
            <FilterValueRow
              description={option.description}
              key={option.value}
              onAdd={() => addFixedFilter(
                nestedField,
                nestedOperator,
                option.value,
                `${viewLabels[view]}: ${option.label}`,
              )}
              onExclude={() => addFixedFilter(
                nestedField,
                nestedExcludeOperator,
                option.value,
                `Exclude ${viewLabels[view].toLowerCase()}: ${option.label}`,
              )}
              title={option.label}
            />
          )) : (
            <p className="search-filter-empty">No logged channels are available yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

function FilterCatalogRow({
  description,
  marker,
  onAdd,
  onExclude,
  title,
}: {
  description: string;
  marker: string;
  onAdd: () => void;
  onExclude: () => void;
  title: string;
}) {
  return (
    <div className="search-filter-catalog-row">
      <button className="search-filter-catalog-main" onClick={onAdd} type="button">
        <span className="search-filter-marker" aria-hidden="true">{marker}</span>
        <span className="search-filter-copy"><strong>{title}</strong><small>{description}</small></span>
        <span className="search-filter-add">Add</span>
      </button>
      <button className="search-filter-catalog-exclude" onClick={onExclude} title={`Exclude ${title.toLowerCase()}`} type="button">
        Exclude
      </button>
    </div>
  );
}

function FilterCatalogLink({
  description,
  marker,
  onClick,
  title,
}: {
  description: string;
  marker: string;
  onClick: () => void;
  title: string;
}) {
  return (
    <button className="search-filter-catalog-link" onClick={onClick} type="button">
      <span className="search-filter-marker" aria-hidden="true">{marker}</span>
      <span className="search-filter-copy"><strong>{title}</strong><small>{description}</small></span>
      <span className="search-filter-chevron" aria-hidden="true">›</span>
    </button>
  );
}

function FilterValueRow({
  description,
  onAdd,
  onExclude,
  title,
}: {
  description: string;
  onAdd: () => void;
  onExclude: () => void;
  title: string;
}) {
  return (
    <div className="search-filter-value-row">
      <button onClick={onAdd} type="button">
        <span className="search-filter-copy"><strong>{title}</strong><small>{description}</small></span>
        <span className="search-filter-add">Add</span>
      </button>
      <button className="search-filter-value-exclude" onClick={onExclude} title={`Exclude ${title.toLowerCase()}`} type="button">
        Exclude
      </button>
    </div>
  );
}

function groupSuggestions(suggestions: SmartSearchSuggestion[]) {
  const groups = new Map<string, SmartSearchSuggestion[]>();
  for (const suggestion of suggestions) {
    const items = groups.get(suggestion.group);
    if (items) items.push(suggestion);
    else groups.set(suggestion.group, [suggestion]);
  }
  return [...groups.entries()];
}

function formatCount(value: number) {
  return compactNumberFormatter.format(value);
}

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}
