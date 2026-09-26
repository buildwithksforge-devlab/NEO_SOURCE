/**
 * NEØ Intelligent Data Onboarding — the shared engine.
 *
 * Pure, deterministic and domain agnostic. It parses a workbook, proposes a
 * column mapping, applies transformations, resolves values against the real
 * NEØ masters, classifies every row by severity and builds the import plan the
 * administrator approves before anything is written.
 *
 * The hard boundary, enforced here rather than hoped for: the engine may
 * clean, classify, transform, match and propose. It never manufactures a
 * business value. A missing cost stays missing and is reported as missing.
 */
import type {
  DomainField,
  DuplicateRule,
  IdentifierPolicy,
  OnboardingDomain,
  RelationshipTarget,
} from "./domains";
import { duplicateRulesFor } from "./domains";
import {
  cleanCell,
  normaliseHeader,
  parseDateValue,
  parseNumberValue,
  similarity,
  titleCase,
} from "./engine-primitives";
import { allowedActions, confidenceBand, matchPolicy, type MatchPolicy, type ResolutionAction } from "./matching";
// resolution.ts imports only types from this module, so this is not a runtime cycle.
import { resolutionContract } from "./resolution";
import { semanticProfile, suspectIdentifierFields, type SemanticWarning } from "./semantic";

export { cleanCell, parseDateValue, parseNumberValue, similarity };
export { semanticProfile, suspectIdentifierFields };
export type { SemanticWarning };
export { allowedActions, confidenceBand, matchPolicy };
export type { MatchPolicy, ResolutionAction };

// ------------------------------------------------------------------ parsing

export type SheetTable = {
  sheet: string;
  headers: string[];
  rows: Record<string, string>[];
};


// ---------------------------------------------------------- column mapping


export type ColumnProposal = {
  column: string;
  fieldKey: string | null;
  confidence: number;
  reason: string;
  samples: string[];
};

/**
 * Proposes `their column → NEØ field`, using the field's own name, label and
 * the generic legacy vocabulary NEØ recognises. Every proposal is reviewable;
 * nothing is applied silently.
 */
export function proposeColumnMapping(
  domain: OnboardingDomain,
  headers: string[],
  rows: Record<string, string>[],
): ColumnProposal[] {
  const taken = new Set<string>();
  const scored = headers.map((column) => {
    let best: { field: DomainField; score: number; reason: string } | null = null;
    for (const field of domain.fields) {
      const candidates: { text: string; reason: string }[] = [
        { text: field.key, reason: `matches the NEØ field name "${field.key}"` },
        { text: field.label, reason: `matches "${field.label}"` },
        ...field.aliases.map((a) => ({ text: a, reason: `"${a}" is a known name for ${field.label}` })),
      ];
      for (const candidate of candidates) {
        const score = similarity(column, candidate.text);
        if (!best || score > best.score) best = { field, score, reason: candidate.reason };
      }
    }
    const samples = rows
      .slice(0, 400)
      .map((r) => cleanCell(r[column]))
      .filter(Boolean)
      .slice(0, 3);
    return { column, best, samples };
  });

  scored.sort((a, b) => (b.best?.score ?? 0) - (a.best?.score ?? 0));

  const proposals: ColumnProposal[] = scored.map(({ column, best, samples }) => {
    if (!best || best.score < 0.55 || taken.has(best.field.key)) {
      return {
        column,
        fieldKey: null,
        confidence: 0,
        reason: "No NEØ field matched this column. Map it yourself or leave it out of this import.",
        samples,
      };
    }
    taken.add(best.field.key);
    return {
      column,
      fieldKey: best.field.key,
      confidence: Math.round(best.score * 100) / 100,
      reason: best.reason,
      samples,
    };
  });

  return proposals.sort((a, b) => headers.indexOf(a.column) - headers.indexOf(b.column));
}

// -------------------------------------------------------- transformations

export type TransformKey =
  | "trim_whitespace"
  | "standardise_dates"
  | "normalise_phones"
  | "strip_currency"
  | "title_case_names";

export const TRANSFORMS: { key: TransformKey; label: string; detail: string }[] = [
  { key: "trim_whitespace", label: "Trim whitespace", detail: "Removes leading, trailing and doubled spaces." },
  { key: "standardise_dates", label: "Standardise dates", detail: "Reads day/month/year and month/day/year styles into one date format." },
  { key: "normalise_phones", label: "Normalise phone numbers", detail: "Strips spaces, brackets and dashes; keeps a leading +." },
  { key: "strip_currency", label: "Strip currency symbols", detail: "Turns amounts like \"KSh 12,500.00\" into 12500.00. Never changes the figure." },
  { key: "title_case_names", label: "Tidy capitalisation of names", detail: "Converts SHOUTED or lowercase names to normal capitalisation." },
];


export function applyTransforms(
  field: DomainField,
  value: string,
  active: Set<TransformKey>,
): string {
  let out = active.has("trim_whitespace") ? cleanCell(value) : String(value ?? "");
  if (!out) return "";
  if (active.has("strip_currency") && (field.format === "money" || field.format === "integer")) {
    const n = parseNumberValue(out);
    out = n === null ? out : String(n);
  }
  if (active.has("standardise_dates") && field.format === "date") {
    out = parseDateValue(out) ?? out;
  }
  if (active.has("normalise_phones") && field.format === "phone") {
    const plus = out.trim().startsWith("+");
    const digits = out.replace(/\D/g, "");
    out = plus ? `+${digits}` : digits;
  }
  if (active.has("title_case_names") && field.format === "text" && /[a-z]/i.test(out) && !/\d/.test(out)) {
    if (out === out.toUpperCase() || out === out.toLowerCase()) out = titleCase(out);
  }
  return out;
}

