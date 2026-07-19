import {
  filterRuleError,
  operatorsForField,
  type FilterField,
  type FilterOperator,
  type FilterRule,
  type FilterMatchMode,
} from "./filters";
import { createFilterRule } from "./filterRuleFactory";

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
  regex: "matches regular expression",
  has: "has",
  notHas: "does not have",
};

export default function FilterRuleEditor({
  match,
  rules,
  allowEmpty = false,
  emptyMessage = "No conditions.",
  onMatchChange,
  onRulesChange,
}: {
  match: FilterMatchMode;
  rules: FilterRule[];
  allowEmpty?: boolean;
  emptyMessage?: string;
  onMatchChange: (match: FilterMatchMode) => void;
  onRulesChange: (rules: FilterRule[]) => void;
}) {
  const updateRule = (id: string, changes: Partial<FilterRule>) => {
    onRulesChange(
      rules.map((rule) => rule.id === id ? { ...rule, ...changes } : rule),
    );
  };

  return (
    <>
      <div className="rule-heading">
        <div>
          <strong>Conditions</strong>
          <span>A message must match</span>
          <select
            aria-label="Condition matching mode"
            onChange={(event) => onMatchChange(event.target.value as FilterMatchMode)}
            value={match}
          >
            <option value="all">all</option>
            <option value="any">any</option>
          </select>
          <span>of these rules</span>
        </div>
        <button
          className="button"
          onClick={() => onRulesChange([...rules, createFilterRule("message")])}
          type="button"
        >
          + Add condition
        </button>
      </div>

      <div className="rule-list">
        {allowEmpty && rules.length === 0 && (
          <div className="rule-list-empty">{emptyMessage}</div>
        )}
        {rules.map((rule, index) => (
          <div className="filter-rule" key={rule.id}>
            <span className="rule-number">{index + 1}</span>
            <label>
              <span>Field</span>
              <select
                onChange={(event) => {
                  const field = event.target.value as FilterField;
                  updateRule(rule.id, createFilterRule(field, rule.id));
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
            <RuleValueInput
              error={rule.operator === "regex" && rule.value ? filterRuleError(rule) : undefined}
              rule={rule}
              onChange={(value) => updateRule(rule.id, { value })}
            />
            <button
              aria-label={`Remove condition ${index + 1}`}
              className="remove-rule"
              disabled={!allowEmpty && rules.length === 1}
              onClick={() => onRulesChange(
                rules.filter((candidate) => candidate.id !== rule.id),
              )}
              title={!allowEmpty && rules.length === 1
                ? "A filter needs at least one condition"
                : "Remove condition"}
              type="button"
            >
              {"\u00d7"}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function RuleValueInput({
  error,
  rule,
  onChange,
}: {
  error?: string;
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
        placeholder={
          rule.operator === "regex"
            ? "e.g. ^hello or /hello|hi/i"
            : rule.field === "badge"
              ? "e.g. subscriber or bits/100"
              : "Enter a value"
        }
        value={rule.value}
      />
      {error && <small className="rule-error">{error}</small>}
    </label>
  );
}
