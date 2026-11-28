import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const required = [
  ["release", ["build", "automated-tests", "database-contract", "deployed-build"]],
  ["workflow", [
    "reservations-and-stays", "folio-and-room-transfer", "housekeeping-and-maintenance",
    "pos-and-room-service", "procurement-and-payables", "inventory-and-production",
    "minibar", "laundry", "events", "guest-ordering-and-delivery", "tills-and-close",
    "staff-and-property-access", "documents",
  ]],
  ["rehearsal", ["purchase-to-sale", "guest-stay", "event-revision", "delivery-recovery", "business-day-close"]],
  ["property", ["configuration", "saved-record-reconciliation", "open-operating-blockers"]],
  ["external", ["physical-print", "payment-provider"]],
];
const mandatory = new Set(["reservations-and-stays", "folio-and-room-transfer", "staff-and-property-access", "documents", "guest-stay", "business-day-close"]);
const day = 24 * 60 * 60 * 1000;
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

export function assessReadiness({ property, release, evidence = [] }, now = new Date()) {
  if (!nonempty(property) || !nonempty(release) || !Array.isArray(evidence)) {
    throw new Error("Provide a property, immutable release identifier and evidence array.");
  }

  const checks = required.flatMap(([layer, keys]) => keys.map((key) => {
    const id = `${layer}/${key}`;
    const rows = evidence.filter((row) => row?.check === id && row.property === property && row.release === release);
    const dated = rows.map((row) => ({ row, time: Date.parse(row.checkedAt) }))
      .sort((a, b) => b.time - a.time);
    const latest = dated[0];
    const unverified = (reason) => ({ id, status: "Unverified", reason, evidence: latest?.row ?? null });
    if (!latest) return unverified("Evidence is missing for this property and release.");
    if (dated.some(({ time }) => !Number.isFinite(time) || time > now.getTime())) {
      return unverified("Evidence contains an invalid or future check time.");
    }
    if (dated[1]?.time === latest.time) return unverified("Multiple results have the same latest check time.");
    const { row, time } = latest;
    const documented = (entry) => [entry.expected, entry.observed, entry.reference].every(nonempty);
    const applicableWaiver = (entry) => entry.result === "not-applicable"
      && !["release", "property"].includes(layer) && !mandatory.has(key)
      && entry.enabled === false && nonempty(entry.applicabilityReason);
    // A skipped or interrupted retest leaves the last verified failure open.
    const completed = dated.find(({ row }) => documented(row)
      && (["pass", "fail"].includes(row.result) || applicableWaiver(row)));
    if (completed?.row.result === "fail") {
      return { id, status: "Blocked", reason: completed.row.observed, evidence: completed.row };
    }
    if (!documented(row)) {
      return unverified("Evidence must include the expected result, observation and reference.");
    }
    const maxAge = layer === "property" ? day : 7 * day;
    if (now.getTime() - time >= maxAge) return unverified("Evidence has expired.");
    if (row.result === "pass") return { id, status: "Ready", reason: row.observed, evidence: row };
    if (applicableWaiver(row)) {
      return { id, status: "Not applicable", reason: row.applicabilityReason, evidence: row };
    }
    return unverified("No completed result or documented disabled workflow applies.");
  }));

  const status = checks.some((check) => check.status === "Blocked") ? "Blocked"
    : checks.some((check) => check.status === "Unverified") ? "Unverified" : "Ready";
  const layers = [...new Set(checks.map((check) => check.id.split("/")[0]))].map((layer) => {
    const group = checks.filter((check) => check.id.startsWith(`${layer}/`));
    const status = ["Blocked", "Unverified", "Ready", "Not applicable"]
      .find((candidate) => group.some((check) => check.status === candidate));
    return { layer, status };
  });
  return { property, release, generatedAt: now.toISOString(), status, layers, checks };
}

function verifyLocal({ property, release, evidence = [] }) {
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error("Local release identity could not be verified.");
    return result.stdout.trim();
  };
  if (git("rev-parse", "HEAD") !== release || git("status", "--porcelain")) {
    throw new Error("Local verification requires a clean checkout at the full release commit SHA.");
  }
  const local = [];
  const commands = [
    ["build", ["node_modules/vite/bin/vite.js", "build"]],
    ["automated-tests", ["node_modules/vitest/vitest.mjs", "run",
      "--exclude", "src/lib/__tests__/live-security.test.ts",
      "--exclude", "src/lib/__tests__/hr-reconciliation.test.ts",
      "--exclude", "src/lib/__tests__/index-coverage.test.ts"]],
  ];
  for (const [key, args] of commands) {
    const command = `node ${args.join(" ")}`;
    const result = spawnSync(process.execPath, args, {
      cwd, encoding: "utf8", timeout: 20 * 60 * 1000, maxBuffer: 8 * 1024 * 1024,
    });
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    const unavailable = /MODULE_NOT_FOUND|Access is denied|EACCES|EPERM/.test(result.stderr ?? "");
    local.push({
      check: `release/${key}`, property, release, checkedAt: new Date().toISOString(),
      expected: `${command} exits successfully`,
      observed: result.error?.message ?? (result.signal ? `Terminated by ${result.signal}` : `Exit code ${result.status}`),
      reference: `${command} at ${release}`,
      result: result.error || result.signal || unavailable ? "unverified" : result.status === 0 ? "pass" : "fail",
    });
  }
  if (git("rev-parse", "HEAD") !== release || git("status", "--porcelain")) {
    throw new Error("Checkout changed during local verification.");
  }
  return [...evidence, ...local];
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const input = JSON.parse(readFileSync(process.argv[2] ?? 0, "utf8").replace(/^\uFEFF/, ""));
    if (process.argv.includes("--verify-local")) input.evidence = verifyLocal(input);
    const report = assessReadiness(input);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = { Ready: 0, Blocked: 1, Unverified: 2 }[report.status];
  } catch (error) {
    console.error(error.message);
    process.exitCode = 3;
  }
}
