# Finance checkout and ledger parity

Status: tested candidate; database installation is not yet confirmed.

Deploy the matching client before installing `APPLY_FINANCE_CHECKOUT_LEDGER_PARITY.sql`. The client accepts both the old projection and the new separately itemized staff-tip liability. Existing historical rows are not backfilled.

The guarded SQL replaces 12 inspected existing routines and installs five private helpers. It preserves existing routine owners and permissions, adds exact cart-to-order identity, and executes no collection, checkout, approval, invoice or stock movement during installation. Unexpected installed definitions cause rollback rather than overwriting unknown repairs.

Verified in isolated PostgreSQL: 46 checkout/posting/installer checks, 14 staff/guest folio checks and nine source-amount checks. Some external collaborators use controlled fixtures; this does not certify live Safaricom settlement or every Finance workflow.

Expected result: `finance-checkout-ledger-parity-v1`, `definitions_match: true`, `routine_count: 12`, `private_helper_count: 5`, `existing_permissions_unchanged: true`.

Remaining Finance work includes refund classification and original-journal evidence, manager-reviewed receipt-code fallback, configurable additional charges, procurement/stock/payroll/report review and authentic KES51 recovery. The other ordered priorities remain open.
