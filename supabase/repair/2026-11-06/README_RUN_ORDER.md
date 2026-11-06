# NEØ local repair → SQL Editor → GitHub → Cloudflare

Source: `C:\Users\Kelvin\Downloads\NEO_COMPLETE_2026-09-26\NEO_SOURCE`
Branch: `repair/neo-waves-20261106`, based on `9d18edc`.
Target Supabase project reference from the local configuration: `zlrrmrcqlerafptkgucl`.
Cloudflare target retained by the existing protected script: `neo-preview` at `https://neo-preview.neo-hospitality.workers.dev`.

## Current evidence

- Local typecheck passed.
- Full offline suite: 3642 passed, 0 failed, 155 skipped.
- All 3,637 assertions passing before the final UI/password-reset batch remained passed by file and full test identity.
- Production build and built-server smoke checks passed for `/` and `/auth` (HTTP 200).
- 32 isolated PostgreSQL checks cover housekeeping/GRN and delivery retry boundaries; these use minimal fixtures and stub dependencies, not a full live Supabase workflow.
- The operational core bundle, scoped device grant and postcheck SQL were separately executed successfully in an isolated PostgreSQL fixture.
- Guest laundry: 23 isolated PostgreSQL tests plus 19 actual-hook/display tests passed. The exact combined laundry SQL transaction and read-only queries also passed in the fixture; repeated application was refused by its drift guard.
- Printing: 22 real API/PostgreSQL fixture checks, 14 local-agent/native-adapter checks and the discovery UI/durable-mutation checks passed. Native inventory found two virtual queues and no candidate physical queues on this computer; no physical paper is certified.
- Device catalogue seed test passed: exactly the two approved role templates, repeat-safe inserts, existing assignments preserved.
- No operational SQL, GitHub push or Cloudflare deployment has been performed.

These results do not mark the 88 original failures, the additional partial outcomes, or the 30 live workflows as passed. The supplied board shows 30 passed / 28 partial / 87 failed; only 71 complete tiles, including 23 passed tiles, were visible. That discrepancy and the cropped lower board remain open.

## 1. SQL Editor preflight — run this first

Run `00_READ_ONLY_PREFLIGHT.sql` in the verified project's SQL Editor. Save/export all result sets, especially function and trigger definitions and migration history. Share the results without credentials. The preflight is read-only.

Do not remove a source-drift guard if a repair refuses to run. It means the operational function/trigger differs from the reviewed checkout or the repair has already been applied. Reconcile that evidence first.

The checkout contains older migrations explicitly labelled `LOCAL DRAFT - DO NOT DEPLOY`. This package does not apply those historical drafts, alter Room 205, repair historical accounting or close an existing business day.

## 2. Core Wave 1 SQL

After the preflight definitions and recovery evidence are reviewed, run `10_APPLY_CORE_WAVE1.sql` as ONE complete SQL Editor submission. It contains only these three versioned repairs in a single transaction:

- `20261106090000`: stop the housekeeping writer from assigning a vacant legacy condition; leave the deployed room-state trigger intact.
- `20261106090100`: reject unconfirmed GRN accrual results instead of reporting a successful posting.
- `20261106090200`: add property-scoped retry identity for staff-assisted delivery intake and preserve the original intake validation/routing routine.

The bundle checks the known room trigger, deployed function bodies and delivery dependencies. It sets bounded lock and statement timeouts. If any statement fails, the transaction cannot commit; use `ROLLBACK;` if the editor retains an aborted transaction. Do not then execute only the later portion of the file.

The individual timestamped SQL files are supplied for comparison and for an intentionally separate application path. Do NOT run those three individually after the combined core bundle succeeds.

## 2a. Guest laundry SQL — after its separate preflight

Run `15_READ_ONLY_LAUNDRY_PREFLIGHT.sql` and review the deployed function definitions, actor column type, folio currency, lifecycle triggers and migration history. Then submit `20_APPLY_GUEST_LAUNDRY.sql` as ONE transaction. It includes only:

- `20261106091000`: atomic, property-scoped guest laundry intake; server catalogue prices, active stay/open guest folio linkage, audit and stable retry identity.
- `20261106091100`: allow the first folio posting retry and require the actual matching saved charge; keep failed posting attempts visibly blocked.
- `20261106091200`: correct the text/UUID delivery actor mismatch and check property access before an idempotent lifecycle return.

Run `95_READ_ONLY_LAUNDRY_POSTCHECK.sql` afterward. Do not also run the three individual files after the combined transaction succeeds. Drift guards intentionally refuse different or already replaced function bodies; do not remove them.

These changes do not backfill old orders, repair historical charges, change role grants or certify the GL chart and journal triggers. The isolated tests exercise the actual folio posting/coordinator functions with fixture dependencies; garment reconciliation is a stated fixture prerequisite. Controlled end-to-end UAT must still confirm collection, batch processing/reconciliation, handover, one correct guest folio charge, posting receipt, downstream journal and stock effects, plus denied property access and safe retries. Do not create synthetic orders in unrelated operational stays.

