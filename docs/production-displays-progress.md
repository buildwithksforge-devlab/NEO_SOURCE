# Production displays — implementation and remaining verification

Updated 2026-10-21. Continue this scope before unrelated Finance/EOD testing.

## Implemented locally, not deployed

- Personal department entry points: `/kitchen/display`, `/bar/display`,
  `/coffee/display`, `/pastry/display`; read-only manager `/production-overview`.
- Menu and direct-link capabilities; one selected property; server-visible
  stations only. Failed/loading scope never defaults to all stations.
- Existing canonical tickets/transitions; fullscreen, refresh and audit history.
- `/staff-display-code`: own code and six-digit PIN enrolment/reset/disable.
- `/production-displays`: supervisor controls, active screen list and revocation.
- Supervisor pairs selected department stations, then signs this browser out.
- `/station-screen`: separate restricted-token screen, no normal staff sidebar.
  Returning from supervisor controls signs out any remaining staff session.
- Device tokens are random 256-bit values, stored hashed server-side, expire
  after 12 hours, and are held in tab session storage, never in the URL.
- Each action needs staff code/PIN; fields clear after submission. PINs are
  bcrypt-hashed; five failures lock that credential for 15 minutes; a display
  also has a 20-failure/15-minute limiter. Failed counters return normally so
  they survive an unsuccessful attempt.
- Each request rechecks active staff, organisation, station, supervisor and
  device authority. Direct API calls cannot bypass the read-only overview.
- Successful work uses existing canonical production transitions and records
  staff actor plus pairing supervisor/device. Locks and expected status protect
  claims; request UUIDs make uncertain-network retries idempotent.
- Shared mode offers Accept, Start Preparing, Ready and Report Delay. Service,
  reassignment and cancellation remain in the authorised staff workspaces.
- Polling every five seconds; offline/error states disable new actions.
- Private credential/session tables and delegation helpers have no anon or
  authenticated direct access. Only token-checked read/action RPCs allow anon.

## Database installation and rollback verification passed

The user's `pquery-results-export-2026-10-21_11-01-30` confirms all 16
rollback checks PASS after installation. Violet's existing Hot Kitchen assignment
was used; no permissions were fabricated. Staff actions recorded Violet as actor
and Mr Saitoti as pairing supervisor. PIN attempts/lockout/reset, expected-status
and retry handling, station/property boundaries, read-only overview, expiry,
revocation, private tables and private delegation helper checks passed.

The fixture was a zero-value non-menu order line for display mechanics. Test PIN
changes, orders, tickets, tills and device sessions were rolled back. These checks
used simulated request identities in a privileged SQL session: actual browser-role
access, true concurrent clients and the finished UI still need verification.

Local build, typecheck and 82 focused tests passed. No external git push or live
frontend deployment has been performed. Next: protected preview deployment and
real staff screen walkthrough. Avoid reinstalling unrelated modules.

## Remaining connected scope (do not lose this list)

1. Deploy the source, then verify real staff
   sign-in, code setup, pairing, PIN action, revocation and reconnect in browser.
2. Verify Kitchen, Coffee, Bar and Pastry permissions with real operator roles.
3. Mixed waiter order → correct station tickets → individual readiness → service
   on one bill. Include assignment/reassignment and item-level shared-screen work.
4. Preparation-ticket PDF/printing, additions-only prints and retry handling.
5. Vegetable burger: legitimate potato transfer into Kitchen Store; normal drink
   setup and Jameson availability. Earlier drinks used rollback configuration.
6. Delivery screens and one connected kitchen-to-rider-to-payment walkthrough.

Prior stock/payment/variance/EOD rollback tests certify their stated cases only;
they do not replace these shared-display and staff-role checks.
