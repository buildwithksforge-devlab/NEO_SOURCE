import { describe, expect, it } from "vitest";
import {
  ATTENTION_LABEL,
  ATTENTION_TONE,
  attentionState,
  isActiveAttention,
  sortByAttention,
} from "@/lib/notification-priority";
import { TONE_TINT } from "@/lib/tone";

const at = (over: Record<string, unknown> = {}) => ({
  status: "open",
  action_required: true,
  priority: "normal",
  category: "operational-alert",
  title: "",
  body: "",
  event_type: "",
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("notification attention state", () => {
  it("keeps each semantic state distinct", () => {
    expect(attentionState(at({ title: "Finance posting failed" }))).toBe("failed");
    expect(attentionState(at({ body: "Stock unavailable — order blocked" }))).toBe("blocked");
    expect(attentionState(at({ event_type: "workflow.escalation" }))).toBe("escalated");
    expect(attentionState(at({ title: "Inspection overdue" }))).toBe("overdue");
    expect(attentionState(at({ category: "approvals" }))).toBe("pending-approval");
    expect(attentionState(at({ title: "Shift due in 1 hour" }))).toBe("due-soon");
    expect(attentionState(at({ action_required: false, title: "Goods received" }))).toBe(
      "informational",
    );
  });

  it("retires completed work from the active feed", () => {
    const done = at({ status: "resolved", title: "Housekeeping job done" });
    expect(attentionState(done)).toBe("resolved");
    expect(isActiveAttention(done)).toBe(false);
    expect(isActiveAttention(at())).toBe(true);
  });

  it("sorts high-importance actionable notices above informational ones", () => {
    const rows = [
      at({ action_required: false, title: "Goods received", created_at: "2026-05-05T10:00:00Z" }),
      at({ category: "approvals", title: "PO awaiting approval", created_at: "2026-05-01T10:00:00Z" }),
      at({ title: "Payment failed", created_at: "2026-04-01T10:00:00Z" }),
      at({ title: "Cleaning overdue", created_at: "2026-04-02T10:00:00Z" }),
    ];
    expect(sortByAttention(rows).map((r) => attentionState(r))).toEqual([
      "failed",
      "overdue",
      "pending-approval",
      "informational",
    ]);
  });

  it("newest first inside the same attention band", () => {
    const older = at({ title: "Payment failed", created_at: "2026-01-01T00:00:00Z" });
    const newer = at({ title: "Payment failed", created_at: "2026-02-01T00:00:00Z" });
    expect(sortByAttention([older, newer])[0]).toBe(newer);
  });

  it("labels and tones every state, and tones never render dark-on-dark", () => {
    for (const state of Object.keys(ATTENTION_LABEL) as (keyof typeof ATTENTION_LABEL)[]) {
      expect(ATTENTION_LABEL[state]).toBeTruthy();
      const tint = TONE_TINT[ATTENTION_TONE[state]];
      expect(tint).toMatch(/^bg-(chip|tint-)/);
      // Theme-aware foreground token, never a solid-fill foreground.
      expect(tint).toMatch(/text-(chip-foreground|on-tint-)/);
    }
  });
});
