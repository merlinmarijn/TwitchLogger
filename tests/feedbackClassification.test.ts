import { describe, expect, it } from "vitest";
import {
  FEEDBACK_FLAG_DEFINITIONS,
  FEEDBACK_STATUSES,
  isFeedbackFlag,
  isFeedbackFlagAllowed,
} from "../shared/feedback";

describe("feedback classification", () => {
  it("offers a broad, unique set of filterable flags", () => {
    const ids = FEEDBACK_FLAG_DEFINITIONS.map((definition) => definition.id);
    const groups = new Set(FEEDBACK_FLAG_DEFINITIONS.map((definition) => definition.group));

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(20);
    expect(groups).toEqual(new Set(["Triage", "Request", "Impact", "Area", "Workflow"]));
    expect(ids.every(isFeedbackFlag)).toBe(true);
  });

  it("supports open and closed states and restricts non-issue to bug reports", () => {
    expect(FEEDBACK_STATUSES).toEqual(["open", "closed"]);
    expect(isFeedbackFlagAllowed("non-issue", "issue")).toBe(true);
    expect(isFeedbackFlagAllowed("non-issue", "feedback")).toBe(false);
    expect(isFeedbackFlagAllowed("feature-request", "feedback")).toBe(true);
  });
});
