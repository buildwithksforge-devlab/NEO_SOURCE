# NEØ queue batch 12 — station display and mapping confirmation

**30 untouched/queued · 27 active/partial · 21 awaiting deployment/retest · 25 awaiting workflow tests.** One print-agent record awaits deployment, one is partially verified, and one is fully verified.

Fresh full offline checks: **3,930 passed, zero failed, 155 skipped**. Original and prior application named passes retained. Fresh TypeScript and production build/server smoke passed. Focused station checks: 52 passed, 7 database-dependent checks skipped.

## Source changes

Explicit coffee, pastry, bar and kitchen station types now win over incidental words in labels. Case/padding and underscore/hyphen code delimiters are normalized. Generic legacy beverage Coffee Station remains coffee, and Larder joins existing kitchen subdivisions. Service stations cannot enter a production display via misleading labels or padded/cased type values. Unknown custom stations remain unclassified for a department and visible only in the already scoped overview. Bookmarks cannot widen the server-scoped station list.

Station-store set/clear mutations now require server ok=true and matching station identity (plus selected store identity for set) before success feedback. Failed, empty or mismatched results retain failure behavior and do not invalidate caches as a success. Station impact requires an explicit boolean outcome and includes organization in its cache identity. Property-store/routing-rule reads explicitly filter organization and reject a manual refetch with missing workspace context.

## Scope retained

This is a client presentation and confirmation fix. It does not alter server-side ticket routing, RLS, station authority, department assignments, stock movements, station creation, PIN setup or employee authentication. Fixed route families and legacy classification fallbacks remain; the fully configuration-driven station requirement remains partial. No operational rows were changed. Changes are local and undeployed.

## Original records advanced

- **NEO-BKL-B01**: Display classification now prefers an explicit coffee/pastry/bar/kitchen station type over conflicting name/code words. Legacy beverage-type Coffee Station remains separate from bar. No stations were merged or production responsibilities reassigned; full routing acceptance remains open.
- **NEO-BKL-B02**: Legacy Larder/Grill subdivisions now resolve to the kitchen display; type/code normalization handles padding, case and underscore delimiters. Service stations cannot enter production displays through misleading names. Server ticket transitions and independent station authority remain unchanged.
- **NEO-BKL-B03**: Presentation classification uses configured explicit types before label fallbacks; mapping set/clear now require matching confirmed station/store evidence before success feedback. Actual department/category-to-ticket routing and item execution remain separately open.
- **NEO-BKL-B04**: Configured display type now has precedence and is normalized, retaining legacy beverage compatibility. Fixed display route families and legacy label fallbacks still exist; this is a partial configuration fix, not fully dynamic station creation/authentication.
- **NEO-BKL-R06**: Station-impact cache now includes organization. Property-store and routing-rule reads explicitly filter organization and reject manual refetch without workspace context. Existing server RLS/visibility/transition authority remains unchanged; reciprocal role acceptance remains open.
- **NEO-BKL-C01**: Supply-store mapping changes no longer report success on null/failed/wrong-station/wrong-location server results. Store reads explicitly filter organization; these client confirmations complement batch 10 core boundary checks, not full physical inventory certification.
