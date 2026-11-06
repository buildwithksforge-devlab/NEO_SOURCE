import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
/** Include actual tracked/untracked source, never environment files or private agent config. */
export function sourceFingerprint(root: string, sourceFiles?: readonly string[]): string {
  const files =
    sourceFiles ??
    execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        "src",
        "public",
        "supabase/migrations",
        "scripts",
        "package.json",
        "package-lock.json",
        "vite.config.ts",
      ],
      { cwd: root, encoding: "utf8" },
    ).split("\0");
  const hash = createHash("sha256");
  for (const file of [...new Set(files)]
    .filter(
      (file) =>
        (/\.(tsx?|m?js|css|json|webmanifest|svg|html|sql)$/.test(file) || file.endsWith("/_headers")) &&
        !/(^|\/)\.env(?:\.|$)/.test(file),
    )
    .sort()) {
    hash.update(file.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(existsSync(join(root,file)) ? readFileSync(join(root, file)) : "<deleted>");
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}
