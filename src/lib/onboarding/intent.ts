/**
 * NEØ Intelligent Data Onboarding — file understanding.
 *
 * Before a single row is mapped, the shared engine asks a blunt question: is
 * this file actually the thing the administrator said it was? A hotel that
 * selects Asset Categories and uploads its 138-row asset register should be
 * told so, in its own words, and offered safe courses of action — never
 * switched to another data type behind its back.
 *
 * This module is pure and domain agnostic. It reads headers and sample values,
 * scores every supported domain the platform declares, and returns evidence.
 * It decides nothing: every option it returns is a proposal a human approves.
 */
import { ONBOARDING_DOMAINS, type OnboardingDomain } from "./domains";
import { cleanCell, similarity } from "./engine-primitives";

/** How well one uploaded file fits one NEØ domain. */
export type DomainFit = {
  domainKey: string;
  domainLabel: string;
  supported: boolean;
  /** Columns in the file that matched a field of this domain. */
  matchedColumns: { column: string; fieldKey: string; fieldLabel: string; confidence: number }[];
  /** Required fields of this domain that the file appears to carry. */
  requiredCovered: string[];
  /** Required fields of this domain the file has no column for. */
  requiredMissing: string[];
  /** Share of the file's columns this domain explains, 0..1. */
  columnCoverage: number;
  /** Share of this domain's required fields the file carries, 0..1. */
  requirementCoverage: number;
  /** Combined evidence strength, 0..1. */
  score: number;
};

export type IntentVerdict =
  | "strong_match"
  | "partial_match"
  | "other_domain"
  | "multi_entity"
  | "unclassified";

export type IntentOptionKind =
  | "continue"
  | "extract_values"
  | "switch_domain"
  | "choose_other"
  | "cancel";

/** A course of action offered to the administrator. Nothing is applied here. */
export type IntentOption = {
  kind: IntentOptionKind;
  label: string;
  detail: string;
  /** For switch_domain / extract_values, the domain the option refers to. */
  domainKey?: string;
  /** For extract_values, the column the unique values are read from. */
  column?: string;
  /** For extract_values, the field those values become. */
  fieldKey?: string;
  recommended: boolean;
};

export type FileIntent = {
  verdict: IntentVerdict;
  headline: string;
  explanation: string;
  selected: DomainFit;
  /** The domain the file resembles most, which may be the selected one. */
  best: DomainFit;
  /** Other credible readings of the same file, strongest first. */
  alternatives: DomainFit[];
  /** Foundation/master data referenced by this file that other domains own. */
  secondaryEntities: { domainKey: string; domainLabel: string; columns: string[] }[];
  options: IntentOption[];
};

const MATCH_FLOOR = 0.62;

function fieldCandidates(domain: OnboardingDomain) {
  return domain.fields.flatMap((field) => [
    { field, text: field.key },
    { field, text: field.label },
    ...field.aliases.map((alias) => ({ field, text: alias })),
  ]);
}

