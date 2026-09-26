# NEØ — External Integration & Device Ecosystem Readiness Audit
Date: 2026-09-20. Method: code + database inspection only. No connectors built, nothing published.

## A. Current integration architecture (what exists)

Three overlapping layers exist, not one:

1. **Integration Centre** — route `/_shell/platform/integrations`, backed by
   `integration_providers` (15 rows, canonical catalogue), `integration_connections`
   (4 rows), `integration_test_runs` (11 rows), `integration_events` (0 rows),
   `integration_webhook_receipts` (0 rows).
2. **Communications/provider layer** — `provider_connections` (16 rows across
   workspaces: resend / whatsapp / africastalking / openai), `provider_credentials`,
   `communication_queue` (real retry with guard), `provider_webhook_events`.
3. **Payments layer** — `mpesa_settings`, `mpesa_transactions`,
   `mpesa_callback_events`, plus public server routes
   `/api/public/mpesa/callback/$token`, `/api/public/payments/callback/$token`,
   `/api/public/delivery/callback/$token`, and two explicitly-named simulator routes.

## B. Genuinely FUNCTIONAL

| Component | Evidence |
|---|---|
| Provider registry (catalogue) | `integration_providers`: code, category, capabilities, webhook/sandbox support, partner-approval flag, required secret names, docs URL |
| Real connection test (M-Pesa) | `runProviderTest` obtains a live Daraja access token; pass/fail recorded via `neo_integration_record_test` |
| Real endpoint reachability test | `testMpesaCallbackEndpoint` posts an intentionally invalid token to the public callback and asserts rejection |
| Honest "no safe test" reporting | Resend / Africa's Talking / card terminal return `not_configured` or `unsupported` rather than a fake pass |
| Webhook tenant resolution | Per-tenant secret token in the URL path; unknown token → 401 before any read; payload applied only to a transaction owned by that tenant |
| Webhook idempotency (payments) | Callback matched to `mpesa_transactions` with `applied_at` guard; unmatched payloads logged, not applied |
| Secret isolation | `mpesa_settings` and `provider_credentials` carry deny-all RLS for `anon` and `authenticated` — reachable only server-side |
| Communication retry queue | `communication_queue` with retry guard trigger (live, in use) |
| Lifecycle fields | `integration_connections` records sandbox_test_passed_at, security_review_passed_at, production_approved_at/by, health, error_count, last_error |
| Tenant/property scoping | Every integration table is organisation-keyed; connections also branch-keyed |

## C. PARTIAL

- **Integration event queue** — `integration_events` has the full shape (idempotency key,
  attempt_count, max_attempts, next_retry_at, dead_lettered_at) but **zero writers in
  application code**. The queue exists; nothing enqueues to it.
- **Webhook receipt ledger** — `integration_webhook_receipts` has
  signature_verified / replay_detected / processed columns but is read-only in the UI;
  the live M-Pesa receiver writes to `mpesa_callback_events` instead.
- **Signature verification** — payments callbacks authenticate by URL secret token, not by
  provider HMAC signature. Adequate for Daraja (which signs nothing), insufficient as a
  general webhook contract for Stripe/Slack-style providers.
- **Two parallel provider models** — `integration_connections` and `provider_connections`
  describe overlapping things with different state vocabularies.
- **Credential rotation / expiry** — `credentials_expire_at` exists and the UI warns; no
  rotation routine.

## D. UI ONLY / PLACEHOLDER

- **Printer profiles** — `printer_profiles` (0 rows) is a POS settings form only: name, role,
  station, connection_type, address, status. Nothing reads it to route a print job.
- **Attendance devices** — `attendance_devices` (0 rows), registration shape only.
- **OTA / channel manager** — `booking_com`, `expedia`, `courier_gateway`, `whatsapp`
  are catalogue rows with no client implementation.
- **Health monitoring** — `health` column is set by tests, not by any scheduled probe.

## E. NOT IMPLEMENTED

Device discovery (any protocol), ESC/POS emission, print job queue, print acknowledgement,
printer fallback, local print bridge/agent, door locks, key cards, barcode scanners,
cash drawers, POS terminals, biometric clocks, external accounting/ERP sync,
outbound public/partner API, partner app credentials, scopes, API versioning,
published event catalogue, sandbox tenant, developer portal, connector certification.

## F. Printer / device capability matrix

