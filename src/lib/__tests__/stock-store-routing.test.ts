import { describe, expect, it } from "vitest";
import {
  resolveStoreForCategory,
  resolveStoreForItem,
  type CategoryRow,
  type GroupStore,
} from "@/lib/stock-hierarchy";

const categories: CategoryRow[] = [
  {
    id: "cat-dairy",
    name: "Dairy & Eggs",
    code: null,
    groupId: "grp-food",
    proposedGroupId: null,
    proposedReason: null,
    confirmedAt: null,
  },
  {
    id: "cat-loose",
    name: "Ungrouped",
    code: null,
    groupId: null,
    proposedGroupId: null,
    proposedReason: null,
    confirmedAt: null,
  },
];

const groupStores: GroupStore[] = [
  { id: "gs1", groupId: "grp-food", branchId: null, locationId: "main-food-store" },
  { id: "gs2", groupId: "grp-food", branchId: "branch-a", locationId: "branch-a-food-store" },
];

const base = { categories, groupStores, branchId: "branch-a" as string | null };

describe("stock store routing precedence", () => {
  it("uses the store chosen on the transaction above everything else", () => {
    expect(
      resolveStoreForItem({
        ...base,
        explicitLocationId: "cold-room",
        defaultLocationId: "chiller",
        categoryId: "cat-dairy",
      }),
    ).toBe("cold-room");
  });

  it("uses the item's own default store above the group fallback", () => {
    expect(
      resolveStoreForItem({ ...base, defaultLocationId: "chiller", categoryId: "cat-dairy" }),
    ).toBe("chiller");
  });

  it("falls back to the group store only when the item has no default store", () => {
    expect(resolveStoreForItem({ ...base, categoryId: "cat-dairy" })).toBe("branch-a-food-store");
  });

  it("prefers a property-specific fallback over the workspace-wide one", () => {
    expect(resolveStoreForCategory("cat-dairy", categories, groupStores, null)).toBe(
      "main-food-store",
    );
  });

  it("asks for a store rather than guessing when nothing applies", () => {
    expect(resolveStoreForItem({ ...base, categoryId: "cat-loose" })).toBeNull();
    expect(resolveStoreForItem({ ...base, categoryId: null })).toBeNull();
  });
});