// ----------------------------------------------------- relationship matching

export type MasterOption = { id: string; label: string; aliases?: string[] };

export type ResolutionState = "resolved" | "proposed" | "ambiguous" | "unmatched" | "empty";

export type MatchEvidence = "identifier" | "exact_name" | "similarity" | "decided" | "none";

export type ValueResolution = {
  target: RelationshipTarget;
  value: string;
  state: ResolutionState;
  matchId: string | null;
  matchLabel: string | null;
  confidence: number;
  alternatives: { id: string; label: string; confidence: number }[];
  /** False when nothing cleared the relationship's evidence floor. */
  credible: boolean;
  evidence: MatchEvidence;
  /** Plain-language explanation shown to the administrator. */
  reason: string;
};

/** Generic hospitality shorthand. Vocabulary only — never a business fact. */
const SHORTHAND: [RegExp, string][] = [
  [/\bf\s*&?\s*b\b/gi, "food and beverage"],
  [/\bf\s*and\s*b\b/gi, "food and beverage"],
  [/\bhk\b/gi, "housekeeping"],
  [/\bhouse\s*keeping\b/gi, "housekeeping"],
  [/\bfo\b/gi, "front office"],
  [/\bf\.?o\.?h\b/gi, "front of house"],
  [/\bmaint\.?\b/gi, "maintenance"],
  [/\bproc(u|)ment\b/gi, "procurement"],
  [/\brm\.?\s*(\d)/gi, "room $1"],
  [/\bno\.?\s*(\d)/gi, "$1"],
  [/\beng\.?\b/gi, "engineering"],
  [/\badmin\.?\b/gi, "administration"],
  [/\bacc(ts|t|ounts)\b/gi, "accounts"],
  [/\bhr\b/gi, "human resources"],
  [/&/g, "and"],
];

export function expandShorthand(value: string): string {
  let out = ` ${cleanCell(value).toLowerCase()} `;
  for (const [pattern, replacement] of SHORTHAND) out = out.replace(pattern, replacement);
  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * Resolves one spreadsheet value against the caller's own masters.
 *
 * Confidence is judged against the relationship's own policy, not one global
 * number, and an exact identifier hit (a code, a staff number) outranks any
 * amount of spelling similarity. When nothing clears the policy floor the
 * answer is "no credible match" with no candidate at all — a 9% suggestion is
 * noise, and offering it invites a wrong decision.
 */
export function resolveValue(
  target: RelationshipTarget,
  value: string,
  options: MasterOption[],
): ValueResolution {
  const policy = matchPolicy(target);
  const raw = cleanCell(value);
  if (!raw) {
    return {
      target,
      value: raw,
      state: "empty",
      matchId: null,
      matchLabel: null,
      confidence: 0,
      alternatives: [],
      credible: false,
      evidence: "none",
      reason: "No value in this column.",
    };
  }
  const expanded = expandShorthand(raw);
  const key = raw.toLowerCase();

  // Identity evidence: an exact hit on a code or alias is decisive.
  const exact = options.find(
    (o) =>
      o.label.trim().toLowerCase() === key ||
      (o.aliases ?? []).some((a) => cleanCell(a).toLowerCase() === key),
  );
  if (exact) {
    return {
      target,
      value: raw,
      state: "resolved",
      matchId: exact.id,
      matchLabel: exact.label,
      confidence: 1,
      alternatives: [],
      credible: true,
      evidence: exact.label.trim().toLowerCase() === key ? "exact_name" : "identifier",
      reason:
        exact.label.trim().toLowerCase() === key
          ? `Exactly matches ${policy.label.toLowerCase()} "${exact.label}".`
          : `"${raw}" is a known identifier for "${exact.label}".`,
    };
  }

  const scored = options
    .map((option) => {
      const candidates = [option.label, ...(option.aliases ?? [])];
      const confidence = Math.max(
        ...candidates.map((c) => Math.max(similarity(raw, c), similarity(expanded, expandShorthand(c)))),
      );
      return { id: option.id, label: option.label, confidence: Math.round(confidence * 100) / 100 };
    })
    .sort((a, b) => b.confidence - a.confidence);

  const credibleOnes = scored.filter((s) => s.confidence >= policy.floor);
  const best = credibleOnes[0];
  const runnerUp = credibleOnes[1];

  if (!best) {
    return {
      target,
      value: raw,
      state: "unmatched",
      matchId: null,
      matchLabel: null,
      confidence: 0,
      alternatives: [],
      credible: false,
      evidence: "none",
      reason: `No credible ${policy.label.toLowerCase()} match. Search your records, or decide what should happen to this value.`,
    };
  }

  if (runnerUp && best.confidence - runnerUp.confidence < 0.06 && best.confidence < 0.99) {
    return {
      target,
      value: raw,
      state: "ambiguous",
      matchId: null,
      matchLabel: null,
      confidence: best.confidence,
      alternatives: credibleOnes.slice(0, 4),
      credible: true,
      evidence: "similarity",
      reason: `"${raw}" is equally close to "${best.label}" and "${runnerUp.label}". NEØ will not choose between them.`,
    };
  }

  const band = confidenceBand(policy, best.confidence);
  if (band === "none") {
    return {
      target,
      value: raw,
      state: "unmatched",
      matchId: null,
      matchLabel: null,
      confidence: best.confidence,
      alternatives: [],
      credible: false,
      evidence: "none",
      reason: `The closest ${policy.label.toLowerCase()} is too weak a match to offer for this kind of record.`,
    };
  }

  return {
    target,
    value: raw,
    state: band === "high" ? "resolved" : "proposed",
    matchId: best.id,
    matchLabel: best.label,
    confidence: best.confidence,
    alternatives: credibleOnes.slice(1, 4),
    credible: true,
    evidence: "similarity",
    reason: `"${raw}" resembles "${best.label}" (${Math.round(best.confidence * 100)}%).`,
  };
}

// --------------------------------------------------------------- validation

export type Severity = "blocker" | "decision" | "warning" | "later" | "ready";

export const SEVERITY_META: Record<Severity, { label: string; dot: string; explain: string }> = {
  blocker: { label: "Blocker", dot: "🔴", explain: "NEØ cannot safely create this record." },
  decision: { label: "Needs decision", dot: "🟠", explain: "NEØ found something ambiguous and needs you to choose." },
  warning: { label: "Warning", dot: "🟡", explain: "The record can import, but something looks questionable." },
  later: { label: "Complete later", dot: "🔵", explain: "NEØ supports this field, your old records never captured it." },
  ready: { label: "Ready", dot: "🟢", explain: "Nothing outstanding." },
};

const SEVERITY_ORDER: Severity[] = ["ready", "later", "warning", "decision", "blocker"];

export function worstSeverity(list: Severity[]): Severity {
  return list.reduce<Severity>(
    (worst, s) => (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst) ? s : worst),
    "ready",
  );
}

