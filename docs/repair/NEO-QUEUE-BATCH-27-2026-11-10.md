# Pending stale-view batch completed — 10 November 2026

Deployed build 3e60a4b662a22e13, version 028d70c4-47ad-4e4d-b82b-4a3f808c9cc5. Previous version 669f2229-7e69-4e04-bbf0-5ad9392b4e78 is the rollback point.

This finishes the existing stale-view release only. Per the user's latest instruction, stop here before further reservation, payment-rule, laundry, provider-integration or general queue work.

Repairs:
- Payment and posting refresh now reaches financial lifecycle, financial states, posting/facts, folio trace, commitments, credit and linked CRM balances, including the older front-desk and finance mutation paths.
- Outbox batch replay validates its saved result and refreshes actual outbox, automation, intelligence and financial keys. A refused/malformed result cannot announce a zero-count success; partial failures remain warnings. No live replay was executed.
- Visible financial views read authoritative changes every 15 seconds, scoped to worker and effective access. The app has a one-minute fallback for selected read-only operational roots if a realtime event is missed. Hidden and unmounted views do not poll; explicit existing query intervals retain precedence. One-shot actions, simulations, signed links and credentials are excluded.
- A changed access contract cancels and clears old cached answers before new grants are published. Access-matrix answers now have organization/worker/access boundaries and an explicit refresh interval; failed reads no longer masquerade as empty overrides.
- Automation query keys include resolved organization/worker/access. Live automation status lists refresh while visible; saved provider changes invalidate linked status summaries.
- Provider status distinguishes loading/read failure from Not configured. Saved-account forms do not present failed masked-summary reads as missing credentials. The Payments summary waits for verified data instead of displaying unknown amounts as zero/current.

Validation: 4347 offline tests passed, zero failed, 155 skipped; all 4280 prior unique passing cases retained. The initial full run had two source-scanner failures after helper refactoring; both scans were updated to follow the actual shared wiring, and all affected suites plus the 53 runtime/cache checks passed again (139 final focused passes). Production code was unchanged by those scanner corrections. Fifty-three targeted stale-view/cache checks pass, including actual QueryClient observers, a simulated remote-worker update, hidden/unmounted behavior, explicit interval override, active/inactive invalidation and cancellation of a late old-authority answer. Strict typecheck, production build, source identity, startup smoke and live HTTP checks pass.

No new SQL, live financial transaction, outbox replay, guest message, provider delivery or historical rewrite was executed. Authenticated business-day acceptance remains separate. This release does not certify that every static audit candidate is a defect or that every runtime stale state has been eliminated. No whole backlog item is newly marked fully closed from these code checks.
