/**
 * Onboarding field alignment.
 *
 * Every supported import domain must line up with the record it actually
 * creates: each declared field is written somewhere (or is explicitly
 * resolve-only), each write rule comes from a declared field, every
 * relationship is declared on the domain and can be resolved against a real
 * master, and duplicate protection reads columns the adapter writes.
 *
 * This is the guard that stops one domain (inventory) being carefully aligned
 * while the others quietly drop values.
 */
import { describe, expect, it } from "vitest";

import { adapterFor } from "@/lib/onboarding/adapters";
import { RESOLVABLE_MASTER_TARGETS } from "@/lib/onboarding/data";
import { ONBOARDING_DOMAINS } from "@/lib/onboarding/domains";

const supported = ONBOARDING_DOMAINS.filter((d) => d.supported);

describe("onboarding domain ↔ destination alignment", () => {
  it("every supported domain has a destination adapter", () => {
    for (const domain of supported) {
      expect(adapterFor(domain.key), `${domain.key} has no adapter`).toBeTruthy();
    }
  });

  it("every declared field is written, unless it is resolve-only", () => {
    for (const domain of supported) {
      const adapter = adapterFor(domain.key)!;
      const written = new Set(adapter.write.map((w) => w.from));
      const dropped = domain.fields
        .filter((f) => !f.resolveOnly && !written.has(f.key))
        .map((f) => f.key);
      expect(dropped, `${domain.key} declares fields it never stores`).toEqual([]);
    }
  });

  it("every write rule reads a declared field", () => {
    for (const domain of supported) {
      const adapter = adapterFor(domain.key)!;
      const keys = new Set(domain.fields.map((f) => f.key));
      const orphans = adapter.write.filter((w) => !keys.has(w.from)).map((w) => w.from);
      expect(orphans, `${domain.key} writes from fields nobody can map`).toEqual([]);
    }
  });

  it("required fields are never resolve-only", () => {
    for (const domain of supported) {
      const bad = domain.fields.filter((f) => f.resolveOnly && f.requirement === "required").map((f) => f.key);
      expect(bad, `${domain.key} requires a value it cannot store`).toEqual([]);
    }
  });

  it("relationship fields are declared on the domain and resolvable", () => {
    for (const domain of supported) {
      const links = new Set(domain.linksTo);
      for (const field of domain.fields) {
        if (!field.relationship) continue;
        expect(links.has(field.relationship), `${domain.key}.${field.key} links to an undeclared master`).toBe(true);
        expect(
          RESOLVABLE_MASTER_TARGETS.includes(field.relationship),
          `${domain.key}.${field.key} resolves against a master nothing loads`,
        ).toBe(true);
      }
    }
  });

  it("relationship fields write a foreign key, not text", () => {
    for (const domain of supported) {
      const adapter = adapterFor(domain.key)!;
      for (const field of domain.fields) {
        if (!field.relationship || field.resolveOnly) continue;
        const rule = adapter.write.find((w) => w.from === field.key);
        expect(rule?.kind, `${domain.key}.${field.key} should resolve into a reference`).toBe("relation");
      }
    }
  });

  it("duplicate protection reads columns the adapter actually writes", () => {
    for (const domain of supported) {
      const adapter = adapterFor(domain.key)!;
      const columns = new Set(adapter.write.map((w) => w.column));
      const unknown = adapter.identityColumns.filter((c) => !columns.has(c));
      expect(unknown, `${domain.key} checks duplicates on columns it never writes`).toEqual([]);

      const keys = new Set(domain.fields.map((f) => f.key));
      for (const rule of domain.duplicateKeys.flat()) {
        expect(keys.has(rule), `${domain.key} duplicate key "${rule}" is not a field`).toBe(true);
      }
    }
  });

  it("a generated identifier maps to a field the hotel can also supply", () => {
    for (const domain of supported) {
      const adapter = adapterFor(domain.key)!;
      if (!adapter.generated) continue;
      const field = domain.fields.find((f) => f.key === adapter.generated!.field);
      expect(field, `${domain.key} generates an identifier with no field`).toBeTruthy();
      expect(field!.generatable, `${domain.key}.${field!.key} must be marked generatable`).toBe(true);
    }
  });
});