export type RowIssue = {
  field: string;
  severity: Severity;
  message: string;
  /**
   * What will actually happen to this field when the batch runs. Set where the
   * outcome is not simply implied by the severity — a generated identifier, a
   * value cleared because it could not be read. The Import Plan reads this, so
   * nothing discovered during analysis can disappear before the write.
   */
  handling?: string;
};

/** How the hotel wants a generatable identifier supplied. */
export type IdentifierChoice = "undecided" | "generate" | "blank" | "external";

/** An explainable duplicate signal — never a silent skip. */
export type DuplicateFinding = {
  rule: string;
  label: string;
  classification: DuplicateRule["classification"];
  scope: "file" | "existing";
  againstRow: number | null;
  againstRecordId: string | null;
  matchedOn: string[];
  explain: string;
};

/**
 * The single outcome this row will have when the batch runs. Every source row
 * carries exactly one, which is what lets the Import Plan account for all of
 * them without lumping different fates under one vague heading.
 */
export type RowOutcome =
  | "ready"
  | "ready_with_blanks"
  | "awaiting_identifier"
  | "awaiting_duplicate"
  | "awaiting_optional_value"
  | "awaiting_required_value"
  | "duplicate_skip"
  | "blocked";

export type PreparedRow = {
  rowNumber: number;
  raw: Record<string, string>;
  values: Record<string, string>;
  resolutions: Record<string, ValueResolution>;
  issues: RowIssue[];
  severity: Severity;
  identity: string | null;
  action: "create" | "update" | "skip";
  duplicateOf: string | null;
  duplicate: DuplicateFinding | null;
  /** The duplicate decision the hotel made for this row, if any. */
  decision: "skip" | "import" | "update" | null;
  outcome: RowOutcome;
};

export type PrepareOptions = {
  transforms: Set<TransformKey>;
  /** Master lists, keyed by relationship target. */
  masters: Partial<Record<RelationshipTarget, MasterOption[]>>;
  /** Fields the hotel has chosen to ignore for this import. */
  ignoredFields: Set<string>;
  /** Accept every proposal at or above this confidence without individual review. */
  autoAcceptFrom: number;
  /** Allow NEØ to generate identifiers for fields marked generatable. */
  generateIdentifiers: boolean;
  /**
   * How the hotel wants generatable identifiers supplied. When omitted, the
   * legacy `generateIdentifiers` flag is used. `undecided` holds the rows
   * rather than assuming a numbering pattern on the hotel's behalf.
   */
  identifierChoice?: IdentifierChoice;
  /** Existing record identities, lowercased, mapped to the existing record id. */
  existingKeys: Map<string, string>;
  /** Per-value decisions the hotel already made: `target::value` → option id or "" to leave blank. */
  decisions: Record<string, string>;
  /** Fields whose values semantic profiling found untrustworthy as identifiers. */
  suspectFields?: Set<string>;
  /** Per-row duplicate decisions the hotel already made. */
  rowDecisions?: Record<number, "skip" | "import" | "update">;
  /**
   * Values the administrator supplied during resolution, for fields their file
   * left empty — typed in, or taken from another column of the same file.
   * Applied only where the source was blank, so a supplied value can never
   * overwrite something the hotel actually recorded.
   */
  valueFills?: ValueFill[];
};

/** A value the hotel supplied for rows its file left blank. */
export type ValueFill = {
  field: string;
  /** "all" settles every blank row for that field; a list settles only those rows. */
  rows: "all" | number[];
  /** A literal value the administrator typed. */
  value?: string;
  /** Or another column of the same file to read the value from. */
  fromColumn?: string;
};

function validateFormat(field: DomainField, value: string): string | null {
  if (!value) return null;
  switch (field.format) {
    case "integer": {
      const n = parseNumberValue(value);
      if (n === null || !Number.isInteger(n)) return `"${value}" is not a whole number`;
      if (n < 0) return `"${value}" cannot be negative`;
      return null;
    }
    case "money": {
      const n = parseNumberValue(value);
      if (n === null) return `"${value}" is not an amount`;
      if (n < 0) return `"${value}" cannot be negative`;
      return null;
    }
    case "date":
      return parseDateValue(value) ? null : `"${value}" is not a date NEØ can read`;
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : `"${value}" is not a valid email address`;
    case "phone":
      return value.replace(/\D/g, "").length >= 7 ? null : `"${value}" looks too short for a telephone number`;
    case "enum":
      return (field.enumValues ?? []).includes(value.toLowerCase().replace(/\s+/g, "-"))
        ? null
        : `"${value}" is not one of: ${(field.enumValues ?? []).join(", ")}`;
    default:
      return null;
  }
}

