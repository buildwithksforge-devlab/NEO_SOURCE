/**
 * NEØ Intelligent Data Onboarding — shared CANONICALISATION layer.
 *
 * CREATE_INLINE must never mean CREATE_BLINDLY. Before the shared engine offers
 * to create a new hotel-defined classification record from a spreadsheet value,
 * it runs this analysis:
 *
 *   1. objective normalisation  — whitespace, casing, punctuation, connectors;
 *   2. a second search of the hotel's own canonical records, using the
 *      normalised form, so a different spelling never creates a second record;
 *   3. comparison against the other unresolved values in the same batch, so
 *      "F&B", "f/b" and "food and beverage" are offered as one proposal;
 *   4. a proposed canonical spelling where the evidence is objective;
 *   5. a hard separation between ORTHOGRAPHIC similarity (spelling, casing,
 *      punctuation, abbreviation — NEØ may propose a correction) and SEMANTIC
 *      similarity (Cutlery vs Cookware vs Utensils — NEØ explains and stops).
 *
 * Nothing here writes anything, and nothing here applies to governed masters.
 * Employees, guests, suppliers, corporate accounts, ledger accounts and tax
 * configuration are excluded by contract: two similar names there are routinely
 * two genuinely different entities.
 */
import { cleanCell, normaliseHeader, similarity, titleCase } from "./engine-primitives";
import type { MatchPolicy } from "./matching";
import type { MasterOption } from "./engine";

/** Objective English spelling repairs. Generic orthography, never hotel facts. */
const SPELLING_REPAIRS: Record<string, string> = {
  knive: "knives",
  knifes: "knives",
  cuttlery: "cutlery",
  cutlary: "cutlery",
  utencils: "utensils",
  utensil: "utensils",
  stationaery: "stationery",
  stationary: "stationery",
  statinery: "stationery",
  equipments: "equipment",
  furnitures: "furniture",
  linnen: "linen",
  crokery: "crockery",
  crockeries: "crockery",
  beddings: "bedding",
  applicance: "appliance",
  appliaces: "appliances",
  electronic: "electronics",
  maintainance: "maintenance",
  mantainance: "maintenance",
  houskeeping: "housekeeping",
  housekeeing: "housekeeping",
  bevarage: "beverage",
  beverages: "beverage",
  kitchenware: "kitchenware",
};

/** Objective abbreviation expansions for connectors and common short forms. */
const ABBREVIATIONS: Record<string, string> = {
  "f b": "food & beverage",
  fnb: "food & beverage",
  fb: "food & beverage",
  "f and b": "food & beverage",
  "food and beverage": "food & beverage",
  hk: "housekeeping",
  "h k": "housekeeping",
  fo: "front office",
  "f o": "front office",
  "b o h": "back of house",
  boh: "back of house",
  "a v": "audio visual",
  av: "audio visual",
  it: "IT",
};

/** How an imported spelling relates to the canonical value NEØ proposes. */
export type CanonicalKind =
  | "already_canonical"
  | "format_variant"
  | "spelling_variant"
  | "abbreviation"
  | "existing_record";

export type SemanticNeighbour = {
  label: string;
  optionId: string | null;
  score: number;
  /** Why NEØ is raising it — and why it is refusing to decide. */
  reason: string;
};

export type CanonicalProposal = {
  /** false for governed masters: no canonicalisation, no proposal, no create. */
  allowed: boolean;
  raw: string;
  /** Objectively normalised form — whitespace, casing, punctuation only. */
  normalised: string;
  /** What NEØ suggests the canonical record should be called. Editable. */
  proposed: string;
  kind: CanonicalKind;
  confidence: number;
  reason: string;
  /** An existing canonical record the normalised value already refers to. */
  existingMatch: MasterOption | null;
  /** Other spellings in this same batch that are variants of the same concept. */
  variants: string[];
  /** Related but possibly different business concepts. Explained, never merged. */
  semanticNeighbours: SemanticNeighbour[];
  /** True when NEØ has raised something a human must settle before creating. */
  requiresHumanJudgment: boolean;
};

