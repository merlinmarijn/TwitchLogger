import { useState } from "react";
import type { ChatViewTab } from "./chatTabModel";
import FilterRuleEditor from "./FilterRuleEditor";
import {
  createClientId,
  createFilterRule,
} from "./filterRuleFactory";
import { filterRuleError } from "./filters";

export function ChatTabBar({
  tabs,
  activeId,
  onSelect,
  onAdd,
  onEdit,
}: {
  tabs: ChatViewTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onEdit: (tab: ChatViewTab) => void;
}) {
  const activeTab = tabs.find((tab) => tab.id === activeId);
  return (
    <div className="chat-tab-bar">
      <div className="chat-tabs" role="tablist" aria-label="Chat views">
        <button
          aria-selected={activeId === "all"}
          className={activeId === "all" ? "selected" : ""}
          onClick={() => onSelect("all")}
          role="tab"
        >
          All chat
        </button>
        {tabs.map((tab) => (
          <button
            aria-selected={activeId === tab.id}
            className={activeId === tab.id ? "selected" : ""}
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            role="tab"
          >
            {tab.layout === "gallery" && (
              <svg
                aria-hidden="true"
                className="tab-gallery-icon"
                viewBox="0 0 16 16"
              >
                <path d="M2.5 2.5h11v11h-11zM4.5 10l2-2 1.5 1.5 2.5-3 2 2.5M5.5 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />
              </svg>
            )}
            {tab.name}
          </button>
        ))}
        <button className="add-chat-tab" onClick={onAdd} title="Add a filtered chat tab">
          + Add tab
        </button>
      </div>
      {activeTab && (
        <button className="edit-chat-tab" onClick={() => onEdit(activeTab)}>
          Edit tab
        </button>
      )}
    </div>
  );
}

export function ChatTabDialog({
  tab,
  onClose,
  onSave,
  onDelete,
}: {
  tab?: ChatViewTab;
  onClose: () => void;
  onSave: (tab: ChatViewTab) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState<ChatViewTab>(() => tab
    ? { ...tab, rules: tab.rules.map((rule) => ({ ...rule })) }
    : createEmptyTab());
  const editorError = !draft.name.trim()
    ? "Give the tab a name."
    : draft.rules.length === 0
      ? "Add at least one condition."
      : draft.rules.map(filterRuleError).find(Boolean);

  const applyTemplate = (template: "images" | "mentions" | "custom") => {
    if (template === "images") {
      setDraft((current) => ({
        ...current,
        name: current.name || "Images",
        layout: "gallery",
        match: "any",
        rules: [{
          ...createFilterRule("message"),
          operator: "regex",
          value: "/https?:\\/\\/[^\\s<>\"']+\\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp)(?:[?#][^\\s<>\"']*)?/i",
        }],
      }));
      return;
    }
    if (template === "mentions") {
      setDraft((current) => ({
        ...current,
        name: current.name || "Mentions",
        layout: "chat",
        match: "any",
        rules: [{ ...createFilterRule("message"), value: "@" }],
      }));
      return;
    }
    setDraft((current) => ({
      ...current,
      layout: "chat",
      rules: [createFilterRule("message")],
    }));
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        aria-labelledby="chat-tab-dialog-title"
        aria-modal="true"
        className="dialog chat-tab-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="chat-tab-dialog-heading">
          <div>
            <span className="eyebrow">Filtered chat view</span>
            <h2 id="chat-tab-dialog-title">{tab ? "Edit chat tab" : "Add chat tab"}</h2>
            <p>Name the view, then define which messages belong in it.</p>
          </div>
          <button aria-label="Close" className="dialog-close" onClick={onClose}>{"\u00d7"}</button>
        </div>

        {!tab && (
          <div className="chat-tab-templates">
            <span>Quick start</span>
            <button onClick={() => applyTemplate("images")}>Image gallery</button>
            <button onClick={() => applyTemplate("mentions")}>Mentions</button>
            <button onClick={() => applyTemplate("custom")}>Custom</button>
          </div>
        )}

        <label className="field">
          <span>Tab name</span>
          <input
            autoFocus
            maxLength={40}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="e.g. Images or Mentions"
            value={draft.name}
          />
        </label>

        <fieldset className="tab-layout-picker">
          <legend>Display results as</legend>
          <div>
            <label className={draft.layout === "chat" ? "selected" : ""}>
              <input
                checked={draft.layout === "chat"}
                name="tab-layout"
                onChange={() => setDraft({ ...draft, layout: "chat" })}
                type="radio"
              />
              <strong>Chat feed</strong>
              <span>Keep each matching message in the live log.</span>
            </label>
            <label className={draft.layout === "gallery" ? "selected" : ""}>
              <input
                checked={draft.layout === "gallery"}
                name="tab-layout"
                onChange={() => setDraft({ ...draft, layout: "gallery" })}
                type="radio"
              />
              <strong>Image gallery</strong>
              <span>Pull direct image links into a visual wall.</span>
            </label>
          </div>
        </fieldset>

        <FilterRuleEditor
          match={draft.match}
          rules={draft.rules}
          onMatchChange={(match) => setDraft({ ...draft, match })}
          onRulesChange={(rules) => setDraft({ ...draft, rules })}
        />

        <div className="dialog-actions chat-tab-dialog-actions">
          {tab && (
            <button
              className="button danger-button"
              onClick={() => onDelete(tab.id)}
            >
              Delete tab
            </button>
          )}
          <span>{editorError ?? "Ready to save"}</span>
          <button className="button" onClick={onClose}>Cancel</button>
          <button
            className="button primary"
            disabled={Boolean(editorError)}
            onClick={() => onSave({ ...draft, name: draft.name.trim() })}
          >
            {tab ? "Save changes" : "Add tab"}
          </button>
        </div>
      </div>
    </div>
  );
}

function createEmptyTab(): ChatViewTab {
  return {
    id: createClientId("chat-tab"),
    name: "",
    layout: "chat",
    match: "all",
    rules: [createFilterRule("message")],
  };
}
