/**
 * Staff preview of the guest / rider experiences.
 *
 * Preview is a presentation flag only: it renders the real screens with the
 * real permissions of whoever is signed in, and blocks every write so a staff
 * walkthrough can never create a customer record, rider record, digital event,
 * cart, order, request, transfer, favourite, folio line, notification or audit
 * entry. It is deliberately not an impersonation mode — no other identity is
 * assumed and no elevated read is granted.
 */
export const PREVIEW_PARAM = "neo_preview";
const STICKY_KEY = "neo:preview";

/**
 * Preview survives in-app navigation that drops the query string, so the flag
 * is remembered for the tab once it has been entered.
 */
export function isPreviewMode(search?: string) {
  if (search !== undefined) {
    return new URLSearchParams(search).get(PREVIEW_PARAM) === "1";
  }
  if (typeof window === "undefined") return false;
  if (new URLSearchParams(window.location.search).get(PREVIEW_PARAM) === "1") {
    try {
      window.sessionStorage.setItem(STICKY_KEY, "1");
    } catch {
      /* private mode — the query string still carries the flag */
    }
    return true;
  }
  try {
    return window.sessionStorage.getItem(STICKY_KEY) === "1";
  } catch {
    return false;
  }
}

/** Leaves preview for this tab (used by the "exit preview" control). */
export function clearPreviewMode() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(STICKY_KEY);
  } catch {
    /* nothing to clear */
  }
}

export function withPreview(path: string) {
  return path.includes("?") ? `${path}&${PREVIEW_PARAM}=1` : `${path}?${PREVIEW_PARAM}=1`;
}

export const PREVIEW_BLOCKED_MESSAGE =
  "Preview only — nothing is saved while you are previewing this experience.";

/**
 * Single choke point for every write path in the guest and rider apps,
 * including silent telemetry. Throws in preview so a mutation can never reach
 * the database, and returns `true` where the caller wants to no-op quietly.
 */
export function guardPreview(): void {
  if (isPreviewMode()) throw new Error(PREVIEW_BLOCKED_MESSAGE);
}

/** Non-throwing variant for fire-and-forget logging hooks. */
export function previewSuppressed(): boolean {
  return isPreviewMode();
}
