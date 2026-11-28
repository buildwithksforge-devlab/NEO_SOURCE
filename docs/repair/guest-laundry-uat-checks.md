# Guest laundry verification after deployment

Source repairs target collection/intake (LN01), folio charging (FO10), and handover failure handling. Preserve the original LN02 processing and LN03 handover outcomes. No item below is marked passed from offline tests.

Use an approved test stay and approved financial reversal/reconciliation procedure in the operational system, or an isolated environment. Record the deployed revision, property, ordinary-role account, order number, order UUID, folio UUID, audit ID, posting receipt, folio line and downstream journal references. Do not record credentials or PINs.

1. Confirm the intended room has one active stay, matching reservation/customer and one open guest folio in the configured property currency. Confirm a configured active garment catalogue and authorised property access.
2. Create a two-garment normal order. Verify saved rates and taxes match the catalogue, and all garments, order totals, stay/reservation/customer/folio links and audit evidence persist after reload. Repeat with express pricing; confirm configured express fallback behavior.
3. Retry the same submitted request after a simulated lost response in an isolated lane. Confirm one order and one audit, with the same saved order ID. A changed payload using that request identity must be rejected; a deliberately new order must have a new identity.
4. In isolation, force a child-item or audit failure. Confirm no orphan order or partial garment rows remain. Test zero, negative and non-finite quantities and unavailable catalogue items.
5. Complete the existing collection, batch processing and garment reconciliation through ordinary authorised screens. Confirm handover cannot skip required lifecycle stages. Recheck the original processing and handover flows rather than substituting completed fixture batches.
6. Confirm actual guest handover saves the actor and delivery state. Confirm exactly one matching non-void laundry charge on the intended folio, one compatible posting receipt, correct taxes/balance and the required balanced GL journal under the deployed chart/triggers. The local fixture does not prove the GL layer.
7. In isolation, fail finance posting and confirm the order stays visibly blocked with a useful reason and no partial charge. Restore prerequisites and retry: confirm the first folio line can be created, and repeated retries retain its ID and do not duplicate it.
8. Test allowed and denied ordinary accounts, a different property and an expired session. A retry must not bypass permission/property checks. Confirm UI reports a warning for saved delivery with blocked billing, and never reports successful billing from an empty response.
9. Confirm closed/missing/ambiguous folios and absent/ambiguous active stays are refused. After a legitimately posted order is checked out, an authorised retry should return the original valid posting without adding another charge.
10. Recheck all protected workflows and earlier repairs on the same deployed revision. Save evidence and reconcile any controlled operational records under the hotel's approved procedure.

Do not manually mark the readiness board green until the saved business evidence satisfies its acceptance criteria. Preserve earlier failed/partial statuses and any new regression until independently resolved.
