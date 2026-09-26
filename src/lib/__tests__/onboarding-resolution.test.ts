/**
 * Universal resolution contract.
 *
 * Detection alone is not a product: every finding must carry its class and
 * the remedies that are safe for it, a supplied value must actually settle the
 * rows it was supplied for, and the summary must never read as "done" while
 * anything is outstanding.
 */
import { describe, expect, it } from "vitest";
import { domainByKey } from "@/lib/onboarding/domains";
import {
  buildImportPlan,
  prepareRows,
  profileRows,
  proposeColumnMapping,
  type ValueFill,
} from "@/lib/onboarding/engine";
import {
  RESOLUTION_CLASS_META,
  classifyDecisionGroup,
  missingValueGroups,
  summaryCounters,
} from "@/lib/onboarding/resolution";

const assets = domainByKey("assets")!;
const transforms = new Set(["trim_whitespace", "standardise_dates", "strip_currency", "title_case_names"] as const);
const masters = {
  department: [
    { id: "d1", label: "Food & Beverage" },
    { id: "d2", label: "Housekeeping" },
  ],
};

const headers = ["Asset Name", "Asset Tag", "Department"];
const rows = [
  { "Asset Name": "Chest Freezer", "Asset Tag": "A-1", Department: "Housekeeping" },
  { "Asset Name": "", "Asset Tag": "A-2", Department: "Food & Beverage" },
  { "Asset Name": "", "Asset Tag": "A-3", Department: "" },
];

function prepare(valueFills?: ValueFill[]) {
  const mapping = Object.fromEntries(
    proposeColumnMapping(assets, headers, rows).map((p) => [p.column, p.fieldKey ?? ""]),
  );
  return prepareRows(assets, mapping, rows, {
    transforms: transforms as never,
    masters,
    ignoredFields: new Set(),
    autoAcceptFrom: 0.9,
    generateIdentifiers: false,
    identifierChoice: "external",
    existingKeys: new Map(),
    decisions: {},
    ...(valueFills ? { valueFills } : {}),
  } as never);
}

describe("resolution classes", () => {
  it("names and explains every class it can raise", () => {
    for (const meta of Object.values(RESOLUTION_CLASS_META)) {
      expect(meta.label.trim()).toBeTruthy();
      expect(meta.explain.trim()).toBeTruthy();
    }
  });

  it("gives every unresolved reference a class and at least one remedy", () => {
    const profile = profileRows(prepare(), [], { domain: assets });
    for (const group of profile.decisionGroups) {
      const classified = classifyDecisionGroup(group);
      expect(RESOLUTION_CLASS_META[classified.resolutionClass]).toBeTruthy();
      if (group.state !== "resolved") expect(classified.remedies.length).toBeGreaterThan(0);
    }
  });
});

describe("missing required values", () => {
  it("groups every row blocked by the same empty field, with a way out", () => {
    const groups = missingValueGroups(assets, prepare(), {
      masters,
      availableColumns: headers,
      mappedColumns: ["Asset Name", "Asset Tag", "Department"],
    });
    const name = groups.find((g) => g.fieldKey === "name");
    expect(name).toBeTruthy();
    expect(name!.occurrences).toBe(2);
    expect(name!.rowNumbers).toEqual([2, 3]);
    expect(name!.remedies.map((r) => r.kind)).toContain("enter_value");
    expect(name!.remedies.map((r) => r.kind)).toContain("apply_to_group");
  });

  it("settles exactly the rows a supplied value was given for, and invents nothing", () => {
    const filled = prepare([{ field: "name", rows: [2], value: "Upright Fridge" }]);
    expect(filled[1]!.values["name"]).toBe("Upright Fridge");
    expect(filled[2]!.values["name"] ?? "").toBe("");
    expect(filled[0]!.values["name"]).toBe("Chest Freezer");
    const groups = missingValueGroups(assets, filled, { masters });
    expect(groups.find((g) => g.fieldKey === "name")!.occurrences).toBe(1);
  });

  it("never overwrites a value the hotel actually recorded", () => {
    const filled = prepare([{ field: "name", rows: "all", value: "Placeholder" }]);
    expect(filled[0]!.values["name"]).toBe("Chest Freezer");
    expect(filled[1]!.values["name"]).toBe("Placeholder");
  });

  it("can take the value from another column of the same file", () => {
    const filled = prepare([{ field: "name", rows: "all", fromColumn: "Asset Tag" }]);
    expect(filled[1]!.values["name"]).toBe("A-2");
    expect(filled[1]!.issues.some((i) => i.handling?.includes("Asset Tag"))).toBe(true);
  });
});

describe("summary honesty", () => {
  it("never reports nothing outstanding while rows are still blocked", () => {
    const prepared = prepare();
    const counters = summaryCounters(profileRows(prepared, [], { domain: assets }), buildImportPlan(prepared, assets));
    expect(counters.blockedRows).toBeGreaterThan(0);
    expect(counters.everythingSettled).toBe(false);
    expect(counters.statement).toMatch(/still to settle/);
  });

  it("separates unresolved references, duplicate candidates and blocked rows", () => {
    const prepared = prepare();
    const counters = summaryCounters(profileRows(prepared, [], { domain: assets }), buildImportPlan(prepared, assets));
    expect(counters.sourceRows).toBe(rows.length);
    expect(counters).toHaveProperty("unresolvedReferenceValues");
    expect(counters).toHaveProperty("duplicateCandidates");
    expect(counters).toHaveProperty("undecidedDuplicates");
  });
});
