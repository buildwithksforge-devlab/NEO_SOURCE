# NEØ UX Audit — why pages still feel plain, and the pattern set that fixes it

Audit only. No code, backend, schema or migration changes are proposed here.

## 1. Scope inspected

- 303 route files under `src/routes` (excluding `__root.tsx`).
- Removing 8 pure redirect stubs (`_shell.rooms`, `_shell.guests`, `_shell.reservations`, `_shell.front-office`, etc.), 16 layout-only parent routes (`_shell.pos.tsx`, `_shell.kitchen.tsx`, … which only render tabs + `<Outlet />`), 12 auth/guest/rider/public routes, and 3 API/utility routes:

**261 staff-facing pages inspected.**

Method: static scan of every route for table density, card/section count, KPI primitives, chart usage, sheet/drawer usage, tab usage, imagery, and filter-control count, followed by hand reading of the representative modules named in the request (Menu Management, PMS lists, Bar, Kitchen, Delivery, Inventory, Procurement, Finance, CRM, Marketing, Automation, HR, Admin, Platform).

## 2. Classification counts

| Classification | Pages | Share |
|---|---|---|
| Good / intentionally composed | 34 | 13% |
| Acceptable but plain | 109 | 42% |
| Needs UX redesign | 96 | 37% |
| Functionally sparse / blank-feeling | 22 | 8% |

Breakdown of "Needs UX redesign" by dominant anti-pattern:
- A) giant table + filter bar, no hierarchy: 32 pages
- B) stacked plain `SectionCard` lists, weak prioritisation: 48 pages
- D) KPI row that is a data box strip, not a workflow surface: 16 pages

"Good" today is concentrated in: `_shell.bar.index`, `_shell.pms.folios.$id`, `_shell.events.bookings.$id`, `_shell.crm.customers.$id`, `_shell.ai-insights`, `_shell.notifications`, `admin.integrity`, `admin.go-live`, the housekeeping board, the KDS/queue screens, and the module index dashboards that use `FactCard` + `ChartKit`.

## 3. Worst offenders (18)

Each is real code, not inference.

1. `/pos/menu` — Menu Management. 810 lines, 9 filter controls in one row, 7 identical `CountTile` boxes, then one wide table. No item imagery in the list despite `MenuItemImage` existing; no menu/category structure visible; everything edits through modals.
2. `/users` — 2,329 lines, one table, 56 form controls, no segmentation between people, roles, and lifecycle state.
3. `/rates` — 780 lines, two tables, no calendar or grid view for what is inherently a date × room-type matrix.
4. `/crm/customers` — flat guest table; no avatar, value tier, or stay history visible until you open a record.
5. `/pms/rooms` — room inventory as rows; rooms are physical objects and read far better as a rack/grid.
6. `/pms/reservations` — booking list with no arrival-day framing, no status lanes, no guest identity.
7. `/pms/waitlist`, `/pms/requests`, `/pms/transport`, `/pms/requisitions` — four near-identical table pages inside one module; nothing distinguishes them visually.
8. `/pos/floor` — floor plan rendered as a table; the domain is spatial.
9. `/pos/shifts` — two tables, no session timeline, no cash-variance emphasis.
10. `/pos/orders` — order list without lifecycle lanes despite the app having a rich, well-defined POS status model.
11. `/credit-accounts` — balances as rows; no ageing visual, no exposure summary.
12. `/housekeeping/lost-found` — table with zero cards, no imagery for physical items.
13. `/marketing/promotions`, `/marketing/suppression`, `/marketing/tasks` — marketing objects are visual by nature and get plain rows.
14. `/*/supplies` (procurement, housekeeping, laundry, HR, events, marketing, PMS) — seven copies of the same unstyled requisition table.
15. `/*/requisitions` (bar, pos, inventory, housekeeping, delivery, pastry, PMS) — same duplication again; a single shared workspace would upgrade all of them at once.
16. `/finance/journals`, `/finance/ledger` — dense accounting tables with no period framing or balance summary strip.
17. `/automation/rules`, `/automation/templates`, `/automation/workflows/$id` — 15 stacked cards, no canvas, no rule preview, no state grouping.
18. `/inventory/receiving`, `/inventory/issues`, `/procurement/requests` — multi-step documents flattened into stacked forms with no step or document framing.

