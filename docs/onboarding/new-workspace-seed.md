# What a brand-new NEØ workspace starts with

This is the exact list of what the system puts into a workspace the moment it is
created, and what the customer must supply before anything can be operated.
It is derived from the live provisioning path
(`bootstrap_tenant_for` → role catalogue → permission templates →
`fin_seed_finance_defaults`), which QA workspaces use unchanged.

## 1. Created automatically by the system (structure, no business facts)

| Layer | What is created | Notes |
| --- | --- | --- |
| Workspace | One organisation record | Named by the customer |
| Property | One property (branch) | Renamed by the customer |
| Departments | Standard department set (Administration, Front Office, Housekeeping, Kitchen, Restaurant, Finance, Procurement, Inventory & Stores, Maintenance, Events, Marketing, Human Resources, Delivery) | Extra departments added later |
| Stations | Standard preparation points (hot kitchen, restaurant floor, bar, pastry, coffee) | Unique per property; duplicates blocked |
| Roles | Full approved role catalogue | Owner assigned to the first user |
| Permissions | Recommended feature permissions compiled per role | Re-appliable from Roles & Permissions |
| Books | Default chart of accounts + accounting period | Required before anything can post |
| Owner | The signing-up user as Owner / Director | Full platform access |

Nothing operational is invented: no rooms, no menu, no stock, no suppliers, no
customers, no prices, no staff other than the owner.

## 2. Must be fed in before the workspace can trade

Ordered as the chains depend on each other.

1. **Property identity** — legal name, currency, timezone, tax rates, address.
2. **People** — staff accounts, department, role, property and station per person.
3. **Front Office** — room types, rooms, rate plans, deposit policy.
4. **Food & Beverage** — menus, categories, menu items with station routing and prices.
5. **Stores** — item groups → categories → stock items (base unit, purchase unit,
   conversion, reorder point), store locations, opening balances.
6. **Recipes** — ingredients per menu item in whole units, so sales deduct stock.
7. **Procurement** — suppliers, credit terms, approval thresholds.
8. **Finance** — bank accounts, cash drawers, account mappings for revenue,
   stock, payables and payroll.
9. **Delivery** (if used) — zones, fees, riders and shifts.
10. **Providers** — SMS / WhatsApp / email / M-Pesa credentials.
11. **HR / Payroll** (if used) — compensation, leave policy, holidays, pay periods.

Until an item on this list exists, the screens that depend on it correctly show
"Not configured" rather than sample figures.

## 3. QA workspaces

QA workspaces follow the same path, then add TEST-prefixed master data so the
automated chains have something to trade with: two rooms, a rate plan, a menu
with one dish and its recipe, one store with stock, one supplier, one guest and
one cash drawer. Every QA workspace is given a distinct invented house name so
no two entries in the Simulation Centre list read alike, and removing an
environment removes the workspace and its temporary accounts entirely.

## Worked example — what a QA hotel is loaded with (2026-09-15)

`NEØ QA — Lamu Coral House (TEST 3e57f6)` was filled to the level a real
property needs before it can trade. Everything is prefixed `TEST`.

| Area | Seeded |
| --- | --- |
| Meal plans | Room Only, Bed & Breakfast, Half Board, Full Board |
| Room types | Standard, Deluxe, Executive Suite, Family (4) |
| Rooms | 20 sellable rooms across 4 floors, all vacant-clean |
| Rate plans | 6 (BB/HB/FB per type, plus a corporate standard rate), 16% tax, 10% service |
| Restaurant tables | T01–T12 (2, 4 and 8 seaters) |
| Menu | 6 categories, 13 published items routed to Hot Kitchen or Restaurant Floor |
| Direct-stock items | Soda 300ml and Bottled Water sell straight off stock |
| Stock | 10 items with opening balances, costs, reorder points, in Main Store |
| Suppliers | 3 (produce, beverages, housekeeping) with credit terms |
| Customers | 3 (2 individual guests, 1 corporate account) |
| Finance | 1 bank account for collections and payouts |

Anything not in this list is still customer-supplied: real staff identities,
real bank details, tax registration, provider credentials (SMS/WhatsApp/M-Pesa),
recipes per dish, and the actual tariff the property sells at.