function ruleIdentity(rule: DuplicateRule, values: Record<string, string>): string | null {
  const parts = rule.fields.map((k) => cleanCell(values[k] ?? "").toLowerCase());
  if (!parts.every(Boolean)) return null;
  return `${rule.fields.join("+")}::${parts.join("|")}`;
}

/**
 * Turns mapped spreadsheet rows into candidate records, fully classified.
 * Nothing here writes; the result is what the administrator reviews.
 */
export function prepareRows(
  domain: OnboardingDomain,
  mapping: Record<string, string>, // column → field key
  rows: Record<string, string>[],
  options: PrepareOptions,
): PreparedRow[] {
  const fieldToColumn = new Map<string, string>();
  for (const [column, fieldKey] of Object.entries(mapping)) {
    if (fieldKey) fieldToColumn.set(fieldKey, column);
  }
  const rules = duplicateRulesFor(domain);
  const suspect = options.suspectFields ?? new Set<string>();
  const rowDecisions = options.rowDecisions ?? {};
  const seen = new Map<string, number>();
  const identifierChoice: IdentifierChoice =
    options.identifierChoice ?? (options.generateIdentifiers ? "generate" : "blank");

  return rows.map((raw, index) => {
    const rowNumber = index + 1;
    const values: Record<string, string> = {};
    const resolutions: Record<string, ValueResolution> = {};
    const issues: RowIssue[] = [];

    for (const field of domain.fields) {
      if (options.ignoredFields.has(field.key)) continue;
      const column = fieldToColumn.get(field.key);
      const source = column ? (raw[column] ?? "") : "";
      let value = applyTransforms(field, source, options.transforms);

      if (!value) {
        // A value the hotel supplied during resolution, for this field, for
        // this row. It never overwrites anything the file already carried.
        const fill = (options.valueFills ?? []).find(
          (f) => f.field === field.key && (f.rows === "all" || f.rows.includes(rowNumber)),
        );
        if (fill) {
          const supplied = fill.fromColumn ? (raw[fill.fromColumn] ?? "") : (fill.value ?? "");
          const cleaned = applyTransforms(field, supplied, options.transforms);
          if (cleaned) {
            value = cleaned;
            issues.push({
              field: field.key,
              severity: "ready",
              message: `${field.label} was supplied during resolution.`,
              handling: fill.fromColumn
                ? `Taken from the "${fill.fromColumn}" column of your file.`
                : `Entered by the person running this import.`,
            });
          }
        }
      }

      values[field.key] = value;

      if (!value) {
        if (field.generatable) {
          // How an identifier is supplied is the hotel's decision, never an
          // assumption NEØ makes quietly on its behalf.
          if (identifierChoice === "generate") {
            issues.push({
              field: field.key,
              severity: field.requirement === "required" ? "warning" : "later",
              message: `${field.label} is empty.`,
              handling: `NEØ will generate ${field.label.toLowerCase()} using the numbering you confirmed.`,
            });
          } else if (identifierChoice === "external") {
            issues.push({
              field: field.key,
              severity: "later",
              message: `${field.label} is empty.`,
              handling: `Imported blank — you are supplying ${field.label.toLowerCase()} separately.`,
            });
          } else if (identifierChoice === "blank") {
            issues.push({
              field: field.key,
              severity: field.requirement === "required" ? "warning" : "later",
              message: `${field.label} is empty.`,
              handling: `Imported blank, to be completed in NEØ later.`,
            });
          } else {
            issues.push({
              field: field.key,
              severity: "decision",
              message: `${field.label} is empty on this row.`,
              handling: `Waiting for you to say whether ${field.label.toLowerCase()} is generated, left blank, or supplied separately.`,
            });
          }
        } else if (field.requirement === "required") {
          issues.push({
            field: field.key,
            severity: "blocker",
            message: `${field.label} is required and is empty.`,
            handling: "This row will not be created until the value is supplied.",
          });
        } else if (field.requirement === "recommended") {
          issues.push({
            field: field.key,
            severity: "warning",
            message: `${field.label} is recommended and is empty.`,
            handling: `Imported blank — the record is still created.`,
          });
        } else {
          issues.push({
            field: field.key,
            severity: "later",
            message: `${field.label} was never recorded.`,
            handling: "Imported blank, to complete later.",
          });
        }
        continue;
      }

      const formatProblem = validateFormat(field, value);
      if (formatProblem) {
        if (field.requirement === "required") {
          issues.push({
            field: field.key,
            severity: "blocker",
            message: formatProblem,
            handling: "This row will not be created until the value is corrected.",
          });
        } else {
          // NEØ never writes a value it could not read, and never guesses one.
          values[field.key] = "";
          issues.push({
            field: field.key,
            severity: "warning",
            message: formatProblem,
            handling: `${field.label} will be imported blank — the original value is kept in the batch so you can correct it afterwards.`,
          });
        }
        continue;
      }

      if (field.relationship) {
        const policy = matchPolicy(field.relationship);
        const decisionKey = `${field.relationship}::${value.toLowerCase()}`;
        const decided = options.decisions[decisionKey];
        const master = options.masters[field.relationship] ?? [];
        let resolution = resolveValue(field.relationship, value, master);
        if (decided !== undefined) {
          const chosen = master.find((m) => m.id === decided);
          resolution = decided
            ? {
                ...resolution,
                state: "resolved",
                matchId: chosen?.id ?? decided,
                matchLabel: chosen?.label ?? resolution.matchLabel,
                confidence: 1,
                credible: true,
                evidence: "decided",
                reason: "You chose this match for every occurrence of this value.",
              }
            : {
                ...resolution,
                state: "empty",
                matchId: null,
                matchLabel: null,
                evidence: "decided",
                reason: "You chose to leave this unassigned.",
              };
        } else if (
          resolution.state === "proposed" &&
          resolution.confidence >= Math.max(options.autoAcceptFrom, policy.accept)
        ) {
          resolution = { ...resolution, state: "resolved" };
        }
        resolutions[field.key] = resolution;

        if (resolution.state === "proposed" || resolution.state === "ambiguous") {
          issues.push({ field: field.key, severity: "decision", message: resolution.reason });
        } else if (resolution.state === "unmatched") {
          issues.push({
            field: field.key,
            severity: field.requirement === "required" ? "blocker" : "decision",
            // Guidance comes from the shared resolution contract, so the
            // message can never promise an action the adapter has not granted.
            message: `${resolution.reason} ${resolutionContract(policy).explanation}`.trim(),
          });
        }
      }
    }

    // ------------------------------------------------------------ duplicates
    let identity: string | null = null;
    let duplicate: DuplicateFinding | null = null;

    for (const rule of rules) {
      const key = ruleIdentity(rule, values);
      if (!key) continue;
      identity ??= key;
      const untrustworthy = rule.fields.some((f) => suspect.has(f));
      const classification: DuplicateRule["classification"] = untrustworthy ? "possible" : rule.classification;
      const withinFile = seen.get(key);
      if (withinFile !== undefined && !duplicate) {
        duplicate = {
          rule: rule.key,
          label: rule.label,
          classification,
          scope: "file",
          againstRow: withinFile,
          againstRecordId: null,
          matchedOn: rule.fields,
          explain: `${rule.explain} Row ${rowNumber} matches row ${withinFile} on ${rule.label.toLowerCase()}.${
            untrustworthy ? " Those values were flagged as unreliable identifiers, so this is only a possible duplicate." : ""
          }`,
        };
      } else if (withinFile === undefined) {
        seen.set(key, rowNumber);
        const existing = options.existingKeys.get(key);
        if (existing && !duplicate) {
          duplicate = {
            rule: rule.key,
            label: rule.label,
            classification,
            scope: "existing",
            againstRow: null,
            againstRecordId: existing,
            matchedOn: rule.fields,
            explain: `${rule.explain} This matches a record already in NEØ on ${rule.label.toLowerCase()}.`,
          };
        }
      }
    }

    let action: PreparedRow["action"] = "create";
    let duplicateOf: string | null = null;
    const decision = duplicate ? (rowDecisions[rowNumber] ?? null) : null;
    let awaitingDuplicate = false;

    if (duplicate) {
      duplicateOf = duplicate.scope === "file" ? `row ${duplicate.againstRow}` : duplicate.againstRecordId;
      if (decision) {
        action = decision === "import" ? "create" : decision === "update" ? "update" : "skip";
        if (decision === "import") duplicateOf = duplicate.scope === "existing" ? duplicateOf : null;
      } else if (duplicate.classification === "exact") {
        action = duplicate.scope === "existing" ? "update" : "skip";
        issues.push({
          field: "_row",
          severity: "warning",
          message: duplicate.explain,
          handling:
            duplicate.scope === "existing"
              ? "The existing record will be updated rather than duplicated."
              : "This row will be skipped as an exact repeat of an earlier row.",
        });
      } else {
        // Never silently merge or drop a record NEØ is not sure about.
        awaitingDuplicate = true;
        issues.push({
          field: "_row",
          severity: "decision",
          message: `${duplicate.explain} NEØ will not decide this for you — import it, skip it, or update the existing record.`,
          handling: "Held until you decide.",
        });
      }
    }

    const severity = worstSeverity(issues.map((i) => i.severity));
    if (severity === "blocker") action = "skip";

    const awaitingIdentifier = issues.some(
      (i) => i.severity === "decision" && i.field !== "_row" && domain.fields.find((f) => f.key === i.field)?.generatable,
    );
    // An optional link the hotel has not settled and a required link it has
    // not settled are different fates, and the plan must never merge them.
    const openValueFields = issues.filter(
      (i) => i.severity === "decision" && i.field !== "_row" && !domain.fields.find((f) => f.key === i.field)?.generatable,
    );
    const awaitingRequiredValue = openValueFields.some(
      (i) => domain.fields.find((f) => f.key === i.field)?.requirement === "required",
    );
    const awaitingOptionalValue = openValueFields.length > 0 && !awaitingRequiredValue;

    // Exactly one outcome per source row, so the plan can add up to the file.
    const outcome: RowOutcome = (() => {
      if (severity === "blocker") return "blocked";
      if (awaitingDuplicate) return "awaiting_duplicate";
      if (awaitingRequiredValue) return "awaiting_required_value";
      if (awaitingOptionalValue) return "awaiting_optional_value";
      if (awaitingIdentifier) return "awaiting_identifier";
      if (action === "skip") return "duplicate_skip";
      if (issues.some((i) => i.severity === "warning" || i.severity === "later")) return "ready_with_blanks";
      return "ready";
    })();

    return {
      rowNumber,
      raw,
      values,
      resolutions,
      issues,
      severity,
      identity,
      action,
      duplicateOf,
      duplicate,
      decision,
      outcome,
    };
  });
}