Functionally sparse examples: `/pms/availability`, `/analytics/catalogue`, `/admin/delivery-zones`, `/admin/meal-plans`, `/admin/finance-periods`, `/admin/suppliers` — the functionality is present but the page is a bare heading plus one control.

## 4. Recurring root causes in the design system

1. **`PageHeader` + `SectionCard` + `Table` is the default page recipe.** `DataDisplay.tsx` exports exactly the primitives that make this easy and nothing that makes anything else easy. There is no list-workspace, master-detail, board, or inspector primitive, so every author reaches for the same three.
2. **Filters outrank work.** On `/pos/menu` nine selects occupy the first screen before a single item is visible. Filters are page-level chrome instead of a compact, collapsible query bar.
3. **No progressive disclosure.** There are 838 lines of dialog code in `MenuCatalogueManager` and near-zero `Sheet`/`Drawer` usage app-wide (2 routes). Everything is either fully on the page or behind a modal that blocks context.
4. **No object-level visual identity.** Rooms, menu items, guests, staff, and suppliers all render as text rows. Imagery exists (`MenuItemImage`, `AvatarDisplay`) but is used on 6 routes.
5. **KPI strips are decoration, not entry points.** `CountTile`/`StatCard` rows report numbers ("Missing routing: 14") that are not clickable filters into the work they describe.
6. **Weak master-detail.** Detail pages exist as separate routes (`$id`), so list → detail is a full navigation; no split view, no keep-your-place.
7. **No visual grouping inside long lists.** Tables are flat even where the domain has natural groups (menu → category, requisition → department, journal → period).
8. **Duplication instead of shared workspaces.** Seven `supplies` pages and seven `requisitions` pages are separate implementations of one interaction.
9. **Section headings carry no summary.** A `SectionCard` title states what the section is, never what it currently says.
10. **Contained ≠ composed.** Recent work correctly fixed containment, gutters and wrapping; that made pages *safe*, not *composed*. The remaining gap is hierarchy and intent, not spacing.

## 5. Proposed reusable pattern set (6 patterns, frontend only)

Deliberately small. Each must upgrade many pages, and each is proposed only where the domain fits.

1. **Catalogue Workspace** — image/identity-led grid or rich list, left rail of the object's own taxonomy, compact query bar, inline status chips.
   Fits: menu management, bar menu, rooms, room types, recipes, inventory items, suppliers, promotions, lost & found. (~24 pages)
2. **Master–Detail with Inspector Sheet** — list keeps its place; selection opens a right inspector (sheet on tablet, full sheet on phone) with tabs; deep-link route preserved.
   Fits: users, guests, reservations, folios, employees, orders, credit accounts, purchase orders. (~30 pages)
3. **Lane Board** — status lanes for anything with a defined lifecycle, reusing the existing housekeeping/KDS board.
   Fits: POS orders, kitchen production, pastry, delivery tasks, procurement requests, maintenance jobs, security incidents, marketing pipeline. (~22 pages)
4. **Smart Summary Strip** — replaces KPI box rows: 1 lead figure with context, 2–3 supporting figures, and each cell is a filter into the list below. Not more cards; fewer, and clickable.
   Fits: every module index and every list page currently carrying `CountTile`/`StatCard` rows. (~60 pages)
5. **Shared Requisition/Supplies Workspace** — one composed component parameterised by department, replacing 14 duplicated table pages.
6. **Command & Search Surface** — a single ⌘K entry for records, actions and navigation, which lets list pages drop several always-visible filter controls.

