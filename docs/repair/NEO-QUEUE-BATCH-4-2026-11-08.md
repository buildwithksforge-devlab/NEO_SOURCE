# NEØ original-queue repair batch 4

This batch resumes the work interrupted by the approval review usage limit. It changes local source only. No deployment, operational payment, booking, task or stock change was performed.

| Original queue ID | Source work and proof | Remaining scope |
|---|---|---|
| NEO-BKL-M01 | A missing, zero, negative or invalid directory rate is no longer advertised as a nightly price; a configured positive rate remains visible. | Deployment and published listing parity. |
| NEO-BKL-D06 / NEO-BKL-M03 | Booking selection and confirmation explain base room nights and the difference to the actual server total. The returned total and currency are retained in the confirmation snapshot. No tax amount is invented. | Deployed display review; separately configured tax policy is unchanged. |
| NEO-BKL-R08 | Header and home greeting now use the same hotel customer name before authentication metadata. | Staff/customer records remain distinct; historical identity differences need review. |
| NEO-BKL-F01 | Quotation editor requires the expected saved quotation ID, all submitted lines and a finite total before success. Ten isolated checks exercise the existing SQL for persistence, retry, rollback, tax/discount/deposit arithmetic and authority/scope denial. | Installed pricing-definition parity and full quote workflow. |
| NEO-BKL-F02 | Existing pricing action cannot close as successful on an incomplete server response. | Broader quotation actions remain open. |
| NEO-BKL-F03 | Event confirmation requires the expected booking identity; empty, wrong-record or explicit failure replies cannot show success. | Deposit prerequisites and the full confirmation workflow remain separately tracked. |
| NEO-BKL-F05 / NEO-BKL-F07 | BEO creation/publishing and enquiry/quotation conversion require saved-record evidence. Existing replay behavior and billing warnings are preserved. | Department assignment and full operational/accounting handoffs are not certified by response validation. |
| NEO-BKL-D07 / NEO-BKL-M04 | Guest booking success requires a confirmed record, reference and finite total. Invalid calendar dates are refused when determining the stay length. Profile-linking does not start registration after a failed profile read. | Inventory hold, payment and full guest journey remain open. |

Targeted validation: 153 passed. Isolated quotation database validation: 10 passed. Final wider validation: 3,787 passed, zero failed, 155 skipped; all 3,667 baseline passing identities retained. TypeScript and production build/server smoke passed. See NEO-BATCHES-4-5-VALIDATION-2026-11-08.json.

The original denominator remains 106, with one fully verified item and 105 still requiring remaining acceptance evidence. This table records concrete code progress inside that queue, not new requests or artificial workflow closures.

The next server-side gap found is department ownership: event confirmation can create a task from a requirement with a null department, and BEO publication can create a requirement without resolving a configured department. Batch 5 adds and isolate-tests the ownership guard for that root cause. It remains uninstalled, and legacy requirements require explicit review. Response validation alone does not certify the full handoff.

