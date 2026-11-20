# Platform readiness report

Select a property in **Platform & Readiness**. Start with **Go-Live Readiness** for failed checks, affected workflows, and the percentage of configuration checks verified for that property. **Testing & Defects** shows saved integrity findings, Simulation results, and the live Guest and Delivery link checks. An unverified result carries no pass credit. The organisation approval checklist requires a saved evidence reference for each mandatory item.

| Area | NEØ can show automatically | Evidence still needed |
| --- | --- | --- |
| Go-Live Readiness | Selected property's configuration results by workflow and signed-out public app responses tied to the app build | Approval of launch gates using current evidence |
| Integration Centre | Saved connection state, configuration requirements, and recorded provider checks | Sandbox charges and callback, device, or provider confirmation |
| History & Tenant Migration | Saved lifecycle actions, status, and audit history | Approval and reconciliation for a proposed move |
| Environments & Flags | Registered environments and saved flag overrides | Isolation, intended flag configuration, and provider mode in each environment |
| Subscription | Saved plan, entitlements, status, and renewal alert | Confirmation from the billing source when updating a plan or an invoice |
| Data Migration | Import validation, row issues, and recorded batch progress | Approval of source data, applying batches, and reconciliation of counts and balances |
| Recovery Centre | Saved snapshots, restore run states, and verification evidence | An approved restore drill with downstream validation |
| Configuration Health | Station/store assignments, stock and menu bindings, recipes, container data, and saved provider configuration | Configuration choices and a retest after repair |
| Testing & Defects | Saved integrity and Simulation failures, plus live public-link verdicts | Triage, confirmation of the fix, and closure of saved defects |
| Simulation Centre | Server registry availability, test environment state, and recorded assertions by workflow | Starting an isolated run and reviewing failures and skipped cases |
| Releases & Monitoring | Recorded release, monitoring, backup, and incident status | Matching the live build to the release and confirming operational acceptance |
| Performance Monitor | Client observations and realtime propagation measurements | A representative workload and device/session evidence |
| Support & Knowledge | Tickets, saved severity, deadlines, and knowledge articles | Repair ownership and a verified outcome |

Public link checks run from the browser while the overview or Quality screen is open. They use an anonymous request and compare the property and build markers in the returned page. A positive result confirms the route answered. Checkout, provider settlement, and departmental handoffs each require their own records. Live link verdicts are displayed on both screens. The existing automated integrity and Simulation results use the saved defect register.

For Delivery, apply migration `20261120100000_public_delivery_and_readiness_links.sql` before releasing the matching client. The publication lookup can return a canonical branded workspace from an exact link or a hotel alias. A property with no published Delivery workspace still needs an authorised publication in App Branding.

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
