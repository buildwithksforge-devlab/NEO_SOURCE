/**
 * Pure checks for the M-Pesa confirmation address.
 *
 * Kept apart from the server code so the rules can be tested on their own and
 * reused by the settings screen without pulling in anything server-only.
 */

/** Editor preview / development addresses: fine for a trial, never for live money. */
export function isTemporaryHost(url: string): boolean {
  return /id-preview--|--[0-9a-f-]+\.lovable\.app|-dev\.lovable\.app|localhost|127\.0\.0\.1/i.test(url);
}

export type CallbackBaseCheck = { ok: boolean; value: string | null; problem?: string };

/**
 * Checks a callback base address a person typed. Safaricom only calls public
 * secure addresses, so a bad one is refused at save time rather than showing up
 * later as confirmations that never arrive.
 */
export function checkCallbackBase(raw: string | null | undefined): CallbackBaseCheck {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return { ok: true, value: null };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      value: null,
      problem: "The callback address must be a full web address, for example https://book.yourhotel.co.ke",
    };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, value: null, problem: "Safaricom only calls secure https addresses." };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, value: null, problem: "Give the plain site address without any ? or # part." };
  }
  return { ok: true, value: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}` };
}
