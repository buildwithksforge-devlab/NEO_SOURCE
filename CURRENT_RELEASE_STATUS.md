# NEØ source and release status — 25 September 2026

## In this source bundle

- Guest checkout waits for payment availability before declaring online payment unavailable. A payment request remains pending until a provider callback confirms the balance.
- The worker phone alert screen restores the current device's registration state after reload, checked against the signed-in worker and organisation. It provides registration, test and removal controls when server dispatch is configured.
- The staff phone navigation has larger tap targets, hover feedback and visible keyboard focus.
- The earlier source fixes cover guest checkout, date selection, scoped in-app notification refresh and other module-specific repairs. They are present in code, not in the older Horizon deployment.

## Evidence and limits

The previous bundle passed 3,312 offline tests. This bundle's new UI edits passed 26 targeted tests across guest commerce, responsive navigation and notification scope. Typecheck and production smoke were rerun after the UI edits. These checks do not certify the live deployment or a complete visual redesign of every module.

| Work | Status | Required next evidence |
| --- | --- | --- |
| Independent live preview | Pending | Hosting access and real deployment configuration; open the new URL and inspect it. |
| Every staff role and guest journey | Pending | Real test identities, a matching deployed source/database and browser walkthroughs on phone and desktop. |
| Database migration parity and financial reconciliation | Pending | Reconcile historical migration history and the named operational exceptions before applying release migrations. |
| External payment, messaging and callback flows | Pending | Provider configuration, safe test transactions and callback receipts on the new origin. |
| Phone alerts while the app is closed | Pending | Apply the push migration, configure VAPID and dispatch scheduler, register a device, lock the phone and confirm a received test alert. |
| Release | NO-GO | Pass the live role, tenant-isolation, provider, accounting and mobile checks on the matching deployment. |

The existing `horizon-prime-os.lovable.app` URL will keep showing its prior release. Follow `DEPLOY_INDEPENDENT.md` to publish this source to an independent preview first. Do not enable outbound messaging or push dispatch against historical queued records merely to make a demonstration work.
