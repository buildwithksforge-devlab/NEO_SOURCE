# R9.4 Entirety Notes

- Removed misleading admin save-success controls from tenant-backed autosave screens: Customer Communication, Dashboard Appearance, Business Documents, and read-only User Defaults.
- Brand Identity now says changes are applied and saving automatically rather than claiming persistence before the debounced database write completes.
- Added regression contract `admin-save-truthfulness.test.ts`.
- Added targeted reconciliation migration for three historical Nairobi POS shifts with zero linked orders. They move to `pending-closure`; no cash is counted or invented and the shifts are not closed.
- Existing 12 Sep pending-closure shift remains untouched because it has linked orders and requires real counted-cash handling.
- Rider remittance REM-260923-6790B remains a genuine KES 4,725 variance pending independent cash count/reconciliation; no auto-zeroing is permitted.
