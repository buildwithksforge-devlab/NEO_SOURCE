# Reports & BI Production Certification

## Goal
Certify Reports & BI against live tenant-scoped data, add secure branded PDF exports, prove AI/automation isolation, and restore the complete three-dot staff actions without weakening effective-permission checks.

## Implementation

### 1. Authoritative report scope and aggregation
- Audit and harden the reporting functions so organization identity is always derived from the signed-in session and branch/property/department filters can only narrow the caller’s effective scope.
- Add date validation, authorized-branch validation, and department-aware filtering where the report includes departmental facts.
- Reconcile KPI totals, time series, breakdowns, and operational fact cards against the same canonical fact layer; remove double-counting paths and make empty data explicit.
- Preserve the rule that operational sales, forecasts, collections, receivables, and posted accounting revenue remain distinct measures.

### 2. Reports experience and branded PDF export
- Extend the shared report scope bar with property/branch and department selectors sourced only from the caller’s permitted assignments.
- Add export controls for key management reports: Executive Summary, Rooms & Occupancy, Revenue & Collections, Restaurant & Kitchen, Events, Inventory & Procurement, and Service Delivery & Workforce.
- Generate PDFs server-side from a fresh authorized data read rather than trusting browser-supplied figures.
- Apply the active tenant’s configured name, logo, brand colors, currency, timezone, report period, scope label, generation timestamp, and confidentiality footer.
- Enforce `reports.export`/equivalent effective capability and record each export in the existing generated-report/audit trail without exposing storage paths or reports across tenants.

### 3. AI insights and automation isolation
- Require explicit Intelligence/Analytics permission for insight reads and narrative generation.
- Ensure financial inputs are omitted unless the caller has the corresponding financial/reporting capability.
- Restrict departmental advisories and automation outputs to the caller’s effective department/branch scope; guest financial detail will not be passed to AI or returned in automation output.
- Add regression coverage for unauthorized, department-only, branch-only, finance-hidden, and cross-tenant personas.

### 4. Restore the Users three-dot actions
- Restore the full staff action menu for each row, including assignment/status actions and existing access, audit, permission, invitation, password, and deliberate Owner controls.
- Keep every item visible only when its exact effective permission allows it and keep state-aware labels (activate versus suspend/deactivate).
- Preserve all existing server-side authorization and audit requirements; no action will rely on role names, job titles, or client state.
- Add a menu contract test so these actions cannot be accidentally removed again.

## UAT and certification
- Run live persona tests across at least two tenants and multiple roles/scopes without creating sample operational data.
- Verify denied cross-tenant reads, unauthorized branch/property/department widening, financial redaction, AI/automation gating, and export denial.
- Stress date ranges, all-authorized versus single branch/property, and department filters; compare summary totals with series/breakdown totals and repeat calls to detect duplicates or inconsistent results.
- Download and visually inspect every page of representative branded PDF exports for correct branding, figures, pagination, clipping, and tenant isolation.
- Exercise the Users three-dot menu in the browser for personas with different administration capabilities.
- Run focused security/integration tests and the complete regression suite, then return a factual PASS/FAIL report with evidence and any blocker clearly identified.

## Technical details
- Database changes will be additive and reversible, with explicit authenticated/service grants, RLS-safe security-definer functions, revoked anonymous/public execution, and no demo inserts.
- Server-function modules will remain thin wrappers; PDF composition helpers and report shaping will live in separate server-only modules.
- PDF generation will use an edge-compatible JavaScript library and embedded/project-approved logo assets rather than native binaries or subprocesses.
