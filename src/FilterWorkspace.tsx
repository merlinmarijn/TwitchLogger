import { useMemo, useState } from "react";
import {
  filterRuleError,
  type FilterAction,
  type MessageFilter,
} from "./filters";
import FilterRuleEditor from "./FilterRuleEditor";
import {
  createClientId,
  createFilterRule,
} from "./filterRuleFactory";

interface FilterWorkspaceProps {
  filters: MessageFilter[];
  activeIds: string[];
  matchCounts: ReadonlyMap<string, number>;
  onSave: (filter: MessageFilter, apply: boolean) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
}

const actionCopy: Record<FilterAction, { label: string; description: string }> = {
  show: { label: "Show only", description: "Keep matching messages in the feed." },
  hide: { label: "Hide", description: "Remove matching messages from the feed." },
  highlight: { label: "Highlight", description: "Keep and visually emphasize matches." },
};

export default function FilterWorkspace({
  filters,
  activeIds,
  matchCounts,
  onSave,
  onDelete,
  onToggle,
}: FilterWorkspaceProps) {
  const [draft, setDraft] = useState(() =>
    filters[0]
      ? { ...filters[0], rules: filters[0].rules.map((rule) => ({ ...rule })) }
      : createEmptyFilter(),
  );
  const active = useMemo(() => new Set(activeIds), [activeIds]);
  const draftIsSaved = filters.some((filter) => filter.id === draft.id);
  const editorError = !draft.name.trim()
    ? "Give the filter a name."
    : draft.rules.length === 0
      ? "Add at least one condition."
      : draft.rules.map(filterRuleError).find(Boolean);
  const canSave = !editorError;

  const edit = (filter: MessageFilter) => {
    setDraft({ ...filter, rules: filter.rules.map((rule) => ({ ...rule })) });
  };

  const applyStarter = (starter: "moderators" | "subscribers" | "commands") => {
    const filter = createStarterFilter(starter);
    onSave(filter, true);
    edit(filter);
  };

  return (
    <div className="filter-workspace">
      <aside className="filter-library">
        <div className="filter-library-heading">
          <div>
            <span className="eyebrow">Reusable presets</span>
            <h2>Your filters</h2>
          </div>
          <button className="button primary" onClick={() => setDraft(createEmptyFilter())}>
            + New
          </button>
        </div>

        {filters.length === 0 ? (
          <div className="filter-library-empty">
            <strong>Start with a recipe</strong>
            <span>Create one in a click, then adjust it on the right.</span>
            <button onClick={() => applyStarter("moderators")}>Highlight moderators</button>
            <button onClick={() => applyStarter("subscribers")}>Only subscribers</button>
            <button onClick={() => applyStarter("commands")}>Hide bot commands</button>
          </div>
        ) : (
          <div className="filter-preset-list">
            {filters.map((filter) => (
              <div
                className={`filter-preset ${draft.id === filter.id ? "selected" : ""}`}
                key={filter.id}
              >
                <button className="filter-preset-main" onClick={() => edit(filter)}>
                  <span>
                    <strong>{filter.name}</strong>
                    <small>
                      {filter.rules.length} rule{filter.rules.length === 1 ? "" : "s"} · {matchCounts.get(filter.id) ?? 0} recent matches
                    </small>
                  </span>
                  <span className={`filter-action-chip ${filter.action}`}>
                    {actionCopy[filter.action].label}
                  </span>
                </button>
                <label className="filter-toggle">
                  <input
                    checked={active.has(filter.id)}
                    onChange={() => onToggle(filter.id)}
                    type="checkbox"
                  />
                  <span>{active.has(filter.id) ? "Applied" : "Off"}</span>
                </label>
              </div>
            ))}
          </div>
        )}

        {filters.length > 0 && (
          <div className="pipeline-summary">
            <strong>{activeIds.length} active preset{activeIds.length === 1 ? "" : "s"}</strong>
            <span>Show filters narrow first, Hide filters remove next, then Highlight filters decorate.</span>
          </div>
        )}
      </aside>

      <section className="filter-editor">
        <div className="filter-editor-heading">
          <div>
            <span className="eyebrow">Rule builder</span>
            <h2>{draftIsSaved ? "Edit filter" : "Create filter"}</h2>
          </div>
          {draftIsSaved && (
            <button
              className="button danger-button"
              onClick={() => {
                onDelete(draft.id);
                setDraft(createEmptyFilter());
              }}
            >
              Delete
            </button>
          )}
        </div>

        <label className="field filter-name-field">
          <span>Name</span>
          <input
            maxLength={80}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="e.g. Highlight questions"
            value={draft.name}
          />
        </label>

        <fieldset className="filter-action-picker">
          <legend>When this filter matches</legend>
          <div>
            {(Object.entries(actionCopy) as Array<[FilterAction, typeof actionCopy.show]>).map(
              ([action, copy]) => (
                <label className={draft.action === action ? "selected" : ""} key={action}>
                  <input
                    checked={draft.action === action}
                    name="filter-action"
                    onChange={() => setDraft({ ...draft, action })}
                    type="radio"
                  />
                  <strong>{copy.label}</strong>
                  <span>{copy.description}</span>
                </label>
              ),
            )}
          </div>
        </fieldset>

        <FilterRuleEditor
          match={draft.match}
          rules={draft.rules}
          onMatchChange={(match) => setDraft({ ...draft, match })}
          onRulesChange={(rules) => setDraft({ ...draft, rules })}
        />

        <div className="filter-editor-actions">
          <span>{canSave ? "Ready to save" : editorError}</span>
          <button className="button" disabled={!canSave} onClick={() => onSave(draft, false)}>
            Save
          </button>
          <button
            className="button primary"
            disabled={!canSave}
            onClick={() => onSave(draft, true)}
          >
            Save & apply
          </button>
        </div>
      </section>
    </div>
  );
}

function createEmptyFilter(): MessageFilter {
  return {
    id: createClientId("filter"),
    name: "",
    action: "show",
    match: "all",
    rules: [createFilterRule("message")],
  };
}

function createStarterFilter(starter: "moderators" | "subscribers" | "commands") {
  if (starter === "moderators") {
    return {
      id: createClientId("filter"),
      name: "Highlight moderators",
      action: "highlight" as const,
      match: "all" as const,
      rules: [{ ...createFilterRule("role"), value: "moderator" }],
    };
  }
  if (starter === "subscribers") {
    return {
      id: createClientId("filter"),
      name: "Only subscribers",
      action: "show" as const,
      match: "all" as const,
      rules: [{ ...createFilterRule("role"), value: "subscriber" }],
    };
  }
  return {
    id: createClientId("filter"),
    name: "Hide bot commands",
    action: "hide" as const,
    match: "all" as const,
    rules: [{ ...createFilterRule("message"), operator: "startsWith" as const, value: "!" }],
  };
}
