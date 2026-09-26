# Three customer-facing applications: Guest, Delivery, Rider

The staff platform and the backend (tables, RPCs, RLS, hooks) already exist. What is missing is the public, tenant-aware front end and the dispatch/rider surfaces. This plan builds them in five stages so each stage is testable against real data before the next begins.

## Foundation (stage 1)

**Public tenant resolution.** A hotel slug in the URL must resolve to an organisation + branch without the browser being trusted. Add a `public_workspaces` table (org, branch, slug, app kind, published flag, branding snapshot) plus a single `TO anon` SELECT policy exposing only safe branding columns. A server function resolves the slug; an unknown or unpublished slug renders a branded "Hotel workspace not found" page.

**Public app shell.** One layout that reads the resolved branding (name, logo, colours, button style, contact, policies) with clean system fallbacks when nothing is uploaded, and a small "Powered by NEØ" mark. Rider uses a NEØ-forward variant that still names the hotel and branch.

**Customer identity.** Registration/login/verify/reset for customers only. Registration always creates a CRM customer record with `account_type = customer`; role assignment is server-side, never derived from the submitted email or any browser field.

Routes: `/guest/$hotelSlug`, `/delivery/$hotelSlug`, `/rider`, `/rider/login`, `/invite/$token`, plus the "not found" workspace page.

## Delivery App (stage 2)

Branch picker (participating branches only), open/closed status from operating hours, real POS menu with modifiers and availability, cart, fulfilment method (delivery or pickup), zone validation against real branch zones, checkout, and payment using only configured providers — anything unconfigured shows "Not Configured" rather than a simulated success. Pricing and totals come exclusively from the existing `delivery_quote_cart` / `delivery_place_order` RPCs.

Then order tracking (`/delivery/$hotelSlug/track/$reference`, signed-in or reference + verification), order history, receipts, reorder, and post-completion feedback into the existing feedback tables. The full status vocabulary from the brief is mapped onto the existing `delivery_orders` status column; any missing values are added as an enum/constraint extension, not a new table.

## Guest App (stage 3)

Home hub, room search against real PMS availability (never offering out-of-order or unavailable rooms), rate plans and policies, reservation with optional deposit, confirmation reference, and `/guest/$hotelSlug/reservations/$reference`.

Then My Reservations, My Stay (checked-in guests: room, dates, meal plan, entitlements, balance), Room Service (posts into POS as room-service revenue, routes to the correct kitchen station, deducts inventory via existing recipe rules, posts to the guest folio), Guest Requests routed to the owning department with real status, My Folio (guest-safe lines only — no cost prices or departmental allocations), and Feedback.

## Dispatch + Rider App (stage 4)

Staff dispatch screen: orders ready for delivery, available riders, assign/reassign with reason, zone and trip context, failed-delivery handling — every assignment recorded with actor, rider, previous rider, reason, timestamp.

Rider App (mobile-first): online/offline/break, current assignment, pending assignments, today's completions, cash awaiting reconciliation. Workflow Assigned → Accepted → At Restaurant → Collected → On the Way → Arrived → Delivered, with failure reasons required. Delivery confirmation honours the configured proof method (PIN, recipient name, signature/photo) and no order reaches Delivered without it. Cash collection records expected vs collected; riders cannot self-reconcile. Status writes are idempotent, show pending sync, and never report success before the backend confirms.

Rider RLS is tightened so a rider reads only their own profile, assignments, and cash records.

## Administration + hardening (stage 5)

Rebuild Administration → App Branding as three real tabs (Guest, Delivery, Rider) persisting to the database per organisation and branch, each with the settings listed in the brief, plus Save, Publish/Unpublish, Copy Link, Download QR, and Preview that opens the live app in a new tab.

Close with the security pass: customer cannot reach staff routes, rider cannot reach administration or unassigned deliveries, no cross-customer or cross-organisation reads, and hidden UI cannot bypass backend policy. Then a manual end-to-end run of the guest, delivery, pickup, and rider journeys against real records, and the completion report the brief asks for.

## Technical notes

- Public routes are top-level and SSR-safe; loaders call only unauthenticated server functions. Customer and rider surfaces sit behind their own gates, separate from the staff `_shell` gate.
- No new duplicate tables: reuse `delivery_orders`, `carts`, `delivery_zones`, `rider_profiles`, `customers`, `folios`, `guest_requests`, POS menus and recipes. New tables only for public workspace slugs and per-app branding where none exists.
- Money, status, ownership and rider assignment stay in SECURITY DEFINER RPCs.
- Every new public table gets GRANTs plus narrow, org-scoped RLS in the same migration.

## Sequencing

Stage 1 lands first and is verifiable on its own (a slug resolves, branding applies, a customer can register and sign in). I'll then work through stages 2–5 in order, reporting after each.
