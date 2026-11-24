# Staff PIN history and display-entry repair

## Existing working connection preserved

The prior “Open Local Vite Test” chat records the device/PIN migration being reported successful after correcting the audit logger signature: its correlation argument is text, not UUID. That successful migration was followed by the Owner/System Administrator management-screen work. It must not be blindly replayed.

Git commit `896fb78` (5 November 2026) deliberately routed Cloudflare staff PIN requests through the deployed `horizon-prime-os.lovable.app` broker. The working chain is the browser's same-origin PIN endpoint, the deployed broker, existing Supabase device/PIN validation and Auth token exchange, then property-scoped entry. The direct Supabase Edge Function URL returning 404 does not establish that this working broker path is broken. The broker, edge-function source and original device migration are unchanged by this batch.

The prior “Fix Deno TypeScript Errors” chat concerned editor configuration for Deno source. It did not require a replacement authentication architecture. The recovered user preference is PowerShell-based source edits and verification, preserving existing code and avoiding unnecessary modules or downloadable script/ZIP instructions.

## Requested behavior implemented locally

- Resolve the existing signed-in property context first. The mode chooser uses its standalone entrance frame, including absolute URLs, trailing slashes and hashes. It does not mount the OS sidebar/topbar.
- Enter NEØ System opens the existing permission-resolved workspace. Chooser and dashboard now mount separate components, fixing the previous conditional-hook transition. Existing ordinary PIN staff work-home routing stays in place; supervisors who can configure displays retain the chooser.
- Standalone display Supervisor Tools opens a local settings dialog and returns to the same screen. It offers authorised paired-station filtering and compact spacing. Changing paired property/department/access explicitly opens the existing supervisor sign-in/management flow; local controls grant no additional station scope.
- A separate Log out of display clears this browser's restricted display token and private query/context state, and uses local-only Auth sign-out. Other devices' staff sessions are preserved. Remote revocation remains the existing authenticated supervisor operation.
- Install acknowledgements/dismissal persist in device-local storage across sign-out and restart. Actual install/standalone events and manual “Already installed” acknowledgement stop repeat reminders. Existing unexpired staff/display authorisation also suppresses the install offer. These preferences never count as authentication or grant access.
- A matching unexpired trusted staff device is acknowledged in the chooser with a disabled Device authorised control instead of issuing another pairing request.

No additional Supabase SQL, role grant, storage migration or authentication endpoint switch is required for these UI fixes. The two organisation rows shown in the SQL screenshot are not used to guess a grant target.

## Evidence and limits

Focused checks passed for the actual chooser-to-dashboard transition, scope denial, device acknowledgement, actual outer entrance frame, tools versus logout, local-only exit, and durable install preferences. The existing PIN/shared-display contracts remain unchanged. Synthetic Chrome checks at 360 and 1440 pixels confirmed an in-bounds tools dialog, no horizontal page overflow, compact-spacing changes and return to the same open display without logout.

The complete source gate passed: 3,667 tests passed, zero failed and 155 skipped, with all 3,642 preceding passes retained. Typecheck, isolated device catalogue, all 14 local printer-agent checks and production build/smoke passed. The built auth page returned HTTP 200 with private/no-store and source fingerprint fcad40292a145382 matching the current source. A static scan of 875 public build files found no Supabase secret-key strings or service-role JWTs; this is not a comprehensive privacy/security certification. Current live deployment remains commit `44389e1`, source `be1ab168d04bf6d9`, until this new source batch is published. No new database writes, staff resets, pairing operations or live ticket transitions have been performed by the tests.

This batch targets the original F10 display-entry area, with related device/display usability. It does not certify the original 87/88 failed business outcomes as green or replace the outstanding financial/stock/stay and original 30 live regression gates.
