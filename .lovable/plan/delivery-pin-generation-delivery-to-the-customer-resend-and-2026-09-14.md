# Delivery PIN: generation, delivery to the customer, resend and manager recovery

Today a PIN exists and is checked at the door, but nothing else about it is visible or controlled: it is a 4-digit number stored in readable text, it is never sent to the customer, it never expires, wrong entries can be tried forever, and no one can see or reissue it. This closes all of that.

## What changes for people

**Customer**
- On order confirmation a six-digit delivery PIN is issued.
- The PIN appears on their own order tracking screen, and is sent to them by SMS/WhatsApp where a provider is connected, with email as the fallback. If no channel is connected the tracking screen still shows it, and the record says plainly that nothing could be sent.
- The same PIN stays valid for the whole delivery. It only changes if a manager regenerates it.

**Rider**
- Unchanged at the door: enter the customer's PIN, correct PIN completes proof of delivery, recipient name and cash collected are still recorded.
- Never sees the PIN itself. After five wrong attempts the order locks and the rider is told to call the delivery manager.
- If the PIN cannot be used at all (no phone, offline), the rider records recipient name plus signature/photo and the delivery waits for manager approval instead of silently passing.

**Delivery manager**
- A PIN panel on each delivery order showing: issued at, expires at, channel used, sent/failed/not-sent, last sent time, failed attempts, locked or not, and how many times it was regenerated. Never the PIN itself.
- Three controls, each requiring a reason where it matters and each audited: **Resend** (same PIN, same or different channel), **Regenerate** (invalidates the old PIN, issues a new one, notifies the customer), **Unlock/override** (reason required; allows delivery to complete after a lockout or an offline fallback).

## Rules being enforced

- Six random digits, never derived from the phone number or order number.
- Verified against a stored hash. The readable copy is reachable only by the customer who owns the order — no staff role, and no rider, can read it through any screen or query.
- Expires after a configurable window (default 24 hours from issue) or once delivery completes, whichever comes first. A consumed or expired PIN can never be used again.
- Five failed attempts locks the order; only a manager override with a written reason clears it.
- Existing open orders keep their current PIN; it is migrated into the new structure and marked as legacy so nothing in flight breaks.

## Technical details

**Migration (additive)**
- Extend `delivery_order_pins`: `pin_hash text`, `pin_secret text` (customer-readable copy), `version int`, `issued_at`, `expires_at`, `attempt_count`, `locked_at`, `last_channel`, `last_sent_at`, `last_send_status`, `last_send_detail`, `regenerated_count`, `invalidated_at`, `notes`. Keep `pin` for legacy rows, stop writing it for new ones; backfill hash/issued_at/version from existing rows.
- New `delivery_pin_events` (org-scoped, RLS, audited): issue / resend / regenerate / failed-attempt / verified / locked / override, with actor, reason, channel and provider result.
- Tighten RLS on `delivery_order_pins`: no direct client SELECT of `pin`/`pin_secret`/`pin_hash`; reads go through functions only.
- Functions (SECURITY DEFINER, execute revoked from `public`/`anon`):
  - `neo_delivery_pin_issue(order, reason)` — used by both order-creation paths in place of the inline 4-digit generation; idempotent per version.
  - `neo_delivery_pin_for_customer(order)` — returns the PIN only to the authenticated customer who owns that order.
  - `neo_delivery_pin_status(order)` — manager metadata, no PIN.
  - `neo_delivery_pin_resend(order, channel)` / `neo_delivery_pin_regenerate(order, reason)` / `neo_delivery_pin_override(order, reason)` — permission-checked against delivery management capability, each writing an audit row.
- Rewrite `delivery_confirm_delivery` to verify against the hash, honour expiry and lockout, increment attempts on failure, consume the PIN on success, and accept a manager-approved fallback proof when PIN verification is impossible.

**Delivery of the PIN**
- Issue, resend and regenerate enqueue a `communication_queue` message through the existing queue, so SMS/WhatsApp/email use the providers already wired in `communication-providers.server.ts`. The result written back to the PIN row is the provider's real answer — never "sent" without one.

**Frontend**
- Customer tracking screen (`delivery.$hotelSlug.track.$orderReference.tsx`): PIN card fed by `neo_delivery_pin_for_customer`, with "give this to the rider" wording and the sent-channel note.
- New `DeliveryPinPanel` on the staff delivery order inspector and the delivery queue: status fields plus Resend / Regenerate / Unlock, each with confirmation and reason capture.
- Rider POD (`rider.index.tsx`): attempts-remaining feedback, lockout message, and the manager-approved fallback path.
- Remove the plaintext PIN from the phone-order success toast in `delivery-data.ts`; replace with confirmation that the PIN was issued and how it was sent.

**Tests**
- Unit tests for the resolver-level rules (expiry, lockout, consumption) and a certification-suite case: issue → customer can read it → rider fails four times → fifth locks → manager override with reason → delivery completes → PIN unusable.