// ---------------------------------------------------------------- reporting

/** One value, every row it appears in, and everything the hotel may do with it. */
export type DecisionGroup = {
  target: RelationshipTarget;
  fieldKey: string;
  fieldLabel: string;
  value: string;
  occurrences: number;
  rowNumbers: number[];
  state: ResolutionState;
  suggestion: { id: string; label: string; confidence: number } | null;
  alternatives: { id: string; label: string; confidence: number }[];
  credible: boolean;
  reason: string;
  policy: MatchPolicy;
  actions: ResolutionAction[];
};

export type DuplicateGroup = {
  classification: DuplicateRule["classification"];
  scope: "file" | "existing";
  label: string;
  count: number;
  rowNumbers: number[];
  explain: string;
};

export type ProfileReport = {
  total: number;
  ready: number;
  missingRecommended: number;
  needsDecision: number;
  duplicates: number;
  blockers: number;
  columnsMapped: number;
  columnsUnmapped: number;
  unresolvedByTarget: Record<string, { value: string; occurrences: number; suggestion: string | null; confidence: number }[]>;
  decisionGroups: DecisionGroup[];
  duplicateGroups: DuplicateGroup[];
  semantic: SemanticWarning[];
  outstandingDecisions: number;
};

export function profileRows(
  prepared: PreparedRow[],
  proposals: ColumnProposal[],
  extra: { domain?: OnboardingDomain; semantic?: SemanticWarning[] } = {},
): ProfileReport {
  const unresolved: ProfileReport["unresolvedByTarget"] = {};
  const groups = new Map<string, DecisionGroup>();
  const fieldLabel = (key: string) =>
    extra.domain?.fields.find((f) => f.key === key)?.label ?? key.replace(/_/g, " ");

  for (const row of prepared) {
    for (const [fieldKey, resolution] of Object.entries(row.resolutions)) {
      if (resolution.state === "resolved" || resolution.state === "empty") continue;
      const bucket = (unresolved[resolution.target] ??= []);
      const existing = bucket.find((e) => e.value.toLowerCase() === resolution.value.toLowerCase());
      if (existing) existing.occurrences += 1;
      else
        bucket.push({
          value: resolution.value,
          occurrences: 1,
          suggestion: resolution.credible ? (resolution.matchLabel ?? resolution.alternatives[0]?.label ?? null) : null,
          confidence: resolution.confidence,
        });

      const groupKey = `${resolution.target}::${fieldKey}::${resolution.value.toLowerCase()}`;
      const group = groups.get(groupKey);
      if (group) {
        group.occurrences += 1;
        group.rowNumbers.push(row.rowNumber);
      } else {
        const policy = matchPolicy(resolution.target);
        groups.set(groupKey, {
          target: resolution.target,
          fieldKey,
          fieldLabel: fieldLabel(fieldKey),
          value: resolution.value,
          occurrences: 1,
          rowNumbers: [row.rowNumber],
          state: resolution.state,
          suggestion:
            resolution.credible && resolution.matchId && resolution.matchLabel
              ? { id: resolution.matchId, label: resolution.matchLabel, confidence: resolution.confidence }
              : (resolution.credible ? (resolution.alternatives[0] ?? null) : null),
          alternatives: resolution.alternatives,
          credible: resolution.credible,
          reason: resolution.reason,
          policy,
          actions: allowedActions(policy),
        });
      }
    }
  }
  for (const bucket of Object.values(unresolved)) bucket.sort((a, b) => b.occurrences - a.occurrences);

  const duplicateGroups = new Map<string, DuplicateGroup>();
  for (const row of prepared) {
    if (!row.duplicate) continue;
    const key = `${row.duplicate.rule}::${row.duplicate.classification}::${row.duplicate.scope}`;
    const group = duplicateGroups.get(key);
    if (group) {
      group.count += 1;
      group.rowNumbers.push(row.rowNumber);
    } else {
      duplicateGroups.set(key, {
        classification: row.duplicate.classification,
        scope: row.duplicate.scope,
        label: row.duplicate.label,
        count: 1,
        rowNumbers: [row.rowNumber],
        explain: row.duplicate.explain,
      });
    }
  }

  const decisionGroups = [...groups.values()].sort((a, b) => b.occurrences - a.occurrences);

  return {
    total: prepared.length,
    ready: prepared.filter((r) => r.severity === "ready" || r.severity === "later").length,
    missingRecommended: prepared.filter((r) => r.severity === "warning").length,
    needsDecision: prepared.filter((r) => r.severity === "decision").length,
    duplicates: prepared.filter((r) => r.duplicate !== null).length,
    blockers: prepared.filter((r) => r.severity === "blocker").length,
    columnsMapped: proposals.filter((p) => p.fieldKey).length,
    columnsUnmapped: proposals.filter((p) => !p.fieldKey).length,
    unresolvedByTarget: unresolved,
    decisionGroups,
    duplicateGroups: [...duplicateGroups.values()],
    semantic: extra.semantic ?? [],
    outstandingDecisions: decisionGroups.length + [...duplicateGroups.values()].filter((g) => g.classification !== "exact").length,
  };
}

