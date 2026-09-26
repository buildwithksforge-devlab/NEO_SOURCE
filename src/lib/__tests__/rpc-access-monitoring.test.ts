/**
 * Contract for the access-failure monitoring surface:
 *  - execute privileges are compared against the callable-surface manifest, and
 *  - a refused or denied call on a payment/delivery routine alerts immediately.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));

import { comparePrivileges, CRITICAL_RPCS, type RpcPrivilegeRow } from "@/lib/rpc-health";
import {
  criticalRpcAlerts,
  onCriticalRpcFailure,
  recordRpcMetric,
  resetRpcTelemetry,
  type RpcCallMetric,
} from "@/lib/rpc-telemetry";

const row = (name: string, over: Partial<RpcPrivilegeRow> = {}): RpcPrivilegeRow => ({
  routine: name,
  arguments: "",
  anon: false,
  authenticated: true,
  service_role: true,
  ...over,
});

const metric = (over: Partial<RpcCallMetric>): RpcCallMetric => ({
  rpc: "neo_delivery_assign",
  required: "authenticated",
  role: "authenticated",
  outcome: "permission_denied",
  durationMs: 4,
  code: "42501",
  message: "permission denied for function",
  at: Date.now(),
  ...over,
});

describe("execute-privilege health check", () => {
  it("passes when every critical routine matches the manifest", () => {
    const rows = CRITICAL_RPCS.map((n) =>
      n.startsWith("neo_mpesa_apply") ? row(n, { authenticated: false }) : row(n),
    );
    expect(comparePrivileges(rows)).toEqual([]);
  });

  it("reports a lost grant for signed-in staff", () => {
    const rows = [row("neo_delivery_rider_directory", { authenticated: false })];
    const found = comparePrivileges(rows, ["neo_delivery_rider_directory"]);
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toBe("missing-grant");
  });

  it("reports a missing routine", () => {
    const found = comparePrivileges([], ["neo_hr_reconcile_staff"]);
    expect(found[0]!.reason).toBe("missing-routine");
  });

  it("reports a server-only routine that signed-in callers can execute", () => {
    const found = comparePrivileges(
      [row("neo_mpesa_apply_result", { authenticated: true })],
      ["neo_mpesa_apply_result"],
    );
    expect(found[0]!.reason).toBe("over-granted");
  });
});

describe("critical routine alerting", () => {
  beforeEach(() => resetRpcTelemetry());

  it("alerts on a denied delivery routine", () => {
    const alerts = criticalRpcAlerts([metric({})]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.area).toBe("delivery");
  });

  it("alerts on a refused payment routine", () => {
    const alerts = criticalRpcAlerts([
      metric({ rpc: "neo_mpesa_apply_result", outcome: "auth_required", role: "anon" }),
    ]);
    expect(alerts[0]!.area).toBe("payment");
    expect(alerts[0]!.message).toContain("refused before dispatch");
  });

  it("ignores successful and non-critical calls", () => {
    expect(criticalRpcAlerts([metric({ outcome: "ok" })])).toEqual([]);
    expect(criticalRpcAlerts([metric({ rpc: "my_dashboards" })])).toEqual([]);
  });

  it("notifies a subscriber the moment a critical call fails", () => {
    const seen: string[] = [];
    const stop = onCriticalRpcFailure((a) => seen.push(a.rpc));
    recordRpcMetric(metric({ rpc: "neo_mpesa_txn_start", outcome: "permission_denied" }));
    recordRpcMetric(metric({ rpc: "my_dashboards", outcome: "permission_denied" }));
    stop();
    expect(seen).toEqual(["neo_mpesa_txn_start"]);
  });
});
