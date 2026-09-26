/**
 * NEØ Intelligent Data Onboarding — semantic column profiling.
 *
 * A heading match is a linguistic opinion; it says nothing about the values
 * underneath it. "Serial No" is a perfectly good name for a column that in
 * fact holds 1, 2, 3 — a spreadsheet row counter, not a manufacturer serial.
 *
 * This module looks at the values after mapping and asks one question per
 * mapped field: do these values behave like the kind of information the
 * canonical field expects? It never reinterprets a mapping — it raises a
 * warning and leaves the decision with the administrator.
 *
 * Domain agnostic: everything is driven by the field's declared format and by
 * generic identifier vocabulary, never by any particular hotel's workbook.
 */
import type { DomainField, OnboardingDomain } from "./domains";
import { cleanCell, parseDateValue, parseNumberValue } from "./engine-primitives";

export type SemanticWarning = {
  column: string;
  fieldKey: string;
  fieldLabel: string;
  kind:
    | "sequence_like_identifier"
    | "mixed_date_formats"
    | "implausible_date"
    | "non_numeric_money"
    | "negative_money"
    | "invalid_quantity"
    | "malformed_email"
    | "malformed_phone"
    | "unknown_enum";
  message: string;
  affected: number;
};

/** Fields whose value is supposed to be a real-world identifier, not a counter. */
function isIdentifierField(field: DomainField): boolean {
  return /serial|tag|code|sku|barcode|registration|imei|licence|license/i.test(`${field.key} ${field.label}`);
}

function looksSequential(values: string[]): boolean {
  const numbers = values.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n >= 0 && n < 100000);
  if (numbers.length < Math.max(5, values.length * 0.6)) return false;
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  if (sorted.length < 5) return false;
  let consecutive = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i]! - sorted[i - 1]! === 1) consecutive += 1;
  return consecutive / (sorted.length - 1) >= 0.7;
}

export function semanticProfile(
  domain: OnboardingDomain,
  mapping: Record<string, string>,
  rows: Record<string, string>[],
): SemanticWarning[] {
  const byKey = new Map(domain.fields.map((f) => [f.key, f] as const));
  const warnings: SemanticWarning[] = [];
  const sample = rows.slice(0, 5000);

  for (const [column, fieldKey] of Object.entries(mapping)) {
    const field = fieldKey ? byKey.get(fieldKey) : undefined;
    if (!field) continue;
    const values = sample.map((r) => cleanCell(r[column])).filter(Boolean);
    if (values.length === 0) continue;
    const push = (kind: SemanticWarning["kind"], message: string, affected: number) =>
      warnings.push({ column, fieldKey: field.key, fieldLabel: field.label, kind, message, affected });

    if (isIdentifierField(field) && looksSequential(values)) {
      push(
        "sequence_like_identifier",
        `"${column}" was mapped to ${field.label}, but its values look like row or sequence numbers rather than real ${field.label.toLowerCase()}s. Confirm this mapping — NEØ will not treat these as trustworthy identifiers.`,
        values.length,
      );
    }

    switch (field.format) {
      case "date": {
        const unreadable = values.filter((v) => !parseDateValue(v)).length;
        if (unreadable) push("mixed_date_formats", `${unreadable} value(s) in "${column}" are not dates NEØ can read.`, unreadable);
        const year = new Date().getFullYear();
        const implausible = values.filter((v) => {
          const iso = parseDateValue(v);
          if (!iso) return false;
          const y = Number(iso.slice(0, 4));
          return y < 1950 || y > year + 20;
        }).length;
        if (implausible)
          push("implausible_date", `${implausible} date(s) in "${column}" fall outside a sensible range.`, implausible);
        break;
      }
      case "money": {
        const bad = values.filter((v) => parseNumberValue(v) === null).length;
        if (bad) push("non_numeric_money", `${bad} value(s) in "${column}" are not amounts.`, bad);
        const negative = values.filter((v) => (parseNumberValue(v) ?? 0) < 0).length;
        if (negative) push("negative_money", `${negative} amount(s) in "${column}" are negative.`, negative);
        break;
      }
      case "integer": {
        const bad = values.filter((v) => {
          const n = parseNumberValue(v);
          return n === null || !Number.isInteger(n) || n < 0;
        }).length;
        if (bad) push("invalid_quantity", `${bad} value(s) in "${column}" are not whole, positive numbers.`, bad);
        break;
      }
      case "email": {
        const bad = values.filter((v) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)).length;
        if (bad) push("malformed_email", `${bad} value(s) in "${column}" are not valid email addresses.`, bad);
        break;
      }
      case "phone": {
        const bad = values.filter((v) => v.replace(/\D/g, "").length < 7).length;
        if (bad) push("malformed_phone", `${bad} value(s) in "${column}" are too short to be telephone numbers.`, bad);
        break;
      }
      case "enum": {
        const allowed = new Set(field.enumValues ?? []);
        const unknown = [...new Set(values.map((v) => v.toLowerCase().replace(/\s+/g, "-")))].filter(
          (v) => !allowed.has(v),
        );
        if (unknown.length)
          push(
            "unknown_enum",
            `"${column}" contains ${unknown.length} value(s) NEØ does not recognise for ${field.label}: ${unknown.slice(0, 6).join(", ")}.`,
            unknown.length,
          );
        break;
      }
      default:
        break;
    }
  }

  return warnings;
}

/** Fields whose values NEØ does not consider trustworthy identity evidence. */
export function suspectIdentifierFields(warnings: SemanticWarning[]): Set<string> {
  return new Set(warnings.filter((w) => w.kind === "sequence_like_identifier").map((w) => w.fieldKey));
}