/**
 * Only the transformations that can actually act on the mapped fields. An
 * asset register never needs telephone normalisation, so it is not offered.
 */
export function relevantTransforms(
  domain: OnboardingDomain,
  mapping: Record<string, string>,
): typeof TRANSFORMS {
  const mapped = new Set(Object.values(mapping).filter(Boolean));
  const formats = new Set(domain.fields.filter((f) => mapped.has(f.key)).map((f) => f.format ?? "text"));
  return TRANSFORMS.filter((t) => {
    switch (t.key) {
      case "trim_whitespace":
        return true;
      case "standardise_dates":
        return formats.has("date");
      case "normalise_phones":
        return formats.has("phone");
      case "strip_currency":
        return formats.has("money") || formats.has("integer");
      case "title_case_names":
        return formats.has("text");
      default:
        return true;
    }
  });
}

/** What identifier generation would actually do, before it is switched on. */
export type IdentifierPreview = {
  fieldKey: string;
  fieldLabel: string;
  pattern: string;
  firstSample: string;
  lastSample: string;
  affected: number;
  note: string;
  /** Where the numbering came from — the hotel's own policy, or no policy at all. */
  source: "configured" | "unconfigured";
};

export function identifierPreview(
  domain: OnboardingDomain,
  prepared: PreparedRow[],
  seed = 0,
  /** The hotel's configured numbering, keyed by field. Nothing is assumed when it is absent. */
  configured?: Partial<Record<string, IdentifierPolicy>>,
): IdentifierPreview[] {
  const previews: IdentifierPreview[] = [];
  for (const field of domain.fields) {
    if (!field.generatable) continue;
    const hotel = configured?.[field.key];
    const policy = hotel ?? domain.identifierPolicies?.[field.key];
    const affected = prepared.filter((r) => !cleanCell(r.values[field.key] ?? "")).length;
    if (!affected) continue;
    const prefix = policy?.prefix ?? `${field.key.slice(0, 3).toUpperCase()}-`;
    const padding = policy?.padding ?? 5;
    const make = (n: number) => `${prefix}${String(n).padStart(padding, "0")}`;
    previews.push({
      fieldKey: field.key,
      fieldLabel: field.label,
      pattern: `${prefix}${"0".repeat(padding)}`,
      firstSample: make(seed + 1),
      lastSample: make(seed + affected),
      affected,
      source: hotel ? "configured" : "unconfigured",
      note: hotel
        ? (hotel.note ??
          `This is your configured ${field.label.toLowerCase()} numbering. Numbering continues from the highest value already in NEØ, so a generated value can never collide with an existing one.`)
        : `No ${field.label.toLowerCase()} numbering is configured for this property, so this is NEØ's default pattern. Confirm it, or set your own numbering first.`,
    });
  }
  return previews;
}

