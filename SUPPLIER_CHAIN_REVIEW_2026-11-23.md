# NEØ supplier chain review — 23 November 2026

## Scope and status

This is a source review and a local implementation batch. It is **not** a live reconciliation, certification, or evidence of an accepted supplier submission. No production database rows or deployments were changed in this batch.

There are two distinct portals:

- `/procurement/supplier-portal` is an internal Procurement order board, guarded by staff permissions.
- `/partner/$propertySlug` is the supplier's private, relationship scoped view. Before this batch it exposed purchase orders, deliveries, invoices, and messages, but no RFQ submissions.

## Chain examined

| Handoff | Existing behavior | This batch |
| --- | --- | --- |
| Approved purchase request → RFQ | Procurement created an RFQ and invitations in separate writes; a failure could leave an orphan RFQ. Dispatch was manually recorded; no outbound notification is asserted. | One database transaction creates the RFQ and all invitations with a retry key. Supplier sees it only once manual dispatch is confirmed. |
| RFQ → quotation | Buyer could enter one total with no item lines. Supplier could not quote from their portal. | Supplier and buyer can submit itemized unit prices and tax. Supplier revisions preserve old quotes as superseded; a repeated supplier submit replays its original result. |
| Comparison → recommendation | Client performed two updates to clear then select a quote; three rows could be from one supplier. | Single database transaction validates request and quote, counts distinct suppliers, requires a reason, and records an explicit single source exception. |
| Recommendation → LPO | LPO creation copied the requester's estimated unit prices, not the selected quote. | Every new LPO requires a selected itemized supplier quote, including a documented single source award when applicable. It copies the quote's prices, tax, currency, and link; mismatched quote lines, supplier, or property currency stop the order. |
| LPO → receiving → invoice → ledger | Existing routines and PO/GRN canonical PDF templates remain. The prior live export showed a KES 150 million accrual traced through this chain. | No live historic valuation correction was attempted. The source of the unit price still requires the supplier's quote or purchase evidence. |
| Partner presentation | Portal used generic colors despite a stored hotel brand. | Partner view now applies the property's configured font, radius, and palette accents. |

## Live exceptions that remain open

The earlier exports exposed patterns for system wide checks: request estimates could become LPO and GRN prices without a supplier quote; till variance, pending PMS payments with journals, POS payment overlap, and stock movements lacking property scope require separate workflow review. These historical rows do not prove money lost. This batch addresses the forward procurement path for every organization and branch; it does not edit historical rows or fix the other Finance paths.

## Release gates

1. Run the new migration on a representative database and verify an invited supplier can submit and revise a quote; another supplier or property cannot read or submit it; a closed RFQ cannot accept it.
2. Verify buyer entered and supplier entered item prices both flow through approval, LPO, GRN, supplier invoice matching, stock valuation, and ledger posting. Include a price per gram versus price per kilogram case, a tax case, and a partial delivery.
3. Inspect the signed in supplier page for each property brand and verify access on a real invited supplier account.
4. Review RFQ and supplier quotation document/PDF requirements. The current canonical renderer supports LPO and GRN, but has no RFQ or supplier quotation document type. Do not represent these as generated PDFs.
5. Review supplier invoice entry, credit notes, payment evidence, messaging notifications, and the unresolved live exceptions before declaring the supplier and finance chain complete.
6. The source changes have been integrated locally on the user's `fb8c30b` release commit. Deploy and verify that combined release before a whole-system verdict.

The new database functions were syntax parsed on the original source branch; they have not been executed against the live schema in this workspace. On the release integration, 135 focused Supply Chain/Finance tests passed. Those checks are separate from a live accounting audit. RFQ expiry uses the branch timezone and the purchase order requires the branch currency; foreign currency purchasing needs a separate conversion design.
