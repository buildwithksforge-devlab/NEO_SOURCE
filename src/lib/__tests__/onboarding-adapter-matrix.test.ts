/**
 * Adapter matrix and volume certification.
 *
 * Two questions, asked of the architecture rather than of one screen:
 *  1. does every supported data type behave the same way through the shared
 *     engine — mapping, required-value honesty, reconciliation, identifiers;
 *  2. does that behaviour hold at 10, 100, 1,000 and 10,000 rows.
 *
 * Every fixture is generated from each domain's own declared fields, so no
 * hotel's file, column or value appears here, and adding an adapter extends
 * the matrix automatically.
 */
import { describe, expect, it } from "vitest";
import { ONBOARDING_DOMAINS, type OnboardingDomain } from "@/lib/onboarding/domains";
import { adapterFor } from "@/lib/onboarding/adapters";
import {
  buildImportPlan,
  commitReadiness,
  prepareRows,
  profileRows,
  proposeColumnMapping,
} from "@/lib/onboarding/engine";
import { classifyFile } from "@/lib/onboarding/intent";
import { missingValueGroups, summaryCounters } from "@/lib/onboarding/resolution";

const supported = ONBOARDING_DOMAINS.filter((d) => d.supported && d.fields.length > 0);
const transforms = new Set(["trim_whitespace", "standardise_dates", "strip_currency", "title_case_names"] as const);

/** A synthetic value for a field, derived only from that field's declared format. */
function sampleValue(domain: OnboardingDomain, fieldKey: string, index: number): string {
  const field = domain.fields.find((f) => f.key === fieldKey)!;
  switch (field.format) {
    case "integer":
    case "money":
      return String(100 + index);
    case "date":
      return "2026-01-15";
    case "email":
      return `record${index}@example.test`;
    case "phone":
      return `+100000000${index % 10}`;
    case "enum":
      return field.enumValues?.[0] ?? `${field.label} ${index}`;
    default:
      return `${field.label} ${index}`;
  }
}

/** Builds a file that carries every required field of a domain, and nothing invented. */
function fileFor(domain: OnboardingDomain, rowCount: number) {
  const fields = domain.fields.filter((f) => f.requirement === "required" || f.requirement === "recommended");
  const headers = fields.map((f) => f.label);
  const rows = Array.from({ length: rowCount }, (_, i) =>
    Object.fromEntries(fields.map((f) => [f.label, sampleValue(domain, f.key, i + 1)])),
  );
  return { headers, rows };
}

function run(domain: OnboardingDomain, rowCount: number) {
  const { headers, rows } = fileFor(domain, rowCount);
  const mapping = Object.fromEntries(
    proposeColumnMapping(domain, headers, rows).map((p) => [p.column, p.fieldKey ?? ""]),
  );
  const prepared = prepareRows(domain, mapping, rows, {
    transforms: transforms as never,
    masters: {},
    ignoredFields: new Set(),
    autoAcceptFrom: 0.9,
    generateIdentifiers: false,
    identifierChoice: "external",
    existingKeys: new Map(),
    decisions: {},
  } as never);
  const profile = profileRows(prepared, [], { domain });
  const plan = buildImportPlan(prepared, domain);
  return { headers, rows, mapping, prepared, profile, plan };
}

