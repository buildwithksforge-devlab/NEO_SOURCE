# HR — Employee 360° Profile

Your read of HR is broadly right, but today it is split across screens: the employee page has tabs that only *display* a few lists, leave balances are stored numbers that nobody calculates, there is no way to apply for leave, no place to configure leave rules, no upload for documents, and the recruitment file stays behind in Recruitment when a candidate becomes staff.

This plan turns the employee record into the single place where the whole working life of a person lives, and makes leave calculate itself.

## What already exists (kept, not rebuilt)

Employee records, departments, branches, stations, employment history, documents, certifications, assets, training, performance, disciplinary, payroll inputs, attendance, rosters, candidates, interviews, offers, leave types, leave requests, leave balances and a leave ledger are all already in the database with tenant and property isolation. The work below fills the gaps rather than starting again.

## 1. Leave policies — configure once, calculate always

New **HR → Settings → Leave Policies** section where HR or the Owner creates and edits each leave category (Annual, Sick, Maternity, Paternity, Compassionate, Study, Unpaid, Off days, and any company-specific one) with:

days allowed, paid or unpaid, accrues monthly or granted annually, eligibility period, carry-forward on/off, maximum carried days, expiry of carried days, whether weekends count, whether public holidays count, minimum notice, supporting document required, and who approves (supervisor only, HR only, or supervisor then HR).

Most of these fields already exist on the leave type record; weekend counting, public-holiday counting and the approval route are added.

## 2. Entitlement calculated by NEØ, never typed in

A new database routine works out every employee's entitlement for the current leave year from the policy plus their joining date (monthly accrual is pro-rated from the date joined; annual grant is full once eligible), then adds carried-forward days within the carry-forward cap and drops expired ones.

Balances refresh when the leave screen or profile is opened and after any approval, so HR never edits a balance by hand. Existing recorded balances are preserved; the routine only recalculates entitlement, accrual, carried and expired figures, never the history of what was taken.

## 3. Applying for leave

**My HR → Leave → Apply for leave**: leave type, start and end date, reason, handover notes, person covering, supporting document when the policy demands one. Requested days are counted for you, honouring the weekend and public-holiday rules of that policy.

Before submitting, the form shows:

```text
Available balance : 15 days
Requested         : 5 days
Balance after approval : 10 days
```

Requests that break policy (over balance, short notice, over the consecutive-day limit, missing required document) are blocked with the reason named; where policy allows an override it is flagged to the approver instead.

## 4. Approving leave

**HR → Leave Requests** gains Pending / Approved / Rejected / Returned / Cancelled / Taken tabs and a decision panel that opens the request with: the employee, their department and property, their current balance, their previous leave, and everyone else in the same department already on leave over those dates. The manager can approve, reject, return for amendment, or record cancellation, always with a comment.

Approval moves the days automatically — pending days release, taken days rise, the balance updates, the leave ledger and the audit trail record who decided and when. "Taken" is set once the end date passes.

## 5. Employee 360° profile

`/hr/employees/{id}` is reorganised into one record with a permanent identity header (photo, name, staff number, job title, department, station, property, reporting manager, employment type and status) and these sections:

- **Overview** — personal and employment information, dates joined, probation start and end, contract start and expiry, emergency contacts.
- **Documents** — upload with document type, expiry date, uploaded by and date; replacing a document keeps the previous version in a version chain rather than overwriting it. Covers CVs, ID/passport, KRA PIN, NSSF, SHA/SHIF, certificates, qualifications, contract, appointment, promotion, warning, appraisal and other.
- **Recruitment** — the application file follows the person: positions applied for, application dates, CV submitted with each application, status, interview dates, scores, interviewers, notes, offer made and accepted or declined, and the original position recruited for. Linked automatically through the existing candidate→employee conversion.
- **Leave** — live balances per type (entitlement, accrued, used, pending, carried, expired, available) and the full request history with dates, days, status and approver; opening a request shows its whole approval and amendment trail.
- **Attendance & shifts** — recent attendance, rota, off days.
- **Pay** — payroll inputs, allowances, deductions, advances (read-only, permission gated).
- **Performance & training** — reviews, ratings, training, certifications with expiry.
- **Conduct** — disciplinary cases, warnings, grievances, incidents, recognition.
- **Assets** — items and uniforms issued, return dates.
- **Exit** — separation type, last working day, clearance checklist.
- **Timeline** — one dated stream of the working life: joined, contract issued, probation completed, leave requested/approved/taken, department change, promotion, transfer, warning, appraisal, training completed, contract renewed, resignation, exit. Assembled from the records themselves, so it can never disagree with them.

Sensitive sections (statutory, pay, conduct) stay behind the existing HR permission gates; employees see their own record only.

## Technical notes

- Additive migration only: new columns on `leave_types` (weekend/holiday counting, approval route, leave category), `leave_requests` (returned/cancelled/taken statuses, return comment, cancellation fields), `employee_documents` (`supersedes_document_id`, `document_date`); no drops, no data loss.
- New SECURITY DEFINER routines anchored to `current_org_id()` and `has_permission`: `neo_hr_leave_sync_entitlements`, `neo_hr_leave_working_days`, `neo_hr_leave_apply`, `neo_hr_leave_decide` (approve / reject / return / cancel), each writing to `leave_transactions` and the audit trail. Registered in the RPC manifest.
- A private HR document bucket with property-scoped access, signed URLs for viewing, and no public exposure.
- New UI under `src/routes/_shell.hr.*` and `src/components/hr/*`, using the existing common primitives and density rules; new data hooks in `src/lib/hr-data.ts`; timeline assembly in a new `src/lib/hr-timeline.ts`.
- Tests: working-day counting with weekend/holiday rules, entitlement and carry-forward maths, balance movement on approve/reject/cancel, and timeline ordering.

## Out of scope for this pass

Public-holiday calendars must be configured with real dates before holiday exclusion can apply — no holidays will be invented. Payroll amounts, salary history and staff loans are displayed from existing records only; no pay figures are created.
