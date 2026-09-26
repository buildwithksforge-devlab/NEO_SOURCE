/**
 * NEØ Intelligent Data Onboarding — the universal resolution model.
 *
 * Detection is not resolution. Telling a hotel "Category name is required and
 * is empty" on seven rows is a finding; giving it a way to settle those seven
 * rows without going back to Excel is the product.
 *
 * Every issue the shared engine raises is classified into one of six classes,
 * and each class carries the remedies that are safe for it. Adapters keep
 * their own business meaning — this module only decides what kind of problem
 * a finding is and what a human is allowed to do about it.
 */
import type { OnboardingDomain, RelationshipTarget } from "./domains";
import type { DecisionGroup, DuplicateGroup, ImportPlan, MasterOption, PreparedRow, ProfileReport } from "./engine";
import { cleanCell, similarity } from "./engine-primitives";
import { hasCapability, type MatchPolicy, type ResolutionCapability } from "./matching";

export type ResolutionClass =
  | "safe_normalisation"
  | "canonical_match"
  | "business_decision"
  | "missing_required"
  | "duplicate"
  | "unsafe";

export const RESOLUTION_CLASS_META: Record<ResolutionClass, { label: string; explain: string }> = {
  safe_normalisation: {
    label: "Cleaned automatically",
    explain: "Objectively safe tidying — spacing, capitalisation, date and number formats. No business meaning changed.",
  },
  canonical_match: {
    label: "Match proposed",
    explain: "NEØ found an existing record this value probably refers to. Accept it, choose another, or leave it unassigned.",
  },
  business_decision: {
    label: "Your decision",
    explain: "NEØ can rank the possibilities from the rest of the row, but the answer is a business judgement.",
  },
  missing_required: {
    label: "Required value missing",
    explain: "The record cannot be created without this. Supply it here, take it from another column, or hold the row back.",
  },
  duplicate: {
    label: "Duplicate candidate",
    explain: "This row may already exist. Skip it, import it separately, or update the existing record where the adapter allows it.",
  },
  unsafe: {
    label: "Cannot proceed",
    explain: "Resolving this would mean inventing a business fact, so NEØ blocks the row and keeps it for correction.",
  },
};

/** What a human may do about one finding. */
export type RemedyKind =
  | "accept_match"
  | "choose_existing"
  | "create_new"
  | "leave_unassigned"
  | "enter_value"
  | "map_from_column"
  | "apply_to_selected"
  | "apply_to_group"
  | "skip_rows"
  | "keep_blocked"
  | "import_separately"
  | "update_existing"
  | "review_individually";

export type Remedy = { kind: RemedyKind; label: string; detail: string };

const REMEDY: Record<RemedyKind, Remedy> = {
  accept_match: { kind: "accept_match", label: "Accept the proposed match", detail: "Applies to every row carrying this value." },
  choose_existing: { kind: "choose_existing", label: "Choose an existing record", detail: "Pick the right one from your configured records." },
  create_new: { kind: "create_new", label: "Create this record", detail: "Only where the adapter allows new records to be created during import." },
  leave_unassigned: { kind: "leave_unassigned", label: "Leave unassigned", detail: "The link stays empty and can be completed later." },
  enter_value: { kind: "enter_value", label: "Enter a value", detail: "Type the value NEØ should use." },
  map_from_column: { kind: "map_from_column", label: "Take it from another column", detail: "Use a different column in your file as the source." },
  apply_to_selected: { kind: "apply_to_selected", label: "Apply to selected rows", detail: "Affects only the rows you tick." },
  apply_to_group: { kind: "apply_to_group", label: "Apply to all matching rows", detail: "One decision settles every row with the same problem." },
  skip_rows: { kind: "skip_rows", label: "Skip these rows", detail: "They are excluded from this import and stay in the batch as skipped." },
  keep_blocked: { kind: "keep_blocked", label: "Keep blocked for later", detail: "The rows remain in the batch, unimported, for correction and retry." },
  import_separately: { kind: "import_separately", label: "Import as separate records", detail: "Treats the rows as genuinely different records." },
  update_existing: { kind: "update_existing", label: "Update the existing record", detail: "Only where this adapter permits updates." },
  review_individually: { kind: "review_individually", label: "Review row by row", detail: "Open the rows and decide each one." },
};

export function remedies(kinds: RemedyKind[]): Remedy[] {
  return kinds.map((kind) => REMEDY[kind]);
}

