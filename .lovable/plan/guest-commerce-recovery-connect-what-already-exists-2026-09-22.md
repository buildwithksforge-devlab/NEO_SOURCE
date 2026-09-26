# Guest Commerce Recovery — connect what already exists

The guest ordering chain is largely built: a server-priced basket, published-menu
reads, canonical placement into the same restaurant/kitchen/bar/pastry engines staff
use, tracking, folio and receipt projections. What is missing is proof that every
link actually holds end to end, plus the handful of places where a screen, a button
or a permission quietly breaks the chain.

So this is an audit-and-connect job, not a rebuild. No second cart, no guest-only
menu, no parallel ordering logic.

## Stage 1 — Register of findings (evidence first)

Walk the whole chain in code and in the live database and record every break:

- Browse → item → basket → checkout → place → production → tracking → receipt/folio
- Restaurant, Kitchen (hot/cold), Bar, Pastry, delivery dispatch, rider
- Payments, receiving accounts, journals, stock consumption, audit

Each finding is written to `.lovable/guest-commerce-register.md` with: what it is,
what it was meant to do, what uses it today, the problem, and one action from —
connect, consolidate, remove, replace legacy query, correct permission, correct
route/import, correct field mismatch, remove placeholder, keep for later.

Nothing is deleted on the strength of a filename looking unused: runtime
references, dynamic imports, routes and database dependencies are confirmed first.

## Stage 2 — Fix the breaks

Only what the register proves is broken, in this order:

1. Basket behaves as a basket — quantities, remove, options, instructions,
   availability, badge, survives refresh, one property only, never visible to POS,
   kitchen, finance, stock or reports.
2. Checkout asks only what the chosen fulfilment needs (table, room and verified
   stay, collection point, or delivery address), shows the final review with tax,
   service charge, delivery charge and discounts, and places the order once.
3. Payment options limited to what the property has actually configured — pay now,
   cash on collection/delivery, charge to room after the stay and credit are
   validated, a configured provider, approved corporate credit. A failed payment
   leaves no paid order, and retrying never doubles an order, receipt, journal or
   stock movement.
4. One placed order fans out through the existing routing resolver to the right
   station, store and recipe. Guest tracking reads the same status staff change.
5. Orders area: active and past orders, totals, fulfilment, payment and production
   status, tracking, receipt, help, cancel where allowed, reorder only after
   availability is rechecked. Guest wording throughout.
6. Receipt or folio charge, posting to the configured receiving account, balanced
   journal, single stock deduction, correct reversal on an eligible cancellation.

## Stage 3 — Live proof

Run the whole journey against the live workspace with clearly labelled test data and
report the actual results, not a passing unit test:

- basket changes create no order; totals match the server
- one press, one order; correct items reach Kitchen, Bar and Pastry
- staff status changes show in guest tracking
- payment or room charge recorded once; receipt, journal and reports agree
- recipe ingredients deducted once from the mapped store
- cancellation reverses cleanly; refresh and retry never duplicate
- another property's basket or order stays out of reach

Also certify the POS discount boundary: a discount reduces the bill, tax follows it,
and stock stays accurate.

## Stage 4 — Whole-app button and link sweep

Extend the existing static sweep to every screen in every app: each button and link,
what it calls, whether that call exists and whether it is reachable. Dead ends are
listed with the rest and fixed.

## Notes

- Existing orders, payments and journals from earlier runs are left untouched.
- Where something cannot be certified because the property has not configured it
  (a payment provider, a sending domain), that is reported as a configuration gap,
  never worked around with invented data.
- Stages 1 and 4 produce written registers; stages 2 and 3 produce the fixes and the
  live evidence.

## Technical detail

Canonical routines already in place and reused as-is: `neo_guest_cart_add_item`,
`neo_guest_cart_set_quantity`, `neo_guest_cart_update`, `delivery_quote_cart`,
`neo_guest_place_room_service`, `delivery_place_order`, `neo_guest_order_tracking`,
`neo_public_menu`, `neo_public_menu_modifiers`, `neo_guest_folio_projection`, plus
the staff POS totals trigger, kitchen ticket routing and recipe consumption service.
Fixes go into the guest surfaces and any incorrect policy or permission; the engines
themselves are not rewritten.
