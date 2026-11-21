# Platform readiness report

Run the readiness report with Node from the repository:

```powershell
node scripts/platform-readiness.mjs evidence.json > readiness.json
```

Use the property ID and full release commit SHA or another immutable deployment identifier. Supply evidence obtained for that particular property and release. An empty evidence array produces a checklist with every required check marked Unverified.

```json
{
  "property": "property-id",
  "release": "full-release-commit-sha",
  "evidence": []
}
```

Each evidence record contains `check` (the check ID from the report), `property`, `release`, `checkedAt` (ISO 8601 with timezone), `expected`, `observed`, `reference` (the test run, transaction references or artifact), and `result` (`pass`, `fail`, `unverified` or `not-applicable`). For an optional capability, a waiver requires `enabled: false`, an `applicabilityReason`, and evidence of that property's configuration. Failed checks should include the step, staff role, transaction reference and downstream records used to reproduce or reconcile the finding.

Passes and waivers expire after 24 hours for property checks and seven days for the other checks. A skipped retest leaves the last verified failure open. The process exits with 0 for Ready, 1 for Blocked, 2 for Unverified and 3 for an input or invocation error.

Add `--verify-local` after the evidence file to collect build and offline test results from a clean checkout at the supplied commit SHA. Command logs go to stderr and the report goes to stdout. Preserve both when saving release evidence.

Use controlled data for workflow and rehearsal evidence. For the live property gates, use the Go-Live configuration checks, saved integrity checks, Quality defects, and reconciliation records. For the external gates, reference the physical print result and provider confirmation for the enabled integrations. The CLI evaluates supplied evidence. Live collection, evidence ownership and approval remain in the existing operational surfaces.