/**
 * One line of the reconciliation: a bucket of source rows with a single,
 * unambiguous fate. Every source row belongs to exactly one bucket.
 */
export type PlanBucket = {
  key: RowOutcome;
  label: string;
  count: number;
  explain: string;
  rowNumbers: number[];
};

/** What happens to one field that analysis found a problem with. */
export type FieldOutcome = {
  fieldKey: string;
  fieldLabel: string;
  severity: Severity;
  rows: number;
  sample: string;
  handling: string;
};

/** Where unresolved relationship values actually land. */
export type RelationshipOutcome = {
  target: string;
  fieldKey: string;
  fieldLabel: string;
  value: string;
  occurrences: number;
  /** Optional link: the record can be created with this left unassigned. */
  disposition: "may_remain_unassigned" | "requires_resolution";
};

export type ImportPlan = {
  /** Source rows read from the file. Buckets always add up to this. */
  total: number;
  accountedFor: number;
  reconciled: boolean;
  buckets: PlanBucket[];

  readyNow: number;
  readyWithBlanks: number;
  awaitingIdentifierDecision: number;
  awaitingDuplicateDecision: number;
  /** Optional links with no decision yet — a row can still proceed unassigned. */
  awaitingOptionalDecision: number;
  /** Required links with no decision yet — the row cannot be created. */
  awaitingRequiredValue: number;
  /** Both of the above. Kept so existing reconciliation call sites still add up. */
  awaitingValueDecision: number;
  duplicateSkips: number;
  blocked: number;

  create: number;
  update: number;
  skipDuplicates: number;
  skipBlocked: number;
  blankOptionalFields: number;
  generatedIdentifiers: number;
  mappedValues: number;
  stillNeedingAttention: number;

  fieldOutcomes: FieldOutcome[];
  relationshipOutcomes: RelationshipOutcome[];
  mayRemainUnassigned: number;
  requiresResolution: number;
};

const OUTCOME_META: Record<RowOutcome, { label: string; explain: string }> = {
  ready: { label: "Ready to create", explain: "Every mapped field is present and understood." },
  ready_with_blanks: {
    label: "Ready, with optional fields blank",
    explain: "These will be created now; the blank fields can be completed in NEØ afterwards.",
  },
  awaiting_identifier: {
    label: "Awaiting your identifier choice",
    explain: "Nothing is written until you say how the identifier is supplied.",
  },
  awaiting_duplicate: {
    label: "Awaiting a duplicate decision",
    explain: "NEØ found a possible duplicate and will not choose for you.",
  },
  awaiting_optional_value: {
    label: "Awaiting an optional link decision",
    explain:
      "An optional reference could not be matched confidently. Choose a record or leave it unassigned — either settles the row.",
  },
  awaiting_required_value: {
    label: "Awaiting a required value decision",
    explain: "A required reference could not be matched to your records, so the record cannot be created yet.",
  },
  duplicate_skip: {
    label: "Skipped as duplicates",
    explain: "An exact repeat of a row already in this file or already in NEØ.",
  },
  blocked: {
    label: "Blocked",
    explain: "A required value is missing or unreadable, so the record cannot be created.",
  },
};

const BUCKET_ORDER: RowOutcome[] = [
  "ready",
  "ready_with_blanks",
  "awaiting_identifier",
  "awaiting_duplicate",
  "awaiting_optional_value",
  "awaiting_required_value",
  "duplicate_skip",
  "blocked",
];

/**
 * The Import Plan is a reconciliation, not a summary. Every source row and
 * every issue analysis raised has a stated outcome before anything is written.
 */
