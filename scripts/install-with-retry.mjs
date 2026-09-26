#!/usr/bin/env node
/**
 * Package install with exponential backoff for transient registry failures
 * (HTTP 429 rate limits, 5xx, socket resets).
 *
 * Usage:  node scripts/install-with-retry.mjs [--frozen-lockfile] [...bun args]
 *
 * Behaviour:
 *  - Runs `bun install --ignore-scripts` (plus any extra args passed through).
 *  - On a transient failure it waits 2s, 4s, 8s, 16s, 32s (with jitter) and retries.
 *  - From the 3rd attempt onwards it switches to the fallback registry
 *    (FALLBACK_NPM_REGISTRY, default https://registry.npmjs.org) so installs can
 *    still succeed while the primary mirror is rate-limiting.
 *  - Non-transient failures (missing package, bad lockfile) fail immediately.
 */
import { spawn } from "node:child_process";

const MAX_ATTEMPTS = Number(process.env["INSTALL_MAX_ATTEMPTS"] ?? 5);
const FALLBACK_REGISTRY =
  process.env["FALLBACK_NPM_REGISTRY"] ?? "https://registry.npmjs.org";
const SWITCH_REGISTRY_AFTER = Number(
  process.env["INSTALL_FALLBACK_AFTER"] ?? 2,
);

const TRANSIENT_PATTERNS = [
  /\b429\b/,
  /\b50[0234]\b/,
  /too many requests/i,
  /rate.?limit/i,
  /socket connection was closed/i,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /EAI_AGAIN/,
  /connection (closed|refused|reset)/i,
  /failed to (download|fetch|resolve)/i,
];

const isTransient = (output) => TRANSIENT_PATTERNS.some((r) => r.test(output));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runInstall(extraArgs, env) {
  return new Promise((resolve) => {
    const child = spawn("bun", ["install", "--ignore-scripts", ...extraArgs], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => {
      output += d;
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      output += d;
      process.stderr.write(d);
    });
    child.on("error", (err) => resolve({ code: 1, output: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

const extraArgs = process.argv.slice(2);
let lastOutput = "";

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  const env = { ...process.env };
  const useFallback = attempt > SWITCH_REGISTRY_AFTER;
  if (useFallback) env["BUN_CONFIG_REGISTRY"] = FALLBACK_REGISTRY;

  console.log(
    `\n[install] attempt ${attempt}/${MAX_ATTEMPTS}` +
      (useFallback ? ` via fallback registry ${FALLBACK_REGISTRY}` : ""),
  );

  const { code, output } = await runInstall(extraArgs, env);
  lastOutput = output;

  if (code === 0) {
    console.log("[install] succeeded");
    process.exit(0);
  }

  if (!isTransient(output)) {
    console.error("[install] non-transient failure — not retrying.");
    process.exit(code);
  }

  if (attempt === MAX_ATTEMPTS) break;

  const backoff = Math.round(2 ** attempt * 1000 * (0.75 + Math.random() / 2));
  console.warn(
    `[install] transient registry error (rate limit / network). Retrying in ${backoff}ms…`,
  );
  await sleep(backoff);
}

console.error(
  "[install] all attempts failed. Last output kept above for diagnostics.",
);
if (/\b429\b/.test(lastOutput)) {
  console.error(
    "[install] hint: the package mirror is rate-limiting. Wait a minute and retry, " +
      "or set FALLBACK_NPM_REGISTRY to a registry you can reach.",
  );
}
process.exit(1);
