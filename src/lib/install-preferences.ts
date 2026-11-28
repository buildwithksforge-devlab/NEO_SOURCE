/** Device-level presentation preferences, never authentication or permission evidence. */
export const INSTALL_DISMISSED_KEY = "neo.install.dismissed.v2";
export const INSTALL_ACK_KEY = "neo.install.acknowledged.v1";
export function readInstallPreference(key: string): boolean {
  try {
    return typeof window !== "undefined" && localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
export function saveInstallPreference(key: string) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    /* Private mode: usable for this page. */
  }
}
export function hasConfiguredDisplayOrStaffDevice(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const staff = JSON.parse(localStorage.getItem("neo.staffPinDevice.meta") ?? "null");
    if (
      localStorage.getItem("neo.staffPinDevice.token") &&
      staff?.branchId &&
      Number.isFinite(Date.parse(staff.expiresAt)) &&
      Date.parse(staff.expiresAt) > Date.now()
    )
      return true;
    const expiry = localStorage.getItem("neo.production.display.expires.v1");
    return Boolean(
      localStorage.getItem("neo.production.display.token.v1") &&
      expiry &&
      Number.isFinite(Date.parse(expiry)) &&
      Date.parse(expiry) > Date.now(),
    );
  } catch {
    return false;
  }
}
