# Beverage stock model, cash journal repair, delivery billing

Three separate pieces of work. Each is testable on its own, so I'd deliver them in order.

## 1. Beverage stock model (sealed containers + open volume)

Today a stock item records a container volume and whether it can be split, but there is no
separate record of "how much is left in an open bottle". Everything is one number. That is why
tots, cocktails and full-bottle sales cannot all draw on the same whisky.

**Stock item settings to add**

- Container type: bottle, can, carton, keg, other
- Container volume and its unit (300 ml, 750 ml, 1 litre)
- Tracking method: whole units, volume, or both
- Purchase conversion (1 case = 24 bottles, 1 bottle = 750 ml)
- May be opened for pours, plus a default pour size
- Home store or location

**Two balances instead of one**

Every beverage with "both" tracking keeps sealed containers and open millilitres separately,
per store. Opening a bottle is its own recorded action: sealed −1, open +750 ml, with who and why.

**Automatic bottle opening.** If 20 ml is open and a 30 ml tot is sold: take the 20 ml, open a new
bottle, take 10 ml more, leave 740 ml open — recorded as one traceable chain, never a negative balance.

**Two kinds of consumption rule**

- Direct rule: one sale takes one container (soda, beer, water, Red Bull, a full bottle sold sealed)
- Consumption recipe: one or more measured amounts (30 ml tot, 60 ml double, a cocktail's ingredients)

A tot is simply a one-line recipe. The same whisky item serves tots, cocktails and bottle sales at once.

**Stock counts** count sealed containers and open volume as two separate figures, and variance is
reported against each.

## 2. Consumption outside the menu

Deductions stop depending on a menu sale. A single controlled stock issue covers bar requisitions and
transfers, bottle opening, breakage, spillage, complimentary drinks, staff consumption, expiry, event
consumption, manual issues and count variances. Each one records reason, employee, store, quantity,
millilitres and the source document.

## 3. Cash and M-Pesa journal repair

Real cash and M-Pesa receipts currently land in M-Pesa Clearing. I'd route each receipt to the account
configured for its tender (cash on hand, the M-Pesa settlement account, the bank account), and add a
reconciliation page showing what was received, what was posted, and what is still sitting in clearing
awaiting settlement, so the difference is visible rather than hidden.

Historical entries are not rewritten. Existing wrong postings are listed on that page for a decision,
and corrected only by an explicit reversal you approve.

## 4. Bottled drink mappings

Set up direct rules for Tusker, Heineken, Red Bull and the other bottled drinks, matched by exact name
to a real stock item at the same property, so a sale takes one container. Where a drink has no matching
stock item, or the name is ambiguous, it is listed as unmapped rather than guessed.

Spirit tots need each bottle's real size before I can map them. I'll list what's missing for you to confirm.

## 5. Delivery order billing

A completed delivery produces a real delivery invoice with its number, records the payment (deposit or
full) against it, and posts a matching journal entry through the same posting path as other revenue —
so delivery stops being test-only. Cash on delivery posts on rider handover; M-Pesa posts on confirmed
payment, never before.

## Notes

- All new stock fields are added alongside existing ones; nothing is dropped and no historical balance,
  movement or journal is rewritten.
- Sealed/open balances and automatic bottle opening live in the database, so POS, delivery, events and
  manual issues cannot disagree.
- Every new table is workspace-scoped with the same access rules as the rest of inventory.

## Sequencing

Part 1 and 2 land first (the model and the issue path), then the mappings in part 4 which depend on it,
then the cash journal repair, then delivery billing. I'll report after each.