| Path | Status | Note |
|---|---|---|
| Browser print of a server-rendered PDF | FUNCTIONAL | `DocumentPrintButton` → `exportBusinessDocument`; canonical record, property masthead, document number, scope-checked |
| USB printer | NOT IMPLEMENTED | Requires WebUSB (Chromium, user gesture, per-device consent) or a local agent |
| LAN / Wi-Fi printer (raw 9100) | NOT IMPLEMENTED | A browser cannot open a TCP socket; needs a local bridge or a cloud-connected printer |
| Bluetooth printer | NOT IMPLEMENTED | Web Bluetooth, Chromium only, per-session pairing |
| ESC/POS byte generation | NOT IMPLEMENTED | No encoder anywhere in the codebase |
| Vendor cloud printer (Star CloudPRNT, Epson Server-Direct) | NOT IMPLEMENTED | The only option that works from a hosted app with no local software |
| Local NEØ print bridge/agent | NOT IMPLEMENTED | Required for USB/LAN/Bluetooth at a hotel |

**Honest discovery position:** a hosted web app cannot scan a hotel's LAN. Only three
discovery mechanisms are technically available — user-initiated WebUSB/Web Bluetooth
pairing, a local agent that reports what it finds, or a vendor cloud that lists the
hotel's registered printers. Any "Scan for printers" button without one of those is fake
and must not be built.

## G. API / webhook / developer capability (external provider → NEØ)

Inbound: three tenant-token callback routes, purpose-built per provider. No generic
partner API, no API keys for third parties, no scopes, no versioning, no published event
catalogue, no sandbox tenant, no partner registration. A vendor today has **no defined
path**; integration would require bespoke work inside NEØ.

## H. Credential / security assessment

Strong: server-only RLS on secret tables; secrets read through `process.env` in server
functions; masked identifiers in the UI; tests never echo values; `required_secret_names`
declared per provider.
Gaps: no encryption at rest beyond Postgres/RLS, no rotation routine, no revocation
action, no per-provider access permission distinct from platform admin.

## I. Tenant / property isolation assessment

Every integration and device table is organisation-keyed and covered by the standing
tenant guards; connections and printers are also branch-keyed. Webhook ownership derives
from a server-side token lookup, never from a browser-supplied organisation id. Workspace
switching reads through `current_org_id()`, so credentials follow the active workspace.
No cross-tenant integration leak found.

## J. Missing infrastructure (ordered by dependency)

1. Print job model: `print_jobs` (payload, destination, attempts, ack, failure) + routing rules.
2. Device transport contract: cloud-poll (CloudPRNT-style) first — works with no local software.
3. Local bridge agent (paired to property, poll-based, no inbound firewall hole) for USB/LAN/Bluetooth.
4. ESC/POS renderer for receipts and kitchen/bar tickets.
5. Generic outbound integration dispatcher writing to the existing `integration_events` queue.
6. Webhook ingress with HMAC verification + `integration_webhook_receipts` as the single ledger.
7. Connector manifest (config schema, capabilities, test definition) so providers are data, not code.
8. Partner surface: API keys, scopes, versioned endpoints, event catalogue, sandbox tenant.
9. Scheduled health probes writing `health`.
10. Credential rotation and revocation.

## K. Recommended sequence

Phase 1 printing via cloud-poll printers (no local install) → Phase 2 print job queue,
routing, retry, audit → Phase 3 local bridge agent → Phase 4 generic connector manifest +
event dispatcher + webhook ingress → Phase 5 partner/developer surface.

## L. Exact printer path possible TODAY at Zuri Crest

1. Open POS → Settings → add a printer profile (name, role, station, address). **Record only.**
2. Open any document (receipt, invoice, PO, GRN) → Print document → server-rendered PDF.
3. Print that PDF from the browser to any printer the operator's own computer already has.

Steps NOT IMPLEMENTED today: discovery, identify device, capability detection, test print,
activation, station routing of a live transaction, acknowledgement, retry, fallback,
offline handling, print audit trail.

## M. Path after the missing infrastructure is built

Integration Centre → Devices → Printers → Add (cloud printer: enter vendor serial;
local: install the property bridge and pick a discovered device) → capabilities read back
→ assign property + station (Front Office / Restaurant / Kitchen / Bar / Coffee / Invoices)
→ test print with a real acknowledgement → activate → transaction raises a print job →
routed → printed → acknowledged or retried → falls back to the next printer for that
station → every attempt in the audit trail.

## Preserved findings (unchanged)

INV-2026-000003 open receivable; 42 quarantined cross-workspace links; provider backup/PITR
terms still unrecorded; ~600 pre-existing linter advisories.
