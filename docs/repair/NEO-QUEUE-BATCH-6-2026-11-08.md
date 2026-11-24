# NEØ event forms and production clocks — batch 6

Local source repairs inside the original queue. No operational rows or historical deadlines were changed.

| Queue record | Repaired source behavior | Remaining boundary |
|---|---|---|
| NEO-BKL-F04 | A configured department is required. Event choices are active departments in the booking's workspace/property or shared configuration. | The separately tested SQL 85 guard still needs controlled installation; legacy ownerless tasks are not rewritten. |
| NEO-BKL-L02 | Event department choices use the existing canonical department identity and prefer property configuration over duplicate shared Main Kitchen choices. | Deployment and observed UI parity. |
| NEO-BKL-F01 / F05 | Shared event forms validate required dropdowns and stale choices, retain recovery drafts on asynchronous failure, and prevent duplicate in-flight submissions. Requirement/menu/stock forms now await their saved record before closing. | Broader quotation and departmental workflows remain open. Callers still using void callbacks do not gain asynchronous outcome proof automatically. |
| NEO-BKL-L04 | Kitchen preparation/use-by, pastry due times and event requirement/menu/stock times use the record property's IANA timezone rather than the computer clock or a timezone-free database timestamp. Pastry deadlines display in that property timezone. | Existing wrong deadlines are unchanged; other date-entry surfaces need separate review. |
| NEO-BKL-F06 | Event stock-required times use the booking property clock and failed captures retain input. | Requisition approval, physical stock issue and full handoff remain open. |
| NEO-BKL-C07 | Production plan quantities reject zero, negative and nonfinite values before the RPC; blank input no longer silently becomes one item. | Canonical recipe yield/consumption and stock-ledger acceptance remain separate. |

Targeted final validation: **133 passed** across seven suites, including 38 new assertions for property clocks, required fields, asynchronous draft retention and production inputs. Existing roster clock and event contracts passed unchanged.

Clock checks cover Nairobi-to-UTC conversion, computer-timezone independence, quarter-hour offsets, UTC date boundaries, seconds, invalid dates, skipped/repeated DST hours and property/workspace resolution. Ambiguous or unknown property times are refused; no external clock/rate service is used.

TypeScript and production build/server smoke passed. The fresh final full offline regression passed 3,831 assertions with zero failures and 155 skipped; all original and previous-batch named passes were retained. The initial synchronous draft-clear regression was corrected, and the unchanged viewport test passed the focused rerun and fresh full suite. See NEO-BATCHES-6-7-VALIDATION-2026-11-08.json. No deployment or frontend operational acceptance was performed.

