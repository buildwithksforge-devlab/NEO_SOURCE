# Unified experience, identity and access build

I inspected the existing platform first. A large part of this brief already exists and will be reused, not rebuilt.

## What already exists (reuse, do not duplicate)

- **Guest app** — `/guest/{hotel}`: home, book, explore, order, orders, folio, trips, transport, account.
- **Delivery app** — `/delivery/{hotel}`: menu, cart, orders, live tracking by reference.
- **Rider app** — `/rider`, rider login, profile, support.
- **Branded staff entrance** — `/h/{property}` resolving a property server-side, with a sign-in that only grants access after the database confirms membership and property assignment.
- **Public workspace resolution + branding**, customer self-registration (`customer_register_self`), customer sessions.
- All operational engines (PMS, POS/KDS, Kitchen, Bar, Pastry, Laundry, Delivery, Housekeeping, Maintenance, Events, Inventory, Procurement, HR, CRM, Finance, Audit) plus the staff permission, property-scope and RLS architecture.

## What is genuinely missing

1. **The NEØ front door itself.** There is no root entry page: no sign-in/continue, no hotel discovery, no four-door chooser. Today a person must already know a hotel URL.
2. **Partner** — no entrance, no relationship model, no portal. Suppliers and corporate accounts exist only as internal master records.
3. **Rider as a front door** beside the others, and a rider/staff dual-identity rule.
4. **Stay verification and My Stay** — a customer cannot prove entitlement to a reservation and then see their own stay, folio and requests.
5. **Customer laundry** (resident and public) against the canonical laundry engine.
6. **Guest requests** reaching real departmental task workflows.
7. **Staff lifecycle gaps** — invite, activation, suspend, reactivate, offboarding with session revocation, fully from the frontend.
8. **Public experience configuration** per property, plus copyable public links.
9. **Channel/source attribution** and an inbound external-transaction record with duplicate protection.

## Build stages

Each stage is completed and checked before the next, and each ends in a working, testable surface.

**Stage 1 — Identity, relationship and access context.** One `neo_party_relationship` layer over the existing identities: a person or an organisation, related to one property, with a relationship type (guest/customer, employee, supplier, corporate, agent, contractor, partner, rider) and an explicit access grant. A person keeps one identity across hotels and across doors. A resolver returns, for the signed-in person: organisations, properties, relationships and which of the four doors they may enter. Access context never grants authorization on its own — existing permissions and RLS remain the authority.

**Stage 2 — Front door.** New `/` NEØ entry: continue/sign in, discover hotels that have opted into public discovery, search, or open a direct property link. Then the four doors — Stay & Dine, Work, Partner, Rider — each routing into its own experience, showing refusal rather than a blank page when the person lacks entitlement.

**Stage 3 — Stay & Dine.** Public hotel page (only the services the property enables), customer account lifecycle, stay verification (reservation reference plus guest detail, and the existing secure link/OTP path where configured), then My Stay: stay details, room, own folio only, payments/receipts, requests, messages, feedback.

**Stage 4 — Guest services into the canonical engines.** Guest requests routed to the owning department's real task workflow with two-way status; room service and dine/pickup/delivery ordering through the canonical POS order (kitchen/bar/pastry routing, stock consumption, folio charge or pay now); customer laundry through the canonical laundry order with configured price lists, resident and public modes.

**Stage 5 — Work.** Complete the employee lifecycle from the frontend: create/import, invite, activate, verify, role and property change, password reset, suspend, reactivate, offboard with session revocation — every step audited. No database access required for ordinary onboarding.

**Stage 6 — Partner.** Partner relationship + explicit portal authorization granted by the hotel (never self-claimed), organisation-and-representative model, then a portal exposing only what canonical records already support: purchase orders, deliveries, supplier invoices and payment status, corporate account information, relevant bookings, documents.

**Stage 7 — Rider.** Rider door and session validating rider entitlement specifically; a hotel-employed rider uses the same canonical person for both Work and Rider. Field experience completed against the existing delivery engine: shift state, assigned jobs, pickup, customer contact, navigation link, PIN/POD, cash accountability.

**Stage 8 — One order, three views.** Customer status, hotel operational status and rider field status all read the single canonical order. PIN belongs to that order, is single-use, and fails safely.

**Stage 9 — Configuration, channel and integration.** Per-property public-experience switches and copyable public links in Administration. Canonical channel attribution on transactions (app, website, QR, room QR, staff POS, phone, walk-in, external). An inbound external-transaction record keyed on provider + external ID so a repeat never creates a second order, stock effect, payment or journal.

**Stage 10 — Boundary tests and journeys.** Automated checks for every boundary in the brief (cross-customer, cross-property, cross-partner, wrong-door, direct URL/ID manipulation), then the eight end-to-end journeys run against real records, and the completion report.

## Technical notes

- New tables only where nothing canonical exists: party relationships and portal grants, public-experience configuration, external transaction inbox, stay verification tokens. Everything else extends existing tables additively.
- Every new table ships with GRANTs and organisation-scoped RLS anchored to `current_org_id()` / `is_org_admin_for(...)` in the same migration.
- Money, status, ownership and assignment stay in SECURITY DEFINER routines; the four experiences call the canonical routines rather than writing directly.
- Public routes stay SSR-safe and call only unauthenticated server routines; customer, partner and rider surfaces sit behind their own gates, separate from the staff shell gate.
- No provider credentials are fabricated: where SMS/WhatsApp/email delivery is unconfigured, messages stay queued and that is reported as configuration, not a defect.

## Sequencing

Stage 1 and 2 land first and are verifiable on their own (a person signs in, finds a hotel, sees exactly the doors they are entitled to). I then work through stages 3–10 in order and report after each.
