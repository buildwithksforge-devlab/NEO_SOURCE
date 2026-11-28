import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    // Keep concurrent jsdom suites within workstation memory.
    maxWorkers: 2,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
