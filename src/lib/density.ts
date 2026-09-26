/**
 * NEØ adaptive density system — a frontend-only display preference.
 *
 * Three official user-facing modes:
 *   • Comfortable    — calm rhythm, the default for analytical/desk work.
 *   • Compact        — tighter rows and padding for register-heavy desk work.
 *   • Touch optimised— larger targets and rows for tablets and phones.
 *
 * Density NEVER changes permissions, scoping or which data is rendered: only
 * spacing rhythm and control sizing. The resolved value is written to
 * <html data-density> so every shared utility reacts at once.
 *
 * Resolution order (see `resolveDensity`):
 *   1. The user's explicit choice, when they made one.
 *   2. Otherwise a role/work-pattern recommendation derived from role names.
 *   3. Otherwise the viewport default.
 *   4. In all cases the touch-target floor wins on coarse-pointer screens:
 *      "compact" is never allowed to shrink rows under a finger.
 *
 * The preference is stored in localStorage, keyed by the signed-in user when
 * one is known. No backend, schema or query change is involved.
 */
import { useSyncExternalStore } from "react";

export const DENSITIES = ["comfortable", "compact", "touch"] as const;
export type Density = (typeof DENSITIES)[number];

/** What the user actually chose. "auto" lets role + viewport decide. */
export type DensityPreference = Density | "auto";

export const DENSITY_LABELS: Record<Density, string> = {
  comfortable: "Comfortable",
  compact: "Compact",
  touch: "Touch optimized",
};

export const DEFAULT_PREFERENCE: DensityPreference = "auto";
export const DEFAULT_DENSITY: Density = "comfortable";

export type DensityViewport = { coarsePointer: boolean; width: number };

/** Below this width a coarse pointer is treated as a phone/tablet surface. */
export const TOUCH_MAX_WIDTH = 1280;

const BASE_KEY = "neo.dashboard.density";

/** Values written by the previous two-mode system. */
const LEGACY: Record<string, Density> = { spacious: "comfortable", cosy: "comfortable" };

let scopeKey = BASE_KEY;
let preference: DensityPreference = DEFAULT_PREFERENCE;
let recommendation: Density | null = null;
let current: Density = DEFAULT_DENSITY;
const listeners = new Set<() => void>();
let viewportBound = false;

const isDensity = (v: unknown): v is Density =>
  typeof v === "string" && (DENSITIES as readonly string[]).includes(v);

const isPreference = (v: unknown): v is DensityPreference => v === "auto" || isDensity(v);

function readPreference(key: string): DensityPreference {
  if (typeof window === "undefined") return DEFAULT_PREFERENCE;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw && LEGACY[raw]) return LEGACY[raw];
    return isPreference(raw) ? raw : DEFAULT_PREFERENCE;
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

/** Current viewport characteristics, safe to call during SSR. */
export function readViewport(): DensityViewport {
  if (typeof window === "undefined") return { coarsePointer: false, width: 1440 };
  let coarsePointer = false;
  try {
    coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  } catch {
    coarsePointer = false;
  }
  return { coarsePointer, width: window.innerWidth || 1440 };
}

/** Viewport-only default when nothing else is known. */
export function viewportDensity(viewport: DensityViewport): Density {
  if (viewport.coarsePointer && viewport.width < TOUCH_MAX_WIDTH) return "touch";
  return DEFAULT_DENSITY;
}

const FINANCE = ["finance", "account", "cashier", "audit", "controller", "bookkeep", "payroll", "credit"];
const EXECUTIVE = ["owner", "director", "executive", "general manager", "chief", "board"];
const OPERATIONAL = [
  "waiter",
  "waitress",
  "barista",
  "bartender",
  "bar ",
  "chef",
  "cook",
  "kitchen",
  "rider",
  "driver",
  "housekeep",
  "steward",
  "host",
  "porter",
  "front office",
  "receptionist",
  "server",
];

const matches = (haystack: string, needles: string[]) => needles.some((n) => haystack.includes(n));

/**
 * Recommend a density from role/work pattern. Purely data-driven from the role
 * names already loaded for the session — no named people, no hardcoded tenant.
 */
export function recommendDensityForRoles(
  roleNames: readonly string[] | null | undefined,
  viewport: DensityViewport,
): Density | null {
  const names = (roleNames ?? []).map((r) => r.toLowerCase()).join(" | ");
  if (!names) return null;
  // Operational roles on a touch surface always want big targets.
  if (viewport.coarsePointer && viewport.width < TOUCH_MAX_WIDTH) return "touch";
  if (matches(names, OPERATIONAL) && viewport.width < TOUCH_MAX_WIDTH) return "touch";
  if (matches(names, EXECUTIVE)) return "comfortable";
  if (matches(names, FINANCE)) return "compact";
  return null;
}

/**
 * The single canonical resolver. Explicit choice beats recommendation beats
 * viewport, but the touch-target floor always wins on coarse pointers.
 */
export function resolveDensity(
  pref: DensityPreference,
  viewport: DensityViewport,
  recommended: Density | null = null,
): Density {
  const base: Density = pref !== "auto" ? pref : (recommended ?? viewportDensity(viewport));
  const smallTouch = viewport.coarsePointer && viewport.width < TOUCH_MAX_WIDTH;
  if (smallTouch && base === "compact") return "touch";
  return base;
}

function apply(value: Density, pref: DensityPreference) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-density", value);
  document.documentElement.setAttribute("data-density-preference", pref);
}

function emit() {
  for (const l of listeners) l();
}

function recompute() {
  const next = resolveDensity(preference, readViewport(), recommendation);
  current = next;
  apply(next, preference);
  emit();
}

/** Keep the resolved density honest when the device rotates or resizes. */
function bindViewport() {
  if (viewportBound || typeof window === "undefined") return;
  viewportBound = true;
  window.addEventListener("resize", recompute, { passive: true });
  try {
    window.matchMedia?.("(pointer: coarse)").addEventListener?.("change", recompute);
  } catch {
    /* older engines simply keep the resize listener */
  }
}

/** Point the store at a user-scoped key once the session is known. */
export function scopeDensityToUser(userId: string | null | undefined) {
  const next = userId ? `${BASE_KEY}.${userId}` : BASE_KEY;
  if (next === scopeKey) return;
  scopeKey = next;
  preference = readPreference(scopeKey);
  recompute();
}

/** Feed the session's role names in so "auto" can recommend sensibly. */
export function setDensityRoleHint(roleNames: readonly string[] | null | undefined) {
  const next = recommendDensityForRoles(roleNames, readViewport());
  if (next === recommendation) return;
  recommendation = next;
  recompute();
}

export function getDensity(): Density {
  return current;
}

export function getDensityPreference(): DensityPreference {
  return preference;
}

export function setDensityPreference(value: DensityPreference) {
  preference = value;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(scopeKey, value);
    } catch {
      /* preference is best-effort only */
    }
  }
  recompute();
}

/** Back-compatible alias: choosing a mode is an explicit preference. */
export const setDensity = (value: Density) => setDensityPreference(value);

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hydrate from storage on the client without a server/client mismatch. */
export function hydrateDensity() {
  preference = readPreference(scopeKey);
  bindViewport();
  recompute();
}

export function useDensity(): {
  density: Density;
  preference: DensityPreference;
  setDensity: (d: Density) => void;
  setPreference: (p: DensityPreference) => void;
} {
  const density = useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_DENSITY,
  );
  const pref = useSyncExternalStore(
    subscribe,
    () => preference,
    () => DEFAULT_PREFERENCE,
  );
  return { density, preference: pref, setDensity, setPreference: setDensityPreference };
}
