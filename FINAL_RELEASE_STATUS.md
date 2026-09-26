# NEØ final release status — 24 Sep 2026

This package is the latest certification working source. It is **not yet a production-certified deployment**.

## Source-side work already completed
- canonical payment/read-model migration staged
- controlled supplier payment / refund / counted-cash / business-day / discount controls staged
- payroll posting-before-payslip guard staged
- prepaid POS service-state guard staged
- guest laundry lifecycle guard staged
- refund journal-sign guard staged
- broken supplier search route corrected
- static internal-link scan: 1,064 literal internal references, 0 unresolved after fix
- static secret boundary scan found no client `import.meta.env` access to service-role/provider secrets

## Known live blockers preserved for certification
- production source/database are behind this package
- remote migration history has historical drift and must not be blind-pushed
- Run 2 Payment Register/Lifecycle POS-journal projection fix not live
- Run 3 supplier AP truth KES 38,000 disagrees with supplier master outstanding balance 0
- Savanna supplier bank account not configured for real bank-transfer settlement
- Savanna laundry LAU-2026-000002 has incomplete lifecycle/posting evidence
- Zuri September payroll was released without finance posting
- real refund policy not configured for Savanna/Zuri
- five open tills require genuine human cash counts
- final business-day/EOD certification must be last

## One-command Windows gate
Run in PowerShell from this folder:

```powershell
.\RUN_FINAL_GATE.ps1
```

Do not apply production migrations until the gate passes and the migration reconciliation plan is followed.
