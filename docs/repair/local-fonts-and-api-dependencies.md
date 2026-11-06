# Local fonts and external dependency review — 6 November 2026

Source: `C:\Users\Kelvin\Downloads\NEO_COMPLETE_2026-09-26\NEO_SOURCE`, branch `repair/neo-waves-20261106`. These are local, uncommitted changes. No operational SQL, push or deployment has been performed.

## Implemented

The web application loads pinned, locally bundled OFL fonts instead of Google Fonts stylesheets. Existing choices remain: Plus Jakarta Sans, Inter, Manrope, DM Sans, Playfair Display and Instrument Serif. Added choices: Noto Sans, Source Sans 3 and Lora. The property-brand and Experience Studio catalogues expose the new choices, retaining system fallbacks. Font binaries are built into the site's own assets; license copies ship under `public/font-licenses`. This removes a third-party font request, not the website's need for hosting or the hotel's need for its database connection.

Authorised metric summaries now use deterministic local formatting unless a workspace explicitly saves a provider key. A platform environment key alone no longer causes automatic narrative requests. Local summaries identify themselves as local, use no model, and do not count as external AI calls. An explicitly disabled workspace remains disabled; an explicitly configured provider remains optional and its failures remain visible. The automation brief uses the same path and rejects failed source reads rather than presenting failures as zero activity. This is factual formatting, not a new local language model or a prediction engine.

## Controls and dependencies traced

| Control / feature | Actual dependency | Decision |
|---|---|---|
| Refresh / pull to refresh | Active application queries | Keep. Read-only application refresh, no AI key. |
| Live status / reconnect | Existing Supabase realtime/application connection | Keep. Needed for live hotel updates; not an AI purchase. |
| Brand and public-site font selectors | Previously remote Google stylesheet | Replaced with local bundled assets and more choices. |
| Intelligence / assistant metric prose | Automatic platform AI gateway fallback | Replaced with local formatting by default; explicit workspace external provider remains available. |
| Automation management brief | Direct OpenAI call using an environment key | Replaced with shared local-first summary path. |
| Provider connectivity test | Explicit request to the selected provider | Retained and labelled as a real external request. |
| Password reset | Existing Supabase Auth and configured reset-email delivery | Keep the existing backend. Fixed the guest settings return URL and false-success handling; no new service. |
| Profile pictures | Existing private Supabase avatars bucket, stored profile paths and signed URLs | Keep existing storage. No extra avatar-generation provider found in this upload path. Save confirmation and legacy remote image references remain review items. |
| M-Pesa initiation/status | Safaricom service | Retained. Local code cannot truthfully confirm a bank/mobile-money transaction without the payment rail. |
| SMS, WhatsApp and email | Africa's Talking, Meta and Resend/provider settings | Retained as explicit delivery integrations. No fake local delivery success. A self-hosted mail/SMS deployment would be separate infrastructure work. |
| eTIMS configuration | Official tax service / configured endpoint | Retained; actual certification and delivery still need verification. |
| Physical printer discovery/output | Owned local property agent and operating-system printer queues | Existing repair uses local discovery, with no new hosted printer vendor. Hardware UAT still required. |
| Delivery map link | User-opened Google Maps link | Optional navigation link, not an automatic API-key call. |
| Configured card/courier gateways and their connection tests | Property-configured endpoints and credentials | Retained as explicit adapters; endpoint/provider proof remains required. Test simulators do not prove real payment or delivery. |
| PDF brand logos | Stored branding image URLs fetched by the server | Separate review still required for allowed hosts, redirects, size limits and timeout behavior. |
| Staff PIN edge-function import | Build/runtime dependency import from esm.sh | Still present; packaging/vendor review remains open. |
| Staff PIN sign-in relay | Hard-coded horizon-prime-os.lovable.app broker; forwards the PIN and authorised-device token | OPEN release issue. Replace with the owned Supabase edge function or owned server authentication only after deployment/configuration and ordinary-role device/PIN evidence. Removing the current path without that prerequisite would break staff access. |
| Public canonical URL fallback | Old Lovable-hosted public origin in route-visibility.ts | OPEN identity cleanup. Align fallback and deployment environment with the chosen Cloudflare origin and rerun metadata/callback checks. |
| Lovable editor auth bridge | Host/frame restricted preview integration | Does not activate on the selected Cloudflare workers.dev host. Preserve the host restrictions. |

`external-host-source-inventory.json` records literal host references and source paths from application code, server functions and scripts. It is a first-pass source inventory, not proof that every configurable URL or every button has been exercised. Placeholder URLs, schema metadata, package-download endpoints and social links are included so they are not mistaken for paid runtime APIs. No environment secrets are included.

## Release checks and remaining work

Focused local summary/font checks passed: 11 assertions covering actual font binaries, configured-provider opt-in, local summaries, disabled settings, permission denial and failed metric reads. Component visual checks at 360, 768 and 1440 pixels found no horizontal page overflow; checklist ticks persisted, the final step could be reached by scrolling, and the header/footer stayed within the viewport. These synthetic fixtures do not certify a hotel's actual cleaning workflow.

The previous completed maintenance gate passed 3,598 offline assertions, retained all earlier passes, and passed 14 local-print-agent checks plus build/smoke. The UI/install/font/API changes completed their separate whole-source gate, recorded below. Live original-workflow evidence and operational SQL parity remain separate gates.

Dependency advisory review found affected framework, serializer, development-server, source-map and schema-validation packages. Patched versions are now installed: TanStack Start 1.168.60 / server core 1.169.39, Vite 8.3.6, Seroval 1.6.11, source-map-js 1.2.2 and Zod 4.6.7. The application has no direct Zod imports; compatible framework copies are aligned through the lockfile override. The official final production-only check reports zero advisory hits across 363 package names. A wider check still flags eight development-tool packages, recorded in dependency-advisories-after-patches.json. This is not a blanket security/privacy certification, and the completed final regression/build result is recorded below. Advisory metadata is saved separately, without hotel data or keys. Framework advisory: https://github.com/TanStack/router/security/advisories/GHSA-qx66-fv34-fjm8 . Zod advisory: https://github.com/advisories/GHSA-mrhx-c7xc-m3w5 .

None of this closes all original 88 failed outcomes. See `NEO-WAVE-STATUS-2026-11-06.md` for repaired business boundaries and the remaining full guest-stay, sale, inventory/AP/day-close and live regression gates.





## Infrastructure constraint confirmed

The current Supabase database, Auth and Storage stay in place. Self-hosting, a second operational database and data/storage migration are out of scope for this repair. Preserve the existing local PowerShell, GitHub and Wrangler/Cloudflare workflow. The owned PIN endpoint probe returned 404 (function not found); replacing the old relay requires deploying the existing function to this same project before app cutover. No authentication endpoint was switched and no function was deployed by this audit.



## Completed UI/font/local-summary source gate

Final patched-source gate: 3642 passed, 0 failed, 155 skipped; all 3,637 preceding passes retained, including the 3,598 maintenance-baseline passes and all 3631 first-UI-batch passes. Typecheck, isolated device catalogue, 14 local print-agent checks and production build/smoke passed. Built / and /auth documents also passed private/no-store, source-identity and local-font checks. No operational SQL, push or deployment was performed. Live wave exits, original 30 workflow reruns and real-device installation remain unverified.
