import { describe, expect, it } from "vitest";
import {
  MAKER_CHECKER_TABLES,
  belongsInMyApprovalQueue,
  canApproveRecord,
  isHeldForIndependentApprover,
} from "../maker-checker";

const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("GOV-APP-01 maker/checker", () => {
  it("blocks the originator even when they hold approval authority", () => {
    const r = canApproveRecord({ viewerId: ME, creatorId: ME, hasApprovalPermission: true });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/somebody else/i);
  });

  it("allows approving somebody else's record", () => {
    expect(
      canApproveRecord({ viewerId: ME, creatorId: OTHER, hasApprovalPermission: true }).allowed,
    ).toBe(true);
  });

  it("refuses without approval authority regardless of who raised it", () => {
    expect(
      canApproveRecord({ viewerId: ME, creatorId: OTHER, hasApprovalPermission: false }).allowed,
    ).toBe(false);
  });

  it("honours a deliberate workspace exception", () => {
    expect(
      canApproveRecord({
        viewerId: ME,
        creatorId: ME,
        hasApprovalPermission: true,
        exceptionActive: true,
      }).allowed,
    ).toBe(true);
  });

  it("keeps my own request out of my approval queue", () => {
    expect(
      belongsInMyApprovalQueue({
        viewerId: ME,
        creatorId: ME,
        assignedUserId: ME,
        status: "pending_approval",
      }),
    ).toBe(false);
  });

  it("routes another person's request into my queue by role", () => {
    expect(
      belongsInMyApprovalQueue({
        viewerId: ME,
        creatorId: OTHER,
        assignedRoleId: "role-a",
        viewerRoleIds: ["role-a"],
        status: "pending_approval",
      }),
    ).toBe(true);
  });

  it("recognises the sole-approver hold", () => {
    expect(isHeldForIndependentApprover("self_only")).toBe(true);
    expect(isHeldForIndependentApprover("ok")).toBe(false);
  });

  it("registers every guarded table with a distinct maker and checker column", () => {
    expect(MAKER_CHECKER_TABLES.length).toBeGreaterThanOrEqual(20);
    for (const r of MAKER_CHECKER_TABLES) expect(r.maker).not.toEqual(r.checker);
    expect(new Set(MAKER_CHECKER_TABLES.map((r) => r.table)).size).toBe(
      MAKER_CHECKER_TABLES.length,
    );
  });
});
