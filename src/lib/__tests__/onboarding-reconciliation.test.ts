/**
 * Import Plan reconciliation contract.
 *
 * The plan is a safety gate, not a summary: every source row lands in exactly
 * one bucket, every issue analysis raised states its handling, and identifiers
 * are never issued without an explicit choice. Fixtures are synthetic — nothing
 * here encodes any hotel's workbook.
 */
import { describe, expect, it } from "vitest";
import { domainByKey } from "@/lib/onboarding/domains";
import {
  buildImportPlan,
  commitReadiness,
  identifierPreview,
  prepareRows,
  profileRows,
  proposeColumnMapping,
  type IdentifierChoice,
} from "@/lib/onboarding/engine";

const assets = domainByKey("assets")!;
const allTransforms = new Set(["trim_whitespace", "standardise_dates", "strip_currency", "title_case_names"] as const);

const masters = {
  department: [
    { id: "d1", label: "Food & Beverage" },
    { id: "d2", label: "Housekeeping" },
  ],
};

const headers = ["Asset Name", "Asset Tag", "Department", "Purchase Date", "Condition", "Status"];

const rows: Record<string, string>[] = [
  { "Asset Name": "Chest Freezer", "Asset Tag": "", Department: "Housekeeping", "Purchase Date": "not known", Condition: "damaged", Status: "inactive" },
  { "Asset Name": "Ice Machine", "Asset Tag": "", Department: "Food & Beverage", "Purchase Date": "2024-02-01", Condition: "", Status: "" },
  { "Asset Name": "Trolley", "Asset Tag": "", Department: "Somewhere Unknown", "Purchase Date": "", Condition: "", Status: "" },
];

function prepare(identifierChoice: IdentifierChoice) {
  const mapping = Object.fromEntries(
    proposeColumnMapping(assets, headers, rows).map((p) => [p.column, p.fieldKey ?? ""]),
  );
  return prepareRows(assets, mapping, rows, {
    transforms: allTransforms as never,
    masters,
    ignoredFields: new Set(),
    autoAcceptFrom: 0.9,
    generateIdentifiers: false,
    identifierChoice,
    existingKeys: new Map(),
    decisions: {},
  } as never);
}

describe("import plan reconciliation", () => {
  it("accounts for every source row in exactly one bucket", () => {
    for (const choice of ["undecided", "generate", "blank", "external"] as IdentifierChoice[]) {
      const plan = buildImportPlan(prepare(choice), assets);
      expect(plan.total).toBe(rows.length);
      expect(plan.accountedFor).toBe(rows.length);
      expect(plan.reconciled).toBe(true);
      expect(plan.buckets.reduce((n, b) => n + b.count, 0)).toBe(rows.length);
    }
  });

  it("holds every row until the hotel says how identifiers are supplied", () => {
    const plan = buildImportPlan(prepare("undecided"), assets);
    // Every row is held: by the identifier choice, or by an earlier open value.
    expect(plan.awaitingIdentifierDecision + plan.awaitingValueDecision).toBe(rows.length);
    expect(plan.awaitingIdentifierDecision).toBeGreaterThan(0);
    expect(plan.readyNow + plan.readyWithBlanks).toBe(0);
    expect(plan.generatedIdentifiers).toBe(0);

    const chosen = buildImportPlan(prepare("generate"), assets);
    expect(chosen.awaitingIdentifierDecision).toBe(0);
    expect(chosen.generatedIdentifiers).toBe(rows.length);
  });

  it("blocks the write while an identifier choice is open", () => {
    const prepared = prepare("undecided");
    const gate = commitReadiness(profileRows(prepared, [], { domain: assets }), buildImportPlan(prepared, assets));
    expect(gate.ready).toBe(false);
    expect(gate.reasons.join(" ")).toMatch(/identifier/i);
    expect(gate.reasons.join(" ")).not.toMatch(/unassigned or blocked/i);
  });

  it("carries every flagged field into the plan with a stated handling", () => {
    const plan = buildImportPlan(prepare("generate"), assets);
    expect(plan.fieldOutcomes.length).toBeGreaterThan(0);
    for (const outcome of plan.fieldOutcomes) {
      expect(outcome.handling.trim().length).toBeGreaterThan(0);
      expect(outcome.rows).toBeGreaterThan(0);
    }
  });

  it("separates links that may remain unassigned from those that must be resolved", () => {
    const plan = buildImportPlan(prepare("generate"), assets);
    expect(plan.mayRemainUnassigned + plan.requiresResolution).toBe(plan.relationshipOutcomes.length);
  });

  it("marks default numbering as unconfigured rather than assuming a hotel policy", () => {
    const previews = identifierPreview(assets, prepare("undecided"));
    for (const preview of previews) expect(preview.source).toBe("unconfigured");

    const configured = identifierPreview(assets, prepare("undecided"), 0, {
      [previews[0]!.fieldKey]: { prefix: "ZZ-", padding: 4 },
    });
    expect(configured[0]!.source).toBe("configured");
    expect(configured[0]!.pattern).toBe("ZZ-0000");
  });
});
