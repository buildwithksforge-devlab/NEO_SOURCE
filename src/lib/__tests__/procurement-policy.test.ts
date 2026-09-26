import { describe, expect, it, vi } from "vitest";
// Policy band tests are pure and must work without production credentials.
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn() } }));
import { findBandGaps } from "@/routes/admin.procurement-policy";
import { capabilityForPath } from "@/lib/capabilities";
import { SETTINGS_CATEGORIES } from "@/lib/settings-catalogue";
import type { ApprovalRule } from "@/lib/finance-controls";

function rule(p: Partial<ApprovalRule>): ApprovalRule {
  return {
    id: Math.random().toString(36).slice(2),
    approval_type: "purchase-request",
    level: 1,
    branch_id: null,
    department_id: null,
    approver_role_id: "role",
    approver_user_id: null,
    min_amount: null,
    max_amount: null,
    max_percent: null,
    required_approvers: 1,
    allow_self_approval: false,
    escalate_above_limit: true,
    active: true,
    label: null,
    currency: null,
    effective_from: null,
    effective_to: null,
    require_rejection_reason: true,
    require_override_reason: true,
    ...p,
  };
}

describe("Procurement approval & control policy", () => {
  it("is discoverable from the Configuration Centre and gated on procurement", () => {
    const entries = SETTINGS_CATEGORIES.flatMap((c) => c.entries);
    expect(entries.some((e) => e.to === "/admin/procurement-policy")).toBe(true);
    expect(capabilityForPath("/admin/procurement-policy")?.module).toBe("procurement");
  });

  it("reports nothing when the bands meet end to end", () => {
    expect(
      findBandGaps([
        rule({ level: 1, min_amount: null, max_amount: 50000 }),
        rule({ level: 2, min_amount: 50000, max_amount: null }),
      ]),
    ).toEqual([]);
  });

  it("reports an amount no configured band covers", () => {
    const gaps = findBandGaps([
      rule({ level: 1, min_amount: null, max_amount: 50000 }),
      rule({ level: 2, min_amount: 80000, max_amount: null }),
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("50,001");
    expect(gaps[0]).toContain("79,999");
  });

  it("keeps each property's bands separate, so one property cannot mask another's gap", () => {
    const gaps = findBandGaps([
      rule({ branch_id: "a", min_amount: null, max_amount: null }),
      rule({ branch_id: "b", min_amount: 10000, max_amount: null }),
    ]);
    expect(gaps).toHaveLength(1);
  });

  it("ignores retired rules, which stay as historical evidence", () => {
    expect(findBandGaps([rule({ active: false, min_amount: 5000 })])).toEqual([]);
  });
});