/**
 * The shared resolution contract for one relationship target.
 *
 * Guidance, offered actions and blocking state are all read from the
 * capability list, so a screen cannot advertise an action the adapter has not
 * granted — and cannot hide one it has.
 */
export type ResolutionContract = {
  capabilities: ResolutionCapability[];
  canCreateInline: boolean;
  canLeaveUnassigned: boolean;
  handoff: { module: string; route: string } | null;
  /** What NEØ says about this target when no credible match exists. */
  explanation: string;
  /** Rows cannot be imported until this value is settled. */
  blocking: boolean;
};

export function resolutionContract(policy: MatchPolicy): ResolutionContract {
  const canCreateInline = hasCapability(policy, "CREATE_INLINE");
  const canLeaveUnassigned = hasCapability(policy, "LEAVE_UNASSIGNED");
  const handoff = hasCapability(policy, "CREATE_IN_OWNING_MODULE")
    ? { module: policy.ownedBy, route: policy.ownerRoute }
    : null;
  const explanation = canCreateInline
    ? policy.guidance
    : `${policy.label} records are owned by ${policy.ownedBy}. ${policy.guidance}`;
  return {
    capabilities: policy.capabilities,
    canCreateInline,
    canLeaveUnassigned,
    handoff,
    explanation,
    blocking: !canCreateInline && !canLeaveUnassigned,
  };
}

/** Classifies a value-resolution group into its class, with its remedies. */
export function classifyDecisionGroup(group: DecisionGroup): {
  resolutionClass: ResolutionClass;
  remedies: Remedy[];
} {
  if (group.state === "resolved") {
    return { resolutionClass: "safe_normalisation", remedies: [] };
  }
  const contract = resolutionContract(group.policy);
  const base: RemedyKind[] = ["choose_existing"];
  if (contract.canCreateInline) base.push("create_new");
  if (contract.canLeaveUnassigned) base.push("leave_unassigned");
  base.push("apply_to_group");

  if (group.credible && group.suggestion) {
    return { resolutionClass: "canonical_match", remedies: remedies(["accept_match", ...base]) };
  }
  if (contract.blocking) {
    // The link is mandatory and the adapter forbids creating the target here:
    // there is no safe automatic answer.
    return { resolutionClass: "unsafe", remedies: remedies(["choose_existing", "skip_rows", "keep_blocked"]) };
  }
  return { resolutionClass: "business_decision", remedies: remedies(base) };
}

export function classifyDuplicateGroup(group: DuplicateGroup, canUpdate: boolean): {
  resolutionClass: ResolutionClass;
  remedies: Remedy[];
} {
  const kinds: RemedyKind[] = ["skip_rows", "import_separately"];
  if (canUpdate && group.scope === "existing") kinds.push("update_existing");
  kinds.push("apply_to_selected", "review_individually");
  return { resolutionClass: "duplicate", remedies: remedies(kinds) };
}

// ------------------------------------------------ missing required values

/** One required field left empty, grouped across every row that shares the gap. */
export type MissingValueGroup = {
  fieldKey: string;
  fieldLabel: string;
  resolutionClass: ResolutionClass;
  rowNumbers: number[];
  occurrences: number;
  /** Ranked possibilities read from the rest of each row. Proposals, never facts. */
  evidence: { label: string; optionId: string | null; reason: string; confidence: number }[];
  /** Other columns in the file that could supply this value. */
  alternativeColumns: string[];
  remedies: Remedy[];
};

/**
 * Ranks existing master records against the other values on a row.
 *
 * This is the cross-column intelligence the brief asks for: an asset called
 * "Samsung 55-inch Smart TV" sitting in a guest room is evidence for some of
 * the hotel's own categories over others. It produces a ranking, never an
 * answer — nothing here writes a value.
 */
export function rankByRowEvidence(
  row: PreparedRow,
  options: MasterOption[],
  excludeField: string,
): { label: string; optionId: string | null; reason: string; confidence: number }[] {
  const context = Object.entries(row.values)
    .filter(([key, value]) => key !== excludeField && cleanCell(value).length > 1)
    .map(([, value]) => cleanCell(value));
  if (!context.length || !options.length) return [];

  const scored = options.map((option) => {
    let best = 0;
    let from = "";
    for (const value of context) {
      const score = Math.max(
        similarity(value, option.label),
        ...(option.aliases ?? []).map((alias) => similarity(value, alias)),
      );
      if (score > best) {
        best = score;
        from = value;
      }
    }
    return {
      label: option.label,
      optionId: option.id,
      reason: from ? `"${from}" elsewhere on this row resembles ${option.label}.` : "",
      confidence: Math.round(best * 100) / 100,
    };
  });

  return scored.filter((s) => s.confidence >= 0.45).sort((a, b) => b.confidence - a.confidence).slice(0, 3);
}

