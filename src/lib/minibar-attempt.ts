// Persist only the request identity, never guest names, notes or consumption.
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function minibarAttemptKey(org: string, user: string, folio: string) {
  if (![org, user, folio].every((value) => uuid.test(value)))
    throw new Error("A signed-in organization, employee and folio are required.");
  return `neo:minibar-attempt:${org}:${user}:${folio}`;
}
export function getMinibarAttempt(key: string, storage: Storage = localStorage): string {
  try {
    const saved = storage.getItem(key);
    if (saved) {
      if (!uuid.test(saved)) throw new Error("Invalid saved request identity");
      return saved;
    }
    const attempt = crypto.randomUUID();
    storage.setItem(key, attempt);
    if (storage.getItem(key) !== attempt) throw new Error("Request identity was not saved");
    return attempt;
  } catch {
    throw new Error("This browser could not retain the minibar request. Check browser storage before posting.");
  }
}
export function clearMinibarAttempt(key: string, expected?: string, storage: Storage = localStorage) {
  if (!expected || storage.getItem(key) === expected) storage.removeItem(key);
}
export function requireMinibarAttemptResult(
  result: Record<string, unknown>, attempt: string, folio: string, location: string, room?: string | null,
) {
  if (result["attempt_id"] !== attempt || result["folio_id"] !== folio || result["location_id"] !== location ||
    !uuid.test(String(result["room_id"])) || (room && result["room_id"] !== room) || typeof result["replayed"] !== "boolean")
    throw new Error("The saved minibar request was not confirmed. Review its history before starting another charge.");
  return result;
}
