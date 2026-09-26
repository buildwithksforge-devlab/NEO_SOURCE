/**
 * QA audit (throwaway): computes, for each staffed role in the QA workspace,
 * exactly which sidebar screens that role's real granted permissions expose.
 * Read-only: no database writes, no live workspace involvement.
 */
import { readFileSync } from "node:fs";
import { addGrant, canFromPermissions } from "@/lib/permissions";
import { navigationForAccess } from "@/lib/nav-permissions";

const rows = readFileSync("/tmp/audit/perms.tsv", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => l.split("\t"));

const byRole = new Map<string, Set<string>>();
for (const [role, module, feature, action] of rows) {
  let set = byRole.get(role);
  if (!set) byRole.set(role, (set = new Set<string>()));
  addGrant(set, module, feature, action);
}

const allPaths = new Set<string>();
const perRole: Record<string, string[]> = {};
for (const [role, set] of [...byRole].sort()) {
  const can = canFromPermissions(set);
  const groups = navigationForAccess(can, false, true);
  const paths = groups.flatMap((g) => g.items.map((i) => i.to));
  perRole[role] = paths;
  paths.forEach((p) => allPaths.add(p));
}

const SENSITIVE = [
  "/admin",
  "/finance",
  "/hr",
  "/settings",
  "/platform",
  "/marketing/settings",
];

console.log("ROLE VISIBILITY\n");
for (const [role, paths] of Object.entries(perRole)) {
  const sensitive = paths.filter((p) => SENSITIVE.some((s) => p.startsWith(s)));
  console.log(
    `${role.padEnd(22)} screens=${String(paths.length).padStart(3)}  sensitive=${sensitive.length}`,
  );
  if (sensitive.length && role !== "Owner") console.log("    ", sensitive.join(" "));
  if (paths.length <= 6) console.log("     ALL:", paths.join(" "));
}
console.log("\nTotal distinct screens reachable across staffed roles:", allPaths.size);
