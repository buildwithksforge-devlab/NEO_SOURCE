/**
 * Per-session cache for the effective-access contract.
 *
 * `my_effective_access()` is the authorisation contract the database itself
 * uses for row-level security. It is correct but expensive: it resolves staff
 * record, membership, properties, departments, stations, roles, individual
 * grants and denials, entitlements and the dashboard key in one pass.
 *
 * Every mount of the workspace used to pay that cost again — plus a duplicate
 * `profiles` read from the tenant store — before a single screen appeared.
 * The contract is cached for the session (tab) keyed by user, and revalidated
 * against the cheap `my_permission_version()` fingerprint. Nothing here grants
 * access: the cache is only ever the same answer the database gave this user,
 * and it is discarded the moment the fingerprint changes or the user signs out.
 */

const ACCESS_PREFIX = "neo.access.v1:";
const ORG_PREFIX = "neo.orgid.v1:";

export type CachedAccess<T> = { version: string | null; payload: T; savedAt: number };

/** Session cache lifetime. A stale contract is never used beyond this. */
const MAX_AGE_MS = 30 * 60 * 1000;

function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readCachedAccess<T>(userId: string): CachedAccess<T> | null {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(ACCESS_PREFIX + userId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedAccess<T>;
    if (!parsed || typeof parsed.savedAt !== "number") return null;
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeCachedAccess<T>(userId: string, version: string | null, payload: T) {
  const s = store();
  if (!s) return;
  try {
    s.setItem(
      ACCESS_PREFIX + userId,
      JSON.stringify({ version, payload, savedAt: Date.now() } satisfies CachedAccess<T>),
    );
  } catch {
    /* quota or private mode — the contract is simply re-fetched */
  }
}

/** The organisation of the signed-in user, shared by auth and the tenant store. */
const orgMemory = new Map<string, string | null>();

export function rememberOrganizationId(userId: string, organizationId: string | null) {
  orgMemory.set(userId, organizationId);
  const s = store();
  try {
    if (organizationId) s?.setItem(ORG_PREFIX + userId, organizationId);
    else s?.removeItem(ORG_PREFIX + userId);
  } catch {
    /* ignore */
  }
}

export function recallOrganizationId(userId: string): string | null | undefined {
  if (orgMemory.has(userId)) return orgMemory.get(userId);
  const s = store();
  try {
    const value = s?.getItem(ORG_PREFIX + userId) ?? null;
    if (value) {
      orgMemory.set(userId, value);
      return value;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Drop every cached authorisation artefact — used on sign-out and user switch. */
export function clearAccessCache() {
  orgMemory.clear();
  const s = store();
  if (!s) return;
  try {
    for (const key of Object.keys(s)) {
      if (key.startsWith(ACCESS_PREFIX) || key.startsWith(ORG_PREFIX)) s.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * Login-to-ready instrumentation
 * ------------------------------------------------------------------ */

export type PerfMark = { label: string; at: number };

type PerfWindow = Window & {
  __neoPerf?: { marks: PerfMark[]; report: () => Record<string, number> };
};

/** Records a named milestone on the sign-in path (visible as `__neoPerf`). */
export function perfMark(label: string) {
  if (typeof window === "undefined") return;
  const w = window as PerfWindow;
  if (!w.__neoPerf) {
    w.__neoPerf = {
      marks: [],
      report() {
        const marks = w.__neoPerf?.marks ?? [];
        const first = marks[0]?.at ?? 0;
        const out: Record<string, number> = {};
        for (const m of marks) out[m.label] = Math.round(m.at - first);
        return out;
      },
    };
  }
  w.__neoPerf.marks.push({ label, at: performance.now() });
}