/** Scores one file against one domain. Pure evidence, no judgement. */
export function fitDomain(domain: OnboardingDomain, headers: string[]): DomainFit {
  const candidates = fieldCandidates(domain);
  const takenFields = new Set<string>();
  const matchedColumns: DomainFit["matchedColumns"] = [];

  const scored = headers
    .map((column) => {
      let best: { fieldKey: string; fieldLabel: string; score: number } | null = null;
      for (const candidate of candidates) {
        const score = similarity(column, candidate.text);
        if (!best || score > best.score) {
          best = { fieldKey: candidate.field.key, fieldLabel: candidate.field.label, score };
        }
      }
      return { column, best };
    })
    .sort((a, b) => (b.best?.score ?? 0) - (a.best?.score ?? 0));

  for (const { column, best } of scored) {
    if (!best || best.score < MATCH_FLOOR || takenFields.has(best.fieldKey)) continue;
    takenFields.add(best.fieldKey);
    matchedColumns.push({
      column,
      fieldKey: best.fieldKey,
      fieldLabel: best.fieldLabel,
      confidence: Math.round(best.score * 100) / 100,
    });
  }

  const required = domain.fields.filter((f) => f.requirement === "required");
  const requiredCovered = required.filter((f) => takenFields.has(f.key)).map((f) => f.key);
  const requiredMissing = required.filter((f) => !takenFields.has(f.key)).map((f) => f.key);

  const columnCoverage = headers.length ? matchedColumns.length / headers.length : 0;
  const requirementCoverage = required.length ? requiredCovered.length / required.length : 1;

  // Column coverage says "this file is mostly about this domain"; requirement
  // coverage says "this domain could actually be created from it". Both matter,
  // and neither alone is enough.
  const score = Math.round((columnCoverage * 0.6 + requirementCoverage * 0.4) * 100) / 100;

  return {
    domainKey: domain.key,
    domainLabel: domain.label,
    supported: domain.supported,
    matchedColumns,
    requiredCovered,
    requiredMissing,
    columnCoverage: Math.round(columnCoverage * 100) / 100,
    requirementCoverage: Math.round(requirementCoverage * 100) / 100,
    score,
  };
}

/**
 * The column in this file whose unique values could seed the selected domain's
 * naming field — the mechanism behind "extract unique Asset Categories from an
 * asset register". Only ever offered, never run automatically.
 */
export function extractionCandidate(
  selected: OnboardingDomain,
  fit: DomainFit,
): { column: string; fieldKey: string; fieldLabel: string } | null {
  const namingField =
    selected.fields.find((f) => f.requirement === "required" && (f.format === "text" || f.format === "longtext")) ??
    selected.fields.find((f) => f.requirement === "required");
  if (!namingField) return null;
  const match = fit.matchedColumns.find((m) => m.fieldKey === namingField.key);
  if (!match) return null;
  return { column: match.column, fieldKey: namingField.key, fieldLabel: namingField.label };
}

/**
 * Reads a file's structure against every supported domain and reports what it
 * appears to be, with the safe choices a human may take.
 */