/** Strips punctuation noise and connector spellings without changing meaning. */
export function normaliseCanonical(value: string): string {
  const base = cleanCell(value)
    .replace(/[_]+/g, " ")
    .replace(/\s*[/\\|]\s*/g, " ")
    .replace(/\s*&\s*/g, " & ")
    .replace(/[.,;:]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return base;
}

function lookupKey(value: string): string {
  return normaliseHeader(value).replace(/&/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** Applies objective spelling/abbreviation repair, word by word and whole-phrase. */
function repair(value: string): { text: string; kind: CanonicalKind } {
  const key = lookupKey(value);
  const phrase = ABBREVIATIONS[key];
  if (phrase) return { text: phrase, kind: "abbreviation" };

  let changed = false;
  const words = normaliseCanonical(value)
    .split(" ")
    .map((word) => {
      const bare = word.toLowerCase().replace(/[^a-z]/g, "");
      const fixed = SPELLING_REPAIRS[bare];
      if (fixed && fixed !== bare) {
        changed = true;
        return fixed;
      }
      return word;
    });
  return { text: words.join(" "), kind: changed ? "spelling_variant" : "already_canonical" };
}

/** "utensils" → "Utensils"; "food & beverage" → "Food & Beverage". A proposal only. */
export function canonicalCasing(value: string): string {
  const cleaned = normaliseCanonical(value);
  return cleaned
    .split(" ")
    .map((word) => {
      if (word === "&") return "&";
      // Existing all-caps short forms the hotel typed deliberately (IT, VIP).
      if (word.length <= 3 && word === word.toUpperCase() && /[A-Z]/.test(word)) return word;
      return titleCase(word);
    })
    .join(" ");
}

/**
 * Orthographic closeness: are these two labels the same word, differing only in
 * spelling, casing, punctuation or a connector? Deliberately stricter than the
 * general similarity score, which also rewards shared tokens between genuinely
 * different concepts ("Kitchen Equipment" vs "Kitchen Utensils").
 */
export function orthographicallySame(a: string, b: string): boolean {
  const x = lookupKey(repair(a).text);
  const y = lookupKey(repair(b).text);
  if (!x || !y) return false;
  if (x === y) return true;
  // Same single word, one of them pluralised.
  if (!x.includes(" ") && !y.includes(" ")) {
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    if (long === `${short}s` || long === `${short}es`) return true;
  }
  return false;
}

/** Stable clustering key: the same key means the same spelling of one concept. */
export function canonicalKey(value: string): string {
  const key = lookupKey(repair(normaliseCanonical(value)).text);
  // Singular/plural of a single word is one concept, not two.
  if (!key.includes(" ")) return key.replace(/(?:es|s)$/, "");
  return key;
}

function isSemanticNeighbour(a: string, b: string): boolean {
  return !orthographicallySame(a, b) && similarity(a, b) >= 0.45;
}

/**
 * The shared canonicalisation and duplicate-prevention step.
 *
 * @param value      the spelling found in the file
 * @param policy     the adapter-declared contract for this relationship
 * @param existing   the hotel's own canonical records for this relationship
 * @param batchValues other unresolved values for the same relationship in this batch
 */
export function proposeCanonical(
  value: string,
  policy: MatchPolicy,
  existing: MasterOption[] = [],
  batchValues: string[] = [],
): CanonicalProposal {
  const raw = cleanCell(value);
  const normalised = normaliseCanonical(raw);
  const base: CanonicalProposal = {
    allowed: false,
    raw,
    normalised,
    proposed: canonicalCasing(normalised),
    kind: "already_canonical",
    confidence: 0,
    reason: "",
    existingMatch: null,
    variants: [],
    semanticNeighbours: [],
    requiresHumanJudgment: false,
  };

  // Governed masters: similar names are routinely different entities, so NEØ
  // neither canonicalises them nor proposes a new record.
  if (!policy.canonicalise) {
    return {
      ...base,
      proposed: raw,
      reason: `${policy.label} records are governed by ${policy.ownedBy}, where two similar names can be two genuinely different records. NEØ will not propose a canonical spelling here.`,
    };
  }

  const repaired = repair(normalised);
  const proposed = canonicalCasing(repaired.text);

  // 2. Search the hotel's own records again, using the normalised/proposed form.
  const existingMatch =
    existing.find((option) => orthographicallySame(proposed, option.label)) ??
    existing.find((option) => (option.aliases ?? []).some((alias) => orthographicallySame(proposed, alias))) ??
    null;

  // 3. Other spellings of the same concept inside this batch. Distinct values
  // only, and bounded, so analysis stays linear on a very large file.
  const scanned = [...new Set(batchValues.map((v) => cleanCell(v)))].slice(0, 400);
  const variants = scanned
    .filter((other) => cleanCell(other).toLowerCase() !== raw.toLowerCase())
    .filter((other) => orthographicallySame(proposed, other))
    .map((other) => cleanCell(other));

  // 5. Related-but-different concepts: explained, never merged.
  const semanticNeighbours: SemanticNeighbour[] = [
    ...existing
      .filter((option) => isSemanticNeighbour(proposed, option.label))
      .map((option) => ({
        label: option.label,
        optionId: option.id,
        score: Math.round(similarity(proposed, option.label) * 100) / 100,
        reason: `“${proposed}” resembles your existing “${option.label}”, but they may be genuinely different classifications. NEØ will not decide that for you.`,
      })),
    ...scanned
      .filter((other) => cleanCell(other).toLowerCase() !== raw.toLowerCase())
      .filter((other) => isSemanticNeighbour(proposed, other))
      .map((other) => ({
        label: cleanCell(other),
        optionId: null,
        score: Math.round(similarity(proposed, other) * 100) / 100,
        reason: `“${cleanCell(other)}” also appears in this file and is related, but it may be a different classification.`,
      })),
  ]
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  if (existingMatch) {
    return {
      ...base,
      allowed: true,
      proposed: existingMatch.label,
      kind: "existing_record",
      confidence: 1,
      existingMatch,
      variants,
      semanticNeighbours,
      reason: `You already have “${existingMatch.label}”. NEØ will not create a second record for a different spelling of it.`,
      requiresHumanJudgment: false,
    };
  }

  const kind: CanonicalKind =
    repaired.kind !== "already_canonical"
      ? repaired.kind
      : proposed !== raw
        ? "format_variant"
        : "already_canonical";

  const reason =
    kind === "abbreviation"
      ? `“${raw}” looks like a short form. NEØ proposes “${proposed}” — confirm it or keep your own wording.`
      : kind === "spelling_variant"
        ? `“${raw}” looks like a spelling variant. NEØ proposes “${proposed}” — confirm it, edit it, or keep “${raw}” if that is genuinely what you mean.`
        : kind === "format_variant"
          ? `NEØ proposes “${proposed}” — the same value, tidied for spacing and capitalisation.`
          : `“${proposed}” is not yet configured in ${policy.ownedBy}.`;

  return {
    ...base,
    allowed: true,
    proposed,
    kind,
    confidence: kind === "already_canonical" ? 0.5 : kind === "format_variant" ? 0.8 : 0.7,
    reason,
    existingMatch: null,
    variants,
    semanticNeighbours,
    requiresHumanJudgment: semanticNeighbours.length > 0 || variants.length > 0,
  };
}

/** One canonical concept and every spelling of it found in one batch. */
export type VariantCluster = {
  canonical: string;
  members: string[];
  existingMatch: MasterOption | null;
};

/**
 * Groups a batch's unresolved values for one relationship into canonical
 * clusters, so a hotel makes one decision instead of five near-identical ones.
 */
export function variantClusters(
  values: string[],
  policy: MatchPolicy,
  existing: MasterOption[] = [],
): VariantCluster[] {
  if (!policy.canonicalise) return [];
  // Keyed grouping, not pairwise comparison: a ten-thousand-row file must
  // cluster in one pass.
  const byKey = new Map<string, VariantCluster>();
  for (const value of values) {
    const member = cleanCell(value);
    if (!member) continue;
    const key = canonicalKey(member);
    const found = byKey.get(key);
    if (found) {
      if (!found.members.includes(member)) found.members.push(member);
      continue;
    }
    const proposal = proposeCanonical(member, policy, existing, []);
    byKey.set(key, {
      canonical: proposal.proposed,
      members: [member],
      existingMatch: proposal.existingMatch,
    });
  }
  return [...byKey.values()];
}
