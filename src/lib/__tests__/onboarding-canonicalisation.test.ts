/**
 * Shared canonicalisation contract.
 *
 * CREATE_INLINE must never mean CREATE_BLINDLY. These tests assert behaviour,
 * not one hotel's spreadsheet: objective spelling/format/abbreviation repair,
 * a second search of the hotel's own records, batch variant clustering, a hard
 * refusal to merge business concepts, and a total ban on canonicalising
 * governed masters.
 */
import { describe, expect, it } from "vitest";
import { matchPolicy } from "@/lib/onboarding/matching";
import {
  canonicalCasing,
  normaliseCanonical,
  orthographicallySame,
  proposeCanonical,
  variantClusters,
} from "@/lib/onboarding/canonicalisation";
import { domainByKey } from "@/lib/onboarding/domains";
import { buildImportPlan, prepareRows, proposeColumnMapping, commitReadiness, profileRows } from "@/lib/onboarding/engine";

const category = matchPolicy("asset_category");
const employee = matchPolicy("employee");
const supplier = matchPolicy("supplier");

describe("objective normalisation", () => {
  it("tidies whitespace and punctuation without changing meaning", () => {
    expect(normaliseCanonical("  kitchen   equipment,")).toBe("kitchen equipment");
    expect(canonicalCasing("coffee shop")).toBe("Coffee Shop");
  });

  it("treats casing and punctuation variants as the same word", () => {
    expect(orthographicallySame("Utensils", "utensils")).toBe(true);
    expect(orthographicallySame("Food & Beverage", "food and beverage")).toBe(true);
    expect(orthographicallySame("Cutlery", "Cookware")).toBe(false);
  });
});

describe("proposals for hotel-defined classification", () => {
  it("proposes a corrected spelling and keeps the original available", () => {
    const proposal = proposeCanonical("knive", category, []);
    expect(proposal.allowed).toBe(true);
    expect(proposal.proposed).toBe("Knives");
    expect(proposal.kind).toBe("spelling_variant");
  });

  it("proposes an expansion for an abbreviation", () => {
    const proposal = proposeCanonical("F&B", category, []);
    expect(proposal.kind).toBe("abbreviation");
    expect(proposal.proposed).toBe("Food & Beverage");
  });

  it("tidies a casing variant without claiming a spelling error", () => {
    const proposal = proposeCanonical("coffee shop", category, []);
    expect(proposal.kind).toBe("format_variant");
    expect(proposal.proposed).toBe("Coffee Shop");
  });

  it("never creates a second record when the hotel already has one", () => {
    const proposal = proposeCanonical("utensils", category, [{ id: "c1", label: "Utensils" }]);
    expect(proposal.kind).toBe("existing_record");
    expect(proposal.existingMatch?.id).toBe("c1");
  });

  it("matches an existing record through the corrected spelling", () => {
    const proposal = proposeCanonical("cuttlery", category, [{ id: "c2", label: "Cutlery" }]);
    expect(proposal.existingMatch?.id).toBe("c2");
  });

  it("explains related concepts instead of merging them", () => {
    const proposal = proposeCanonical("kitchen utensils", category, [
      { id: "c3", label: "Kitchen Equipment" },
    ]);
    expect(proposal.existingMatch).toBeNull();
    expect(proposal.semanticNeighbours.length).toBeGreaterThan(0);
    expect(proposal.requiresHumanJudgment).toBe(true);
  });

  it("does not treat unrelated classifications as neighbours", () => {
    const proposal = proposeCanonical("Stationery", category, [{ id: "c4", label: "Linen" }]);
    expect(proposal.semanticNeighbours).toHaveLength(0);
  });
});

describe("batch variant clustering", () => {
  it("offers several spreadsheet spellings as one canonical record", () => {
    const clusters = variantClusters(["F&B", "f/b", "Food and Beverage", "Housekeeping"], category, []);
    const fnb = clusters.find((c) => c.canonical === "Food & Beverage");
    expect(fnb?.members).toHaveLength(3);
    expect(clusters).toHaveLength(2);
  });

  it("keeps genuinely different concepts in separate clusters", () => {
    const clusters = variantClusters(["Cutlery", "Cookware", "Utensils"], category, []);
    expect(clusters).toHaveLength(3);
  });
});

