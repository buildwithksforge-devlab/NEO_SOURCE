/**
 * Onboarding adapter family contract.
 *
 * Generic on purpose: no hotel, workbook or column of any real property
 * appears here. The assertions are about the architecture — every supported
 * domain declares a destination, every declared relationship has a match
 * policy, dependencies are real and ordered, and identifier generation is
 * always opt-in and policy driven.
 */
import { describe, expect, it } from "vitest";
import {
  ONBOARDING_DOMAINS,
  ONBOARDING_STAGES,
  blankTemplateCsv,
  domainsByStage,
  exampleCsv,
  prerequisiteDomains,
  requiredFields,
  stageOf,
} from "@/lib/onboarding/domains";
import { adapterFor, allAdapters, buildPayload, columnForField } from "@/lib/onboarding/adapters";
import { matchPolicy } from "@/lib/onboarding/matching";

const STAGE_ORDER = ONBOARDING_STAGES.map((s) => s.key);

describe("the onboarding family", () => {
  it("covers every stage of a hotel's onboarding sequence", () => {
    expect(domainsByStage().map((g) => g.stage.key)).toEqual(STAGE_ORDER);
  });

  it("gives every domain a unique key, a capability and a field guide or an honest 'not yet'", () => {
    const keys = ONBOARDING_DOMAINS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const domain of ONBOARDING_DOMAINS) {
      expect(domain.capability.module).toBeTruthy();
      expect(domain.capability.action).toBeTruthy();
      if (domain.supported) expect(domain.fields.length).toBeGreaterThan(0);
    }
  });

  it("declares a destination for every domain it claims to support, and none for the rest", () => {
    for (const domain of ONBOARDING_DOMAINS) {
      expect(Boolean(adapterFor(domain.key))).toBe(domain.supported);
    }
    for (const adapter of allAdapters()) {
      expect(ONBOARDING_DOMAINS.some((d) => d.key === adapter.key)).toBe(true);
    }
  });

  it("can write every required field of a supported domain", () => {
    for (const domain of ONBOARDING_DOMAINS.filter((d) => d.supported)) {
      const adapter = adapterFor(domain.key)!;
      for (const field of requiredFields(domain)) {
        expect(adapter.write.some((w) => w.from === field.key)).toBe(true);
      }
    }
  });

  it("resolves every declared relationship into a foreign key, never into text", () => {
    for (const domain of ONBOARDING_DOMAINS.filter((d) => d.supported)) {
      const adapter = adapterFor(domain.key)!;
      for (const field of domain.fields.filter((f) => f.relationship && !f.resolveOnly)) {
        const rule = adapter.write.find((w) => w.from === field.key);
        expect(rule?.kind, `${domain.key}.${field.key} must resolve through its canonical relationship`).toBe("relation");
        expect(matchPolicy(field.relationship!).label).toBeTruthy();
      }
    }
  });

  it("reads back the columns its duplicate rules depend on", () => {
    for (const domain of ONBOARDING_DOMAINS.filter((d) => d.supported)) {
      const adapter = adapterFor(domain.key)!;
      for (const fields of domain.duplicateKeys) {
        for (const field of fields) {
          expect(adapter.identityColumns).toContain(columnForField(adapter, field));
        }
      }
    }
  });

  it("only generates an identifier where a policy says it may", () => {
    for (const domain of ONBOARDING_DOMAINS.filter((d) => d.supported)) {
      const adapter = adapterFor(domain.key)!;
      const generatable = domain.fields.filter((f) => f.generatable).map((f) => f.key);
      if (adapter.generated) {
        expect(generatable).toContain(adapter.generated.field);
        expect(domain.identifierPolicies?.[adapter.generated.field]?.prefix).toBeTruthy();
      } else {
        expect(generatable).toHaveLength(0);
      }
    }
  });

  it("orders dependencies so a prerequisite is never imported after the domain that needs it", () => {
    for (const domain of ONBOARDING_DOMAINS) {
      for (const dep of prerequisiteDomains(domain)) {
        expect(STAGE_ORDER.indexOf(stageOf(dep))).toBeLessThanOrEqual(STAGE_ORDER.indexOf(stageOf(domain)));
      }
      for (const key of domain.dependsOn ?? []) {
        expect(ONBOARDING_DOMAINS.some((d) => d.key === key)).toBe(true);
      }
    }
  });

  it("produces a template and an example for every documented domain", () => {
    for (const domain of ONBOARDING_DOMAINS.filter((d) => d.fields.length > 0)) {
      const headers = blankTemplateCsv(domain).trim().split(",");
      expect(headers).toEqual(domain.fields.map((f) => f.key));
      expect(exampleCsv(domain).split("\n")[0]).toBe(headers.join(","));
    }
  });
});

describe("payload building", () => {
  const adapter = adapterFor("suppliers")!;

  it("leaves a value the hotel did not supply empty", () => {
    const payload = buildPayload(adapter, { name: "Example" }, {});
    expect(payload["name"]).toBe("Example");
    expect(payload["email"]).toBeNull();
    expect(payload["credit_terms_days"]).toBeNull();
  });

  it("writes a resolved relationship as an identifier, not as the original text", () => {
    const items = adapterFor("stock_items")!;
    const payload = buildPayload(items, { name: "Example", category: "Whatever the file said" }, { category: "cat-1" });
    expect(payload["category_id"]).toBe("cat-1");
    expect(Object.values(payload)).not.toContain("Whatever the file said");
  });

  it("issues a generated identifier only when one is handed to it", () => {
    const employees = adapterFor("employees")!;
    expect(buildPayload(employees, { full_name: "Example" }, {})["employee_number"]).toBeNull();
    expect(buildPayload(employees, { full_name: "Example" }, {}, "EMP-00007")["employee_number"]).toBe("EMP-00007");
  });
});
