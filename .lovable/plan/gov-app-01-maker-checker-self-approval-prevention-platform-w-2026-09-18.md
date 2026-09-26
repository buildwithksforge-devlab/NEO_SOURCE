# GOV-APP-01 — Maker/Checker & Self-Approval Prevention (platform-wide)

Turn the Front Office Manager / Sales & Events Manager corrections into one enforced
platform rule: whoever originates a controlled transaction cannot approve that same
record, even when their role legitimately holds the approve permission.

## What already exists (verified in the live workspace)

- Central approval queue (`approval_requests`) already blocks self-approval unless an
  explicit policy allows it, and writes a governance audit line.
- Stock adjustments have their own no-self-approval guard.
- Approval step guard already stops a person acting on a level assigned to someone else.
- Routing already skips a rule whose named approver is the requester.

## What is missing

- Dozens of module tables carry a creator field and an approver field with **no** guard:
  banquet orders, complimentary register, cash refunds, credit notes, corporate credit
  applications and limits, event change requests, event quotations, budgets, campaigns,
  employment offers, employment history, payroll runs, supplier invoices/payments,
  requisitions, purchase orders, GRNs, journal approval/posting, deposit overrides,
  and more.
- The approvals list and My Work do not consistently exclude records the viewer raised,
  and nothing re-routes such records to an independent approver.
- No defined behaviour when the creator is the only eligible approver.
- No explicit, audited organisation exception; today the escape hatch is an ad-hoc
  emergency override.

## Plan

### 1. One governance rule in the database

Add a single reusable guard applied to every controlled table (generic trigger, one
registry table naming the creator column and approver column per table). The guard
raises a clear, human-worded error when the approver equals the creator, unless an
explicit, audited organisation exception applies. Each blocked or excepted attempt
writes an audit line naming creator and approver separately.

Applied to (creator/approver pairs that exist today): banquet event orders,
complimentary register, cash refund requests, credit notes, corporate credit
applications and settings, event change requests and quotations, event payments,
budgets, campaigns, employment offers and history, payroll periods/runs, supplier
invoices and payments, requisitions, purchase orders, GRNs, journal approval and
posting, check-in deposit overrides, stores adjustments (already guarded — folded in
for consistency), plus folio adjustment/charge approval where an approver is recorded.

### 2. Routing: exclude the originator, then escalate

Extend approval routing so the requester is never a valid approver for their own record,
regardless of role. Order of resolution:

1. Configured approver who is not the creator.
2. Next configured level, then the scoped fallback approver already in place.
3. If the creator is the **only** person holding that authority in scope, the request is
   **escalated and held** — status makes it clear it is waiting on an independent
   approver, with a named reason. It is never silently self-approvable.
4. Owner-created records follow the same rule; only an explicitly configured, audited
   organisation exception changes that. Delegation cannot resolve back to the creator.

### 3. My Work / Approvals / Inbox

- Records I raised never appear in "Needs your approval" — they appear in a separate
  "Raised by me — awaiting someone else" view with the current approver named.
- Records raised by others that I am authorised to decide do appear.
- Escalated-and-held items surface to whoever can resolve the deadlock, with the reason.

### 4. Exception configuration

An organisation can record a deliberate exception per workflow type (who may
self-approve, why, effective dates). It is off by default, requires a written reason,
and every use is audited.

### 5. Certification

Automated tests plus authenticated browser walkthroughs on the TEST workspace:

- Creator raises → not in own queue → appears for independent approver → decision →
  downstream effect → audit shows two distinct people.
- Creator attempts the decision directly (API path) → refused with a clear message.
- Sole-approver case → held/escalated, not self-approved.
- Owner case → same rule; with exception configured → allowed and audited.
- Delegation case → cannot route back to the creator.
- Regression: existing approvals, POS voids/refunds, procurement and payroll flows still
  pass; no historical record is modified.

## Notes

- Additive only: no data, grants, roles or history are removed; roles keep both create
  and approve permissions.
- No invented approval thresholds, approvers or organisation policy — exceptions stay
  unset until you configure them.
