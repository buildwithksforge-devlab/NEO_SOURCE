/**
 * Account administration catalogue for the Users page.
 *
 * The Users list stays visually clean, so a person's three-dot menu is the full
 * account administration surface. This module is the single declarative source
 * of that surface: every action names the exact `module.feature.action`
 * capability that authorises it, the group it belongs to and the record states
 * it applies to. The page renders from this catalogue, and the regression tests
 * read the same catalogue — so a future UI simplification cannot silently
 * remove administrative controls again.
 *
 * Authority rules encoded here:
 *  - Owner/Director and IT/System Administrator are equal superusers and
 *    receive the complete catalogue.
 *  - HR receives staff-record and assignment actions through its HR/user
 *    capabilities, and never security or account-administration powers unless a
 *    capability explicitly grants them.
 *  - Ordinary managers hold no `administration.users` security capability, so
 *    password, session, MFA and account-status controls never appear for them.
 *
 * Nothing here performs a mutation: each action is executed by an audited
 * server function, and the interface only decides what to offer.
 */

export type UserActionGroup =
  | "profile"
  | "assignment"
  | "security"
  | "status"
  | "audit";

export const USER_ACTION_GROUP_LABELS: Record<UserActionGroup, string> = {
  profile: "Profile & details",
  assignment: "Assignment & roles",
  security: "Access & security",
  status: "Account status",
  audit: "Audit & history",
};

export const USER_ACTION_GROUP_ORDER: UserActionGroup[] = [
  "profile",
  "assignment",
  "security",
  "status",
  "audit",
];

/** The state of the account a menu is being built for. */
export type UserActionTarget = {
  id: string;
  email: string | null;
  /** login/account state — distinct from employment status */
  account_status: string | null;
  /** HR employment state, shown and changed through HR, never renamed here */
  employment_status: string | null;
  must_change_password: boolean | null;
  invitation_status: string | null;
  mfa_enrolled: boolean | null;
  /** True when the row is the signed-in user's own account. */
  isSelf: boolean;
  /** True when the account currently holds the Owner role. */
  isOwner: boolean;
};

export type CapabilityRef = { module: string; feature: string; action: string };

export type UserAction = {
  id: string;
  label: string;
  group: UserActionGroup;
  /** Primary capability; any one of `alt` also authorises the action. */
  capability: CapabilityRef;
  alt?: CapabilityRef[];
  /** Superusers always receive the action; capability holders receive it too. */
  destructive?: boolean;
  /** Requires a typed/entered reason that is stored on the audit record. */
  requiresReason?: boolean;
  /** Confirmation dialog before the mutation runs. */
  confirm?: boolean;
  /** Never offered for an action that cannot apply to this record's state. */
  applies?: (t: UserActionTarget) => boolean;
};

const cap = (feature: string, action: string): CapabilityRef => ({
  module: "administration",
  feature,
  action,
});