/**
 * Groups every row blocked by the same empty required field, so a hotel makes
 * one decision instead of five thousand.
 */
export function missingValueGroups(
  domain: OnboardingDomain,
  prepared: PreparedRow[],
  context: {
    masters?: Partial<Record<RelationshipTarget, MasterOption[]>>;
    availableColumns?: string[];
    mappedColumns?: string[];
  } = {},
): MissingValueGroup[] {
  const required = domain.fields.filter((f) => f.requirement === "required");
  const unmapped = (context.availableColumns ?? []).filter((c) => !(context.mappedColumns ?? []).includes(c));
  const groups: MissingValueGroup[] = [];

  for (const field of required) {
    const rows = prepared.filter((row) => !cleanCell(row.values[field.key] ?? ""));
    if (!rows.length) continue;

    const options = field.relationship ? ((context.masters ?? {})[field.relationship] ?? []) : [];
    const evidence = new Map<string, { label: string; optionId: string | null; reason: string; confidence: number }>();
    for (const row of rows.slice(0, 50)) {
      for (const candidate of rankByRowEvidence(row, options, field.key)) {
        const existing = evidence.get(candidate.label);
        if (!existing || candidate.confidence > existing.confidence) evidence.set(candidate.label, candidate);
      }
    }

    const ranked = [...evidence.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 3);

    groups.push({
      fieldKey: field.key,
      fieldLabel: field.label,
      // Where the row carries evidence it is a judgement call; where it carries
      // none, it is simply a value nobody recorded.
      resolutionClass: ranked.length ? "business_decision" : "missing_required",
      rowNumbers: rows.map((r) => r.rowNumber),
      occurrences: rows.length,
      evidence: ranked,
      alternativeColumns: unmapped,
      remedies: remedies([
        "enter_value",
        ...(unmapped.length ? (["map_from_column"] as RemedyKind[]) : []),
        "apply_to_group",
        "apply_to_selected",
        "skip_rows",
        "keep_blocked",
      ]),
    });
  }

  return groups.sort((a, b) => b.occurrences - a.occurrences);
}

// ------------------------------------------------------- summary language

/**
 * Honest counters.
 *
 * The old summary could say "0 values to decide" beside "109 possible
 * duplicates" and "7 rows needing attention", which reads as "you are done"
 * when you are not. These counters name each concept separately and state
 * plainly whether anything is outstanding.
 */
export type SummaryCounters = {
  sourceRows: number;
  unresolvedReferenceValues: number;
  duplicateCandidates: number;
  undecidedDuplicates: number;
  blockedRows: number;
  rowsAwaitingAction: number;
  readyRows: number;
  everythingSettled: boolean;
  statement: string;
};

export function summaryCounters(
  profile: ProfileReport,
  plan: ImportPlan,
  decidedRowNumbers: number[] = [],
): SummaryCounters {
  const decided = new Set(decidedRowNumbers);
  const unresolvedReferenceValues = profile.decisionGroups.length;
  const duplicateCandidates = profile.duplicates;
  const undecidedDuplicates = profile.duplicateGroups
    .flatMap((g) => g.rowNumbers)
    .filter((n) => !decided.has(n)).length;
  const blockedRows = profile.blockers;
  const rowsAwaitingAction =
    plan.awaitingIdentifierDecision + plan.awaitingValueDecision + undecidedDuplicates + blockedRows;
  const everythingSettled = rowsAwaitingAction === 0 && unresolvedReferenceValues === 0;

  const statement = everythingSettled
    ? "Nothing outstanding — every row has a settled outcome."
    : [
        unresolvedReferenceValues ? `${unresolvedReferenceValues} unresolved reference value(s)` : "",
        undecidedDuplicates ? `${undecidedDuplicates} duplicate candidate(s) awaiting a decision` : "",
        blockedRows ? `${blockedRows} blocked row(s)` : "",
      ]
        .filter(Boolean)
        .join(", ") + " still to settle.";

  return {
    sourceRows: profile.total,
    unresolvedReferenceValues,
    duplicateCandidates,
    undecidedDuplicates,
    blockedRows,
    rowsAwaitingAction,
    readyRows: plan.readyNow + plan.readyWithBlanks,
    everythingSettled,
    statement,
  };
}
