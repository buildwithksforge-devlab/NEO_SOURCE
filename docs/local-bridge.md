# NEØ local bridge

Lets a separately hosted copy of NEØ (your local machine or the Cloudflare
Worker) use **M-Pesa, Staff PIN sign-in and printer computers** without the
managed server key. The copy forwards those calls to the live Lovable app,
which runs the same code with its own server access.

## What each side needs (server-only settings — never `VITE_`)

| Where | Setting | Value |
|---|---|---|
| Live Lovable app | `NEO_BRIDGE_SECRET` | the shared password (already saved) |
| Local / Cloudflare copy | `NEO_BRIDGE_SECRET` | the same shared password, 32+ characters |
| Local / Cloudflare copy | `NEO_BRIDGE_ORIGIN` | `https://horizon-prime-os.lovable.app` |

Local dev: put both lines in `.dev.vars` (Wrangler) or export them in the shell
that runs `vite dev`. Do not commit them.

Cloudflare Worker:

```sh
npx wrangler secret put NEO_BRIDGE_SECRET
npx wrangler secret put NEO_BRIDGE_ORIGIN   # https://horizon-prime-os.lovable.app
```

Leave `NEO_BRIDGE_ORIGIN` **unset** on the live Lovable app; that is what makes
it the side that does the work.

## What travels and what is checked

| Area | Local path (unchanged for the browser / printer program) | Live bridge path | Who acts |
|---|---|---|---|
| M-Pesa | the existing M-Pesa server functions | `POST /api/public/bridge/mpesa/<function>` | the signed-in staff member (their sign-in token is passed through and checked) |
| Staff PIN | `POST /api/public/staff-pin-login` | `POST /api/public/bridge/staff-pin-login` | the device token + PIN |
| Printing | `POST /api/public/print-agent/<action>` | `POST /api/public/bridge/print-agent/<action>` | the printer computer's token |

- Every bridge call needs the `X-Neo-Bridge-Key` header **and** the caller's own
  credential. The password alone never signs anyone in or prints anything.
- Only those headers are forwarded; cookies and browser origin are not.
- A call that already came through a bridge is never forwarded again.
- M-Pesa callbacks always go to the live app, because the bridged functions run
  there.
- M-Pesa functions available through the bridge: getMpesaSettings,
  saveMpesaSettings, testMpesaConnection, chargeWithMpesa,
  reconcileMpesaTransaction, chargeDeliveryWithMpesa, chargeGuestFolioWithMpesa,
  chargeGuestDepositWithMpesa. The Integrations page "Daraja" health check is
  not bridged; use Test connection on the M-Pesa settings page.

## Responses you may see

- `503 bridge_not_configured` — the live app has no shared password.
- `401 bridge_unauthorized` — the passwords differ.
- `502 bridge_unavailable` — the live app could not be reached.

The bridge only works once the live app has been **published** with its bridge endpoints. This local release contains the forwarding side; the live app must serve those endpoints separately.
