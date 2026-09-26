/**
 * Frontend dirty-state contract for edit/create forms.
 *
 * An edit form's Save must activate as soon as a meaningful editable value
 * changes, and stay inert when the values still equal what was loaded. This
 * hook only compares the values the form already holds — it never changes what
 * is persisted, or how the existing mutation runs.
 */
import { useCallback, useMemo, useRef, useState } from "react";

export type FormValues = Record<string, unknown>;

const normalise = (v: unknown): unknown => {
  if (v === undefined || v === null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map(normalise);
  if (typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as FormValues)
        .map(([k, val]) => [k, normalise(val)])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
  }
  return String(v);
};

/** True when two form snapshots differ in any editable value. */
export function valuesChanged(baseline: FormValues | null, current: FormValues): boolean {
  if (!baseline) return true;
  return JSON.stringify(normalise(baseline)) !== JSON.stringify(normalise(current));
}

export function useDirtyForm(current: FormValues, options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const [baseline, setBaselineState] = useState<FormValues | null>(null);
  const baselineRef = useRef<FormValues | null>(null);

  const setBaseline = useCallback((values: FormValues) => {
    baselineRef.current = values;
    setBaselineState(values);
  }, []);

  const dirty = useMemo(() => {
    if (!enabled) return true;
    return valuesChanged(baseline, current);
  }, [enabled, baseline, current]);

  /** Call after a successful save so the saved values become the new baseline. */
  const markSaved = useCallback(
    (values?: FormValues) => setBaseline(values ?? current),
    [setBaseline, current],
  );

  return { dirty, baseline, setBaseline, markSaved };
}
