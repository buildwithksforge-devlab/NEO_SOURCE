/**
 * Dashboard metrics data contract.
 *
 * The shared `dashboard_metrics` service must count records using the same
 * vocabulary the operational tables actually store, and must never answer
 * organisation-wide for a reader whose access is limited to properties.
 * Channel: read-only SQL (PG* environment) plus the client resolver.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolveCardState } from "@/lib/card-state";
import { readMetric } from "@/lib/dashboards";

const HAS_SQL = Boolean(process.env["PGHOST"]);
const d = HAS_SQL ? describe : describe.skip;

function scalar(query: string): string {
  return execFileSync("psql", ["-At", "-c", query], { encoding: "utf8" }).trim();
}

const body = () =>
  scalar(
    `SELECT pg_get_functiondef(p.oid) FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'dashboard_metrics'`,
  );

d("dashboard_metrics vocabulary", () => {
  it("counts approvals with the canonical request lifecycle", () => {
    const def = body();
    expect(def).toContain("'pending_approval'");
    expect(def).toContain("'approved_pending_execution'");
    // The legacy 'pending' literal never occurs in approval_requests, so a card
    // reading it silently reported zero pending decisions.
    expect(def).not.toMatch(/status = 'pending'\)/);
  });

  it("measures turnaround from the recorded decision, not the last row edit", () => {
    expect(body()).toContain("decided_at - created_at");
  });

  it("never mixes properties: every block narrows by the reader's properties", () => {
    const def = body();
    const narrowing = def.match(/_branches IS NULL OR/g) ?? [];
    // tasks (x2), approvals, notifications, staff, branches, departments,
    // stations, audit, alerts.
    expect(narrowing.length).toBeGreaterThanOrEqual(10);
    expect(def).toContain("current_branch_ids()");
    expect(def).toContain("property_out_of_scope");
  });

  it("keeps Owner/Director and System Administrator organisation-wide", () => {
    expect(body()).toMatch(/_scope IN \('organisation','organization','technical'\)/);
  });

  it("shows only own work to personal-scope staff", () => {
    const def = body();
    expect(def).toContain("NOT _self OR assignee_id = _uid");
    expect(def).toContain("NOT _self OR requester_id = _uid");
  });
});

describe("metric reading never invents or hides a figure", () => {
  it("reads a real zero as zero, and renders it", () => {
    const payload = { tasks: { open: 0 } };
    expect(readMetric(payload, "tasks.open")).toBe(0);
    expect(resolveCardState({ hasLoaded: true, value: 0 })).toBe("ready");
  });

  it("treats a missing branch of the payload as no records, not zero", () => {
    expect(readMetric({ tasks: {} }, "approvals.pending")).toBeNull();
    expect(resolveCardState({ hasLoaded: true, value: null })).toBe("no-records");
  });

  it("never prints a figure while the query is in flight or failed", () => {
    expect(resolveCardState({ isLoading: true, value: 4 })).toBe("loading");
    expect(resolveCardState({ error: new Error("boom"), value: 4 })).toBe("query-failed");
  });
});
