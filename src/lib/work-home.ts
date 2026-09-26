/**
 * Canonical work home.
 *
 * One place answers the question "who is this person, and where does their
 * work actually start?" — from the identity already resolved by the database:
 * the account, its organisation, its property assignment, its workplace scope
 * and its effective permissions. Nothing here reads a role name, and nothing
 * here grants access: every destination is a screen the person's permissions
 * already reach, and each of those screens still asks its own capability.
 */

export type WorkHome = {
  /** Where this person's working day starts. */
  route: string;
  /** Plain words for the person, used when we explain the landing. */
  label: string;
  /** Why this destination was chosen — for support and tests, not marketing. */
  reason: string;
};

export type WorkHomeIdentity = {
  /** Workplace scope resolved by the same helpers the row policies use. */
  accessScope: "organisation" | "branch" | "department" | "team" | "self" | "technical";
  /** Dashboard resolved for this account, when the account has one. */
  dashboardKey: string | null;
  /** Module-level entry check from effective permissions. */
  canModule: (module: string, action?: string) => boolean;
  /**
   * Whether the destination screen itself would open for this person.
   *
   * Holding a module is not the same as being able to run its main screen: a
   * cashier holds a narrow point-of-sale grant for settling bills but does not
   * run the restaurant floor. Without this check the person is landed on a
   * screen that immediately refuses them. Optional so existing callers keep
   * their behaviour; when absent every destination is treated as openable.
   */
  canOpen?: (route: string) => boolean;
};

export const DASHBOARD_HOME: WorkHome = {
  route: "/workspace",
  label: "Operations dashboard",
  reason: "oversight-scope",
};

/**
 * Frontline homes, most specific first. A person is sent to the screen that
 * holds their own shift work, not to a navigation tree.
 */
const FRONTLINE_HOMES: { module: string; route: string; label: string }[] = [
  { module: "housekeeping", route: "/housekeeping/my-work", label: "My housekeeping work" },
  { module: "laundry", route: "/laundry/my-work", label: "My laundry work" },
  { module: "kitchen", route: "/kitchen/my-station", label: "My station" },
  { module: "security", route: "/security/my-post", label: "My post" },
  { module: "pos", route: "/pos/floor", label: "Point of sale" },
  { module: "front_office", route: "/front-office", label: "Front office" },
  { module: "maintenance", route: "/maintenance/my-jobs", label: "My maintenance jobs" },
];

/** Scopes whose day genuinely starts on an oversight dashboard. */
const OVERSIGHT_SCOPES = new Set(["organisation", "branch", "technical"]);

/**
 * Resolve where this signed-in employee should land.
 *
 * Oversight scopes land on their dashboard, because their work is the whole
 * property or group. Everybody else lands on their own work: the departmental
 * screen they hold, or the shared My Work board when they hold several.
 */
export function resolveWorkHome(identity: WorkHomeIdentity): WorkHome {
  if (OVERSIGHT_SCOPES.has(identity.accessScope)) return DASHBOARD_HOME;

  const canOpen = identity.canOpen ?? (() => true);
  const held = FRONTLINE_HOMES.filter(
    (home) => identity.canModule(home.module, "view") && canOpen(home.route),
  );
  if (held.length === 1) {
    const only = held[0]!;
    return { route: only.route, label: only.label, reason: `single-module:${only.module}` };
  }
  if (held.length > 1) {
    return { route: "/my-work", label: "My work", reason: "multiple-modules" };
  }
  if (identity.dashboardKey) return DASHBOARD_HOME;
  return { route: "/my-work", label: "My work", reason: "no-module-entry" };
}
