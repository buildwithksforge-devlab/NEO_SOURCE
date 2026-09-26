import { describe, expect, it } from "vitest";
import {
  PLATFORM_APPROVAL_TYPES,
  approvalTypesForDomain,
  selectableApprovalTypes,
} from "@/lib/approval-types";

describe("canonical approval transaction-type registry", () => {
  it("defines the procurement workflow objects the routing engine must know", () => {
    const keys = approvalTypesForDomain("procurement").map((t) => t.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "purchase-request",
        "purchase-order",
        "procurement-variance",
        "supplier-invoice",
      ]),
    );
  });

  it("never repeats a key", () => {
    const keys = PLATFORM_APPROVAL_TYPES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("offers the procurement catalogue even when the workspace has no rows yet", () => {
    expect(selectableApprovalTypes("procurement", []).length).toBeGreaterThanOrEqual(4);
    expect(selectableApprovalTypes("procurement", undefined).length).toBeGreaterThanOrEqual(4);
  });

  it("uses the workspace's own wording where it renamed a type", () => {
    const list = selectableApprovalTypes("procurement", [
      { key: "purchase-order", name: "Local Purchase Order", active: true },
    ]);
    expect(list.find((t) => t.key === "purchase-order")?.name).toBe("Local Purchase Order");
  });

  it("hides a type the workspace deactivated", () => {
    const list = selectableApprovalTypes("procurement", [
      { key: "supplier-invoice", name: "Supplier invoice", active: false },
    ]);
    expect(list.some((t) => t.key === "supplier-invoice")).toBe(false);
  });
});
