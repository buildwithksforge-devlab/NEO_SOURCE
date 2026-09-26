# Unified NEØ application styling and overflow correction

## Goal
Connect one deliberate NEØ visual system across Guest/Stay & Dine, Rider, Partner, Platform Console, and the staff operating system, while preserving all existing permissions, records, routes, and operational logic.

## What will change
1. **Unify shared presentation roots**
   - Consolidate public-app framing so Guest, Stay & Dine, Rider, and Partner inherit the same NEØ typography, spacing, navigation, surfaces, attribution, and responsive behavior.
   - Keep hotel-controlled brand colours and media where configured; retain honest fallbacks where they are absent.
   - Align Platform Console and the staff OS with the same brand hierarchy while keeping their distinct navigation and purposes.

2. **Eliminate layout and text failures at the shared level**
   - Add a strict containment contract to every application shell, panel, card, grid, row, dialog, form, and navigation area.
   - Prevent one-word-per-line headings by fixing narrow flex/grid tracks, allowing text containers to shrink correctly, and keeping controls from stealing the text column.
   - Keep identifiers, money, dates, statuses, and short labels intact through ellipsis or local horizontal scrolling; allow prose to wrap naturally without breaking words.
   - Convert wide data areas into contained scrolling or mobile label/value layouts instead of allowing page-level overflow.

3. **Repair the main portal surfaces**
   - Replace disconnected white-card styling in Guest/Stay & Dine and Rider with shared NEØ public surfaces and reusable controls.
   - Correct Partner conversation, record table, account summary, and navigation containment.
   - Correct Platform Console header, filter, summary, business/property rows, and narrow-screen navigation.
   - Apply shared containment to the staff OS without redesigning working operational screens.

4. **Audit reachable routes and reusable primitives**
   - Scan all route and shared-component call sites for fixed widths, unsafe `nowrap`, missing `min-width: 0`, oversized action rows, and uncontained tables.
   - Fix shared primitives first, then only the remaining route-specific failures across the named surfaces.

5. **Regression and visual validation**
   - Add focused tests for shell containment and required shared styling hooks.
   - Test representative Guest, Stay & Dine, Rider, Partner, Platform Console, and staff pages at phone, tablet, laptop, and wide desktop widths.
   - Verify no page-level horizontal overflow, no clipped controls, no headings collapsing word-by-word, and no change to tenant/property/RBAC behavior.

## Technical boundaries
- Presentation and layout only; no schema, workflow, financial, permissions, or data changes.
- Existing route architecture and canonical hooks remain intact.
- Approved NEØ image assets and semantic design tokens remain authoritative; no CSS recreation of the logo and no invented hotel content.
- Existing operational evidence and Run-1/Run-2 records remain untouched.