After this transaction and its postchecks actually succeed, reconcile ONLY these versions with the verified project's installed CLI:

```powershell
npx supabase migration repair 20261106091000 20261106091100 20261106091200 --status applied --linked
```

## 2b. Owned local printing — app, API and agent together

Printer setup is now in Configuration Centre → Integrations → Printers & Print Queue (`/admin/printers`). POS links there; the older platform URL redirects there. The old POS transport buttons only saved labels. The new local agent performs Windows queue inventory and local network discovery; no outside printing/discovery service was added.

Run `25_READ_ONLY_PRINT_PREFLIGHT.sql`. The deployed `neo_print_agent_printers`, `neo_print_agent_claim` and `neo_print_agent_finish` definitions must match the reviewed physical-agent migration. The app/API repair corrects single-object claim handling and the exact `claim_id`/`_claim` contract. An older TABLE-returning claim or different finish signature must be reconciled before deploying this source. Do not blindly run `20261101123000_complete_physical_print_agent.sql` over a different deployment.

Submit `30_APPLY_LOCAL_PRINTER_DISCOVERY.sql` as one transaction, then run `96_READ_ONLY_PRINT_POSTCHECK.sql`. It contains only version `20261106092000`: discovery metadata and tightly scoped first-party functions. Exact source guards, lock/statement timeouts and service-role-only agent execution are retained. It creates no new role grants and rewrites no historical printers or jobs. The individual versioned file is supplied for comparison; do not apply it again after the combined submission.

Only after actual commit and verified postchecks:

```powershell
npx supabase migration repair 20261106092000 --status applied --linked
```

Deploy the matching application/API revision and update the property computer's owned-local agent files together. Pair the correct property computer and download its one-time private configuration. Start it with `scripts/start-print-agent.ps1` using Node 22. Keep secrets out of Git. `OWNED-LOCAL-PRINTING.md` in the output package and `docs/repair/owned-local-printing.md` in the checkout explain supported transports, native pairing prerequisites, startup and physical test evidence.

USB/Bluetooth search means installed Windows queues; Bluetooth radio pairing is handled in Windows. Wi-Fi/LAN discovers local advertisements and installed network queues. Direct IPP, cloud-vendor printing and arbitrary Bluetooth drivers are not implemented. Known virtual queues are not offered as physical printers. A discovered device or accepted TCP/spooler write is not proof of paper at the correct station. Each PL outcome stays open until its own physical, isolation and reprint evidence exists.

## 2c. Maintenance verification and room handback

Run `35_READ_ONLY_MAINTENANCE_PREFLIGHT.sql` and review the saved lifecycle, room release, history/assignment/asset triggers and room-state definitions. Submit `40_APPLY_VERIFIED_MAINTENANCE.sql` as one transaction, then run `97_READ_ONLY_MAINTENANCE_POSTCHECK.sql`. This is version `20261106093000`; do not apply its individual SQL again after the bundle succeeds.

The change connects board transitions to the canonical RPC, enforces independent noted closure, prevents direct lifecycle-evidence bypass, records one history event with its note, scopes room release and preserves other room holds. It rewrites no historical rows and adds no role grants. Exact function and room-trigger guards refuse a different deployment. Keep and review preflight recovery evidence; do not strip guards.

After actual commit and verified postchecks only:

```powershell
npx supabase migration repair 20261106093000 --status applied --linked
```

Deploy the matching application revision. Follow `MAINTENANCE-VERIFICATION-AND-HANDBACK.md` in the output package, or `docs/repair/maintenance-verification-and-handback.md` in source, for ordinary-role UAT and limitations. Historical safety holds, asset servicing, parts/stock and notification routing remain separate controlled evidence; source tests do not certify the entire maintenance workflow.

## 3. Device administration — separate, approved scope

The approved capability is `administration.devices.manage`, only for Owner and IT/System Administrator. `administration.users.manage` was not added.

- If the preflight shows the device backend is already installed and matches the working checkout, do not reapply it.
- `OPTIONAL_EXISTING_DEVICE_PREREQUISITE_REVIEW_FIRST.sql` is your pre-existing device/PIN feature, wrapped transactionally. Its source file is preserved unchanged. It is not part of the tested core bundle. If this backend is missing, review its prerequisites and recovered definitions before applying this separate feature. Its local security/contract tests passed, but it has not been executed against a full Supabase copy here.
- Run `20261106090300_device_management_capability.sql` to add the permission and two template catalogue entries. This alone does not alter existing role assignments.
- If enabling existing roles is required, use `50_OPTIONAL_SCOPED_DEVICE_GRANT.sql`. Replace the organisation UUID using the verified preflight row and enter the operator/change reference. It grants only the dedicated device capability to existing active Owner/System Administrator roles in that ONE organisation, records grant audit IDs and leaves user assignments, PIN values, other permissions and other organisations unchanged. No global template rewrite is required.

