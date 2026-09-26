# NEØ Controlled Finance Flows — Production Checkpoint

Date: 2026-09-24

This checkpoint completes the code-side production contracts requested before local/prod continuation:

1. Supplier payment lifecycle
   - canonical schedule/payment states
   - maker/releaser separation
   - supplier/invoice/matching/outstanding validation
   - bank account + transfer/cheque reference evidence
   - AP settlement posting and invoice paid/partially-paid reconciliation

2. Refund lifecycle
   - approved refund settlement through controlled RPCs
   - same-property/open-till checks for cash refunds
   - enough expected cash required before cash payout
   - refund audit movement without double-reducing expected cash
   - partial POS refunds do not falsely mark the original payment fully refunded

3. Cashier shift close with counted cash
   - physical counted cash required
   - canonical cash movement types
   - cashier may only close their own till
   - expected cash remains server-derived
   - unexplained variance is rejected
   - real variance routes to independent variance review

4. Business-day open/close
   - explicit open RPC
   - one open business day per property
   - closed date cannot be reopened
   - close requires signed night audit and resolved reconciliation/blocking exceptions
   - advisory locking serialises property business-calendar transitions

5. Real discount authority
   - configured branch/date/time/order-type discount policies are authoritative
   - Operations Manager ceiling is 15%
   - discounts above 15% require Owner authority/reason
   - server, not UI, enforces the policy boundary

Primary migration:
- `supabase/migrations/20260924090000_finish_controlled_finance_flows.sql`

Contract tests:
- `src/lib/__tests__/controlled-finance-flows.test.ts`

Relevant UI/data paths:
- `src/routes/_shell.finance.payables.tsx`
- `src/components/finance/CashRefundsCard.tsx`
- `src/routes/_shell.finance.till.tsx`
- `src/routes/_shell.finance.eod.tsx`
- `src/lib/finance-data.ts`
- `src/lib/frontdesk-ops.ts`
- `src/lib/finance-controls.ts`
- `src/lib/pos-data.ts`

Important deployment rule: do not manually replay or paste this SQL into production out of order. Apply it through the repository migration chain after the target Supabase project has been identified and its migration history compared.
