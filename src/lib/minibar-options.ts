/** Empty channel lists mean unrestricted, matching the canonical sales rule. */
export function minibarChannelAllowed(channels: unknown): boolean {
  return (
    channels == null ||
    (Array.isArray(channels) && (channels.length === 0 || channels.includes("minibar")))
  );
}

export function minibarStoreAllowed(
  store: { active?: unknown; branch_id?: unknown },
  branchId: unknown,
): boolean {
  return (
    typeof branchId === "string" &&
    branchId.length > 0 &&
    store.active === true &&
    store.branch_id === branchId
  );
}