Explicitly **not** proposed: kanban for accounting ledgers, imagery for finance, charts on transactional lists, or a canvas editor for automation (out of proportion to value right now).

## 6. Worked example — Menu Management (`/pos/menu`)

Preserves every current capability: menus, categories, items, modifier groups/options, station routing and routing source, publish/draft, imports and import batches, availability, SKU, imagery, recipe link status, property scoping, bulk publish.

**Above the fold**
- Outlet/menu context line (property + active menu) and one primary action: *Add item*. Import, publish, and manage-menus move into an overflow.
- One summary strip, not seven tiles: lead = "Sellable now: 214 items". Supporting = "18 drafts", "14 missing routing", "22 missing photo", "9 recipe not linked". Every one is a filter toggle into the catalogue below — this alone removes four selects.
- A single search field. The remaining eight selects collapse into one "Filters" control showing an active-filter chip row.

**Structure**
- Left rail (laptop/tablet): the menu's category tree with live counts. Selecting a category filters the catalogue and becomes the visual grouping. This replaces the category select and gives the page the object-level identity it lacks.
- Segmented views across the top of the catalogue: **Items** · **Categories** · **Modifiers** · **Imports**. These are today's stacked sections, so nothing is lost, but each gets a full working surface instead of a squeezed one.

**Catalogue body**
- Items render as an image-led rich list, not a wide table: 56px item photo (or a typographic placeholder that reads as a deliberate "no photo" state, which doubles as the data-quality signal), name + SKU, price, and a small chip cluster — station route, availability, draft badge, recipe-linked dot. Grouped by category with sticky group headers.
- Routing source ("Inherited from category") stays, shown as secondary text on the routing chip rather than its own column.
- Density toggle already exists; comfortable = image list, compact = current-style rows for power users doing price runs.

**Detail drawer**
- Selecting an item opens an inspector sheet: Overview (image, price, availability, SKU), Routing (station + source, editable inline), Recipe (link status and consumption), Modifiers, and History. Today's `MenuItemFormDialog` becomes this sheet's edit mode, keeping the existing dirty/save contract, so the list never disappears while editing.

**Responsive behaviour**
- Phone: no left rail — category becomes a horizontally scrollable chip row; catalogue is a single-column image list; inspector is a full-height sheet; summary strip is a two-line compact block.
- Tablet: rail collapses to icons + counts; catalogue two columns in comfortable mode; inspector is a right sheet over the list.
- Laptop: persistent rail + list + inspector as a true three-pane workspace.

## 7. "Contain everything" ≠ "card everything"

Containment is a layout guarantee: nothing overflows, gutters hold, text does not wrap badly. It is already largely achieved and should be kept.

Carding is a visual decision and is currently overused — `/crm/customers/$id` has 59 card boundaries, `/automation/rules` has 15. Rule for the next pass: a card is justified only when the content is independently actionable or independently scoped. Otherwise use a **section band** — a heading, generous whitespace, and a hairline rule — inside one containing surface. Nested cards (card in card) should be treated as a defect. Target: at most 3–5 card boundaries visible per screen.

## 8. Visual tone

No decorative gradients. Hierarchy comes from type scale, weight, whitespace and restraint: one lead figure per screen, one primary action per screen, brand colour reserved for state and the single primary action, hairlines instead of borders-everywhere, and imagery only where the object is genuinely physical (menu items, rooms, people, lost property). Motion limited to sheet transitions and selection. The goal is calm and information-dense, which is the opposite of both "table dump" and "everything in a rounded box".

## 9. Suggested sequencing (if approved later, as separate build work)

1. Add the pattern primitives (summary strip, inspector sheet, catalogue workspace, lane board) to the design system.
2. Convert Menu Management as the reference implementation.
3. Roll the shared requisitions/supplies workspace across the 14 duplicated pages.
4. Apply master-detail to the top 8 list pages, lane board to the 8 lifecycle pages.
5. De-card pass over the top 20 heaviest pages.
