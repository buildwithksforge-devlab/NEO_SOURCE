#!/usr/bin/env node
/**
 * Production build smoke guard.
 *
 * Unit tests import modules through Vite/Vitest, which resolves ESM entry
 * points differently from the production bundler. A dependency that breaks
 * only under esbuild's CommonJS interop (for example the tslib 1.x
 * `const { __extends } = tslibDefault` pattern) therefore passes a green test
 * suite and still crashes the app at module load.
 *
 * This script closes that gap:
 *   1. runs a real production build,
 *   2. statically scans the emitted bundles for destructure-of-default interop
 *      shapes that throw "Cannot destructure property 'X' of
 *      '__toESM(...).default' as it is undefined",
 *   3. boots the built server and asserts the document actually renders.
 *
 * Usage: bun run smoke   (or: node scripts/build-smoke.mjs --no-build)
 */


import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
// TanStack Start/Nitro emits the deployable application under `.output`.
// The old Vite-only project used `dist`; keeping that path made the smoke test
// fail after a successful production build without ever loading the server.
const DIST = path.join(ROOT, ".output");
const SKIP_BUILD = process.argv.includes("--no-build");
const PORT = Number(process.env.SMOKE_PORT ?? 4173);
const ROUTES = ["/", "/auth"];

/** Helper names that only exist in a TS runtime shim such as tslib. */
const HELPER_NAMES = [
  "__extends",
  "__assign",
  "__awaiter",
  "__generator",
  "__decorate",
  "__spreadArray",
  "__importDefault",
];

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(m?js|cjs)$/.test(entry.name)) yield full;
  }
}

/**
 * Flags `var { __extends, ... } = __toESM(<cjs module>)` — esbuild's interop
 * shape for an ESM shim that destructures a CommonJS default export. When the
 * CommonJS module is a UMD bundle with no real default, every destructured
 * helper is undefined and the module throws on load.
 */
export function findBrokenInteropDestructures(source) {
  const hits = [];
  const pattern = /(?:var|const|let)\s*\{([^}]{0,4000}?)\}\s*=\s*[^;{}]{0,80}?__toESM\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const names = match[1];
    const helper = HELPER_NAMES.find((name) => new RegExp(`\\b${name}\\b`).test(names));
    if (helper) hits.push(helper);
  }
  return hits;
}

async function scanBundles() {
  const offenders = [];
  for await (const file of walk(DIST)) {
    const source = await readFile(file, "utf8");
    const hits = findBrokenInteropDestructures(source);
    if (hits.length) offenders.push({ file: path.relative(ROOT, file), helpers: [...new Set(hits)] });
  }
  return offenders;
}

/**
 * Loads the emitted server bundle and renders real routes through its fetch
 * handler. This is what catches a module-load crash: the whole SSR graph
 * (routes, shared libs, every dependency) is evaluated exactly as it is in
 * production, and an interop failure surfaces as a throw or a 500.
 */
async function smokeRoutes() {
  const entry = path.join(DIST, "server", "index.mjs");
  const mod = await import(`file://${entry}`);
  const handler = mod.default ?? mod;
  if (typeof handler.fetch !== "function") throw new Error("built server exposes no fetch handler");

  for (const route of ROUTES) {
    const res = await handler.fetch(new Request(`http://localhost:${PORT}${route}`), process.env, {
      waitUntil() {},
      passThroughOnException() {},
    });
    const body = await res.text();
    if (res.status >= 500) throw new Error(`${route} → HTTP ${res.status}: ${body.slice(0, 300)}`);
    if (/"unhandled"\s*:\s*true/.test(body)) throw new Error(`${route} returned a swallowed SSR error`);
    if (/Cannot destructure property/.test(body)) {
      throw new Error(`${route} rendered a module-load interop crash`);
    }
    if (res.status < 400 && !/<html/i.test(body)) throw new Error(`${route} rendered no document`);
    console.log(`  ✓ ${route} → HTTP ${res.status}`);
  }
}

async function main() {
  if (!SKIP_BUILD) {
    console.log("→ production build");
    await run("npx", ["vite", "build"]);
  }

  console.log("→ scanning bundles for ESM/CommonJS interop crashes");
  const offenders = await scanBundles();
  if (offenders.length) {
    for (const o of offenders) console.error(`  ✗ ${o.file}: destructures ${o.helpers.join(", ")}`);
    throw new Error(
      "Bundle contains a destructure-of-default interop shape that throws at module load. " +
        "Force a single, ESM-safe version of the offending runtime shim (see package.json overrides).",
    );
  }
  console.log("  ✓ no broken interop destructures");

  console.log("→ smoke-loading the built server");
  await smokeRoutes();
  console.log("\nBuild smoke check passed.");
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`\nBuild smoke check FAILED: ${error.message}`);
    process.exit(1);
  });
}
