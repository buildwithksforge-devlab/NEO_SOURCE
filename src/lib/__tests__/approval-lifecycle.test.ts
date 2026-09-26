import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// These state-model assertions never contact Supabase; avoid initialising the live client.
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn() } }));
import {
  REQUEST_STATUSES,
  STEP_STATUSES,
  activeStep,
  isInMyInbox,
} from "@/routes/_shell.approvals";
import { ACTIONABLE_TASK_STATUSES, CLOSED_TASK_STATUSES, isActionable } from "@/routes/_shell.tasks";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

type Step = {
  id: string;
  level: number;
  status: string;
  approver_user_id: string | null;
  approver_role_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  comment: string;
};

const step = (level: number, status: string, approver: string | null = null): Step => ({
  id: `s${level}`,
  level,
  status,
  approver_user_id: approver,
  approver_role_id: null,
  decided_by: null,
  decided_at: null,
  comment: "",
});

const request = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: "r1",
    reference: "APP-1",
    approval_type: "purchase",
    requester_id: "requester",
    approver_id: null,
    reason: "fruits",
    notes: "",
    amount: 78900,
    level: 1,
    max_level: 2,
    status: "pending_approval",
    execution_status: "not_started",
    execution_error: "",
    created_at: new Date().toISOString(),
    decided_at: null,
    completed_at: null,
    approval_steps: [step(1, "active"), step(2, "waiting")],
    ...over,
  }) as never;

describe("approval state model", () => {
  it("uses exactly the authoritative request states", () => {
    expect([...REQUEST_STATUSES]).toEqual([
      "draft",
      "pending_approval",
      "returned_for_correction",
      "approved_pending_execution",
      "executing",
      "completed",
      "rejected",
      "cancelled",
      "execution_failed",
    ]);
  });

  it("uses exactly the authoritative step states", () => {
    expect([...STEP_STATUSES]).toEqual([
      "waiting",
      "active",
      "approved",
      "rejected",
      "returned",
      "escalated",
      "skipped",
      "cancelled",
    ]);
  });
});

describe("multi-level inbox visibility", () => {
  it("shows a request only to the currently active level", () => {
    const r = request({ approval_steps: [step(1, "approved"), step(2, "active", "boss")] });
    expect(activeStep(r)?.level).toBe(2);
    expect(isInMyInbox(r, "boss")).toBe(true);
    expect(isInMyInbox(r, "level-one-approver")).toBe(false);
  });

  it("never shows a resolved chain in an inbox", () => {
    for (const status of ["completed", "rejected", "cancelled", "execution_failed", "approved_pending_execution"]) {
      const r = request({ status, approval_steps: [step(1, "approved"), step(2, "approved")] });
      expect(isInMyInbox(r, "boss")).toBe(false);
    }
  });

  it("never shows a requester their own request as actionable", () => {
    expect(isInMyInbox(request(), "requester")).toBe(false);
  });

  it("shows a routed role step only to a member of that exact role", () => {
    const routed = request({
      approval_steps: [{ ...step(1, "active"), approver_role_id: "operations-role" }],
    });
    expect(isInMyInbox(routed, "operator", ["operations-role"])).toBe(true);
    expect(isInMyInbox(routed, "other", ["finance-role"])).toBe(false);
  });

  it("reports the active level, not the first level, after level 1 resolves", () => {
    const r = request({ level: 2, approval_steps: [step(1, "approved"), step(2, "active")] });
    expect(activeStep(r)?.level).toBe(2);
  });
});

describe("task queue hygiene", () => {
  it("keeps only actionable statuses in My Tasks", () => {
    for (const s of ACTIONABLE_TASK_STATUSES) expect(isActionable({ status: s })).toBe(true);
    for (const s of CLOSED_TASK_STATUSES) expect(isActionable({ status: s })).toBe(false);
  });
});

describe("query rules are wired to the authoritative status", () => {
  const approvals = read("src/routes/_shell.approvals.tsx");

  it("records decisions through the transactional routine only", () => {
    expect(approvals).toContain("neo_approval_decide");
    expect(approvals).not.toMatch(/from\("approval_requests"\)\s*\.update/);
    expect(approvals).not.toMatch(/from\("approval_actions"\)\s*\.insert/);
  });

  it("passes an idempotency key with every decision", () => {
    expect(approvals).toContain("_idempotency_key");
  });

  it("offers a retry path for failed downstream execution", () => {
    expect(approvals).toContain("neo_approval_retry_execution");
  });

  it("never filters dashboards on the legacy pending status", () => {
    for (const file of ["src/lib/dashboard-data.ts"]) {
      const src = read(file);
      expect(src).not.toContain('.eq("status", "pending")');
      expect(src).toContain('.eq("status", "pending_approval")');
    }
  });

  it("derives action-required notices from live approval chains, not resolved notifications", () => {
    const notifications = read("src/routes/_shell.notifications.tsx");
    expect(notifications).toContain("activeApprovalIds");
    expect(notifications).toContain('.eq("status", "pending_approval")');
  });
});
