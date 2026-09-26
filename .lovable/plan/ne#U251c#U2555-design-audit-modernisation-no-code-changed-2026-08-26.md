# NEØ Design Audit — Modernisation (no code changed)

Read-only review of `src/styles.css`, the shadcn primitives (`button`, `badge`, `tabs`), the module tab strips (16 route layouts), `DashboardStateCard`, `DataDisplay.StatusPill`, `ScopeBar`, `AnalyticsShared` and `document-pdf.server.ts`.

## CURRENT UI PROBLEMS

1. **Heavy filled "active" states everywhere.** 16 module layouts (`_shell.finance`, `.pos`, `.kitchen`, `.hr`, `.inventory`, `.pms`, `.events`, `.housekeeping`, `.laundry`, `.procurement`, `.marketing`, `.security`, `.maintenance`, `.pastry`, `.automation`, `onboarding`) each hand-roll the same strip: `flex flex-wrap gap-1 rounded-xl border bg-card p-1` with the active tab as `bg-primary text-primary-foreground`. Three consequences: the active tab reads as a solid button rather than a tab; the inactive tabs are flat white blocks; and the strip wraps into 3–4 rows on iPad/iPhone (Finance has 14 tabs) instead of scrolling.
2. **Perceived "black pills".** `--primary-foreground` is Midnight Navy `oklch(0.16 …)` on turquoise, and `--sidebar`, `--sidebar-accent`, popovers/selects in dark contexts are all near-black navy. Any control that inherits the default shadcn `Badge`/`Button` variant (`bg-primary text-primary-foreground`) or sits over the navy sidebar/popover therefore renders navy-on-turquoise or light-on-navy with inconsistent contrast — the exact complaint about scope pills and section selectors. There is no dedicated *selected-chip* token; each surface improvises.
3. **Contrast tokens are unclaimed.** `--warning-foreground` and `--accent-foreground` are dark-on-mid tones; `--muted-foreground` (Steel Grey `0.6`) on `--muted` (`0.955`) is ~4.3:1 — borderline for the 12px caption text used across cards, notes and chart legends.
4. **Duplicated tone maps.** At least three private copies of the same tone→class map exist (`DashboardStateCard.TONE_RING`, `DataDisplay` metric `toneRing`, `StatusPill.tones`), so a contrast fix has to be repeated and drifts.
5. **Cards are uniform and flat.** Every KPI/panel is `surface-panel` with a 1px border and near-zero shadow, no elevation hierarchy, no distinction between a headline figure, a supporting figure and a container. Dashboards read as a grid of identical rectangles.
6. **Analytics under-uses the palette.** Only 6 files use recharts; charts use raw `var(--color-primary)` / `--color-accent` / `--color-info` with flat fills, no gradients, no reference lines, no delta chips, no sparkline treatment. `--chart-1..5` exist but are barely wired.
7. **Filter bars are desktop-first.** `ScopeBar` is a wrapping `flex items-end` row of native date inputs and three outline preset buttons — on phone it stacks into a tall block; touch targets are `h-9` (36px, under the 44px iOS target).
8. **Documents are functional, not premium.** `document-pdf.server.ts` already pulls property logo, brand hex, canonical lines and totals, but the layout is a plain column list: no title band, no accent rule, no customer/source block framing, small totals emphasis, no footer identity band.

## SHARED COMPONENTS / TOKENS TO CHANGE

Central, no page-by-page edits:

- `src/styles.css` — add tokens: `--surface-1/2/3`, `--chip`, `--chip-foreground`, `--chip-selected`, `--chip-selected-foreground`, `--tint-success/warning/info/destructive` (soft backgrounds), `--elevation-1/2/3`, `--outline-subtle`; raise `--muted-foreground` lightness slightly; add `@utility surface-raised`, `surface-quiet`, `neo-segment`.
- `src/components/ui/tabs.tsx` — add `variant="segmented" | "underline" | "pill"` to `TabsList`/`TabsTrigger`.
- **New** `src/components/common/SectionTabs.tsx` — one link-based segmented control consuming a `{label,to}[]` array; the 16 route layouts each swap their hand-rolled `<nav>` for it (markup-only, tab arrays and permission filters untouched).
- `src/components/ui/badge.tsx` — add `soft`, `success`, `warning`, `info`, `outline-quiet` variants; make `soft` the house default for status.
- **New** `src/lib/tone.ts` — one exported tone→class map; `StatusPill`, `DashboardStateCard`, `MetricCard` import it instead of local copies.
- `src/components/ui/button.tsx` — `h-10` default and `min-h-11` on touch (`@media (pointer: coarse)`), plus a `quiet` variant for toolbar/filter actions.
- `src/components/analytics/AnalyticsShared.tsx` + `ScopeBar.tsx` — shared `ChartFrame` styling, delta chips, and a responsive filter bar that collapses into a sheet on small screens.
- `src/lib/document-pdf.server.ts` — layout constants only (bands, rules, spacing, totals block).

