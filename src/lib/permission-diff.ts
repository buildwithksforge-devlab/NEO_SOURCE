/**
 * Before-and-after review for role permission changes.
 *
 * Role editing is staged: ticking the matrix changes a local draft only, and the
 * draft is compared with the saved state so the administrator reviews exactly
 * which capabilities are being granted and which are being taken away before
 * anything is written. The comparison is pure so the same logic is used by the
 * review dialog and by the regression tests.
 */

export type PermissionRef = {
  id: string;
  module: string;
  feature: string | null;
  action: string;
};

export type PermissionDiff = {
  added: PermissionRef[];
  removed: PermissionRef[];
  unchanged: number;
  /** Number of capabilities the role will hold once saved. */
  total: number;
};

/** `module.feature.action`, with `*` standing for a whole-module grant. */
export function permissionKey(ref: Pick<PermissionRef, "module" | "feature" | "action">): string {
  return `${ref.module}.${ref.feature ?? "*"}.${ref.action}`;
}

/** Human label for one capability row in the review list. */
export function permissionLabel(
  ref: PermissionRef,
  labels?: { modules?: Record<string, string>; actions?: Record<string, string> },
): string {
  const module = labels?.modules?.[ref.module] ?? ref.module;
  const feature = !ref.feature || ref.feature === "*" ? "Whole module" : ref.feature.replace(/-/g, " ");
  const action = labels?.actions?.[ref.action] ?? ref.action;
  return `${module} · ${feature} · ${action}`;
}

/**
 * Compares the saved permission ids with the draft. Unknown ids (a permission
 * removed from the catalogue) are still reported, using their id, so a change is
 * never hidden from review.
 */
export function diffPermissionSets(
  saved: Iterable<string>,
  draft: Iterable<string>,
  index: Map<string, PermissionRef>,
): PermissionDiff {
  const before = new Set(saved);
  const after = new Set(draft);
  const resolve = (id: string): PermissionRef =>
    index.get(id) ?? { id, module: "unknown", feature: null, action: id };

  const added: PermissionRef[] = [];
  const removed: PermissionRef[] = [];
  let unchanged = 0;

  for (const id of after) {
    if (before.has(id)) unchanged += 1;
    else added.push(resolve(id));
  }
  for (const id of before) {
    if (!after.has(id)) removed.push(resolve(id));
  }

  const sort = (a: PermissionRef, b: PermissionRef) =>
    permissionKey(a).localeCompare(permissionKey(b));
  added.sort(sort);
  removed.sort(sort);

  return { added, removed, unchanged, total: after.size };
}

/** Groups one side of the diff by module so the review reads module by module. */
export function groupPermissionsByModule(
  refs: PermissionRef[],
): Array<{ module: string; permissions: PermissionRef[] }> {
  const byModule = new Map<string, PermissionRef[]>();
  for (const ref of refs) {
    const list = byModule.get(ref.module) ?? [];
    list.push(ref);
    byModule.set(ref.module, list);
  }
  return [...byModule.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, permissions]) => ({ module, permissions }));
}

export function isEmptyDiff(diff: PermissionDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0;
}

/** One-line summary used on the pending-changes bar and in the audit reason. */
export function describePermissionDiff(diff: PermissionDiff): string {
  if (isEmptyDiff(diff)) return "No pending changes";
  const parts: string[] = [];
  if (diff.added.length) parts.push(`${diff.added.length} added`);
  if (diff.removed.length) parts.push(`${diff.removed.length} removed`);
  return parts.join(" · ");
}
