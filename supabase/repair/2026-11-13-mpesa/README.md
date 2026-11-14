# Installed M-Pesa corrections — 13 November 2026

These are repair evidence, not automatic migrations. Both corrections were run in the existing managed SQL Editor and confirmed by the user. Do not reinstall blindly.

- Unsafe manual Release is disabled: lack of a checkout reference cannot prove an attempt was never dispatched. No historical attempt was changed by this installer.
- Mawimbi / TWIN BOABAB ENTERPRISES LTD callback base now targets the existing Lovable backend. Its former hostname returned 404 at the callback endpoint; the managed endpoint correctly rejected a fabricated callback token with401. Existing token, credentials, production setting, other workspaces and attempts are preserved. Earlier prompts require reconciliation, not another prompt.

No Supabase project was created, no service-role credential was retrieved, and no RLS policy was disabled. No real payment was initiated by these repairs. A real prompt-to-receipt confirmation remains a separate acceptance check.
User-confirmed additional installed packages: APPLY_MPESA_CONFIRMATION_PAID_SERVICE_STOCK.sql and APPLY_RECEIVING_REVIEW_GRN_HANDOFF.sql. These install definitions only. Do not rerun against unknown definition drift. The private KES51 recovery script is not archived here. See the deployed release report for unresolved financial recovery.
