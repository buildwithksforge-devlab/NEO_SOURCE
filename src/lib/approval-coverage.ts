/**
 * Canonical approval-policy resolution.
 *
 * One module answers two questions that must never disagree:
 *
 *   1. *Runtime* — for this transaction type, property, currency and amount,
 *      which configured rule applies? This mirrors the database routine
 *      `neo_approval_route` exactly: property-specific rules outrank
 *      organisation-wide ones, then the lowest approval level whose band
 *      covers the amount wins.
 *   2. *Configuration* — given the saved rules, which amounts would reach
 *      nobody (a real gap) and which bands contradict each other (an overlap
 *      at the same level)?
 *
 * Nothing here knows a hotel's figures, currency, roles or number of approval
 * levels. Every threshold is read from the saved policy.
 */

export type CoverageRule = {
  id?: string;
  approval_type: string;
  level: number;
  branch_id: string | null;
  approver_role_id?: string | null;
  approver_user_id?: string | null;
  min_amount: number | null;
  max_amount: number | null;
  currency?: string | null;
  effective_from?: string | null;
  effective_to?: string | null;
  active: boolean;
};

export type Scope = { id: string | null; name: string };

const DEFAULT_CURRENCY_KEY = "__workspace__";

function isoToday(onDate?: Date): string {
  const d = onDate ?? new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Is this rule in force on the given day? Historic rules stay as evidence. */
export function isInForce(rule: CoverageRule, onDate?: Date): boolean {
  if (!rule.active) return false;
  const today = isoToday(onDate);
  if (rule.effective_from && rule.effective_from > today) return false;
  if (rule.effective_to && rule.effective_to < today) return false;
  return true;
}

/**
 * The smallest amount a hotel can actually enter for this policy.
 *
 * A policy written in whole units (0–100,000 then 100,001–500,000) is
 * continuous authority, not a one-shilling hole. So the step is 1 when every
 * configured edge is a whole number, and the currency's minor unit otherwise.
 */
export function amountStep(currency: string | null | undefined, rules: CoverageRule[]): number {
  const edges = rules.flatMap((r) =>
    [r.min_amount, r.max_amount].filter((v): v is number => v !== null && v !== undefined),
  );
  const allWhole = edges.every((v) => Number.isInteger(v));
  if (allWhole) return 1;
  let digits = 2;
  try {
    if (currency && /^[A-Za-z]{3}$/.test(currency)) {
      digits =
        new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() })
          .resolvedOptions().maximumFractionDigits ?? 2;
    }
  } catch {
    digits = 2;
  }
  return Number((10 ** -digits).toFixed(digits));
}

/** Does this rule's currency apply to a transaction in `currency`? */
function currencyMatches(rule: CoverageRule, currency: string | null): boolean {
  const own = rule.currency?.trim().toUpperCase() || null;
  if (!own || !currency) return true;
  return own === currency.trim().toUpperCase();
}

/**
 * The rules that could apply to a transaction, in the order the runtime router
 * considers them: property-specific first, then by approval level.
 * Another property's rules are never included.
 */
export function effectiveRules(
  rules: CoverageRule[],
  ctx: { type: string; branchId?: string | null; currency?: string | null; onDate?: Date },
): CoverageRule[] {
  const currency = ctx.currency ?? null;
  return rules
    .filter(
      (r) =>
        r.approval_type === ctx.type &&
        isInForce(r, ctx.onDate) &&
        (r.branch_id === null || r.branch_id === ctx.branchId) &&
        currencyMatches(r, currency),
    )
    .sort((a, b) => {
      const scope = Number(b.branch_id !== null) - Number(a.branch_id !== null);
      if (scope !== 0) return scope;
      return (a.level ?? 1) - (b.level ?? 1);
    });
}

/** Which configured rule approves this amount? `null` when none does. */
export function resolveApprovalRule(
  rules: CoverageRule[],
  ctx: {
    type: string;
    amount: number;
    branchId?: string | null;
    currency?: string | null;
    onDate?: Date;
  },
): CoverageRule | null {
  for (const r of effectiveRules(rules, ctx)) {
    if (r.min_amount !== null && ctx.amount < r.min_amount) continue;
    if (r.max_amount !== null && ctx.amount > r.max_amount) continue;
    return r;
  }
  return null;
}

export type CoverageIssue = {
  kind: "gap" | "overlap";
  type: string;
  typeName: string;
  scope: string;
  currency: string;
  message: string;
};

export type LadderBand = {
  from: number;
  to: number | null;
  rule: CoverageRule;
  orgWide: boolean;
};

