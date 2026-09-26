/**
 * Generic onboarding intelligence contract.
 *
 * Nothing here encodes a hotel's workbook: the fixtures are synthetic and the
 * assertions are about behaviour — thresholds per relationship, refusal to
 * offer noise, refusal to invent, explainable duplicates, contextual clean-up
 * and a commit gate that holds while decisions are open.
 */
import { describe, expect, it } from "vitest";
import { domainByKey } from "@/lib/onboarding/domains";
import { matchPolicy } from "@/lib/onboarding/matching";
import {
  buildImportPlan,
  commitReadiness,
  identifierPreview,
  prepareRows,
  profileRows,
  proposeColumnMapping,
  relevantTransforms,
  resolveValue,
  semanticProfile,
  suspectIdentifierFields,
} from "@/lib/onboarding/engine";

const assets = domainByKey("assets")!;
const allTransforms = new Set(["trim_whitespace", "standardise_dates", "strip_currency", "title_case_names"] as const);

const masters = {
  department: [
    { id: "d1", label: "Food & Beverage", aliases: ["FNB"] },
    { id: "d2", label: "Housekeeping" },
  ],
};

function prepare(rows: Record<string, string>[], headers: string[], overrides: Record<string, unknown> = {}) {
  const mapping = Object.fromEntries(
    proposeColumnMapping(assets, headers, rows).map((p) => [p.column, p.fieldKey ?? ""]),
  );
  return prepareRows(assets, mapping, rows, {
    transforms: allTransforms as never,
    masters,
    ignoredFields: new Set(),
    autoAcceptFrom: 0.9,
    generateIdentifiers: false,
    existingKeys: new Map(),
    decisions: {},
    ...overrides,
  } as never);
}

describe("relationship matching policy", () => {
  it("uses a stricter floor for people than for classification", () => {
    expect(matchPolicy("employee").floor).toBeGreaterThan(matchPolicy("asset_category").floor);
    expect(matchPolicy("employee").inlineCreate).toBe(false);
  });

  it("treats an exact identifier as decisive evidence", () => {
    const result = resolveValue("department", "FNB", masters.department);
    expect(result.state).toBe("resolved");
    expect(result.evidence).toBe("identifier");
    expect(result.matchId).toBe("d1");
  });

  it("offers no candidate at all when nothing is credible", () => {
    const result = resolveValue("department", "Zx9 Qqq", masters.department);
    expect(result.state).toBe("unmatched");
    expect(result.credible).toBe(false);
    expect(result.alternatives).toHaveLength(0);
    expect(result.reason).toMatch(/no credible/i);
  });

  it("refuses to choose between two equally close records", () => {
    const result = resolveValue("department", "House", [
      { id: "a", label: "House Keeping" },
      { id: "b", label: "House Laundry" },
    ]);
    expect(["ambiguous", "unmatched"]).toContain(result.state);
    expect(result.matchId).toBeNull();
  });
});

describe("semantic profiling", () => {
  it("flags an identifier column whose values are sequence numbers", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ Name: `Item ${i}`, "Serial No": String(i + 1) }));
    const mapping = { Name: "name", "Serial No": "serial_number" };
    const warnings = semanticProfile(assets, mapping, rows);
    expect(warnings.some((w) => w.kind === "sequence_like_identifier")).toBe(true);
    expect(suspectIdentifierFields(warnings).has("serial_number")).toBe(true);
  });

  it("stays silent when the values look like genuine identifiers", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ Name: `Item ${i}`, "Serial No": `SN-99${i}A` }));
    const warnings = semanticProfile(assets, { Name: "name", "Serial No": "serial_number" }, rows);
    expect(warnings.some((w) => w.kind === "sequence_like_identifier")).toBe(false);
  });
});

describe("duplicates", () => {
  const headers = ["Asset Name", "Tag No", "Location"];

  it("classifies a shared tag as certain and explains it", () => {
    const rows = [
      { "Asset Name": "Fridge", "Tag No": "T-1", Location: "Kitchen" },
      { "Asset Name": "Fridge", "Tag No": "T-1", Location: "Kitchen" },
    ];
    const prepared = prepare(rows, headers);
    expect(prepared[1]!.duplicate?.classification).toBe("exact");
    expect(prepared[1]!.duplicate?.explain).toMatch(/asset tag/i);
    expect(prepared[1]!.action).toBe("skip");
  });

  it("never silently skips a merely possible duplicate", () => {
    const rows = [
      { "Asset Name": "Plate", "Tag No": "", Location: "Restaurant" },
      { "Asset Name": "Plate", "Tag No": "", Location: "Restaurant" },
    ];
    const prepared = prepare(rows, headers);
    const second = prepared[1]!;
    if (second.duplicate) {
      expect(second.duplicate.classification).not.toBe("exact");
      expect(second.action).not.toBe("skip");
    }
  });

  it("honours a row decision to import duplicates separately", () => {
    const rows = [
      { "Asset Name": "Fridge", "Tag No": "T-1", Location: "Kitchen" },
      { "Asset Name": "Fridge", "Tag No": "T-1", Location: "Kitchen" },
    ];
    const prepared = prepare(rows, headers, { rowDecisions: { 2: "import" } });
    expect(prepared[1]!.action).toBe("create");
  });
});

describe("clean-up, plan and commit gate", () => {
  it("only offers clean-up that can act on the mapped fields", () => {
    const keys = relevantTransforms(assets, { A: "name", B: "purchase_date" }).map((t) => t.key);
    expect(keys).toContain("standardise_dates");
    expect(keys).not.toContain("normalise_phones");
  });

  it("previews generated identifiers without issuing them", () => {
    const prepared = prepare(
      [{ "Asset Name": "Fridge", Dept: "F&B" }],
      ["Asset Name", "Dept"],
      { generateIdentifiers: true },
    );
    const preview = identifierPreview(assets, prepared, 40);
    const tag = preview.find((p) => p.fieldKey === "asset_tag");
    expect(tag?.firstSample).toBe("AST-00041");
    expect(prepared[0]!.values["asset_tag"] ?? "").toBe("");
  });

  it("holds the commit gate while a value is undecided", () => {
    const prepared = prepare([{ "Asset Name": "Fridge", Dept: "Qqqq Zzz" }], ["Asset Name", "Dept"]);
    const profile = profileRows(prepared, [], { domain: assets });
    const gate = commitReadiness(profile, buildImportPlan(prepared));
    expect(profile.decisionGroups.length).toBeGreaterThan(0);
    expect(profile.decisionGroups[0]!.rowNumbers).toEqual([1]);
    expect(gate.ready).toBe(false);
  });
});
