# Front door: discovery truth + four working entrances

Functional work only. No visual redesign — your new design direction is recorded and applied later, as a separate bounded migration per experience (Discovery → Stay & Dine → Rider → Partner → mobile Work → Platform Console).

## A. Why only one hotel appears

Build a discovery eligibility report over every existing property, one row each:

property · business · business active · property active · platform eligible/blocked · hotel discovery switch · public profile sufficient · expected to appear · actually appears · reason if hidden.

Then compare each row against the intended rule (business active + property active + platform eligible + hotel discovery on). Two outcomes only:

- Legitimately hidden → recorded as **configuration / expected hidden state**, not a defect, not "fixed".
- Meets every condition but missing → **software defect**; repair the shared discovery query and retest.

No property IDs hard-coded, no loosening of the rule to make the list look fuller.

## B. Make the reason visible without reading the database

- Hotel Administration shows what the hotel owns: Public Discovery on/off, public link, public services, and any genuinely required profile readiness.
- Platform Console shows what NEØ owns: business active, property active, discovery eligible/blocked.
- Each surface prints one plain outcome line — "Publicly listed", or "Not publicly listed — public discovery is off" / "property inactive" / "platform discovery blocked". No setting owned in two places.

## C. Four entrances — real routing repair

Current code already shows why three of them misbehave: Work routes to sign-in with the hotel forgotten, Rider drops to a generic rider address with no hotel, and neither returns you where you were going after signing in.

Fix the shared entrance behaviour so that, for each of Stay & Dine / Work / Partner / Rider:

1. The intended hotel *and* intended entrance survive sign-in and come back afterwards.
2. An already signed-in person with the right relationship is authorised and let in — no second password.
3. A signed-in person without the relationship gets a clear refusal on the hotel's own page, not a login form, dead page or unrelated workspace.
4. Typing the address directly behaves identically to clicking the entrance.

Then exercise all four against the running application and record, per entrance: source URL, link clicked, target URL, signed-out result, auth route, post-auth return URL, relationship check, authorised result, unauthorised result. Nothing is called PASS on the strength of a button existing.

## D. Partner and Work content

- Partner entrance: partner sign-in path, the supplier/corporate relationships the hotel actually granted, and a portal dashboard of pending orders and outstanding payments — read from canonical purchase orders, deliveries and invoices.
- Work entrance: staff sign-in path into the existing Staff OS for that hotel, plus a staff dashboard surfacing pending orders and stock levels from canonical data. Existing OS is reused, not rebuilt.

## E. Join NEØ, walked end to end

Create a new hotel through the public "Put it on NEØ" flow, complete each listing condition in turn, and confirm the hotel then appears in public discovery — reporting which conditions the hotel controls and which NEØ controls.

## F. Then freeze and continue

Once discovery and the four entrances are proven against the deployed app, freeze them and resume the existing completion route (rider walkthrough → finance/folio → remaining functional completeness → staff/partner/communication proof → J1–J8 → final report). No restart, no repeat of canonical stock proof.

## Final report

Hotel discovery: properties evaluated, which appear, which do not, exact reason per hidden property, any defect fixed.
Four entrances: per-entrance result, direct-link result, signed-out, signed-in, post-auth return, unauthorised behaviour.

## Technical notes

- Discovery predicate stays in the single shared database routine behind the front door; the admin/console surfaces read the same computed reason rather than re-deriving it in the UI.
- Entrance intent is carried as a sign-in return target and re-resolved through the existing relationship resolver after authentication — authentication establishes identity, the resolver grants context.
- No new rider or partner identities: hotel-employed riders keep the one canonical person identity already proven for Work and Rider.
