# NEØ R9.5 certification continuation — 25 September 2026

## Evidence boundaries

R9.5 is a **local source correction** based on the R9.4 Entirety archive. It has not been synced to or deployed on the published Lovable project. The published UI and connected production database remain separate evidence surfaces. No EOD, cash count, payment, remittance reconciliation, queued-message dispatch or protected Run 1 mutation was performed.

## Live read-only checks

- Nairobi POS shift IDs `322c3411-d032-40cb-8654-94a48a0a630f`, `90bd9d7f-d09d-4775-be8a-c82ee02b25f6`, and `ea58a9fc-09b1-42a7-92d3-5fb63da6dc88` are `pending-closure`, with zero linked orders and counted cash NULL. **BACKEND VERIFIED** for status only.
- `e9dc071b-23b1-4039-9cde-68e12904e67e` remains `pending-closure`, counted NULL. Served/unpaid POS orders `POS-20260913-WN7ID` (KES 300) and `POS-20260913-JZCB3` (KES 1,500) have `folio_post_status=not-posted`, paid KES 0. **FAILED/DEFECT**, disposition unresolved.
- `REM-260923-6790B` expected KES 7,510, declared KES 2,785, variance KES -4,725; `REM-260915-97573` KES 1,940 and `REM-260915-8200E` KES 780 submitted. All three counted NULL and unreconciled. **LIVE PARTIAL**.
- Queued communications: platform-wide 396; **Savanna Nairobi 186 = 178 email + 8 SMS**, consistent with transfer. Earlier comparison of global 396 to Savanna 186 was a scope error, now corrected. No queue dispatched.
- Savanna payroll posting settings 0; Nairobi active leave types 0. **BUSINESS CONFIGURATION REQUIRED**.
- Rendered public front door resolves both Savanna and Zuri. Zuri displays three room types and property-specific Guest route. Savanna delivery menu renders and search `pizza` filters to two dishes. Signed-out menu Add buttons are disabled in the published version. Guest booking asks for sign-in before date/rate search. **LIVE PARTIAL** for these observed public states, not transactional completion.

## Local R9.5 source corrections

- Repaired out-of-sync npm lockfile; installed dependencies and regenerated the TanStack route tree for R9.4's new routes.
- Guest folio and booking deposit M-Pesa dispatch now read `MerchantRequestID` and `CheckoutRequestID` from the successful STK response's `data` object; previous source looked for nonexistent top-level camel-case fields. Provider callback and settlement remain **EXTERNAL DEPENDENCY**.
- Delivery menu gains clear visual hierarchy, category filters, description search, empty-search recovery, dish imagery fallback and item-level sign-in action. **IMPLEMENTED NOT VERIFIED** on published app.
- Staff navigation groups collapse and expand, with the active section opening automatically and accessible expanded state. **IMPLEMENTED NOT VERIFIED** on published OS.
- Zuri front-door contact line avoids repeating city/country already contained in the address. **IMPLEMENTED NOT VERIFIED** live.
- Payroll payslip release now uses guarded RPC; delivery report date range no longer shifts month start under local-to-UTC conversion; waitlist uses the shared date picker and deterministic blank values.
- Corrected exact-optional-property typing and stale source-contract expectations; removed unused RPC manifest entries. Tests requiring live backend are excluded from the offline suite and remain a separate gate.

## Still required

1. Complete networked gate with recorded command output, then deploy/sync source and re-test published routes and visual layout on desktop/mobile.
2. Run authenticated Staff, Guest, Partner and Rider workflows with authorized test accounts and appropriate clean fixtures, including role/property denials and retry/exactly-once checks.
3. Validate STK dispatch transaction ID persistence and an actual sandbox/provider callback. Do not claim receipt on request creation.
4. Obtain genuine cash counts and independently reconcile pending tills/remittances; establish disposition of the two served unpaid orders.
5. Configure genuine leave, payroll, bank, loyalty, notification and operational masters; investigate autonomous dispatcher and handle historical queue explicitly.
6. Run integrated hotel day and finance convergence; recovery; Night Audit **last**. Protected Run 1 records remain untouched.

## Release gate

`npm ci` PASS; typecheck PASS; offline tests 3,311 PASS / 155 skipped; production build PASS; build smoke `/` and `/auth` HTTP 200; post-build secret scan PASS over 804 public files. Node v24.19.0 was used here; the Windows gate retains its Node 22 requirement. Live security and provider tests remain pending. See `R9_5_GATE_OUTPUT.txt`. No local result grants LIVE CERTIFIED status.
