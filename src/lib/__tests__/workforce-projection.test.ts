import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { describeWorkforceScope, type WorkforceSummary } from "@/lib/workforce";

const summary = (over: Partial<WorkforceSummary> = {}): WorkforceSummary => ({
  authorised: true,
  branch_id: null,
  employees_active: 48,
  employees_total: 48,
  accounts_active: 52,
  employees_without_account: 3,
  accounts_without_employee: 7,
  ...over,
});

describe("canonical workforce projection", () => {
  it("never presents login accounts as people", () => {
    const text = describeWorkforceScope(summary(), null);
    expect(text).toContain("48 on the roster");
    expect(text).toContain("52 staff accounts");
  });

  it("names the selected property when the projection is property scoped", () => {
    expect(describeWorkforceScope(summary({ branch_id: "b1" }), "Zawadi Springs Nairobi")).toContain(
      "Zawadi Springs Nairobi",
    );
  });

  it("stays honest when the reader is not authorised", () => {
    expect(describeWorkforceScope({ ...summary(), authorised: false })).toMatch(/not available/i);
  });

  it("HR headcount consumes the canonical projection, not a local employee count", () => {
    const hr = readFileSync("src/lib/hr-data.ts", "utf8");
    expect(hr).toContain('from "@/lib/workforce"');
    expect(hr).toContain("canonicalHeadcount ??");
  });

  it("reads the projection through the guarded RPC path", () => {
    const src = readFileSync("src/lib/workforce.ts", "utf8");
    expect(src).toContain("guardedRpc");
    expect(src).toContain("neo_workforce_summary");
    expect(src).toContain("neo_workforce_people");
    expect(src).not.toMatch(/supabase\.rpc\(/);
  });
});
