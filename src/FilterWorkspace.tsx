import { useMemo, useState } from "react";
import type { ChatMessage } from "./api";
import {
  matchesMessageFilter,
  operatorsForField,
  type FilterAction,
  type FilterField,
  type FilterOperator,
  type FilterRule,
  type MessageFilter,
} from "./filters";

interface FilterWorkspaceProps {
  filters: MessageFilter[];
  activeIds: string[];
  messages: ChatMessage[];
  onSave: (filter: MessageFilter, apply: boolean) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
}

const fieldLabels: Record<FilterField, string> = {
  message: "Message text",
  sender: "Sender",
  channel: "Channel",
  role: "Role",
  badge: "Badge",
  messageType: "Message type",
};

const operatorLabels: Record<FilterOperator, string> = {
  contains: "contains",
  notContains: "does not contain",
  equals: "is",
  notEquals: "is not",
  startsWith: "starts with",
  endsWith: "ends with",
  wholeWord: "contains whole word",
  has: "has",
  notHas: "does not have",
};

const actionCopy: Record<FilterAction, { label: string; description: string }> = {
  show: { label: "Show only", description: "Keep matching messages in the feed." },
  hide: { label: "Hide", description: "Remove matching messages from the feed." },
  highlight: { label: "Highlight", description: "Keep and visually emphasize matches." },
};

export default function FilterWorkspace({
  filters,
  activeIds,
  messages,
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
  const matchCounts = useMemo(
    () => new Map(filters.map((filter) => [
      filter.id,
      messages.filter((message) => matchesMessageFilter(message, filter)).length,
    ])),
    [filters, messages],
  );
  const draftIsSaved = filters.some((filter) => filter.id === draft.id);
  const canSave = Boolean(
    draft.name.trim() && draft.rules.length > 0 && draft.rules.every((rule) => rule.value.trim()),
  );

  const edit = (filter: MessageFilter) => {
    setDraft({ ...filter, rules: filter.rules.map((rule) => ({ ...rule })) });
  };

  const addRule = () => {
    setDraft((current) => ({
      ...current,
      rules: [...current.rules, createRule("message")],
    }));
  };

  const updateRule = (id: string, changes: Partial<FilterRule>) => {
    setDraft((current) => ({
      ...current,
      rules: current.rules.map((rule) => rule.id === id ? { ...rule, ...changes } : rule),
    }));
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
                      {filter.rules.length} rule{filter.rules.length === 1 ? "" : "s"} · {matchCounts.get(filter.id) ?? 0} matches
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

        <div className="rule-heading">
          <div>
            <strong>Conditions</strong>
            <span>A message must match</span>
            <select
              aria-label="Condition matching mode"
              onChange={(event) => setDraft({
                ...draft,
                match: event.target.value as MessageFilter["match"],
              })}
              value={draft.match}
            >
              <option value="all">all</option>
              <option value="any">any</option>
            </select>
            <span>of these rules</span>
          </div>
          <button className="button" onClick={addRule}>+ Add condition</button>
        </div>

        <div className="rule-list">
          {draft.rules.map((rule, index) => (
            <div className="filter-rule" key={rule.id}>
              <span className="rule-number">{index + 1}</span>
              <label>
                <span>Field</span>
                <select
                  onChange={(event) => {
                    const field = event.target.value as FilterField;
                    const replacement = createRule(field, rule.id);
                    updateRule(rule.id, replacement);
                  }}
                  value={rule.field}
                >
                  {(Object.entries(fieldLabels) as Array<[FilterField, string]>).map(
                    ([field, label]) => <option key={field} value={field}>{label}</option>,
                  )}
                </select>
              </label>
              <label>
                <span>Comparison</span>
                <select
                  onChange={(event) => updateRule(rule.id, {
                    operator: event.target.value as FilterOperator,
                  })}
                  value={rule.operator}
                >
                  {operatorsForField(rule.field).map((operator) => (
                    <option key={operator} value={operator}>{operatorLabels[operator]}</option>
                  ))}
                </select>
              </label>
              <RuleValueInput rule={rule} onChange={(value) => updateRule(rule.id, { value })} />
              <button
                aria-label={`Remove condition ${index + 1}`}
                className="remove-rule"
                disabled={draft.rules.length === 1}
                onClick={() => setDraft((current) => ({
                  ...current,
                  rules: current.rules.filter((candidate) => candidate.id !== rule.id),
                }))}
                title={draft.rules.length === 1 ? "A filter needs at least one condition" : "Remove condition"}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="filter-editor-actions">
          <span>{canSave ? "Ready to save" : "Give the filter a name and complete every condition."}</span>
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

function RuleValueInput({
  rule,
  onChange,
}: {
  rule: FilterRule;
  onChange: (value: string) => void;
}) {
  if (rule.field === "role") {
    return (
      <label>
        <span>Role</span>
        <select onChange={(event) => onChange(event.target.value)} value={rule.value}>
          <option value="broadcaster">Broadcaster</option>
          <option value="moderator">Moderator</option>
          <option value="subscriber">Subscriber</option>
          <option value="vip">VIP</option>
        </select>
      </label>
    );
  }
  if (rule.field === "messageType") {
    return (
      <label>
        <span>Type</span>
        <select onChange={(event) => onChange(event.target.value)} value={rule.value}>
          <option value="text">Normal message</option>
          <option value="channel_points_highlighted">Channel points highlight</option>
          <option value="channel_points_sub_only">Channel points sub-only</option>
          <option value="user_intro">First-time chatter</option>
          <option value="power_ups_message_effect">Power-up effect</option>
          <option value="power_ups_gigantified_emote">Gigantified emote</option>
        </select>
      </label>
    );
  }
  return (
    <label>
      <span>Value</span>
      <input
        maxLength={200}
        onChange={(event) => onChange(event.target.value)}
        placeholder={rule.field === "badge" ? "e.g. subscriber or bits/100" : "Enter a value"}
        value={rule.value}
      />
    </label>
  );
}

function createEmptyFilter(): MessageFilter {
  return {
    id: createId("filter"),
    name: "",
    action: "show",
    match: "all",
    rules: [createRule("message")],
  };
}

function createRule(field: FilterField, id = createId("rule")): FilterRule {
  const defaults: Partial<Record<FilterField, string>> = {
    role: "moderator",
    messageType: "text",
  };
  return {
    id,
    field,
    operator: operatorsForField(field)[0],
    value: defaults[field] ?? "",
  };
}

function createStarterFilter(starter: "moderators" | "subscribers" | "commands") {
  if (starter === "moderators") {
    return {
      id: createId("filter"),
      name: "Highlight moderators",
      action: "highlight" as const,
      match: "all" as const,
      rules: [{ ...createRule("role"), value: "moderator" }],
    };
  }
  if (starter === "subscribers") {
    return {
      id: createId("filter"),
      name: "Only subscribers",
      action: "show" as const,
      match: "all" as const,
      rules: [{ ...createRule("role"), value: "subscriber" }],
    };
  }
  return {
    id: createId("filter"),
    name: "Hide bot commands",
    action: "hide" as const,
    match: "all" as const,
    rules: [{ ...createRule("message"), operator: "startsWith" as const, value: "!" }],
  };
}

function createId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}
