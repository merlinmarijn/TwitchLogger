import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { FilterMatchMode } from "../shared/messageFilters";
import { api, type Channel } from "./api";
import { useQuery } from "./postgresReact";
import {
  buildSmartSearchSuggestions,
  type SmartSearchSuggestion,
  type SmartSearchToken,
} from "./smartSearch";

const SEARCH_DEBOUNCE_MS = 180;
const MIN_USER_SUGGESTION_LENGTH = 3;
const compactNumberFormatter = new Intl.NumberFormat(undefined, { notation: "compact" });

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
  const [activeIndex, setActiveIndex] = useState(0);
  const [activeSide, setActiveSide] = useState<"filter" | "exclude">("filter");
  const inputId = useId();
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const pending = searching || draft !== value;
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
  const visibleSuggestions = open && draft.trim().length > 0 ? suggestions : [];
  const safeActiveIndex = visibleSuggestions.length > 0
    ? Math.min(activeIndex, visibleSuggestions.length - 1)
    : 0;

  useEffect(() => {
    if (draft === value && draft.trim() === suggestionText) return;
    const timeout = window.setTimeout(() => {
      onChange(draft);
      setSuggestionText(draft.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [draft, onChange, suggestionText, value]);

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
    setActiveIndex(0);
    setActiveSide("filter");
    inputRef.current?.focus();
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
      }
    }
  };

  return (
    <div
      className="search-group smart-search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className="search-field smart-search-field">
        <span aria-hidden="true" className="search-icon">⌕</span>
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
              setOpen(true);
              setActiveIndex(0);
              setActiveSide("filter");
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder={tokens.length > 0 ? "Add another filter…" : "Search or add a filter…"}
            ref={inputRef}
            role="combobox"
            type="search"
            value={draft}
          />
        </div>
        {draft || tokens.length > 0 ? (
          <button aria-label="Clear search and filters" className="search-clear" onClick={clear} type="button">
            ×
          </button>
        ) : (
          <kbd aria-hidden="true">/</kbd>
        )}
      </div>

      <div className="search-meta">
        <span aria-live="polite" className="search-status">
          {pending
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
