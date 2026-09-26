# Role-aware NEØ Intelligence, finance screens, kitchen dashboard

Fixed already this turn (no approval needed): reactivating a financial year or accounting period wrote the word "active", which the database rejects. Years and periods now read and write Open/Closed, and the pills show Open/Closed instead of always "Inactive".

## 1. Button and action audit

Before adding anything new, sweep every screen for controls that look live but are not wired, or that write a value the database refuses. Output: a short list of dead or mis-wired controls, each fixed or explicitly reported as out of reach.

## 2. Minibar deducts like everything else

Today a minibar line only deducts when the menu item is mapped directly to one stock item. Make it use the same consumption service the restaurant uses, so a recipe-based item deducts each of its ingredients. Unmapped items stay blocked and named — nothing is guessed.

## 3. NEØ Intelligence: one engine, a brain per role

No second AI product; the same deterministic engine, narrowed by what the person already holds.

- **Context comes from the top bar only.** Remove the property selector inside Intelligence and show a plain "Working in: <property>" line instead. Changing the top-bar property changes Intelligence with everything else. "All properties" only appears for people whose access actually spans properties.
- **Permission-first data.** The server routine resolves organisation, property, period and capability before any figure is read, so out-of-reach data never enters the answer. Attack prompts ("ignore my permissions", "show salaries", "show the other property") fail because the data is never fetched.
- **Three layers on the Intelligence screen:**
  1. *My work* — what needs me now, composed from the modules I hold (arrivals for reception, tickets for a chef, rooms for a housekeeper, deliveries for a rider, till readiness for a cashier).
  2. *Ask NEØ* — natural language over exactly what I may see, with grounded evidence and honest refusals.
  3. *Insights* — proactive findings from recorded data only, never invented trends.
- **Derived from RBAC, not a role list.** The brief per role is assembled from the capabilities held, so a new or custom role behaves correctly with no code change.
- **Role-aware actions.** Where NEØ offers to do something, it runs the same guarded routine a person would use. Without the authority it prepares the request and routes it to the right approver instead of performing it.

## 4. Finance screens wired to real money

- **Cashbook** — every receipt and payment against a bank or cash account, with running balance.
- **Bank accounts** — balances, statements and reconciliation status (already partly present; completed and linked).
- **Invoices** — issue, view, settle, credit-note, with the folio/event source visible.
- **Payments** — record, allocate, refund, each posting to the ledger.
- **Profit & loss** — revenue and cost by account for a chosen period and property, from posted journals only. Periods with nothing posted say so rather than showing zeros as fact.

## 5. Kitchen dashboard

One screen for the kitchen: ingredient stock by store, today's sales and covers, ticket load, and a reorder alert listing items below their reorder point with the outstanding requisitions and expected deliveries against them. Alerts come from recorded stock and recorded reorder points; where a reorder point is not configured the item is listed as unconfigured rather than assumed safe.

## 6. Certification

Role-by-role browser certification in the isolated test workspace for each new surface: what NEØ shows automatically, what it answers, what it refuses, which actions run and which route for approval, and that its figures match the underlying records. Plus the deliberate attack prompts above.

## Technical notes

- Intelligence brief and answers stay server-side through the existing `neo_intelligence` routine, extended with a role brief section; the browser never chooses figures.
- Role brief composition reuses `intelligence-role.ts` (`permittedModules`, `scopeDiscoveries`, `scopeDecisions`) rather than a new permission path.
- Property context reads the existing global property filter; the Intelligence-local selector is deleted.
- Minibar posting routes through the shared consumption routine used by POS, keeping the single-transaction folio charge plus stock movement.
- Finance screens read posted journals and canonical financial state; no new source of truth.
- All migrations additive; no live data created or altered.

Given the size, I will deliver in this order: audit and minibar, then Intelligence, then finance screens, then the kitchen dashboard — each certified before moving on.
