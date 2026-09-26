# Finish holidays, payroll to the ledger, payslips, bulk onboarding and role certification

## What I found already working

Public holidays are already finished. Adding a holiday saves it against the workspace, writes an audit entry, and shows the year the date belongs to. Leave day counting already skips those dates for any leave type set to exclude public holidays, across every year on record. I will re-check this with real clicks and report evidence rather than rebuild it.

Payroll posting also already exists: a period that is approved, has pay on every employee, and has accounts chosen can post a single journal to the books. What is missing is the accounts themselves — nothing has been chosen for salary cost, deductions and net pay.

## 1. Payroll period to the ledger (real accounts)

- Add a guided "Salary accounts" step inside Pay and posting that lists the six things a payroll journal needs (basic pay cost, allowances, bonuses, reimbursements, deductions owed, net pay owed) and lets Finance pick an existing account for each from the chart of accounts.
- Where a workspace has no suitable account yet, offer to create it under the correct category with a clear name, on a button press — never silently.
- After posting, show the journal number, the date, and a line-by-line comparison of the payroll totals against what landed in the ledger, so the two can be seen to agree.

I will not invent account codes or pick accounts on the hotel's behalf; the choice stays with Finance.

## 2. Payslip screen

New HR page listing, per employee for a chosen period: basic pay, each allowance, bonus and reimbursement, each deduction, and net pay, with the same figures the posting panel uses. Includes:
- a single payslip view per employee, printable,
- staff seeing only their own payslip from My HR,
- release routing: payslips stay hidden until the period is approved and an authorised person releases them, with the release recorded in the audit trail.

## 3. Bulk onboarding screen

New HR page that takes several staff at once through the three stages already in the onboarding journey — employment terms, pay, payment details. Rows are pre-filled only with what is already on record; blanks stay blank. Shared values (grade, contract dates, pay period) can be applied down a column, each row is still saved individually and validated individually, and a row that fails says why instead of failing the whole batch.

## 4. Permission certification for the other roles

Check, against live permissions, whether Sales & Events Manager, Marketing Manager and Front Office Manager can: close End of Day, charge a folio, record or approve banquet payments, and administer corporate accounts. Report role by role what each can and cannot do, and flag separation-of-duties problems — for example the same role both recording and approving a payment, or a sales role able to close the day's books. I will report gaps rather than change anyone's access in this turn.

## 5. Finance Manager walkthrough

Signed in as Finance Manager, walk End of Day, a minibar charge and a banquet payment in the test workspace, then confirm each one shows up in the ledger with matching amounts. Evidence recorded as pass/fail per step. No real money moves.

## Technical notes

- Payroll posting uses the existing guarded posting routine and the existing payroll settings record; only account selection and verification are added.
- Payslip figures reuse `usePayrollComputation` so the payslip, the posting preview and the journal cannot drift apart.
- Bulk onboarding reuses the existing employment-terms and payroll-enrolment routines per row; no new write paths into employee records.
- Release and account changes are audit-logged; all reads stay workspace- and property-scoped.
