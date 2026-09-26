# Owner onboarding, payroll figures and Ask NEØ answers

Four pieces of work, in this order.

## 1. Owner who signs up can finish their own workspace

What happens now: when the creator already has a staff record but the workspace
was only half set up, the app shows "an administrator must finish provisioning
it" and never offers the resume action. The resume path exists, but it is only
checked when the person has no staff record at all — so the exact case you hit
(sign up, verify email, sign back in) falls through to the dead end.

Fix:
- Whenever sign-in lands on "setup incomplete", ask the workspace-link check
  whether this exact signed-in account is the verified creator, and show
  "Resume workspace setup" when it is.
- Resume finishes the workspace for the creator: organisation, property,
  Administration department, Owner role and assignment, default settings and
  finance defaults, then refreshes access so the Owner walks straight in.
- Nothing about the System Administrator route changes. Ownership is still
  proven by the stored creator account only — never by email, workspace name,
  or being the only person in the workspace.
- Re-check that a second workspace's Owner, an ordinary employee, and a person
  from another workspace cannot use the resume action.

## 2. Payroll screen with salary, hours and deductions

Extend the HR payroll screen so each staff member in the selected period shows:
name and job title, contracted salary from their compensation record, hours
worked and overtime from verified attendance, leave taken, deductions and
statutory lines already recorded, and the net figure.

Rules:
- Every figure is read from what is already recorded (compensation records,
  approved attendance, approved leave, payroll inputs). No rate, hour or
  deduction is invented; where a staff member has no compensation record the
  row says "Not configured" instead of a number.
- Attendance hours follow the HR settings you configured (late grace, early
  departure, missed clock-out), so the screen and the settings agree.
- Only people with payroll permission can open it; everyone else is refused as
  today.

## 3. Ask NEØ answers with figures, per role

Keep one engine, change what it may read:
- Owner/Director, System Administrator, HR and payroll roles: Ask NEØ can
  answer pay questions — total payroll cost for the open period, headcount
  paid, a named person's salary where that role is allowed to see it — each
  answer citing the period and property it came from.
- Everyone else: pay questions stay refused exactly as they are now.
- All roles get a fuller answer format: the question box returns the figure,
  the period/property it covers, and a link to the screen the figure came
  from, rather than only a work block.
- Suggested questions per role are extended to match (Owner: payroll cost,
  occupancy, revenue; HR: headcount, leave liability, absences; departmental
  roles: unchanged).

## 4. Security re-scan and role certification

- Run the security scan again, fix what is genuinely fixable without weakening
  workspace isolation, and report what remains and why.
- Re-run the click-through certification in the isolated test workspace for
  Owner, HR, Receptionist, Chef and Storekeeper: each asks safe and forbidden
  questions, and we confirm pay figures appear only for Owner and HR and never
  leak across properties.

## Technical notes

- Owner path touches `src/lib/auth.tsx` (recoverability check on the
  setup-incomplete branch), `WorkspaceBootGate.tsx`, and the existing
  creator-bound recovery routine; no new privilege grants.
- Payroll reads existing `hr-data` hooks plus employee compensation and
  attendance aggregates; a read-only database routine is added if a safe
  aggregate does not already exist.
- Ask NEØ gains a permission-gated payroll fact source in
  `src/lib/department-ask.ts` and its server function; refusals stay the
  default for any role without that permission.
