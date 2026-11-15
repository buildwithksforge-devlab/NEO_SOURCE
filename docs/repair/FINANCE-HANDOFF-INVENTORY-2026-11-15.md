# Installed Finance handoff findings

The user-supplied `finance-handoff-and-front-office-access-v1` inventory supplies seven exact routine definitions, current triggers, relevant columns and role grants. This is code inspection, not a live financial acceptance test.

## Preserved live repairs

`neo_finance_post_txn` already prevents a delivery-linked POS order from being recognised as a second standalone sale and verifies existing delivery invoice journal evidence. `neo_delivery_bill` verifies replay evidence and balanced posted journals. Preserve these newer definitions rather than restoring older repository versions. The inventory reports zero POS orders with multiple delivery links.

The earlier installed calculation inventory confirms delivery quotes already extract included tax; they do not add that tax again to the quoted grand total. An older repository-only mismatch must not be presented as the current live defect.

## Remaining handoff defects

- Room-service passes its tax-inclusive discounted subtotal into `folio_post_charge`, which adds the supplied tax again. Repair the complete quote-to-POS-to-folio contract, including modifiers, discounts and tips; do not rewrite historical entries during installation.
- Cart modifier charges enter the quote subtotal, but the supplied live triggers show no modifier-row total recalculation. Existing guest creators write base-price POS lines followed by separate modifier inserts. The new atomic selection mechanism should be reused and final saved amounts verified against the quote.
- POS authoritative totals do not retain delivery fees and tips. The guest M-Pesa initializer derives the due amount from that POS total. Quote, production bill, provider amount and invoice must agree before this chain is certified.
- Converted-cart retry selects the customer's latest order rather than a durable cart-bound order. A successful HTTP response or a nonempty order ID alone cannot establish correct replay identity.
- Live delivery accounting credits rider tips to revenue. Changing that classification requires a documented configured policy; do not silently invent a liability account.
- Finance tax-code configuration is not yet a shared extensible sales-charge contract across all operational paths. Newly configured taxes/charges require calculation, saved component, posting and document/report support together.

## Completed guards in this batch

The user confirmed installation of `pos-discount-collection-guard-v1`: future discount commands reject pending/recorded collections, validate policy amounts and time windows, and preserve approval rules. Nineteen isolated checks and installer/ACL checks passed.

`folio-finite-amount-guard-v1` adds finite-value validation to the existing folio invariant while retaining negative reversal signs and its existing arithmetic tolerance. Twenty isolated amount checks and installer repeat/ACL/unchanged-row/refusal checks passed. Its managed installation requires a separate user result; source presence is not proof of installation.

The guest client now requires saved delivery/POS order UUIDs and room-charge evidence before reporting success. This improves response validation but does not resolve the backend cart replay defect.

No real payment, booking, approval, stock movement or historical correction was executed for this audit. The existing KES51 recovery remains unresolved until an authentic original sale snapshot is found.
