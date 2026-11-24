# Guest and Delivery receipt checkpoint — 22 November 2026

## Source and live identity

- Worktree: `codex/neo-audit-20261122`, based on remote `1754070` (`repair/neo-waves-20261106`). Five local Guest and Delivery changes were reapplied and reconciled above the remote tip without rewriting it.
- At inspection, Preview `/auth` returned HTTP 200 with build marker `c17f2e1718dec9e0`. No source commit or Cloudflare deployment record was established for that marker; the worktree changes here are **not claimed deployed**.
- Previous installed Cloud SQL evidence for `20261122140000_guest_delivery_receipt_projection.sql` is recorded in `WORKFLOW-TASKS.json`. The new `20261122150000_guest_receipt_property_evidence.sql` is **local only**. The read-only post-install check is `supabase/repair/2026-11-22/guest-receipt-property-verification.sql`.

## Actions and remaining evidence

| Workflow / route | Source result | Remaining evidence |
| --- | --- | --- |
| Guest cart and Delivery checkout `/guest/$hotelSlug/*`, `/delivery/$hotelSlug/checkout` | Combined recovery, saved reference, retry and account-scoped tracking changes | Deployed matching build; controlled signed-in M-Pesa and pickup cases with saved IDs, stock, kitchen, Rider and Finance outcomes. |
| Rider `/rider/active` | Saved transition acknowledgement and customer-visible refresh | Signed-in rider, PIN/proof, remittance and delivery acceptance. |
| Guest order `/guest/$hotelSlug/orders/$orderReference` | Receipt PDF button uses the saved customer-owned payment row and displays its actual received amount, including partial payment. | Install property evidence SQL, verify grant/definition readback and exercise a real paid Delivery payment and download. POS-only receipts still need a customer-owned saved payment projection and PDF path. |
| Guest receipt server `exportGuestBillDocument` | Checks confirmed status and property in the authenticated customer projection before rendering that property's PDF. | Install SQL and test a real payment, sibling-property refusal, long document and PDF download. |
| Preview release | Public route and build marker observed | Match build to commit using deployment record; preflight migration parity, deploy exact artifact and run signed-in acceptance. |

Keep source, SQL installation, Worker deployment, printer installation and physical acceptance as separate statuses. This checkpoint does not close the full 34-chain operational queue.