export function classifyFile(
  selected: OnboardingDomain,
  headers: string[],
  _rows: Record<string, string>[] = [],
  catalogue: OnboardingDomain[] = ONBOARDING_DOMAINS,
): FileIntent {
  const fits = catalogue
    .filter((d) => d.fields.length > 0)
    .map((d) => fitDomain(d, headers))
    .sort((a, b) => b.score - a.score || b.matchedColumns.length - a.matchedColumns.length);

  const selectedFit = fits.find((f) => f.domainKey === selected.key) ?? fitDomain(selected, headers);
  const best = fits[0] ?? selectedFit;
  const alternatives = fits
    .filter((f) => f.domainKey !== selected.key && f.matchedColumns.length >= 2 && f.score >= 0.25)
    .slice(0, 3);

  // Which other domains this file clearly also carries information about.
  const secondaryEntities = alternatives
    .filter((f) => f.domainKey !== best.domainKey && f.matchedColumns.length >= 2)
    .map((f) => ({
      domainKey: f.domainKey,
      domainLabel: f.domainLabel,
      columns: f.matchedColumns.map((m) => m.column),
    }));

  const selectedMatched = selectedFit.matchedColumns.length;
  const totalColumns = headers.length;
  const clearlyElsewhere =
    best.domainKey !== selected.key &&
    best.matchedColumns.length >= Math.max(3, selectedMatched * 2) &&
    best.score >= selectedFit.score + 0.2;

  let verdict: IntentVerdict;
  if (clearlyElsewhere) verdict = "other_domain";
  else if (selectedFit.requirementCoverage === 1 && selectedFit.columnCoverage >= 0.6) verdict = "strong_match";
  else if (selectedMatched === 0) verdict = "unclassified";
  else if (secondaryEntities.length >= 2 && selectedFit.columnCoverage < 0.5) verdict = "multi_entity";
  else verdict = "partial_match";

  const extraction = extractionCandidate(selected, selectedFit);

  const headline =
    verdict === "other_domain"
      ? `This file appears primarily to be a ${best.domainLabel} file.`
      : verdict === "strong_match"
        ? `This file matches ${selected.label}.`
        : verdict === "unclassified"
          ? `NEØ could not confidently recognise this file as ${selected.label}.`
          : verdict === "multi_entity"
            ? `This file carries several kinds of information, not only ${selected.label}.`
            : `This file only partly matches ${selected.label}.`;

  const explanation =
    verdict === "other_domain"
      ? `${best.matchedColumns.length} of ${totalColumns} columns describe ${best.domainLabel.toLowerCase()}, while ${selectedMatched} match ${selected.label.toLowerCase()}. NEØ has not changed anything — you decide what to do.`
      : `${selectedMatched} of ${totalColumns} columns match ${selected.label.toLowerCase()}${
          selectedFit.requiredMissing.length
            ? `, and ${selectedFit.requiredMissing.length} required field(s) have no column in this file`
            : ""
        }.`;

  const options: IntentOption[] = [];

  if (extraction) {
    options.push({
      kind: "extract_values",
      label: `Extract the unique ${extraction.fieldLabel.toLowerCase()} values`,
      detail: `Reads the distinct values in "${extraction.column}" and prepares them as ${selected.label}, keeping a link back to the rows they came from.`,
      domainKey: selected.key,
      column: extraction.column,
      fieldKey: extraction.fieldKey,
      recommended: verdict === "other_domain",
    });
  }

  if (best.domainKey !== selected.key && best.supported && best.matchedColumns.length >= 2) {
    options.push({
      kind: "switch_domain",
      label: `Switch this file to ${best.domainLabel}`,
      detail: `Start again with the ${best.domainLabel} rules, which explain ${best.matchedColumns.length} of your ${totalColumns} columns. Your file is re-read; nothing is imported yet.`,
      domainKey: best.domainKey,
      recommended: verdict === "other_domain" && !extraction,
    });
  }

  options.push({
    kind: "continue",
    label: `Continue with ${selected.label}`,
    detail:
      selectedMatched > 0
        ? `Map the columns yourself. Columns NEØ cannot place are simply left out of this import.`
        : `Nothing matched automatically, so every column needs mapping by hand.`,
    recommended: verdict === "strong_match" || verdict === "partial_match",
  });

  options.push({
    kind: "choose_other",
    label: "Choose a different data type",
    detail: "Return to the onboarding list and pick the type this file really is.",
    recommended: verdict === "unclassified",
  });

  options.push({
    kind: "cancel",
    label: "Cancel and review the file",
    detail: "Nothing is kept. Your existing records are untouched.",
    recommended: false,
  });

  return { verdict, headline, explanation, selected: selectedFit, best, alternatives, secondaryEntities, options };
}

/** A distinct value lifted out of a source column, with its lineage intact. */
export type ExtractedValue = {
  value: string;
  occurrences: number;
  sourceRows: number[];
};

/**
 * Deduplicates one column into candidate records for a foundation domain, and
 * reports the rows that carried no value at all — those are a real finding,
 * not something to quietly drop.
 */
export function extractUniqueValues(
  rows: Record<string, string>[],
  column: string,
): { values: ExtractedValue[]; blankRows: number[] } {
  const byKey = new Map<string, ExtractedValue>();
  const blankRows: number[] = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const value = cleanCell(row[column]);
    if (!value) {
      blankRows.push(rowNumber);
      return;
    }
    const key = value.toLowerCase();
    const found = byKey.get(key);
    if (found) {
      found.occurrences += 1;
      found.sourceRows.push(rowNumber);
    } else {
      byKey.set(key, { value, occurrences: 1, sourceRows: [rowNumber] });
    }
  });

  return {
    values: [...byKey.values()].sort((a, b) => b.occurrences - a.occurrences || a.value.localeCompare(b.value)),
    blankRows,
  };
}
