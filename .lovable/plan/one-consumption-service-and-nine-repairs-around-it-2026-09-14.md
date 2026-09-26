# One consumption service, and nine repairs around it

## What I confirmed against the two live orders

- **Drinks (POS-20260914-2BFR6)** did deduct: one bottle each of Still Water, Heineken, Tusker and Red Bull came off **SCN Beverage Store** at 13:49. The stock screen you were reading was showing a different store/property balance — so this is a *reporting* fault, not a deduction fault.
- **Burger (POS-20260914-O7SVC)** deducted beef mince, cheese, tomato, lettuce and 2 buns from **SCN Main Store**, because the Grill station has no store mapped and the resolver falls back to the main store. Buns came out whole (2), so whole-unit rounding is already working today; the old `-8.08 pc` is historical damage, not a live bug.

Everything below is built on that: the deduction engine is mostly right, the routing, the payment commit, and the read surfaces are not.

## 1. One central consumption service

Keep a single database routine as the only path that moves stock for a sale, used identically by POS, Bar, Delivery, Room Service and Events on every property.

Rules it enforces, for every stock type:

- deduction = recipe quantity x quantity sold x unit conversion, converted into the item's own base unit (375 g from a kg item becomes 0.375).
- wastage multiplies the required quantity only where a wastage % is configured.
- whole-container items (piece, bottle, can, bun, egg, tray...) always move whole numbers; the wastage remainder is posted as a **separate whole wastage movement**, never as a fraction of the sale line.
- poured spirits deduct millilitres from the open-bottle balance and automatically open a sealed bottle when the open volume runs out; sealed count and open volume stay separate figures.
- sauce/batch items deduct from the prepared batch; the batch's own raw ingredients were already deducted at production.
- every event records order number, ticket number, recipe id + version, item, store, quantity, unit and the reversal reference.
- posting stays idempotent per order item + stock item, so a retry cannot deduct twice.
- a void or cancellation reverses the **stored original movements**, never a recalculation from the current recipe.

## 2. Post exactly once at Served/Completed

Direct-stock and recipe items post their consumption when the item reaches Served/Completed, once, through the service above.

## 3. Station store routing — no silent fallback

Every production station must have a consumption store (Grill to SCN Kitchen Store). If a station has no store for the selected property, sending the item is **blocked** with a configuration error naming the station; the main store is never used as a substitute. A configuration screen lists stations missing a store so they can be mapped.

## 4. Cash payment becomes atomic

Till validation, payment, receipt, till movement and finance journal all commit in one database transaction. The screen only reports success after the commit returns; a failure shows the actual reason and leaves nothing half-written.

## 5. Bar catalogue

Bar Sell lists items for the selected property whose station belongs to a Bar department or is a bar-capable station — Main Bar and Beverage both qualify. No hard-coded station name.

## 6. Stock Levels and Live Stock read the same source

Both screens read one property/store balance source, so a store that shows balances in Live Stock cannot show zero tracked items in Stock Levels.

## 7. Housekeeping stale-task actions

Supersede, Complete, Cancel with reason, Reassign, and Create replacement — each audited with who resolved it and why. Creating a new cleaning task is blocked while a valid open task already exists for the same room.

## 8. Spirit configuration binds

The item-group / category selector persists the selected IDs, so Whiskey and Single Malt stay bound after save instead of showing a label only.

## 9. Direct recipe creation sequence

Create menu item without recipe, create and approve the recipe, and the recipe is then attached back to that menu item automatically — no chicken-and-egg.

## Technical notes

- Consumption service: rework `inventory_consume_order_item_core` plus `neo_station_consumption_location` (drop the `is_main` fallback branch, return null instead), keep `inventory_apply_movement` as the single ledger writer, extend `inventory_posting_events.payload` with recipe version and reversal reference, and mirror the arithmetic in `src/lib/recipe-engine.ts` for the editor preview only.
- Open-bottle tracking: per-item open-volume balance alongside the sealed count, with an automatic "open a bottle" movement pair.
- Cash payment: single `SECURITY DEFINER` routine wrapping till check, `payments`, receipt numbering, `cash_movements` and `fin_post_journal`; the client surfaces the returned error verbatim.
- All migrations additive; no existing movement, event or journal is rewritten. Historical fractional balances are left as-is and can be corrected through an audited stock adjustment if you want them cleaned.

## What I will not invent

Station-to-store mappings beyond Grill to SCN Kitchen Store, bottle volumes, tot/pour sizes, spirit group membership, or any payment. Where those are missing the screens will say so and block, rather than guess.
