# NEØ production handoff

This repository is the application source. Moving it to GitHub or localhost must not change business behavior. Treat code, database migrations, runtime secrets, and external-provider callbacks as four separate deployment concerns.

## 1. Freeze and protect the current working system

- Keep the current Lovable deployment available until the new deployment passes the production gate.
- Take/verify a recoverable Supabase backup before applying any production migration.
- Do not rewrite published Git history on a Lovable-connected branch.
- Never commit `.env`, `.env.local`, `.dev.vars`, service-role keys, provider tokens, or database passwords.

## 2. Local application setup

Use Node 22 (see `.nvmrc`). Install dependencies from the committed lockfile:

```bash
npm ci
```

Create local configuration:

```bash
cp .env.example .env.local
```

Populate the Supabase URL/keys **for a staging/non-production Supabase project first**. The service-role key is server-only and must never use a `VITE_` prefix. Do not point a developer laptop at the live production service-role key for normal local testing.

Start NEØ:

```bash
npm run dev
```

For an initial smoke test, verify `/`, `/auth`, sign-in, `/workspace`, and one read-only page from each major module before creating or changing records.

## 3. Verify the exported application before deployment

```bash
npm run typecheck
npm run test:offline
npm run smoke
```

For the release pipeline, build with a synthetic server-secret sentinel and scan the public bundle:

```bash
SUPABASE_SERVICE_ROLE_KEY=NEO_SECRET_LEAK_SENTINEL npm run build
NEO_SECRET_LEAK_SENTINEL=NEO_SECRET_LEAK_SENTINEL npm run secret-scan
```

`npm run test:offline` runs the full local suite except the deliberately live-only security certification. Run `npm run test:live-security` only from a trusted environment with a read-only PostgreSQL connection plus Supabase public API variables.

`npm run smoke` performs a real production build, scans emitted bundles for the known ESM/CommonJS runtime crash shape, loads the built server, and renders `/` and `/auth`.

## 4. Database migration safety

The repository contains the migration history. Do not blindly replay migrations into the existing production database.

Link the CLI to the intended Supabase project and compare history first:

```bash
supabase login
supabase link --project-ref <project-ref>
supabase migration list
supabase db push --dry-run
```

Only after the remote/local history is understood and a backup is confirmed should pending migrations be applied:

```bash
supabase db push
```

Never use `--include-seed` against production.

## 5. Production environment

Required core variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (secret, server only)
- `VITE_PUBLIC_SITE_URL` (public HTTPS origin)
- `PUBLIC_SITE_URL` (same public HTTPS origin for callbacks)
- `SITE_URL` (same public HTTPS origin unless the host requires otherwise)

Optional provider variables are listed in `.env.example` and should only be added for providers actually enabled. Generic card/QR/courier connector secrets must use the `NEO_CONNECTOR_*` namespace; tenant configuration is intentionally prevented from resolving arbitrary host environment variables.

## 6. External callbacks

Do not switch live M-Pesa/payment/delivery callbacks to localhost or a preview hostname. Their production callback base must be the final public HTTPS origin. NEØ already rejects temporary callback hosts for live M-Pesa enablement.

## 7. Release gate after deployment

Through the final public hostname, verify at minimum:

- `/` and `/auth` render without 5xx responses.
- Staff sign-in, hard refresh, sign-out, and session expiry behave correctly.
- A user cannot access another workspace/property's data.
- Reservation → check-in → folio → payment → checkout posts correctly.
- POS → KDS → payment/reconciliation → Finance posts correctly.
- Procurement → GRN → supplier invoice → payable/journal posts correctly.
- Delivery lifecycle and proof-of-delivery work for the enabled provider mode.
- Guest app/cart/checkout/payment paths work for the enabled payment modes.
- Finance registers agree with the source documents and journals.
- Public sitemap/canonical URLs use the new production domain, never the Lovable preview hostname.
- A controlled server error is visible in production logs without leaking secrets.
- Rollback to the previous application release has been rehearsed separately from database rollback.

## 8. Known product boundaries from the current codebase audit

The core hospitality workflows are extensively covered by the repository's automated tests and prior certification. External hardware/integration capability is not identical to core application functionality: browser/PDF printing works, while direct USB/LAN/Bluetooth printer discovery/routing and a generic third-party partner API are not implemented in the current codebase. Treat those as later product work, not deployment blockers for the existing NEØ application.