export const USER_ACTIONS: UserAction[] = [
  {
    id: "view_profile",
    label: "View profile & effective access",
    group: "profile",
    capability: cap("users", "view_access"),
    alt: [cap("users", "view")],
  },
  {
    id: "manage_photo",
    label: "Manage official staff photo",
    group: "profile",
    // HR owns the canonical photograph; Owner/System Administrator override it.
    capability: { module: "human-resources", feature: "staff-photos", action: "manage" },
  },
  {
    id: "copy_details",
    label: "Copy account details",
    group: "profile",
    capability: cap("users", "view"),
  },
  {
    id: "edit_assignment",
    label: "Edit staff assignment…",
    group: "assignment",
    capability: cap("users", "edit"),
    alt: [
      cap("users", "assign_property"),
      cap("users", "assign_department"),
      cap("users", "assign_station"),
      // Legacy plural vocabulary still held by existing HR roles. Both
      // spellings are accepted; neither is migrated away.
      cap("users", "assign_branches"),
      cap("users", "assign_departments"),
      cap("users", "assign_stations"),
      cap("users", "transfer"),
    ],
  },
  {
    id: "manage_roles",
    label: "Manage roles & primary role…",
    group: "assignment",
    capability: cap("users", "assign_role"),
    alt: [
      cap("users", "edit"),
      cap("users", "assign_roles"),
      cap("users", "assign_branches"),
      cap("users", "assign_departments"),
      cap("users", "assign_stations"),
    ],
  },
  {
    id: "individual_permission",
    label: "Individual permission grant…",
    group: "assignment",
    capability: cap("users", "override_permission"),
  },
  {
    id: "assign_owner",
    label: "Assign Owner role…",
    group: "assignment",
    capability: cap("users", "assign_owner"),
    requiresReason: true,
    confirm: true,
    applies: (t) => !t.isOwner,
  },
  {
    id: "remove_owner",
    label: "Remove Owner role…",
    group: "assignment",
    capability: cap("users", "assign_owner"),
    requiresReason: true,
    confirm: true,
    destructive: true,
    applies: (t) => t.isOwner,
  },
  {
    id: "reset_password",
    label: "Reset password…",
    group: "security",
    capability: cap("users", "reset_auth"),
    confirm: true,
  },
  {
    id: "require_password_change",
    label: "Require password change at next sign-in",
    group: "security",
    capability: cap("users", "require_password_change"),
    applies: (t) => t.must_change_password !== true,
  },
  {
    id: "clear_password_requirement",
    label: "Clear password-change requirement",
    group: "security",
    capability: cap("users", "require_password_change"),
    applies: (t) => t.must_change_password === true,
  },
  {
    id: "resend_invitation",
    label: "Resend welcome / setup email",
    group: "security",
    capability: cap("users", "resend_invitation"),
    // Only where a delivery address exists — otherwise the control is dead.
    applies: (t) => Boolean(t.email),
  },
  {
    id: "revoke_sessions",
    label: "Force sign-out (revoke sessions)",
    group: "security",
    capability: cap("users", "reset_auth"),
    confirm: true,
    destructive: true,
  },
  {
    id: "reset_mfa",
    label: "Reset two-factor enrolment",
    group: "security",
    capability: cap("users", "reset_auth"),
    confirm: true,
    destructive: true,
    applies: (t) => t.mfa_enrolled !== false,
  },
  {
    id: "view_security",
    label: "Sign-in & security metadata",
    group: "security",
    capability: cap("users", "view_access"),
    alt: [cap("users", "view")],
  },
  {
    id: "suspend",
    label: "Lock / suspend account",
    group: "status",
    capability: cap("users", "manage_status"),
    requiresReason: true,
    confirm: true,
    destructive: true,
    applies: (t) => t.account_status === "active" && !t.isSelf,
  },
  {
    id: "activate",
    label: "Reactivate / unlock account",
    group: "status",
    capability: cap("users", "manage_status"),
    confirm: true,
    applies: (t) => t.account_status !== "active",
  },
  {
    id: "deactivate",
    label: "Deactivate account access",
    group: "status",
    capability: cap("users", "manage_status"),
    requiresReason: true,
    confirm: true,
    destructive: true,
    applies: (t) => t.account_status === "active" && !t.isSelf,
  },
  {
    id: "offboard",
    label: "Offboard through HR…",
    group: "status",
    // Employment ends through the canonical HR workflow, which keeps the
    // employment history and exit clearance; the account closure follows it.
    capability: { module: "human-resources", feature: "employees", action: "offboard" },
    alt: [{ module: "human-resources", feature: "employees", action: "delete" }],
    confirm: true,
    applies: (t) => !t.isSelf,
  },
  {
    id: "delete_account",
    label: "Delete login account…",
    group: "status",
    capability: cap("users", "delete"),
    requiresReason: true,
    confirm: true,
    destructive: true,
    applies: (t) => !t.isSelf && !t.isOwner,
  },
  {
    id: "view_audit",
    label: "View account & access audit history",
    group: "audit",
    capability: { module: "administration", feature: "audit-logs", action: "view" },
  },
];

export type CanFn = (module: string, feature: string, action?: string) => boolean;

function authorised(action: UserAction, can: CanFn, isSuperuser: boolean): boolean {
  if (isSuperuser) return true;
  const refs = [action.capability, ...(action.alt ?? [])];
  return refs.some((r) => can(r.module, r.feature, r.action));
}

/** Every action the viewer is authorised to perform, ignoring record state. */
export function authorisedUserActionIds(can: CanFn, isSuperuser: boolean): string[] {
  return USER_ACTIONS.filter((a) => authorised(a, can, isSuperuser)).map((a) => a.id);
}

/**
 * The grouped menu for one row: authorised actions that also apply to the
 * record's current state. Inapplicable actions are omitted rather than shown
 * disabled, so the menu never offers a dead control.
 */
export function buildUserActionMenu(
  can: CanFn,
  isSuperuser: boolean,
  target: UserActionTarget,
): Array<{ group: UserActionGroup; label: string; actions: UserAction[] }> {
  return USER_ACTION_GROUP_ORDER.map((group) => ({
    group,
    label: USER_ACTION_GROUP_LABELS[group],
    actions: USER_ACTIONS.filter(
      (a) =>
        a.group === group &&
        authorised(a, can, isSuperuser) &&
        (a.applies ? a.applies(target) : true),
    ),
  })).filter((g) => g.actions.length > 0);
}

/** Non-sensitive identifiers that may be copied. Secrets are never included. */
export function copyableAccountDetails(row: {
  full_name?: string | null;
  staff_id?: string | null;
  email?: string | null;
  job_title?: string | null;
  branch_name?: string | null;
  department_name?: string | null;
}): string {
  return [
    row.full_name ? `Name: ${row.full_name}` : null,
    row.staff_id ? `Staff ID: ${row.staff_id}` : null,
    row.email ? `Email: ${row.email}` : null,
    row.job_title ? `Job title: ${row.job_title}` : null,
    row.branch_name ? `Property: ${row.branch_name}` : null,
    row.department_name ? `Department: ${row.department_name}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
