# NEØ Intelligent Data Onboarding — engine first, Assets as the first certified module

This turns the parked "asset Excel import" item into a reusable onboarding engine
(Y-DATA-ONBOARD-01) and certifies Assets against it (P-ASSET-IMPORT-01). It also
lists the Stores/Procurement walkthroughs you asked for at the end, which I will
do **after** the importer, because several of them need real records to exist.

## What exists today

- Administration → Data Migration is a single screen: pick a data type, upload a
  CSV, see valid/invalid counts, record a "dry run" batch, approve, lock. It
  never writes real records, has no mapping step, no relationship resolution,
  no bulk fixes, no resumable batches, no lineage back to created records.
- Batches and rows are already stored (reference, data type, status, row values,
  errors, warnings, duplicate marker, imported record id). That storage is a
  sound foundation and will be extended, not replaced.
- Assets & Equipment has manual entry only.

## Stage 1 — Hotel Data Onboarding Centre (useful before any upload)

Replace the bare upload screen with a chooser of data domains (People & HR,
Rooms, Assets & Equipment, Inventory Items, Suppliers, Guests, Corporate
Accounts, Rates & Packages). Each domain carries a definition NEØ owns:

- required / recommended / optional fields, with plain-language meaning
- accepted formats and units
- which NEØ records it must link to (department, property, employee, supplier)
- Download blank template · Download completed example · View field guide ·
  Upload existing data

A brand-new hotel can therefore prepare itself with nothing uploaded.

## Stage 2 — The engine (shared by every domain)

A staged batch: **Uploaded → Analysing → Mapping → Validation → Ready →
Importing → Completed / Completed with exceptions / Failed**, with progress
counts. Progress lives in the database, so a refresh resumes the batch.

- **Profiling.** After upload NEØ reports what it found: rows read, import-ready,
  missing recommended info, values needing mapping, possible duplicates,
  blockers — each explained, never a bare "import failed".
- **Column mapping.** Their header is matched to NEØ's field by name similarity
  and sample-value shape (Equipment Description → Asset Name, Acquisition Value
  → Purchase Cost, Staff No → Employee ID). Every proposal shows confidence and
  is reviewable and overridable; unmapped columns can be ignored for the import.
- **Relationship resolution.** Values are resolved against the real masters —
  departments, employees, suppliers, PMS rooms, stores — not copied as text.
  F&B → Food & Beverage, House Keeping → Housekeeping, Rm 204 → Room 204, each
  with a confidence score, accept-all-high-confidence or review individually.
- **Four severities**: 🔴 Blocker, 🟠 Needs decision, 🟡 Warning, 🔵 Complete
  later. Only blockers stop a record; optional history never delays go-live.
- **Bulk operations** with preview: apply a mapping to all occurrences, trim
  whitespace, standardise dates, normalise phone numbers, ignore a field, leave
  missing custodians unassigned, generate identifiers where the domain allows.
- **Import plan** before committing: records to create, matched records to
  update, duplicates to skip, fields left blank, identifiers to generate,
  mappings applied, rows still needing attention.
- **Idempotency.** Batch id + row identity + domain duplicate keys; re-running a
  batch never doubles records, and questionable matches are never merged
  silently — they surface as a decision.
- **Lineage.** Every created record records its batch, original file, row
  number, importer, timestamp, mappings and transformations applied. Manual
  records stay labelled as manual.
- **Reversal.** An authorised administrator can reverse an eligible batch.
  Records that already have operational dependencies are refused, not deleted.

### Hard boundary

NEØ may clean, classify, transform, match and propose. It will never invent a
cost, serial, warranty, date, supplier, employee or transaction. Missing stays
missing and is reported as such.

## Stage 3 — Assets as the first implementation

Asset field definition, template and example; asset duplicate keys (asset tag,
serial, external reference); department/custodian/property/supplier resolution;
asset tag generation only where the hotel opts in. Entry points: **Assets &
Equipment → Import Assets** and Administration → Data Migration, both driving
the same engine. Documents (invoice, warranty, manual, photo, certificate)
remain attachments on the asset record, separate from the structured import.

## Stage 4 — Certification walkthrough (as a real administrator)

Blank Asset Register → Import Assets → upload an untouched register → analysis →
mapping review → ambiguity resolution → preview → import → refresh → verify
assets → open one → confirm Maintenance selects the same canonical asset. Then
re-run the same batch to prove no duplication, and test a deliberately messy
file (different names, typos, missing columns, multiple sheets).

## Then, in order, the Stores and Procurement items

1. Departmental store selector; issue a real requisition from a Bar Store to its
   department and confirm stock moves and issues are recorded.
2. Procurement Approval & Control Policy live: save a real threshold ladder, then
   submit a Purchase Request and confirm it routes to the correct approver.
3. Full chain: Requisition → Purchase Request → Purchase Order → Goods Receiving,
   confirming each step updates stock and approvals.
4. Departmental stock dashboard: stock levels, movement history, requisition
   status per department, to certify consumption.
5. Date persistence: Purchase Request Effective From and Supplier Invoice due
   date both persist and reopen correctly.

Maintenance P1 questions (fault category source, priorities, room and asset
resolution, technician eligibility, status transitions, preventive recurrence,
escalation, materials to Stores, asset history) and the matching Grounds set stay
open and will be resolved before Block P closes. They are not dropped.

## Technical notes

- Extend `data_migration_batches` / `data_migration_rows` additively: stage,
  processed counters, field mapping, transformations, resolution decisions,
  row-level severity and target record type. No drops, no data loss.
- Import execution runs server-side in chunks against the authenticated caller's
  own permissions, so tenant and property isolation and RLS apply unchanged.
- Spreadsheet parsing supports CSV and multi-sheet Excel.
- Existing dry-run batches remain readable and keep their current status.

## Scope note

This is large. I will build Stages 1–3 and run Stage 4 in one pass, then move to
the Stores/Procurement list. Nothing in the certification steps will invent hotel
data — where a real record is missing, I will say so rather than create it.
