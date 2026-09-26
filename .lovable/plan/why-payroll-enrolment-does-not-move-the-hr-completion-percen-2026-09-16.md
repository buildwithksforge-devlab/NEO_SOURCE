# Why payroll enrolment does not move the HR completion percentage

Investigation only — no code was changed.

## 1. The figure the user is watching

There is exactly one percentage in HR, and it appears in two places:

- Employee profile → "Record readiness" card: "<n>% of tracked facts recorded", plus the progress bar.
- Employee Directory → each row and the inspector: "<n>% — Needs completion / Not payroll ready".

The HR dashboard itself shows no percentage. The directory's summary tiles (Employees, Complete, Needs completion, Not payroll ready, No system access) are counts derived from the same rule.

## 2. Exact formula and source fields

`employeeReadiness()` in `src/lib/hr-readiness.ts`:

```text
percent = round((11 - missingCount) / 11 * 100)
```

The 11 tracked facts are all columns on the `employees` row:

- Personal details: full_name, phone, work_email
- Placement: branch_id, department_id, job_title, reporting_manager_id
- Employment terms: employment_type, employment_date, position_grade, contract_start

Nothing else feeds the number.

## 3. Does payroll contribute? No — zero.

`payroll_status` is read only for the separate `payrollReady` boolean (the "Payroll ready / Not payroll ready" badge). It is deliberately excluded from `missing`, so it cannot change the percentage by any amount. The same is true for the agreed pay record, payment/bank details and `payroll_effective_from` — none of them are checked anywhere in the readiness rule.

Compounding it: the directory's "Not payroll ready" tile counts employees with missing *placement/terms* fields (`payrollBlockers`), not employees who are outside payroll. So enrolling someone does not move that tile either. `workforceReadiness()` does compute a `payrollReady` count that honours `payroll_status`, but no screen displays it.

## 4. Is payroll linked to the same employee identity?

Yes. `neo_hr_set_payroll_enrolment` writes `employees.payroll_status` and `employees.payroll_effective_from` on the same employee row; `employee_compensation` and `employee_payment_details` are keyed by `employee_id`. Live data confirms the write works: 1 employee `active`, 488 `not_ready`. The identity chain is sound.

## 5. Diagnosis

This is not a persistence or wiring bug. The readiness rule was written to measure *HR record completeness only*, and payroll enrolment was added later without being added to that rule. The two "payroll" and "access" sections even exist in `READINESS_SECTION_LABELS` but have no checks behind them — the intent was there, the checks were never written. So the user's expectation (put someone on payroll → completeness rises) is reasonable and the system simply does not model it.

## 6. Minimal safe fix (for a later turn, on approval)

Confined to `src/lib/hr-readiness.ts` plus the two display surfaces; no RBAC, no schema, no migration, no other module.

Option A — smallest, recommended:
- Add payroll checks to `READINESS_CHECKS` under the existing `payroll` section: payroll enrolment (`payroll_status` in ready/active/approved) and `payroll_effective_from`, both `blocksPayroll: false` so nobody's current "Not payroll ready" state changes meaning.
- Denominator moves 11 → 13; every existing employee's percentage drops slightly until enrolled, then rises on enrolment. That movement is the behaviour asked for, but it is a visible change to a number people have been reading — worth confirming before applying.

Option B — non-disruptive alternative:
- Leave the percentage at 11 facts and instead fix the directory so the "Not payroll ready" tile and lens use `payrollReady` (which already honours `payroll_status`), so enrolment visibly moves a figure without redefining the percentage.

Open question for you: should enrolment raise the completion percentage (A), or should it only move the payroll tile (B)? A can also include the agreed pay record and payment details as checks if you want "fully onboarded for payroll" to be the bar.