## PROPOSED NEØ VISUAL SYSTEM

- **Surfaces, not fills.** Light neutral canvas, white cards, one visible elevation step for the primary card in a section. Dark navy is reserved for: sidebar, brand/auth surfaces, document header band. Nothing else gets a near-black fill.
- **Selection = tint + accent edge, never a solid slab.** Selected chip/tab = `--primary-soft` background, navy text, 2px turquoise indicator. Guarantees ≥ 7:1 in light and dark.
- **Tabs hierarchy.** Level 1 (module) = underline tabs with a turquoise indicator, horizontally scrollable with edge fade. Level 2 (sub-section) = soft segmented control in a `--muted` track. Level 3 = quiet text toggles. Filters never look like tabs.
- **Colour discipline.** Turquoise = primary/selection/first data series. Navy = text and structure. Champagne gold = accent only for value-carrying moments (totals, premium/loyalty, document rules). Success/warning/error/info only as tinted backgrounds with dark text, never as decoration.
- **Type scale.** 11/12 caption, 14 body, 16 section title, 24–28 KPI figure, tabular-nums for all money and counts.
- **Motion.** 150–200ms opacity/transform only; already respects `prefers-reduced-motion`.

## INTELLIGENCE / BI DESIGN

- KPI card: label, big tabular figure, delta chip (tinted, arrowed), tiny sparkline, source/period footnote. Existing `DashboardStateCard` states (`loading`, `no-records`, `not-configured`, `select-property`, `query-failed`, `access-denied`) stay exactly as they are — visual restyle only.
- Chart set: gradient area fills from `--chart-1..3` at low opacity, 1px grid, no chart junk, styled tooltip card, legend as soft chips, optional target/reference line.
- Composition per analytics page: a 4-up KPI band → one wide primary chart → two supporting panels (breakdown + advisories) → dense table. `FactSection`, `FactHandoff`, advisories and AI disclosure keep their current content and wording.
- Advisory list gets confidence as a tinted chip rather than a coloured pill, so the panel reads as evidence, not alerts.

## DOCUMENT SYSTEM (receipt / invoice / folio statement)

All content stays generated from canonical transaction data via `neo_document_payload`; only layout changes.

- Header band: property logo left, legal identity (registered name, tax/PIN, address, contact) right, thin champagne rule beneath.
- Document title block: large type ("TAX INVOICE", "RECEIPT", "FOLIO STATEMENT"), number, dates, status chip.
- Party/source block: two columns — bill-to (guest/company) and source (reservation, folio, outlet, cashier, property).
- Item table: light header row, generous row height, right-aligned tabular amounts, subtle row rules.
- Totals: right-aligned stack, grand total in a tinted card with the accent rule; tax lines itemised as today.
- Payments and balance-due block, then a footer band with terms, bank/M-Pesa details and contact.
- Property-specific branding drives logo and the two brand hexes (already read in `document-pdf.server.ts`).

## SAFE IMPLEMENTATION PLAN

**Near-zero business-logic risk (pure presentation):**
1. Token additions and contrast tuning in `src/styles.css`.
2. `SectionTabs` + tabs variants; swap the 16 module `<nav>` strips (arrays and `canAccessPath`/`can()` filters copied verbatim).
3. Badge variants + shared `tone.ts`; restyle `StatusPill`, `MetricCard`, `DashboardStateCard`.
4. Chart/frame restyle and responsive `ScopeBar` (filter sheet on mobile) — same scope state and query keys.
5. Touch targets, table→card collapse on phone, drawer/sheet padding.
6. PDF layout constants in `document-pdf.server.ts`.

**Needs care (still no business logic, but verify):**
- `DashboardStateCard` restyle must keep `data-card-state` attributes — `dashboard-card-contracts` and `dashboard-shell-ux` tests assert them.
- Route layout swaps must keep permission filtering identical — `navigation-access`, `visibility-contract` and `role-access-matrix` tests cover this.
- PDF changes must keep every payload field rendered — document/reporting tests assert content presence.

Suggested order: tokens → tabs/segmented control → chips/badges/state cards → BI composition → responsive pass → documents, running `bun run smoke` and the suite after each stage.
