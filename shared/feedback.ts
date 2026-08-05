export const FEEDBACK_KINDS = ["feedback", "issue"] as const;
export type FeedbackKind = typeof FEEDBACK_KINDS[number];

export const FEEDBACK_STATUSES = ["open", "closed"] as const;
export type FeedbackStatus = typeof FEEDBACK_STATUSES[number];

export const FEEDBACK_FLAG_DEFINITIONS = [
  { id: "needs-review", label: "Needs review", group: "Triage", kinds: FEEDBACK_KINDS },
  { id: "needs-info", label: "Needs info", group: "Triage", kinds: FEEDBACK_KINDS },
  { id: "duplicate", label: "Duplicate", group: "Triage", kinds: FEEDBACK_KINDS },
  { id: "non-issue", label: "Non-issue", group: "Triage", kinds: ["issue"] },
  { id: "feature-request", label: "Feature request", group: "Request", kinds: FEEDBACK_KINDS },
  { id: "improvement", label: "Improvement", group: "Request", kinds: FEEDBACK_KINDS },
  { id: "question", label: "Question", group: "Request", kinds: FEEDBACK_KINDS },
  { id: "support", label: "Support", group: "Request", kinds: FEEDBACK_KINDS },
  { id: "documentation", label: "Documentation", group: "Request", kinds: FEEDBACK_KINDS },
  { id: "urgent", label: "Urgent", group: "Impact", kinds: FEEDBACK_KINDS },
  { id: "high-priority", label: "High priority", group: "Impact", kinds: FEEDBACK_KINDS },
  { id: "low-priority", label: "Low priority", group: "Impact", kinds: FEEDBACK_KINDS },
  { id: "usability", label: "Usability", group: "Area", kinds: FEEDBACK_KINDS },
  { id: "accessibility", label: "Accessibility", group: "Area", kinds: FEEDBACK_KINDS },
  { id: "performance", label: "Performance", group: "Area", kinds: FEEDBACK_KINDS },
  { id: "security", label: "Security", group: "Area", kinds: FEEDBACK_KINDS },
  { id: "mobile", label: "Mobile", group: "Area", kinds: FEEDBACK_KINDS },
  { id: "desktop", label: "Desktop", group: "Area", kinds: FEEDBACK_KINDS },
  { id: "data-quality", label: "Data quality", group: "Area", kinds: FEEDBACK_KINDS },
  { id: "integration", label: "Integration", group: "Area", kinds: FEEDBACK_KINDS },
  { id: "quick-win", label: "Quick win", group: "Workflow", kinds: FEEDBACK_KINDS },
  { id: "planned", label: "Planned", group: "Workflow", kinds: FEEDBACK_KINDS },
  { id: "in-progress", label: "In progress", group: "Workflow", kinds: FEEDBACK_KINDS },
  { id: "blocked", label: "Blocked", group: "Workflow", kinds: FEEDBACK_KINDS },
  { id: "wont-do", label: "Won't do", group: "Workflow", kinds: FEEDBACK_KINDS },
] as const;

export type FeedbackFlag = typeof FEEDBACK_FLAG_DEFINITIONS[number]["id"];

const feedbackFlagSet = new Set<string>(
  FEEDBACK_FLAG_DEFINITIONS.map((definition) => definition.id),
);

export function isFeedbackKind(value: unknown): value is FeedbackKind {
  return typeof value === "string" && FEEDBACK_KINDS.includes(value as FeedbackKind);
}

export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return typeof value === "string" && FEEDBACK_STATUSES.includes(value as FeedbackStatus);
}

export function isFeedbackFlag(value: unknown): value is FeedbackFlag {
  return typeof value === "string" && feedbackFlagSet.has(value);
}

export function isFeedbackFlagAllowed(flag: FeedbackFlag, kind: FeedbackKind) {
  const definition = FEEDBACK_FLAG_DEFINITIONS.find((candidate) => candidate.id === flag);
  return Boolean(definition?.kinds.some((candidate) => candidate === kind));
}
