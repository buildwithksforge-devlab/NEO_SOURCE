# Connected NEØ Apps Completion

## Goal
Make Guest/Stay & Dine, Partner, and Rider complete self-service experiences that operate through the same records and workflows as the hotel OS. Preserve all existing tenant, property, role, payment, pricing, inventory, kitchen, finance, and audit controls.

## Build sequence

### 1. One guest commerce journey
- Consolidate menu, favourites, basket, quote, checkout, payment, order history, and tracking around the existing canonical cart/order routines.
- Make “Order” on Explore add the selected item or open its options, rather than losing context on navigation.
- Add a persistent basket indicator and a dedicated saved-favourites view; saved dishes remain property-scoped and can be added back to the live basket after availability and price are rechecked.
- Keep totals server-priced, checkout repeat-safe, and payment state driven by confirmed provider/Finance evidence.
- Show clear retry, unavailable, configuration-required, and payment-pending states without declaring unconfirmed payments successful.

### 2. Complete the guest account
- Replace remaining embedded sign-in forms with the dedicated hotel sign-in screen and preserve the intended return page.
- Expand Account into profile, saved addresses, preferences, security, favourites, reservations, orders, payments/folios, requests, laundry, and transport history using existing records.
- Add safe address create/edit/remove/default actions and property-scoped preference updates.
- Keep private pages out of search results and never expose internal notes, staff identifiers, accounting internals, or another guest’s data.

### 3. Canonical operational handoffs
- Verify each guest action reaches its existing receiving module: reservation → Front Desk/PMS; order → POS/KDS; delivery → Dispatch/Rider; room charge/payment → Folio/Finance; laundry → Laundry/Folio; request → owning department.
- Repair shared data/query/RLS or field-shape defects only where a real app flow fails; do not rebuild certified engines or create parallel records.
- Preserve channel/source attribution and record privacy-safe app events for traffic and conversion reporting through the existing analytics/event architecture.

### 4. Partner and Rider completeness
- Finish Partner navigation and self-service around real relationships: overview, purchase orders, deliveries, invoices, payment status, conversations, profile, contact preferences, and history.
- Finish Rider home, active work, job history, availability, location-sharing feedback, cash handover, support, profile, and settings around roster and assignment records.
- Keep relationship, roster, branch, and record-scope checks authoritative; no self-granted access.

### 5. Experience and reliability pass
- Apply the established NEØ design tokens and containment rules to every changed screen across desktop, tablet, mobile browser, and installed layouts.
- Add focused regressions for cart ownership, favourites, repricing, checkout idempotency, payment-pending behavior, history isolation, app attribution, route returns, and responsive overflow.
- Run browser journeys against configured properties and report separately: software defects fixed, missing configuration, external payment/provider dependencies, and unverified live steps.

## Guardrails
- No invented hotel data, prices, payment providers, identities, assignments, mappings, or business decisions.
- No second authentication system and no weakening of tenant/property/RLS protections.
- No duplicate commerce, payment, kitchen, inventory, folio, Finance, Partner, or Rider engines.
- Existing historical records are read and linked, never recreated or replayed for convenience.