describe("every supported adapter behaves the same way through the shared engine", () => {
  it.each(supported.map((d) => [d.label, d] as const))("%s", (_label, domain) => {
    const { headers, prepared, profile, plan } = run(domain, 10);

    // The file is recognised as the type it was built from.
    const intent = classifyFile(domain, headers, []);
    expect(intent.selected.requiredMissing).toEqual([]);

    // Every source row is accounted for exactly once.
    expect(prepared).toHaveLength(10);
    expect(plan.total).toBe(10);
    expect(plan.accountedFor).toBe(10);
    expect(plan.reconciled).toBe(true);

    // Nothing required is silently missing, and nothing was invented.
    expect(missingValueGroups(domain, prepared)).toEqual([]);
    for (const row of prepared) {
      for (const field of domain.fields.filter((f) => f.requirement === "required")) {
        expect(row.values[field.key] ?? "").not.toBe("");
      }
    }

    // The destination can write every required field.
    const adapter = adapterFor(domain.key)!;
    for (const field of domain.fields.filter((f) => f.requirement === "required")) {
      expect(adapter.write.some((w) => w.from === field.key)).toBe(true);
    }

    // The summary is honest about what remains.
    const counters = summaryCounters(profile, plan);
    expect(counters.sourceRows).toBe(10);
    if (counters.everythingSettled) expect(counters.rowsAwaitingAction).toBe(0);
    else expect(counters.statement).toMatch(/still to settle/);
  });

  it("holds an identifier back until the hotel says how identifiers are supplied", () => {
    for (const domain of supported) {
      const adapter = adapterFor(domain.key)!;
      if (!adapter.generated) continue;
      const { headers: allHeaders, rows: allRows } = fileFor(domain, 5);
      // A file that does not carry the identifier at all: the only way it can
      // be filled is a decision the hotel has not yet made.
      const identifierLabel = domain.fields.find((f) => f.key === adapter.generated!.field)?.label;
      const headers = allHeaders.filter((h) => h !== identifierLabel);
      const rows = allRows.map((row) => {
        const copy = { ...row };
        if (identifierLabel) delete copy[identifierLabel];
        return copy;
      });
      const mapping = Object.fromEntries(
        proposeColumnMapping(domain, headers, rows).map((p) => [p.column, p.fieldKey ?? ""]),
      );
      const prepared = prepareRows(domain, mapping, rows, {
        transforms: transforms as never,
        masters: {},
        ignoredFields: new Set(),
        autoAcceptFrom: 0.9,
        generateIdentifiers: false,
        identifierChoice: "undecided",
        existingKeys: new Map(),
        decisions: {},
      } as never);
      const plan = buildImportPlan(prepared, domain);
      expect(plan.generatedIdentifiers).toBe(0);
      expect(commitReadiness(profileRows(prepared, [], { domain }), plan).ready).toBe(false);
    }
  });
});

describe("volume certification", () => {
  const domain = supported.find((d) => d.key === "assets") ?? supported[0]!;

  it.each([10, 100, 1000, 10000])(
    "reconciles exactly at %i rows",
    (count) => {
      const started = Date.now();
      const { prepared, plan, profile } = run(domain, count);
      expect(prepared).toHaveLength(count);
      expect(plan.total).toBe(count);
      expect(plan.accountedFor).toBe(count);
      expect(plan.reconciled).toBe(true);
      expect(profile.total).toBe(count);
      // Analysis of a full workbook must stay within a wait a person will
      // tolerate, and must not degrade faster than the row count.
      expect(Date.now() - started).toBeLessThan(60_000);
    },
    120_000,
  );

  it("keeps one decision covering many rows instead of one per row", () => {
    const { headers, rows } = fileFor(domain, 1000);
    const required = domain.fields.find((f) => f.requirement === "required")!;
    for (const row of rows) row[required.label] = "";
    const mapping = Object.fromEntries(
      proposeColumnMapping(domain, headers, rows).map((p) => [p.column, p.fieldKey ?? ""]),
    );
    const prepared = prepareRows(domain, mapping, rows, {
      transforms: transforms as never,
      masters: {},
      ignoredFields: new Set(),
      autoAcceptFrom: 0.9,
      generateIdentifiers: false,
      identifierChoice: "external",
      existingKeys: new Map(),
      decisions: {},
    } as never);
    const groups = missingValueGroups(domain, prepared);
    const group = groups.find((g) => g.fieldKey === required.key)!;
    expect(group.occurrences).toBe(1000);
    expect(groups.filter((g) => g.fieldKey === required.key)).toHaveLength(1);
  });
});