describe("inventory classifications follow the same shared contract", () => {
  it.each([
    ["stock category", matchPolicy("stock_category")],
    ["item group", matchPolicy("stock_item_group")],
  ])("%s tidies spellings but never merges different concepts", (_name, policy) => {
    expect(policy.canonicalise).toBe(true);
    expect(policy.inlineCreate).toBe(true);
    // Same concept, written three ways — one record offered.
    expect(variantClusters(["dry  goods", "Dry Goods", "dry-goods"], policy, [])).toHaveLength(1);
    // Different concepts stay apart, however similar the words look.
    expect(variantClusters(["Dry Goods", "Frozen Goods", "Cleaning"], policy, [])).toHaveLength(3);
    // An existing record wins over creating a near-duplicate.
    const proposal = proposeCanonical("dry goods", policy, [{ id: "1", label: "Dry Goods" }]);
    expect(proposal.existingMatch?.id).toBe("1");
  });
});

describe("governed masters are never canonicalised", () => {
  it.each([
    ["employee", employee],
    ["supplier", supplier],
  ])("%s refuses proposals and clustering", (_name, policy) => {
    expect(policy.canonicalise).toBe(false);
    const proposal = proposeCanonical("j. mwangi", policy, []);
    expect(proposal.allowed).toBe(false);
    expect(proposal.proposed).toBe("j. mwangi");
    expect(variantClusters(["J Mwangi", "Joel Mwangi"], policy, [])).toHaveLength(0);
  });
});

describe("canonicalisation holds at volume", () => {
  it.each([10, 100, 1000, 10000])("clusters %i values without collapsing distinct concepts", (size) => {
    const values = Array.from({ length: size }, (_, i) => (i % 2 === 0 ? "f&b" : `Category ${i}`));
    const clusters = variantClusters(values, category, []);
    expect(clusters.find((c) => c.canonical === "Food & Beverage")?.members.length).toBeGreaterThan(0);
    expect(clusters.length).toBeLessThanOrEqual(values.length);
  });
});

describe("import plan separates optional links from required ones", () => {
  const assets = domainByKey("assets")!;
  const headers = ["Asset Name", "Dept"];
  const rows = [{ "Asset Name": "Fridge", Dept: "Qqqq Zzz" }];

  function prepared(decisions: Record<string, string> = {}) {
    const mapping = Object.fromEntries(
      proposeColumnMapping(assets, headers, rows).map((p) => [p.column, p.fieldKey ?? ""]),
    );
    return prepareRows(assets, mapping, rows, {
      transforms: new Set(["trim_whitespace"] as const),
      masters: { department: [{ id: "d1", label: "Housekeeping" }] },
      ignoredFields: new Set(),
      autoAcceptFrom: 0.9,
      generateIdentifiers: false,
      existingKeys: new Map(),
      decisions,
    } as never);
  }

  it("never reports rows held by zero values", () => {
    const rowsOut = prepared();
    const plan = buildImportPlan(rowsOut, assets);
    expect(plan.awaitingRequiredValue).toBe(0);
    expect(plan.awaitingOptionalDecision).toBe(1);
    const gate = commitReadiness(profileRows(rowsOut, [], { domain: assets }), plan);
    expect(gate.reasons.join(" ")).not.toMatch(/held by 0/);
  });

  it("lets an explicit leave-unassigned decision settle the row", () => {
    const rowsOut = prepared({ "department::qqqq zzz": "" });
    const plan = buildImportPlan(rowsOut, assets);
    expect(plan.awaitingOptionalDecision).toBe(0);
    expect(plan.readyNow + plan.readyWithBlanks).toBe(1);
    expect(commitReadiness(profileRows(rowsOut, [], { domain: assets }), plan).ready).toBe(true);
  });

  it("keeps every source row accounted for exactly once", () => {
    const plan = buildImportPlan(prepared(), assets);
    expect(plan.reconciled).toBe(true);
    expect(plan.buckets.reduce((n, b) => n + b.count, 0)).toBe(plan.total);
  });
});
