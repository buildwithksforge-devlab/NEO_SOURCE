import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8").trim();

export function providerPaymentRolloutSql() {
  const baseline = read("supabase/repair/2026-11-21/provider-dispatch-baseline.sql").replace(/;$/, "");
  const dispatch = read("supabase/migrations/20261112140000_provider_payment_dispatch_safety.sql");
  const refund = read("supabase/migrations/20261121123600_provider_refund_reconciliation_guard.sql");
  if (!refund.startsWith("BEGIN;") || !refund.endsWith("COMMIT;")) throw new Error("Refund transaction wrapper changed.");

  return `-- Run only on the authorised project with the reviewed provider payment definitions.
BEGIN;
DO $rollout$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (${baseline}) AS installed
    WHERE deployment_state = 'review_required'
       OR anonymous_can_execute IS TRUE
       OR (operation = 'apply' AND (browser_can_execute IS DISTINCT FROM false OR service_can_execute IS DISTINCT FROM true))
  ) THEN
    RAISE EXCEPTION 'Provider callback definitions or grants differ. Run provider-dispatch-baseline.sql.';
  END IF;
  IF EXISTS (SELECT 1 FROM (${baseline}) AS installed WHERE deployment_state = 'refund_safe') THEN
    RAISE EXCEPTION 'The provider refund guard is already installed. Use provider-dispatch-baseline.sql to verify permissions.';
  END IF;
END;
$rollout$;

${dispatch}

${refund.slice(6, -7).trim()}

NOTIFY pgrst, 'reload schema';
COMMIT;

${baseline};
`;
}

if (process.argv[1] && new URL(import.meta.url).pathname.split("/").at(-1) === process.argv[1].split(/[\\/]/).at(-1)) {
  const output = new URL(".output/", root);
  mkdirSync(output, { recursive: true });
  const target = new URL("NEO_PROVIDER_PAYMENT_ROLLOUT.sql", output);
  writeFileSync(target, providerPaymentRolloutSql(), "utf8");
  console.log("Wrote .output/NEO_PROVIDER_PAYMENT_ROLLOUT.sql");
}
