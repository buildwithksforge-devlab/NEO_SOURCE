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
import { fileURLToPath, pathToFileURL } from "node:url";
import { findBrokenInteropDestructures } from "./bundle-interop.mjs";

const ROOT = process.cwd();
// TanStack Start/Nitro emits the deployable application under `.output`.
// The old Vite-only project used `dist`; keeping that path made the smoke test
// fail after a successful production build without ever loading the server.
const DIST = path.join(ROOT, ".output");
const SKIP_BUILD = process.argv.includes("--no-build");
const PORT = Number(process.env.SMOKE_PORT ?? 4173);
const ROUTES = ["/", "/auth"];

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
  const mod = await import(pathToFileURL(entry).href);
  const handler = mod.default ?? mod;
  if (typeof handler.fetch !== "function") throw new Error("built server exposes no fetch handler");

  // Exercise the real Nitro -> SSR boundary, not only src/server.ts directly.
  // No remote call or live agent operation occurs: only the managed upstream
  // fetch is replaced, then restored before the ordinary route checks below.
  const originalFetch = globalThis.fetch;
  let printForwards = 0;
  try {
    globalThis.fetch = async (input, init) => {
      if (String(input) !== "https://horizon-prime-os.lovable.app/api/public/print-agent/printers") {
        throw new Error("Smoke print request reached an unexpected executor");
      }
      const headers = new Headers(init?.headers);
      if (headers.has("cookie") || headers.has("apikey")) throw new Error("Smoke print request forwarded a private browser header");
      printForwards++;
      return Response.json({ printers: [] });
    };
    const print = await handler.fetch(new Request(`http://localhost:${PORT}/api/public/print-agent/printers`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer neopc_" + "0".repeat(64), cookie: "smoke-only" },
      body: "{}",
    }), { NEO_MANAGED_PRINT_ENABLED: "true" }, { waitUntil() {}, passThroughOnException() {} });
    if (print.status !== 200 || printForwards !== 1) throw new Error("Compiled managed printing did not use its request-local runtime binding");
    const payload = await print.json();
    if (!Array.isArray(payload.printers) || payload.printers.length !== 0) throw new Error("Compiled print routing returned an unexpected result");
    console.log("  ✓ managed print route uses request-local bindings and fixed executor; no live request");
    let commsForwards=0;
    const summaryId="e98b312a6ceb488a8c655879fd1294414c8ca3f5371063378ad309e1c8c1f433";
    globalThis.fetch=async(input,init)=>{
      if(String(input)!==`https://horizon-prime-os.lovable.app/_serverFn/${summaryId}`)throw new Error("Unexpected communication executor");
      if(new Headers(init?.headers).has("cookie"))throw new Error("Communication relay forwarded cookie");
      commsForwards++;return Response.json({masked:true});
    };
    const comms=await handler.fetch(new Request(`http://localhost:${PORT}/_serverFn/${summaryId}`,{method:"POST",headers:{authorization:"Bearer smoke.payload.signature","content-type":"application/json"},body:"{}"}),{NEO_MANAGED_COMMS_ENABLED:"true"},{waitUntil(){},passThroughOnException(){}});
    if(comms.status!==200||commsForwards!==1)throw new Error("Compiled communications did not use request-local runtime bindings");
    console.log("  ✓ managed communication route uses request-local bindings; no email sent");
  } finally {
    globalThis.fetch = originalFetch;
  }

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
    const cache = res.headers.get("cache-control") ?? "";
    if (!cache.includes("private") || !cache.includes("no-store")) {
      throw new Error(`${route} does not protect the dynamic document from shared caching`);
    }
    if (!/name="neo-build-id"\s+content="[a-f0-9]{16}"/.test(body)) {
      throw new Error(`${route} has no actual-source build identity`);
    }
    if (/fonts\.(?:googleapis|gstatic)\.com/.test(body)) {
      throw new Error(`${route} still loads a remote Google font resource`);
    }
    console.log(`  ✓ ${route} → HTTP ${res.status}; private/no-store, source identity, local fonts`);
  }
}

async function main() {
  if (!SKIP_BUILD) {
    console.log("→ production build");
    await run(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build"]);
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
