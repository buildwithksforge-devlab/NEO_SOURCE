/**
 * Which build am I looking at?
 *
 * Stamped at build time from the source revision, so an authorised person can
 * confirm from inside the running application whether the deployment they are
 * looking at contains a given change. Presentation/diagnostics only — it never
 * influences behaviour, data or access.
 */
declare const __NEO_BUILD_REVISION__: string;
declare const __NEO_BUILD_TIME__: string;

function safe(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export const buildInfo = {
  /** Short source revision the bundle was built from. */
  revision: safe(
    typeof __NEO_BUILD_REVISION__ === "undefined" ? undefined : __NEO_BUILD_REVISION__,
    "unknown",
  ),
  /** ISO timestamp of the build. */
  builtAt: safe(
    typeof __NEO_BUILD_TIME__ === "undefined" ? undefined : __NEO_BUILD_TIME__,
    "",
  ),
} as const;

/** One short human line, e.g. "Build 541d610f · 22 Sep 2026 01:20". */
export function buildLabel(): string {
  const when = buildInfo.builtAt ? new Date(buildInfo.builtAt) : null;
  const stamp =
    when && !Number.isNaN(when.getTime())
      ? when.toLocaleString(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;
  return stamp ? `Build ${buildInfo.revision} · ${stamp}` : `Build ${buildInfo.revision}`;
}
