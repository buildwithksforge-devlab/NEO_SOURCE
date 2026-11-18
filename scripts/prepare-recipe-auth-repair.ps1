param([string]$OutputDirectory = 'supabase/repair/2026-11-18/recipe-auth-bundle', [switch]$VerifyLocal, [string]$NodePath = 'node')
$ErrorActionPreference = 'Stop'
$neoRepairRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$neoRepairOutput = [IO.Path]::GetFullPath((Join-Path $neoRepairRoot $OutputDirectory))
if (-not $neoRepairOutput.StartsWith($neoRepairRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must remain inside this checkout.' }
New-Item -ItemType Directory -Path $neoRepairOutput -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $neoRepairRoot 'supabase/repair/2026-11-18/recipe-sheet-preflight.sql') -Destination (Join-Path $neoRepairOutput '01-READ-ONLY-PREFLIGHT.sql')
Copy-Item -LiteralPath (Join-Path $neoRepairRoot 'supabase/repair/2026-11-18/recipe-single-result-inspection.sql') -Destination (Join-Path $neoRepairOutput '01B-SINGLE-RESULT-INSPECTION.sql')
Copy-Item -LiteralPath (Join-Path $neoRepairRoot 'supabase/migrations/20261113100000_atomic_recipe_sheets.sql') -Destination (Join-Path $neoRepairOutput '02-REVIEWED-RECIPE-INSTALL.sql')
Copy-Item -LiteralPath (Join-Path $neoRepairRoot 'supabase/migrations/20261118120000_recipe_direct_sale_binding.sql') -Destination (Join-Path $neoRepairOutput '02B-DIRECT-SALE-APPROVAL-BINDING.sql')
Copy-Item -LiteralPath (Join-Path $neoRepairRoot 'supabase/repair/2026-11-18/INSTALL-RECIPE-SAVE-AND-IMPORT.sql') -Destination (Join-Path $neoRepairOutput 'INSTALL-RECIPE-SAVE-AND-IMPORT.sql')
Copy-Item -LiteralPath (Join-Path $neoRepairRoot 'supabase/repair/2026-11-18/REPAIR-MAWIMBI-EXISTING-MENU-STOCK.sql') -Destination (Join-Path $neoRepairOutput 'REPAIR-MAWIMBI-EXISTING-MENU-STOCK.sql')
Copy-Item -LiteralPath (Join-Path $neoRepairRoot 'supabase/repair/2026-11-18/mawimbi-menu-stock-map.json') -Destination (Join-Path $neoRepairOutput 'mawimbi-menu-stock-map.json')
Copy-Item -LiteralPath (Join-Path $neoRepairRoot 'scripts/check-recipe-auth-api.mjs') -Destination (Join-Path $neoRepairOutput 'check-recipe-auth-api.mjs')
$neoPostcheck = @'
SELECT to_regprocedure('public.neo_recipe_sheet_save(jsonb,jsonb,uuid)') AS save_routine,
       to_regprocedure('public.neo_recipe_activate(uuid,uuid)') AS approve_routine;
SELECT has_function_privilege('authenticated','public.neo_recipe_sheet_save(jsonb,jsonb,uuid)','EXECUTE') AS staff_save,
       has_function_privilege('anon','public.neo_recipe_sheet_save(jsonb,jsonb,uuid)','EXECUTE') AS anonymous_save;
NOTIFY pgrst, 'reload schema';
'@
[IO.File]::WriteAllText((Join-Path $neoRepairOutput '03-POSTCHECK-AND-SCHEMA-RELOAD.sql'), $neoPostcheck)
$neoInstructions = @'
RECIPE / USERS / AUTH REPAIR — 18 NOVEMBER 2026

This command only prepares files. It does not install SQL, change passwords,
send email, deploy, create accounts or move stock.

LATEST STATE: user has installed the atomic recipe contract; both signatures and
history resolved, authenticated grants true, anonymous grants false. Independent
API probe now returns 401/42501 instead of missing-function 404/PGRST202.
Do not reinstall the absent-contract installer for that already-installed state.
Current data repair is REPAIR-MAWIMBI-EXISTING-MENU-STOCK.sql: 21 EXISTING menu
records, owned stock IDs, exact selected product names and container units. It
audits changes and retains all old approved recipe and stock history. No new
stock/menu/recipe is created. User authorized selecting variants on 18 November.
Frontend rollout is still needed for corrective draft source and import fixes;
normal reviewed recipe approval remains separate. Data repair is not stock sale
acceptance, nor proof of all product/station/finance workflows.

EARLIER 18 Nov inspection confirmed save/approval/history absent and no duplicate
active versions. INSTALL-RECIPE-SAVE-AND-IMPORT.sql is the consolidated installer
for that exact state: use it INSTEAD OF 02 plus 02B, not in addition to them.
It includes preflight, atomic commands, corrected future direct-sale quantity/unit
binding and a single postcheck result. Existing cross-organisation stock mappings
remain a separate review; installing commands does not make those mappings valid.

From the repository root in PowerShell:
  .\scripts\prepare-recipe-auth-repair.ps1
  node --env-file=.env.local scripts/check-recipe-auth-api.mjs
Optional complete local verification (no live business operations):
  .\scripts\prepare-recipe-auth-repair.ps1 -VerifyLocal -NodePath 'PATH-TO-NODE.EXE'
Use the existing installed Node executable if the NVM launcher is unavailable.
18 Nov diagnostic: public Auth HTTP 200; recipe RPC HTTP 404 / PGRST202.
After installation, the anonymous recipe probe should be denied by permissions;
authorised SQL preflight/postcheck is still required to verify the installed body.

1. Run 01 in the EXISTING managed project's SQL editor. Inspect the returned
   routines and duplicate active versions. If the atomic routines already exist
   but differ, preserve their definitions for review rather than overwriting.
   Do not delete duplicate recipes to make the unique index pass.
   If the editor exports only one result set, use 01B instead: it combines routine,
   duplicate-version and stock/branch ownership checks into one result row.
2. If the atomic recipe contract is absent and prerequisites/duplicates have
   been reviewed, apply 02 as one transaction in that same project. This is the
   existing atomic-recipe migration, not every migration in the repository.
3. Apply 02B after the atomic contract: future direct-sale approvals synchronize
   menu stock ID, quantity and unit together; existing approved rows are untouched.
   Its guard refuses unrecognized approval definitions and preserves owner/grants.
   Run 03. Both routines must resolve, staff_save=true, anonymous_save=false.
   A schema-cache reload cannot create a missing function; install must succeed.
4. Release the matching app source, then test one manual draft and the same
   dish imported twice. Header/components save together, retry reuses the result,
   approval is separate, and creating/approving recipes must not move stock.
5. Direct-sale imports: recipe_type=direct_sale, menu_item=<existing ID/code/name>,
   output_stock_item=<existing ID/SKU/name>, yield_quantity=1, yield_unit=bottle.
   Leave ingredient/quantity/unit blank. Dish/batch recipes still use one row per
   ingredient. Ambiguous names require exact IDs; never guess duplicate drinks.
6. Review active direct-sale rows identified by 01 before calling them ready.
   Station-store readiness does not establish that each product has a stock map.
   Verify approved direct-sale quantity/unit agrees with the menu's saved
   stock_quantity_per_sale/stock_unit before certifying inventory consumption.

AUTH PATHS
Forgot password uses public Supabase Auth, not the rejected service key.
Allow the real site's /auth/reset-password redirect in managed Auth URL settings;
verify SMTP/recovery template, email rate limits, inbox receipt and latest link.
Do not paste keys/passwords/recovery links into repair evidence.
Administrator temporary-password reset still needs the original managed
privileged executor; do not substitute a public key or weaken RLS.
Resend setup now requests an actual recovery email after capability/scope checks,
not generateLink (which did not send email). History failure is reported separately.
Test permission denial, cross-tenant denial and email-request failure before release.
No real password reset or email was performed by preparation.

CONDITIONAL HORIZON COMMUNICATIONS / PRIVILEGED USERS ROUTING
The local relay is off by default. It only supports the explicitly reviewed
existing operations; it does not copy a service key or provide arbitrary access.
NEO_MANAGED_COMMS_ENABLED=true enables the supported provider-summary read path.
NEO_MANAGED_USERS_ENABLED=true selects the supported privileged Users routes.
Separate NEO_MANAGED_COMMS_ACTIONS_ENABLED=true and
NEO_MANAGED_USERS_ACTIONS_ENABLED=true are required for their respective writes.
Verify the installed Horizon authorization, property scope and audit behavior
before releasing actions. A matching public route ID alone is insufficient.
Public forgot-password/setup email stays on Auth; do not relay the older Horizon
setup-email implementation which generated a link without sending email.
Do not enable outbound queue release or replay historical messages as a health
check. The actual sender requires its own outbound release/cutoff review.
Local email dispatch supplies a stable message idempotency key and holds unknown
provider outcomes for review instead of claiming delivery or blindly retrying.
These local changes do not prove the managed host has the same sender version.
'@
[IO.File]::WriteAllText((Join-Path $neoRepairOutput '00-READ-FIRST.txt'), $neoInstructions)
Get-ChildItem -LiteralPath $neoRepairOutput -File | Get-FileHash -Algorithm SHA256 | Select-Object Hash,Path
if ($VerifyLocal) {
  Push-Location -LiteralPath $neoRepairRoot
  try {
    & $NodePath node_modules/vitest/vitest.mjs run src/lib/__tests__/recipe-sheet-contract.test.ts src/lib/__tests__/recipe-command-error.test.ts src/lib/__tests__/staff-recovery-email.test.ts src/lib/__tests__/staff-password-pages.test.tsx src/lib/__tests__/user-management-access.test.ts src/lib/__tests__/managed-service-relay.test.ts src/lib/__tests__/managed-print-entry.test.ts src/lib/__tests__/email-provider-outcome.test.ts src/lib/__tests__/outbound-release-gate.test.ts --maxWorkers=1 --hookTimeout=30000
    if ($LASTEXITCODE -ne 0) { throw 'Recipe/Auth regression failed; do not release.' }
    & $NodePath --max-old-space-size=6144 node_modules/typescript/bin/tsc --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed; do not release.' }
    & $NodePath --max-old-space-size=6144 node_modules/vite/bin/vite.js build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed; do not release.' }
    & $NodePath scripts/build-smoke.mjs --no-build
    if ($LASTEXITCODE -ne 0) { throw 'Smoke failed; do not release.' }
  } finally { Pop-Location }
}
