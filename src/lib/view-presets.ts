/**
 * Saved views — a per-user display preference, never a system of record.
 *
 * A "view" is the combination of the client-side lenses, quick filters and
 * ranking a page offers. Three things are remembered, all in localStorage and
 * all keyed by the signed-in user:
 *
 *   1. The last view state the user left the page in, so returning to
 *      Reservations, POS Orders or Menu Management restores their working set.
 *   2. Named presets they explicitly saved.
 *   3. Nothing else. No filter here widens data access: every value is applied
 *      on top of the already scoped, already permission-filtered query result.
 *
 * Role defaults answer a different question — "what should this manager see
 * the first time they open the page, before they have a preference of their
 * own?" — and are derived from the caller's own capability checks, never from
 * a hardcoded person or a role name comparison in this module.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

export type ViewState = Record<string, string>;

export type ViewPreset = {
  id: string;
  name: string;
  state: ViewState;
};

type StoredView = {
  last?: ViewState;
  presets?: ViewPreset[];
};

const NAMESPACE = "neo.view";

export function viewStorageKey(viewKey: string, userId?: string | null): string {
  return userId ? `${NAMESPACE}.${viewKey}.${userId}` : `${NAMESPACE}.${viewKey}`;
}

function read(key: string): StoredView {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredView;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function write(key: string, value: StoredView) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* A full or blocked storage must never break the page. */
  }
}

/** Only keys the page declared are ever restored, so stale shapes cannot leak in. */
export function sanitizeState(candidate: unknown, defaults: ViewState): ViewState {
  const next: ViewState = { ...defaults };
  if (!candidate || typeof candidate !== "object") return next;
  for (const key of Object.keys(defaults)) {
    const value = (candidate as Record<string, unknown>)[key];
    if (typeof value === "string") next[key] = value;
  }
  return next;
}

export function statesEqual(a: ViewState, b: ViewState): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? "") !== (b[k] ?? "")) return false;
  return true;
}

/**
 * Resolve the opening state for a page.
 *
 * Precedence: the user's own last view → the role default the page computed
 * from its capability checks → the page's neutral default.
 */
export function resolveOpeningState(
  defaults: ViewState,
  roleDefault: Partial<ViewState> | undefined,
  stored: ViewState | undefined,
): ViewState {
  if (stored) return sanitizeState(stored, defaults);
  return sanitizeState({ ...defaults, ...(roleDefault ?? {}) }, defaults);
}

export type UseSavedViewOptions = {
  /** Stable key for the page, e.g. "pms.reservations". */
  viewKey: string;
  defaults: ViewState;
  /** Opening state for a user who has no saved preference yet. */
  roleDefault?: Partial<ViewState>;
  userId?: string | null;
};

export type SavedView = {
  state: ViewState;
  /** Update one field of the view. */
  set: (key: string, value: string) => void;
  /** Replace the whole view. */
  apply: (next: ViewState) => void;
  presets: ViewPreset[];
  savePreset: (name: string) => void;
  applyPreset: (id: string) => void;
  deletePreset: (id: string) => void;
  /** Back to the role/neutral opening state. */
  reset: () => void;
  /** True when the current state differs from the opening state. */
  isCustomised: boolean;
  activePresetId: string | null;
};

export function useSavedView({
  viewKey,
  defaults,
  roleDefault,
  userId,
}: UseSavedViewOptions): SavedView {
  const storageKey = viewStorageKey(viewKey, userId);
  const opening = useMemo(
    () => sanitizeState({ ...defaults, ...(roleDefault ?? {}) }, defaults),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storageKey, JSON.stringify(defaults), JSON.stringify(roleDefault ?? {})],
  );

  const [state, setState] = useState<ViewState>(opening);
  const [presets, setPresets] = useState<ViewPreset[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Storage is read after mount so server and first client render agree.
  useEffect(() => {
    const stored = read(storageKey);
    setState(resolveOpeningState(defaults, roleDefault, stored.last));
    setPresets(Array.isArray(stored.presets) ? stored.presets : []);
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  useEffect(() => {
    if (!hydrated) return;
    write(storageKey, { last: state, presets });
  }, [hydrated, storageKey, state, presets]);

  const apply = useCallback((next: ViewState) => setState((s) => sanitizeState({ ...s, ...next }, s)), []);
  const set = useCallback(
    (key: string, value: string) => setState((s) => ({ ...s, [key]: value })),
    [],
  );

  const savePreset = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setPresets((list) => {
        const existing = list.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
        if (existing) {
          return list.map((p) => (p.id === existing.id ? { ...p, state } : p));
        }
        return [...list, { id: `${Date.now().toString(36)}-${list.length}`, name: trimmed, state }];
      });
    },
    [state],
  );

  const applyPreset = useCallback(
    (id: string) => {
      const preset = presets.find((p) => p.id === id);
      if (preset) setState(sanitizeState(preset.state, opening));
    },
    [presets, opening],
  );

  const deletePreset = useCallback(
    (id: string) => setPresets((list) => list.filter((p) => p.id !== id)),
    [],
  );

  const reset = useCallback(() => setState(opening), [opening]);

  const activePresetId = presets.find((p) => statesEqual(sanitizeState(p.state, opening), state))?.id ?? null;

  return {
    state,
    set,
    apply,
    presets,
    savePreset,
    applyPreset,
    deletePreset,
    reset,
    isCustomised: !statesEqual(state, opening),
    activePresetId,
  };
}
