import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { guardedRpc } from "@/lib/rpc-guard";
import {
  detectRpcSpikes,
  getRpcMetrics,
  resetRpcTelemetry,
  rpcMetricsCsv,
} from "@/lib/rpc-telemetry";
import {
  clearPendingActions,
  listPendingActions,
  rememberIfReauthNeeded,
  replayPendingActions,
} from "@/lib/retry-after-reauth";

const session = { value: null as null | { access_token: string } };

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: session.value } }) },
  },
}));

function client(result: { data?: unknown; error?: { code?: string; message?: string } | null }) {
  return { rpc: vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null })) };
}

describe("guardedRpc session guard", () => {
  beforeEach(() => {
    resetRpcTelemetry();
    clearPendingActions();
    session.value = null;
  });

  it("refuses an authenticated routine while the browser is anonymous", async () => {
    const sb = client({ data: [1] });
    const { data, error } = await guardedRpc(sb, "my_effective_access");
    expect(sb.rpc).not.toHaveBeenCalled();
    expect(data).toBeNull();
    expect(error?.code).toBe("no_session");
    expect(getRpcMetrics()[0]).toMatchObject({ outcome: "auth_required", role: "anon" });
  });

  it("dispatches and records a metric once a session exists", async () => {
    session.value = { access_token: "token" };
    const sb = client({ data: { ok: true } });
    const { data, error } = await guardedRpc(sb, "neo_delivery_assign", { _order: "o1" });
    expect(error).toBeNull();
    expect(data).toEqual({ ok: true });
    expect(getRpcMetrics()[0]).toMatchObject({ outcome: "ok", role: "authenticated" });
  });

  it("classifies a permission denial without throwing", async () => {
    session.value = { access_token: "token" };
    const sb = client({ error: { code: "42501", message: "permission denied for function x" } });
    const { error } = await guardedRpc(sb, "neo_delivery_dispatch_candidates");
    expect(error?.message).toContain("permission denied");
    expect(getRpcMetrics()[0]?.outcome).toBe("permission_denied");
  });
});

describe("telemetry export and alerting", () => {
  beforeEach(() => resetRpcTelemetry());

  it("raises one alert per routine and role once denials cluster", async () => {
    session.value = null;
    const sb = client({ data: null });
    for (let i = 0; i < 3; i += 1) await guardedRpc(sb, "my_effective_access");
    const alerts = detectRpcSpikes();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ rpc: "my_effective_access", role: "anon", denials: 3 });
  });

  it("stays quiet for a single ordinary denial", async () => {
    session.value = null;
    await guardedRpc(client({ data: null }), "my_effective_access");
    expect(detectRpcSpikes()).toHaveLength(0);
  });

  it("exports a header row and one line per call", async () => {
    session.value = { access_token: "token" };
    await guardedRpc(client({ data: 1 }), "bi_kpis");
    const csv = rpcMetricsCsv(getRpcMetrics()).split("\n");
    expect(csv[0]).toContain("routine,required_role,executing_role,outcome,duration_ms");
    expect(csv).toHaveLength(2);
    expect(csv[1]).toContain("bi_kpis");
  });
});

describe("retry after re-authentication", () => {
  beforeEach(() => clearPendingActions());

  it("remembers only authorisation failures", () => {
    const action = { key: "delivery-assign:1", label: "Assign rider", run: () => undefined };
    expect(rememberIfReauthNeeded(new Error("That rider is off shift"), action)).toBe(false);
    expect(listPendingActions()).toHaveLength(0);
    expect(rememberIfReauthNeeded(new Error("permission denied for function"), action)).toBe(true);
    expect(listPendingActions()).toHaveLength(1);
  });

  it("replays the remembered dispatch exactly once", async () => {
    const run = vi.fn(async () => "assigned");
    rememberIfReauthNeeded(new Error("permission denied"), {
      key: "delivery-assign:1",
      label: "Assign rider",
      run,
    });
    const result = await replayPendingActions();
    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ replayed: 1, failed: 0 });
    expect(listPendingActions()).toHaveLength(0);
  });
});

describe("no unguarded routine call remains in client code", () => {
  it("routes every browser-side rpc through the guard", () => {
    const files = globSync("src/**/*.{ts,tsx}").filter(
      // property-entrance.ts holds the one deliberate signed-out lookup: the
      // guard refuses anonymous dispatch by design, so the branded sign-in
      // page resolves its hotel through the anon-safe routine directly. Its
      // signed-in routine in the same file does go through the guard.
      // front-door.ts is the same case for the NEØ front door: the public
      // hotel list, a hotel's public page and the entrance states are read
      // before anyone signs in, and grant nothing on their own.
      (f) =>
        !/__tests__|\.functions\.ts|\.server\.ts|rpc-guard|rpc-telemetry|property-entrance\.ts|front-door\.ts/.test(
          f,
        ),
    );
    const offenders = files.filter((f) => /(?<![\w.])[A-Za-z_$][\w$]*\.rpc\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
