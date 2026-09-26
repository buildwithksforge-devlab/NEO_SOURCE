/**
 * Attention ordering and semantic state for the notification feed.
 *
 * Two rules the operators asked for:
 *
 * 1. High-importance actionable notices sit ABOVE informational history. The
 *    feed is sorted by attention rank first and recency second, so a failed
 *    posting never sinks below a routine "goods received" note.
 * 2. Overdue is not Blocked. Each notice resolves to exactly one semantic
 *    state — failed, blocked, escalated, overdue, pending approval, due soon
 *    or informational — instead of every late item being painted as blocked.
 *
 * This module is presentation logic only: it reads fields the database already
 * writes and never changes what a reader is allowed to see.
 */
import type { Tone } from "@/lib/tone";

export type AttentionState =
  | "failed"
  | "blocked"
  | "escalated"
  | "overdue"
  | "pending-approval"
  | "due-soon"
  | "informational"
  | "resolved";

export type AttentionInput = {
  category?: string | null;
  priority?: string | null;
  status?: string | null;
  action_required?: boolean | null;
  event_type?: string | null;
  title?: string | null;
  body?: string | null;
  created_at?: string | null;
};

export const ATTENTION_LABEL: Record<AttentionState, string> = {
  failed: "Failed",
  blocked: "Blocked",
  escalated: "Escalated",
  overdue: "Overdue",
  "pending-approval": "Pending approval",
  "due-soon": "Due soon",
  informational: "For information",
  resolved: "Resolved",
};

export const ATTENTION_TONE: Record<AttentionState, Tone> = {
  failed: "destructive",
  blocked: "destructive",
  escalated: "warning",
  overdue: "warning",
  "pending-approval": "info",
  "due-soon": "info",
  informational: "default",
  resolved: "success",
};

/**
 * Lower number = higher in the feed.
 * failed/blocked → escalated → overdue → pending approval → due soon →
 * informational → resolved history.
 */
export const ATTENTION_RANK: Record<AttentionState, number> = {
  failed: 0,
  blocked: 1,
  escalated: 2,
  overdue: 3,
  "pending-approval": 4,
  "due-soon": 5,
  informational: 6,
  resolved: 7,
};

const has = (text: string, ...needles: string[]) => needles.some((n) => text.includes(n));

/** The single semantic state a notice is in. */
export function attentionState(n: AttentionInput): AttentionState {
  const status = (n.status ?? "open").toLowerCase();
  if (status !== "open") {
    return status === "escalated" ? "escalated" : "resolved";
  }

  const text = `${n.event_type ?? ""} ${n.title ?? ""} ${n.body ?? ""}`.toLowerCase();
  const priority = (n.priority ?? "normal").toLowerCase();
  const category = (n.category ?? "").toLowerCase();
  const actionable = Boolean(n.action_required);

  if (has(text, "failed", "failure", "error", "rejected", "declined")) return "failed";
  if (has(text, "blocked", "cannot continue", "stock unavailable", "out of stock", "halted"))
    return "blocked";
  if (has(text, "escalat")) return "escalated";
  if (has(text, "overdue", "past due", "late")) return "overdue";
  if (category === "approvals" || has(text, "awaiting approval", "approval required"))
    return actionable ? "pending-approval" : "informational";

  if (actionable) {
    if (priority === "urgent" || priority === "critical") return "blocked";
    if (priority === "high") return "overdue";
    if (has(text, "due", "reminder")) return "due-soon";
    return "due-soon";
  }

  return "informational";
}

/** True when the notice still belongs in the active attention feed. */
export function isActiveAttention(n: AttentionInput): boolean {
  return (n.status ?? "open").toLowerCase() === "open" && Boolean(n.action_required);
}

/** Attention rank first, newest first inside a rank. */
export function compareByAttention(a: AttentionInput, b: AttentionInput): number {
  const rank = ATTENTION_RANK[attentionState(a)] - ATTENTION_RANK[attentionState(b)];
  if (rank !== 0) return rank;
  return (b.created_at ?? "").localeCompare(a.created_at ?? "");
}

/** Non-mutating attention sort for a notification list. */
export function sortByAttention<T extends AttentionInput>(rows: readonly T[]): T[] {
  return [...rows].sort(compareByAttention);
}
