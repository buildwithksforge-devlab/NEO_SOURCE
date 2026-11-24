/** Layout decision only; the existing context resolver and server still own access. */
export function isWorkspaceEntrance(href: string): boolean {
  try {
    const location = new URL(href, "https://neo.invalid");
    const home = location.searchParams.get("home");
    return (
      location.pathname.replace(/\/+$/, "") === "/workspace" &&
      (home === "1" || home === '"1"')
    );
  } catch {
    return false;
  }
}