export function buildImportPlan(prepared: PreparedRow[], domain?: OnboardingDomain): ImportPlan {
  let blankOptionalFields = 0;
  let generatedIdentifiers = 0;
  let mappedValues = 0;

  const fieldLabel = (key: string) =>
    domain?.fields.find((f) => f.key === key)?.label ?? key.replace(/_/g, " ");

  const outcomes = new Map<string, FieldOutcome>();
  const relationships = new Map<string, RelationshipOutcome>();

  for (const row of prepared) {
    for (const issue of row.issues) {
      if (issue.severity === "later") blankOptionalFields += 1;
      if (issue.handling?.startsWith("NEØ will generate")) generatedIdentifiers += 1;
      if (issue.field === "_row") continue;

      const key = `${issue.field}::${issue.severity}::${issue.handling ?? issue.message}`;
      const existing = outcomes.get(key);
      if (existing) existing.rows += 1;
      else
        outcomes.set(key, {
          fieldKey: issue.field,
          fieldLabel: fieldLabel(issue.field),
          severity: issue.severity,
          rows: 1,
          sample: issue.message,
          handling:
            issue.handling ??
            (issue.severity === "blocker"
              ? "This row will not be created."
              : issue.severity === "decision"
                ? "Held until you decide."
                : issue.severity === "warning"
                  ? "Imported with this field blank."
                  : "Imported blank, to complete later."),
        });
    }

    for (const [fieldKey, resolution] of Object.entries(row.resolutions)) {
      if (resolution.state === "resolved" && resolution.matchLabel && resolution.matchLabel !== resolution.value) {
        mappedValues += 1;
        continue;
      }
      if (resolution.state === "resolved" || resolution.state === "empty") continue;
      const field = domain?.fields.find((f) => f.key === fieldKey);
      const required = field?.requirement === "required";
      const key = `${resolution.target}::${fieldKey}::${resolution.value.toLowerCase()}`;
      const existing = relationships.get(key);
      if (existing) existing.occurrences += 1;
      else
        relationships.set(key, {
          target: resolution.target,
          fieldKey,
          fieldLabel: fieldLabel(fieldKey),
          value: resolution.value,
          occurrences: 1,
          disposition: required ? "requires_resolution" : "may_remain_unassigned",
        });
    }
  }

  const counts = new Map<RowOutcome, number[]>();
  for (const row of prepared) {
    const list = counts.get(row.outcome) ?? [];
    list.push(row.rowNumber);
    counts.set(row.outcome, list);
  }

  const buckets: PlanBucket[] = BUCKET_ORDER.map((key) => {
    const rowNumbers = counts.get(key) ?? [];
    return {
      key,
      label: OUTCOME_META[key].label,
      explain: OUTCOME_META[key].explain,
      count: rowNumbers.length,
      rowNumbers,
    };
  });

  const bucketCount = (key: RowOutcome) => counts.get(key)?.length ?? 0;
  const accountedFor = buckets.reduce((n, b) => n + b.count, 0);
  const relationshipOutcomes = [...relationships.values()].sort((a, b) => b.occurrences - a.occurrences);

  return {
    total: prepared.length,
    accountedFor,
    reconciled: accountedFor === prepared.length,
    buckets,

    readyNow: bucketCount("ready"),
    readyWithBlanks: bucketCount("ready_with_blanks"),
    awaitingIdentifierDecision: bucketCount("awaiting_identifier"),
    awaitingDuplicateDecision: bucketCount("awaiting_duplicate"),
    awaitingOptionalDecision: bucketCount("awaiting_optional_value"),
    awaitingRequiredValue: bucketCount("awaiting_required_value"),
    awaitingValueDecision: bucketCount("awaiting_optional_value") + bucketCount("awaiting_required_value"),
    duplicateSkips: bucketCount("duplicate_skip"),
    blocked: bucketCount("blocked"),

    create: prepared.filter((r) => r.action === "create").length,
    update: prepared.filter((r) => r.action === "update").length,
    skipDuplicates: prepared.filter((r) => r.action === "skip" && r.duplicateOf !== null).length,
    skipBlocked: prepared.filter((r) => r.action === "skip" && r.severity === "blocker").length,
    blankOptionalFields,
    generatedIdentifiers,
    mappedValues,
    stillNeedingAttention:
      bucketCount("awaiting_identifier") +
      bucketCount("awaiting_duplicate") +
      bucketCount("awaiting_optional_value") +
      bucketCount("awaiting_required_value"),

    fieldOutcomes: [...outcomes.values()].sort((a, b) => b.rows - a.rows),
    relationshipOutcomes,
    mayRemainUnassigned: relationshipOutcomes.filter((r) => r.disposition === "may_remain_unassigned").length,
    requiresResolution: relationshipOutcomes.filter((r) => r.disposition === "requires_resolution").length,
  };
}

/**
 * Commit gate: nothing may be written while the plan does not account for every
 * source row, or while a decision NEØ refuses to take for the hotel is open.
 */
export function commitReadiness(profile: ProfileReport, plan: ImportPlan): {
  ready: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  if (!plan.reconciled) {
    reasons.push(
      `Only ${plan.accountedFor} of ${plan.total} source rows have a known outcome. NEØ will not write a partially explained batch.`,
    );
  }
  if (plan.awaitingIdentifierDecision) {
    reasons.push(
      `${plan.awaitingIdentifierDecision} row(s) are waiting for you to choose how the identifier is supplied — generated, left blank, or supplied separately.`,
    );
  }
  if (plan.awaitingRequiredValue) {
    reasons.push(
      `${plan.awaitingRequiredValue} row(s) are held by ${plan.requiresResolution} required value(s) that must be resolved before the record can be created.`,
    );
  }
  if (plan.awaitingOptionalDecision) {
    reasons.push(
      `${plan.awaitingOptionalDecision} row(s) carry ${plan.mayRemainUnassigned} optional link(s) with no decision yet. Choose a record or say "leave unassigned" — either one settles them.`,
    );
  }
  if (plan.awaitingDuplicateDecision) {
    reasons.push(`${plan.awaitingDuplicateDecision} possible duplicate row(s) have no decision yet.`);
  }
  if (plan.create + plan.update === 0) reasons.push("This batch would create or update nothing.");
  return { ready: reasons.length === 0, reasons };
}
