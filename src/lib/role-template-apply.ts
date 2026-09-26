/**
 * Reconciling a role with its recommended template.
 *
 * The defect this fixes was generic, not specific to one role: the screen
 * reported "Success" while permissions were still missing, because the missing
 * list and the apply routine resolved the template differently. The database
 * now resolves both through one routine, applies every grant idempotently,
 * re-reads the persisted rows and refuses to return success while anything the
 * template asks for is still absent.
 *
 * This module holds the one place the client decides what the returned result
 * means, so the button can never claim more than the database proved.
 */

export type ApplyResult = {
  ok?: boolean;
  verified?: boolean;
  role?: string;
  role_key?: string;
  added?: number;
  removed?: number;
  expected?: number;
  missing_after?: number;
  unavailable?: { module: string; action: string }[];
};

export type ApplyOutcome =
  | { kind: "reconciled"; message: string; unavailable: number }
  | { kind: "incomplete"; message: string; missing: number }
  | { kind: "failed"; message: string };

export type TemplateStatus = {
  status: "approved" | "custom" | "retired" | "incomplete";
  role_key: string | null;
  template_rows: number;
};

export function parseTemplateStatus(value: unknown): TemplateStatus {
  if (!value || typeof value !== "object") {
    throw new Error("The database did not return a role-template status.");
  }
  const row = value as Partial<TemplateStatus>;
  if (!["approved", "custom", "retired", "incomplete"].includes(row.status ?? "")) {
    throw new Error("The database returned an unknown role-template status.");
  }
  return {
    status: row.status!,
    role_key: typeof row.role_key === "string" ? row.role_key : null,
    template_rows: Number(row.template_rows ?? 0),
  };
}

/**
 * Turns the database result into an honest outcome.
 *
 * - `reconciled` only when the database verified zero remaining gaps.
 * - `incomplete` when rows remain missing — never shown as success.
 * - `failed` when the result is absent or unreadable.
 */
export function interpretApplyResult(result: unknown, reset = false): ApplyOutcome {
  if (!result || typeof result !== "object") {
    return { kind: "failed", message: "The role was not reconciled: the database returned no result." };
  }
  const r = result as ApplyResult;
  const missing = Number(r.missing_after ?? 0);
  const added = Number(r.added ?? 0);
  const removed = Number(r.removed ?? 0);
  const unavailable = Array.isArray(r.unavailable) ? r.unavailable.length : 0;

  if (r.ok !== true || r.verified !== true || !Number.isFinite(missing) || missing > 0) {
    return {
      kind: "incomplete",
      missing: Number.isFinite(missing) ? missing : -1,
      message:
        missing > 0
          ? `Not applied: ${missing} recommended permission${missing === 1 ? "" : "s"} could not be saved. The role is unchanged in that respect.`
          : "Not applied: the database could not confirm the role was reconciled.",
    };
  }

  const parts: string[] = [];
  // A repeat click legitimately adds nothing — that is success, not a failure.
  parts.push(added === 0 ? "Already aligned with the template" : `${added} permission${added === 1 ? "" : "s"} added`);
  if (reset && removed > 0) parts.push(`${removed} removed`);
  return {
    kind: "reconciled",
    unavailable,
    message: `${parts.join(", ")} · 0 missing`,
  };
}
