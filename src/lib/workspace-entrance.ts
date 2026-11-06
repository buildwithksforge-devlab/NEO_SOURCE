/** Layout decision only; the existing context resolver and server still own access. */
export function isWorkspaceEntrance(href: string): boolean {
  try {
    const location = new URL(href, "https://neo.invalid");
    return (
      location.pathname.replace(/\/+$/, "") === "/workspace" &&
      location.searchParams.get("home") === "1"
    );
  } catch {
    return false;
  }
}
