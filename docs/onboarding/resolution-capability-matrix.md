# Onboarding resolution capability matrix

One shared contract decides what an administrator may do with an unresolved
value. Adapters declare meaning; the engine, the wizard and the picker all read
the same capability list, so no screen can advertise an action that is not
granted.

Source of truth: `src/lib/onboarding/matching.ts`.
Guarded by: `src/lib/__tests__/onboarding-resolution-contract.test.ts`.

| Relationship | Inline create | Owning module | Leave unassigned | Blocks the row |
| --- | --- | --- | --- | --- |
| Asset category | Yes | Assets & Equipment | Yes | No |
| Item group | Yes | Inventory & Stores | Yes | No |
| Stock category | Yes | Inventory & Stores | Yes | No |
| Department | No | Organisation structure | Yes | No |
| Employee | No | People & HR | Yes | No |
| Supplier | No | Procurement — Supplier Master | Yes | No |
| Guest | No | Guest profiles | Yes | No |
| Corporate account | No | Corporate accounts | Yes | No |
| Room | No | PMS configuration | Yes | No |
| Room type | No (import Room Types first) | PMS configuration | Yes | No |
| Meal plan | No | PMS configuration | Yes | No |
| Rate plan | No | PMS rates | Yes | No |
| Menu section | No (belongs to a menu) | Menu management | Yes | No |
| Store | No | Inventory & Stores | Yes | No |
| Ledger account | No | Chart of Accounts | No | Yes |
| Property | No | Organisation structure | No | Yes |

## Why the split

- **Classification the hotel owns** (categories, groups) may be created during
  an import. It carries no money, no identity and no legal term, and the hotel
  is the only authority on how it classifies its own equipment and stock.
- **Governed masters** (people, suppliers, guests, corporate accounts, rooms,
  rates, ledger accounts) are never created as a side effect of another import.
  NEØ hands off to the owning module and keeps the batch where it is.
- **Blocking targets** (ledger account, property) have no safe empty value, so
  affected rows stay in the batch, unimported, until the target exists.

## Inline creation rules

Every inline creation goes through the owning domain's own adapter, so it
inherits that domain's tenant and property scope, its columns and its duplicate
protection. Before inserting, NEØ looks for an existing record with the same
name in the same scope and reuses it. The only value written is the one the
hotel's own file contained, and the creation is audited as
`onboarding.master_created_inline`.
