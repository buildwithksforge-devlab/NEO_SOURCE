import { describe, expect, it } from "vitest";
import { domainByKey } from "@/lib/onboarding/domains";
import { buildImportPlan, prepareRows, profileRows, proposeColumnMapping } from "@/lib/onboarding/engine";

const assets = domainByKey("assets")!;

const headers = ["Equipment Description", "Acquisition Value", "Dept", "Tag No", "Serial"];
const rows = [
  { "Equipment Description": " upright fridge ", "Acquisition Value": "", Dept: "F&B", "Tag No": "AST-1", Serial: "SN1" },
  { "Equipment Description": "", "Acquisition Value": "1,200", Dept: "Housekeping", "Tag No": "", Serial: "" },
];

describe("onboarding engine", () => {
  it("proposes mappings from legacy column names", () => {
    const proposals = proposeColumnMapping(assets, headers, rows);
    const byColumn = Object.fromEntries(proposals.map((p) => [p.column, p.fieldKey]));
    expect(byColumn["Equipment Description"]).toBe("name");
    expect(byColumn["Dept"]).toBe("department");
    expect(byColumn["Tag No"]).toBe("asset_tag");
  });

  it("blocks rows without a required value and never invents one", () => {
    const mapping = Object.fromEntries(
      proposeColumnMapping(assets, headers, rows).map((p) => [p.column, p.fieldKey ?? ""]),
    );
    const prepared = prepareRows(assets, mapping, rows, {
      transforms: new Set(["trim_whitespace", "standardise_dates", "strip_currency", "title_case_names"] as const),
      masters: { department: [{ id: "d1", label: "Food & Beverage" }, { id: "d2", label: "Housekeeping" }] },
      ignoredFields: new Set(),
      autoAcceptFrom: 0.9,
      generateIdentifiers: false,
      existingKeys: new Map(),
      decisions: {},
    });

    expect(prepared[0]!.severity).not.toBe("blocker");
    expect(prepared[1]!.severity).toBe("blocker");
    expect(prepared[1]!.values["name"] ?? "").toBe("");
    expect(prepared[0]!.values["purchase_cost"] ?? "").toBe("");

    const plan = buildImportPlan(prepared);
    expect(plan.skipBlocked).toBe(1);
    expect(plan.create).toBe(1);

    const profile = profileRows(prepared, proposeColumnMapping(assets, headers, rows));
    expect(profile.total).toBe(2);
    expect(profile.blockers).toBe(1);
  });
});
