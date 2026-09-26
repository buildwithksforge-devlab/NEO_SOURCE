/**
 * Which property an operator is working in, remembered per signed-in user.
 *
 * The active property is a personal working context, not a device setting.
 * Two people who share a workstation must not inherit each other's property:
 * a cashier who opens the browser after the night auditor signed out should
 * come back to their own property, never to whatever the previous session was
 * looking at. So the selection is stored under the user's ID.
 *
 * This is a convenience only. It never widens reach: `useBranchScope` still
 * validates the remembered value against the properties the backend actually
 * grants, and RLS remains the authority over every row.
 */
const STORE_KEY = "hos.propertySelection";
/** The pre-user-scoped key, migrated once so a live session is not disturbed. */
const LEGACY_KEY = "hos.activeBranch";

type SelectionMap = Record<string, string>;

function read(): SelectionMap {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as SelectionMap) : {};
  } catch {
    return {};
  }
}

function write(map: SelectionMap) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(map));
  } catch {
    /* storage may be unavailable; the selection simply is not remembered */
  }
}

/** The remembered property for this user, or null when there is none yet. */
export function readPropertySelection(userId: string | null): string | null {
  if (!userId) return null;
  const stored = read()[userId];
  if (stored) return stored;
  // One-time migration from the device-wide key, so an operator mid-shift
  // keeps the property they were already working in.
  try {
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      writePropertySelection(userId, legacy);
      window.localStorage.removeItem(LEGACY_KEY);
      return legacy;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Remember the selection for this user. Anonymous sessions remember nothing. */
export function writePropertySelection(userId: string | null, branchId: string): void {
  if (!userId) return;
  const map = read();
  map[userId] = branchId;
  write(map);
}

/** Forget one user's selection — used when that user signs out of the device. */
export function clearPropertySelection(userId: string | null): void {
  if (!userId) return;
  const map = read();
  if (!(userId in map)) return;
  delete map[userId];
  write(map);
}
