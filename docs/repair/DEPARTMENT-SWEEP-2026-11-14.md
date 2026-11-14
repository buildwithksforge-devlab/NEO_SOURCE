# Hotel and restaurant workflow sweep — 14 November 2026

## Repaired in this release

- POS menu failures use the existing red, inline bill-error styling from the pre-dialog terminal. Exact ingredient/quantity/store reasons are retained. Unavailable items remain outside the bill. The stock dialog and visible selection-checking label are removed. Backend send-time stock validation is unchanged.
- Procurement receiving review now keys its cache by organization, staff user and active property, waits for authentication/permission loading and filters the visible queue to the selected property. Existing server authorization remains authoritative. This shared change applies across workspaces, not just Savanna.

## Sweep results

- Finance, procurement, stores, receiving, kitchen, property/data scope and M-Pesa group: 481 passed, zero failed; 31 live-database checks skipped (Finance tenant policies and live GRN/Finance evidence).
- Inventory, reservation, housekeeping, laundry, refund/void and menu-chain group: 314 passed, zero failed; 18 live branch/inventory checks skipped.
- Release regression group: see current all-entry-confirmation-tests.json; these groups overlap and must not be added as a unique-test total.
- Existing shared Finance/Procurement/Stores/Kitchen hooks use organization-based caches and server-scoped operations. No Savanna-name or previously identified organization-ID special case was found in the inspected hook families. This is a source audit, not proof that every workspace has equivalent configuration.

## Department status and limits

| Chain | Local verification | Remaining live acceptance |
| --- | --- | --- |
| Procurement → receiving → GRN → stock → Finance | Workflow, posting evidence, rollback, replay and permission tests pass | Legitimate delivery with independent authorized staff; stock movement and matching accrual journal |
| Menu → POS → kitchen → service → settlement | Routing, stock explanations, role assignment and M-Pesa regressions pass | Configured menu/station/store mapping per property; real service handoff |
| PMS → housekeeping → laundry → folio | Relevant execution, reservation and laundry suites pass | Actual staff-role acceptance and guest folio balances |
| Finance and workspace separation | Local cache and transaction contracts pass | Live RLS/catalogue checks were not run without a direct database connection |

## Open work retained

- Existing real KES51 provider-success attempt is still not credited: its associated draft was emptied after the collection started. Restore the original Ginger Cookie sale only if an authentic historical snapshot is available, then reconcile the same transaction. Do not send another prompt. A database guard against financially changing draft lines during unresolved provider collection is still open.
- Prior installed POS payment-function evidence contained workspace-specific safety validation. Current live definitions must be rechecked before claiming all financial safeguards are identical across organizations. Do not remove tenant boundaries or spread owner privileges to other roles.
- Printer hardware output, phone delivery/provider setup and broad end-to-end role acceptance are not certified by this sweep.

No stock, payment, supplier approval, guest balance or permission was modified by this audit. No new API, service-role key, Supabase project or RLS bypass was added.

Deployment guard correction: the protected deployment script retains verified compatibility_date 2026-11-13. A Nairobi-local generated date of 2026-11-14 was rejected by Cloudflare while UTC was still 13 November. The failed version was not declared deployed; strict exit-code/new-version and live-asset proof checks were retained.

Verified deployed Worker: 8e45795b-c9c9-4582-be6a-141cf3c40aa8. Release regression323/323; TypeScript/build/smoke passed. All seven live invalid-session payment checks rejected; fake callback/device proofs rejected; home/auth200. Four changed/shared deployed assets match the local build byte-for-byte, including the inline stock-error terminal. The Checking stock label is absent from that bundle.
