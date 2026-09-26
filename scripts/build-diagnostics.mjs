#!/usr/bin/env node
/**
 * Build diagnostics report.
 *
 * Usage:
 *   node scripts/build-diagnostics.mjs               # report from a fresh install+build
 *   node scripts/build-diagnostics.mjs --log <file>  # report from an existing build log
 *
 * Writes docs/build-diagnostics.md with the full captured install/build output
 * plus classified errors and recommended fixes.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const RULES = [
  {
    id: "registry-rate-limit",
    match: /\b429\b|too many requests|rate.?limit/i,
    title: "Package registry rate limit (HTTP 429)",
    fix: "Transient. Re-run `bun run install:retry`, which backs off exponentially and falls back to FALLBACK_NPM_REGISTRY after two attempts. No code change is needed.",
  },
  {
    id: "registry-5xx",
    match: /\b50[0234]\b .*(registry|pkg\.dev)|failed to (download|fetch)/i,
    title: "Registry unavailable or download failed",
    fix: "Transient. Retry the install; if it persists, point FALLBACK_NPM_REGISTRY at a reachable registry.",
  },
  {
    id: "auth",
    match: /\b40[13]\b|unauthorized|forbidden/i,
    title: "Registry authentication failure",
    fix: "Check the registry token in Workspace Settings → Build Secrets and that the secret name matches .npmrc exactly.",
  },
  {
    id: "lockfile",
    match: /lockfile|frozen-lockfile/i,
    title: "Lockfile mismatch",
    fix: "package.json and bun.lock disagree. Run `bun install` locally and commit the updated bun.lock.",
  },
  {
    id: "missing-module",
    match: /Could not resolve|Cannot find module/i,
    title: "Unresolved import",
    fix: "A file or package is imported but missing. Create the file or install the package before building.",
  },
  {
    id: "typescript",
    match: /error TS\d+/,
    title: "TypeScript error",
    fix: "Fix the reported type errors; the build will not emit until they are resolved.",
  },
  {
    id: "node-incompat",
    match: /\[unenv\].*not implemented|__dirname is not defined/,
    title: "Node-only dependency in the edge runtime",
    fix: "Replace the dependency with a Worker/edge-compatible alternative or move the work to an external API.",
  },
];

const args = process.argv.slice(2);
const logFlag = args.indexOf("--log");

function capture(cmd, cmdArgs) {
  const res = spawnSync(cmd, cmdArgs, { encoding: "utf8", shell: false });
  return {
    command: [cmd, ...cmdArgs].join(" "),
    code: res.status ?? 1,
    output: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

let steps;
if (logFlag !== -1) {
  const file = args[logFlag + 1];
  if (!file) {
    console.error("--log requires a file path");
    process.exit(2);
  }
  steps = [{ command: `log: ${file}`, code: 1, output: readFileSync(file, "utf8") }];
} else {
  steps = [
    capture("node", ["scripts/install-with-retry.mjs"]),
    capture("bun", ["run", "build"]),
  ];
}

const combined = steps.map((s) => s.output).join("\n");
const findings = RULES.filter((r) => r.match.test(combined));

const lines = [
  "# Build diagnostics report",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  "## Steps",
  "",
  ...steps.map((s) => `- \`${s.command}\` — exit ${s.code}`),
  "",
  "## Findings",
  "",
];

if (findings.length === 0) {
  lines.push("No known failure patterns matched.", "");
} else {
  for (const f of findings) {
    lines.push(`### ${f.title}`, "", `**Recommended fix:** ${f.fix}`, "");
  }
}

lines.push("## Full output", "");
for (const s of steps) {
  lines.push(`### \`${s.command}\``, "", "```text", s.output.trim(), "```", "");
}

mkdirSync("docs", { recursive: true });
writeFileSync("docs/build-diagnostics.md", lines.join("\n"));

console.log("Wrote docs/build-diagnostics.md");
for (const f of findings) console.log(`- ${f.title}: ${f.fix}`);

process.exit(steps.every((s) => s.code === 0) ? 0 : 1);