## 4. Post-apply and live evidence

Run `90_READ_ONLY_POSTCHECK.sql` after the selected changes commit. Save its results. Test with ordinary allowed and denied accounts after refreshing the session; SQL Editor admin success does not prove app access.

Use controlled labelled workflows, not unrelated operational data: occupied stayover through inspection, vacant turnover, maintenance-blocked control, one rejected/retried save, and duplicate delivery submission. Financial and stock consequences need their own saved/audit/downstream evidence. Recheck every original passed workflow and newly fixed flow on the same deployed revision. Until this evidence exists, the launch decision remains NO-GO.

## 5. Reconcile migration history

SQL Editor changes bypass CLI migration history. After checking the real database state, mark ONLY the versions that actually committed as applied; do not rerun their SQL through another channel.

Check your installed CLI's target flags with `npx supabase migration repair --help`. The CLI reference documents the linked-project form below. If your installed version uses `--remote`, use that documented remote form after confirming the same project.

```powershell
Set-Location 'C:\Users\Kelvin\Downloads\NEO_COMPLETE_2026-09-26\NEO_SOURCE'
npx supabase --version
npx supabase migration repair --help
npx supabase link --project-ref zlrrmrcqlerafptkgucl
npx supabase migration list --linked

# ONLY after the combined core transaction and postchecks succeeded:
npx supabase migration repair 20261106090000 20261106090100 20261106090200 --status applied --linked

# ONLY if the device catalogue SQL also committed:
npx supabase migration repair 20261106090300 --status applied --linked

# Mark 20261106020000 only if that separate existing device migration
# was actually applied and its results verified.
npx supabase migration list --linked
```

Do not run a broad `db push` over all 1,085 historical migration files from this checkout. Missing history and older drafts must be reconciled individually. `migration repair` changes the history record; it does not execute or reverse SQL.

References: [Supabase migration deployment guidance](https://supabase.com/docs/guides/deployment/database-migrations), [CLI migration repair](https://supabase.com/docs/reference/cli/supabase-migration-repair).

## 6. Review and push the tested source

Use the Node 22 runtime already validated in this session, without modifying the global NVM installation:

```powershell
Set-Location 'C:\Users\Kelvin\Downloads\NEO_COMPLETE_2026-09-26\NEO_SOURCE'
$neoRuntime = 'C:\Users\Kelvin\Documents\Codex\2026-11-06\files-pasted-by-the-user-ne\work\tooling\node-v22.23.3-win-x64'
$env:PATH = "$neoRuntime;$env:PATH"
git status --short --branch
git diff --check
git diff
```

Review new files too; normal `git diff` does not show untracked contents. Stage the reviewed repair files and your existing device-authorisation work deliberately. Keep `.env.local`, credentials, runtime binaries and private evidence out of the commit.

Then commit the reviewed change set and push `repair/neo-waves-20261106` normally. Do not force-push or rewrite published history. A push alone does not prove that Cloudflare built this branch.

## 7. Deploy the verified revision to the protected Worker

After SQL/postchecks/history and source review are complete, use the existing protected script from the intended committed revision:

```powershell
npm.cmd run verify
# After source review, commit and normal push of the intended branch:
.\scripts\deploy-neo-preview.ps1
```

The script checks the existing Worker and account before deploying. Preserve the current Cloudflare secrets; configure any needed backend secrets through Cloudflare's secret mechanism, never client `VITE_*` variables or committed files. Verify deployed build identity, public startup, staff access and the labelled affected workflows after deployment.

For local startup without deploying, use `Start-NEO.ps1` in the parent outputs folder, or `scripts/start-local.ps1 -NodeDirectory $neoRuntime` from the source checkout. The local app uses the configured operational backend; synthetic regression writes in this session used an isolated local database instead.
## Additional accounting/receipt requirements — read-only first

45_READ_ONLY_FINANCE_RECEIPT_PREFLIGHT.sql inspects current deployed pricing/totals, discount, settlement and receipt definitions, column schemas, triggers and policies in this SAME project. It does not read financial rows or change data. It executed successfully in an isolated PGlite read-only transaction. This is an inventory for the new tax-inclusive VAT/CTL, discounts, historical KES/USD equivalents, payment instructions and receipt/accounting acceptance requirements; it is not an apply script or a claim those requirements are fixed. See NEO-MASTER-REPAIR-REGISTER.md in the output package.

The local-font, install, Back and password-reset source fixes need no additional operational SQL. Existing SQL repair prerequisites and live UAT gates still apply before deployment. The existing Wrangler deployment script was not changed.