/** A readable authority ladder for one type, property and currency. */
export function authorityLadder(
  rules: CoverageRule[],
  ctx: { type: string; branchId?: string | null; currency?: string | null; onDate?: Date },
): LadderBand[] {
  return effectiveRules(rules, ctx)
    .map((r) => ({
      from: r.min_amount ?? 0,
      to: r.max_amount,
      rule: r,
      orgWide: r.branch_id === null,
    }))
    .sort((a, b) => a.from - b.from || (a.rule.level ?? 1) - (b.rule.level ?? 1));
}

function fmt(v: number): string {
  return v.toLocaleString();
}

/**
 * Real gaps and contradictory overlaps in the saved policy.
 *
 * Scopes are evaluated the way the router resolves them: for each property the
 * effective policy is that property's own rules *plus* the organisation-wide
 * ones, so a group-wide ceiling rule never makes lower property authority
 * vanish, and a property's own bands never mask another property's gap.
 */
export function findCoverageIssues(
  rules: CoverageRule[],
  ctx: {
    types: ReadonlyArray<{ key: string; name: string }>;
    branches?: ReadonlyArray<{ id: string; name: string }>;
    currencyLabel?: string;
    onDate?: Date;
  },
): CoverageIssue[] {
  const live = rules.filter((r) => isInForce(r, ctx.onDate));
  const out: CoverageIssue[] = [];

  for (const type of ctx.types) {
    const ofType = live.filter((r) => r.approval_type === type.key);
    if (ofType.length === 0) continue;

    const currencies = new Set(
      ofType.map((r) => r.currency?.trim().toUpperCase() || DEFAULT_CURRENCY_KEY),
    );

    const scopes: Scope[] =
      ctx.branches && ctx.branches.length > 0
        ? ctx.branches.map((b) => ({ id: b.id, name: b.name }))
        : (() => {
            const own = [...new Set(ofType.map((r) => r.branch_id).filter(Boolean))] as string[];
            return own.length > 0
              ? own.map((id) => ({ id, name: "This property" }))
              : [{ id: null, name: "All properties" }];
          })();

    for (const currencyKey of currencies) {
      const currency = currencyKey === DEFAULT_CURRENCY_KEY ? null : currencyKey;
      const currencyLabel = currency ?? ctx.currencyLabel ?? "workspace currency";

      for (const scope of scopes) {
        const applicable = effectiveRules(ofType, {
          type: type.key,
          branchId: scope.id,
          currency,
          ...(ctx.onDate ? { onDate: ctx.onDate } : {}),
        });
        if (applicable.length === 0) continue;

        const step = amountStep(currency, applicable);
        const bands = [...applicable].sort(
          (a, b) => (a.min_amount ?? 0) - (b.min_amount ?? 0) || (a.level ?? 1) - (b.level ?? 1),
        );

        // Gaps: walk the bands and look for an amount no band covers.
        let covered: number | null = null; // highest amount covered so far
        for (const r of bands) {
          const from = r.min_amount ?? 0;
          const start = covered === null ? 0 : covered + step;
          if (from > start + 1e-9) {
            out.push({
              kind: "gap",
              type: type.key,
              typeName: type.name,
              scope: scope.name,
              currency: currencyLabel,
              message: `${type.name} · ${scope.name} · ${currencyLabel}: no approver is configured for amounts from ${fmt(start)} to ${fmt(from - step)}.`,
            });
          }
          if (r.max_amount === null) {
            covered = Number.POSITIVE_INFINITY;
            break;
          }
          covered = Math.max(covered ?? 0, r.max_amount);
        }

        // Overlaps only matter when two rules at the same level collide: the
        // router resolves different levels deterministically by order.
        for (let i = 0; i < bands.length; i += 1) {
          for (let j = i + 1; j < bands.length; j += 1) {
            const a = bands[i]!;
            const b = bands[j]!;
            if ((a.level ?? 1) !== (b.level ?? 1)) continue;
            if (a.branch_id !== b.branch_id) continue;
            const aTo = a.max_amount ?? Number.POSITIVE_INFINITY;
            const bFrom = b.min_amount ?? 0;
            if (bFrom <= aTo) {
              out.push({
                kind: "overlap",
                type: type.key,
                typeName: type.name,
                scope: scope.name,
                currency: currencyLabel,
                message: `${type.name} · ${scope.name} · ${currencyLabel}: two level ${a.level} rules both claim amounts from ${fmt(bFrom)}. Give them different levels or separate their bands.`,
              });
            }
          }
        }
      }
    }
  }

  // The same rule can be reached through several properties; report once.
  const seen = new Set<string>();
  return out.filter((i) => (seen.has(i.message) ? false : (seen.add(i.message), true)));
}
