/**
 * Canonical department ↔ role scoping for staff assignment.
 *
 * Departments are property-scoped: in a multi-property tenant the same
 * department name exists once per property, so an administrator must only ever
 * see the departments of the property they selected (plus genuinely
 * organisation-wide departments, which carry no `branch_id`).
 *
 * Roles are department-scoped through canonical relationships only — the role's
 * own `department_id` (compared by the department's `catalogue_key`, never by
 * id, so the same department in another property still matches) or, when the
 * role row carries none, the approved catalogue's department label. Nothing here
 * infers scope from a role name. Roles whose access scope is genuinely
 * organisation-wide or technical are always offered.
 *
 * The same rules are enforced server-side by
 * `public.neo_validate_role_assignment`; this module is the interface half of
 * that single contract.
 */

export type ScopedDepartment = {
  id: string;
  name: string;
  branch_id: string | null;
  catalogue_key: string | null;
  active?: boolean | null;
};

export type ScopedRole = {
  id: string;
  name: string;
  access_scope: string | null;
  department_id: string | null;
  normalized_role_key: string | null;
  role_status?: string | null;
  active?: boolean | null;
};

export type CatalogueScope = {
  role_key: string;
  department: string | null;
  access_scope: string | null;
  retired?: boolean | null;
};

/** Scopes that legitimately reach beyond a single department. */
const ORG_WIDE_SCOPES = new Set(["organisation", "technical"]);

/** Role keys retired from the NEØ role model and never offered again. */
export const RETIRED_ROLE_KEYS = new Set(["night-auditor", "porter"]);

/**
 * Canonical department key for a role-catalogue department label. Mirrors
 * `public.neo_department_catalogue_key`. Labels with no single honest
 * equivalent resolve to `null` and are never guessed.
 */
const CATALOGUE_DEPARTMENT_KEYS: Record<string, string> = {
  administration: "administration",
  bar: "bar",
  delivery: "delivery",
  executive: "executive-management",
  "executive management": "executive-management",
  finance: "finance",
  "food beverage": "food-and-beverage",
  "front office": "front-office",
  housekeeping: "housekeeping",
  "human resources": "human-resources",
  "inventory stores": "inventory-and-stores",
  "it systems": "it-and-systems",
  kitchen: "main-kitchen",
  "main kitchen": "main-kitchen",
  laundry: "laundry",
  maintenance: "maintenance",
  marketing: "marketing",
  operations: "operations",
  "pastry bakery": "pastry-and-bakery",
  procurement: "procurement",
  "sales events banqueting": "sales-events-banqueting",
  security: "security",
};

function normalisedDepartmentLabel(label: string | null | undefined): string {
  return (label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+(and|of|the)\s+/g, " ")
    .trim();
}

export function departmentCatalogueKey(label: string | null | undefined): string | null {
  const normalised = normalisedDepartmentLabel(label);
  return CATALOGUE_DEPARTMENT_KEYS[normalised] ?? null;
}

/**
 * The comparable identity of a department.
 *
 * Canonical `catalogue_key` first; when a tenant department carries none (most
 * hotel-created departments do not), the normalised department name is used so
 * the role's own `department_id` relationship still decides. Falling straight
 * through to "cannot be proven invalid" made every role selectable in every
 * department, which is the defect this closes.
 */
export function departmentIdentity(
  department: Pick<ScopedDepartment, "name" | "catalogue_key"> | null | undefined,
): string | null {
  if (!department) return null;
  return (
    department.catalogue_key ??
    departmentCatalogueKey(department.name) ??
    (normalisedDepartmentLabel(department.name) || null)
  );
}

/** Identity for a role-catalogue department label (no department row exists). */
export function catalogueDepartmentIdentity(label: string | null | undefined): string | null {
  return departmentCatalogueKey(label) ?? (normalisedDepartmentLabel(label) || null);
}

/** Departments an administrator may pick for the selected property. */
export function departmentsForBranch(
  departments: ScopedDepartment[],
  branchId: string | null | undefined,
): ScopedDepartment[] {
  const usable = departments.filter((d) => d.active !== false);
  if (!branchId) return usable;
  return usable.filter((d) => d.branch_id === branchId || d.branch_id === null);
}

/** True when the department may be kept after a property change. */
export function isDepartmentValidForBranch(
  departments: ScopedDepartment[],
  branchId: string | null | undefined,
  departmentId: string | null | undefined,
): boolean {
  if (!departmentId) return true;
  return departmentsForBranch(departments, branchId).some((d) => d.id === departmentId);
}

export function isOrgWideRole(role: ScopedRole, catalogue: CatalogueScope[] = []): boolean {
  const cat = catalogue.find((c) => c.role_key === role.normalized_role_key);
  const scope = role.access_scope ?? cat?.access_scope ?? null;
  return Boolean(scope && ORG_WIDE_SCOPES.has(scope));
}

export function isRetiredRole(role: ScopedRole, catalogue: CatalogueScope[] = []): boolean {
  const cat = catalogue.find((c) => c.role_key === role.normalized_role_key);
  return (
    role.active === false ||
    role.role_status === "archived" ||
    Boolean(cat?.retired) ||
    (role.normalized_role_key ? RETIRED_ROLE_KEYS.has(role.normalized_role_key) : false)
  );
}

/**
 * The canonical department key a role belongs to, or `null` when the role has no
 * canonical department relationship at all (bespoke tenant roles).
 */
export function roleDepartmentKey(
  role: ScopedRole,
  departments: ScopedDepartment[],
  catalogue: CatalogueScope[] = [],
): string | null {
  const own = departments.find((d) => d.id === role.department_id);
  if (own) return departmentIdentity(own);
  const cat = catalogue.find((c) => c.role_key === role.normalized_role_key);
  return catalogueDepartmentIdentity(cat?.department ?? null);
}

/**
 * Roles that may be assigned alongside the selected department. With no
 * department selected only organisation-wide roles are offered — never the
 * whole catalogue.
 */
export function rolesForDepartment(
  roles: ScopedRole[],
  departments: ScopedDepartment[],
  departmentId: string | null | undefined,
  catalogue: CatalogueScope[] = [],
): ScopedRole[] {
  const live = roles.filter((r) => !isRetiredRole(r, catalogue));
  const selected = departments.find((d) => d.id === departmentId);
  return live.filter((role) => {
    if (isOrgWideRole(role, catalogue)) return true;
    if (!selected) return false;
    const key = roleDepartmentKey(role, departments, catalogue);
    // No department relationship of any kind: cannot be proven invalid.
    if (!key) return true;
    return key === departmentIdentity(selected);
  });
}

/** Drops role selections that the newly selected department no longer permits. */
export function pruneRoleIds(
  roleIds: string[],
  roles: ScopedRole[],
  departments: ScopedDepartment[],
  departmentId: string | null | undefined,
  catalogue: CatalogueScope[] = [],
): string[] {
  const allowed = new Set(
    rolesForDepartment(roles, departments, departmentId, catalogue).map((r) => r.id),
  );
  return roleIds.filter((id) => allowed.has(id));
}
