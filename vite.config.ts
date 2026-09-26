// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { execSync } from "node:child_process";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

/**
 * Build identity. Stamped into the bundle so an authorised person can confirm
 * from inside the running application which source revision is deployed,
 * instead of guessing from appearance. Build-time only — never shipped logic.
 */
function sourceRevision(): string {
  try {
    return execSync("git rev-parse --short=8 HEAD", { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    define: {
      __NEO_BUILD_REVISION__: JSON.stringify(sourceRevision()),
      __NEO_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
  },
});
