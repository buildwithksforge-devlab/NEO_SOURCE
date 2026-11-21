import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const report = ".output/local-workflow-tests.json";
const fixtures = [
  "staff-pin-login-contract", "pin-device-session-flow", "neo-access-boundaries",
  "guest-experience-quality", "guest-operations-property-postgres", "guest-basket-property-postgres",
  "cross-entry-guest-rider-contract", "public-delivery-publication-postgres", "delivery-intake-postgres",
  "delivery-dispatch-contract", "guest-mpesa-deposit-idempotency", "guest-laundry-postgres",
  "pms-missing-accommodation-postgres", "pms-multi-folio-checkout-postgres", "pms-nightly-pricing-parity-postgres",
  "pms-night-audit-close-gate-postgres", "pos-room-transfer-postgres", "payment-gateway-dispatch-safety",
  "sales-tax-workflow-postgres", "thermal-receipt-layout", "print-agent-postgres-api",
  "inventory-batch-cost-postgres", "receiving-document-postgres", "supplier-payable-integration-postgres",
  "housekeeping-execution-chain", "events-property-contract", "payroll-posting-release-guard",
  "automatic-platform-checks-postgres", "platform-public-app-health", "simulation-release",
];

function run(...args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

mkdirSync(new URL("../.output/", import.meta.url), { recursive: true });
console.log("Running isolated PostgreSQL fixtures and workflow contracts.");
run("node_modules/vitest/vitest.mjs", "run", "--maxWorkers", "2",
  "--reporter=default", "--reporter=json", `--outputFile=${report}`,
  ...fixtures.map((name) => `src/lib/__tests__/${name}.test.ts`));
run("scripts/test-readiness-queue-boundaries.mjs");
console.log(`Local workflow checks passed. Test report: ${report}`);
