# NEØ — START HERE ON WINDOWS

Follow this order. Do not skip ahead to production DNS or production database changes.

## Step 0 — keep the current system alive

Do not unpublish the existing Lovable deployment. It is your rollback while the independent deployment is being proven.

## Step 1 — extract this repository to a clean folder

Example:

```text
C:\NEO\neo-production
```

Open **PowerShell** in that folder.

## Step 2 — prove the local toolchain

```powershell
node -v
npm -v
```

Use Node 22. The repository includes `.nvmrc` with `22`.

If `node` is not installed or is a different major version, fix Node first. Do not alter NEØ code to compensate for a machine setup problem.

## Step 3 — install exactly from the committed npm lockfile

```powershell
npm ci
```

Expected result: installation completes without changing application source files.

If installation fails because of DNS, registry, proxy, firewall or a temporary network error, fix the network/package-manager issue first. Do not start rewriting imports or dependencies based on a registry failure.

## Step 4 — create a LOCAL/STAGING environment file

```powershell
Copy-Item .env.example .env.local
notepad .env.local
```

Fill in a **staging/non-production Supabase project** first.

Required for the normal application:

```text
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SERVICE_ROLE_KEY=
VITE_PUBLIC_SITE_URL=http://localhost:3000
PUBLIC_SITE_URL=http://localhost:3000
SITE_URL=http://localhost:3000
```

Rules:

- Never rename `SUPABASE_SERVICE_ROLE_KEY` to a `VITE_*` variable.
- Do not commit `.env.local`.
- Do not use the live production service-role key for ordinary laptop testing.
- Leave optional provider keys blank until that provider is intentionally being tested.

## Step 5 — boot NEØ locally

```powershell
npm run dev
```

Open the localhost address printed by Vite (normally port 3000 in this project environment).

First checks, in this order:

1. `/` renders.
2. `/auth` renders.
3. Sign in with a staging owner/admin account.
4. `/workspace` loads.
5. Hard-refresh the page while signed in.
6. Sign out and sign back in.
7. Open one read-only page from Front Office, POS, Kitchen, Inventory, Procurement, Finance, HR, Housekeeping, Delivery and Admin.

**STOP** if you get an auth loop, cross-workspace data, a 500, or missing staging schema. Capture the exact error before changing code.

## Step 6 — run the local code gate

Stop the dev server, then run:

```powershell
npm run verify
```

That runs TypeScript, the offline automated suite and a real production build/server smoke.

Then run the secret boundary scan using a harmless sentinel:

```powershell
$env:SUPABASE_SERVICE_ROLE_KEY="NEO_SECRET_LEAK_SENTINEL_LOCAL_ONLY"
npm run build
$env:NEO_SECRET_LEAK_SENTINEL="NEO_SECRET_LEAK_SENTINEL_LOCAL_ONLY"
npm run secret-scan
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
Remove-Item Env:NEO_SECRET_LEAK_SENTINEL
```

Expected result: the sentinel is **not** present in the public client build.

## Step 7 — initialise Git and push to a PRIVATE GitHub repository

Only after Steps 1–6 pass:

```powershell
git init
git add .
git status
git commit -m "Prepare NEØ production handoff"
git branch -M main
git remote add origin <YOUR_PRIVATE_GITHUB_REPOSITORY_URL>
git push -u origin main
```

Before the commit, `git status` must **not** show `.env.local`, `.env`, `.dev.vars`, keys or credentials.

GitHub will run `.github/workflows/production-gate.yml` automatically on `main` and pull requests.

## Step 8 — do NOT push the production database yet

The repository contains 977 Supabase migrations. The target database already has its own migration history, so compare histories first.

```powershell
supabase login
supabase link --project-ref <TARGET_PROJECT_REF>
supabase migration list
supabase db push --dry-run
```

Do not run the real `supabase db push` until:

- the target project is confirmed,
- the dry-run has been reviewed,
- a recoverable backup/PITR position is confirmed,
- and the pending migrations are understood.

Never use `--include-seed` for production.

## Step 9 — live environment certification

The repository includes a separate manually-triggered GitHub workflow:

```text
.github/workflows/live-environment-gate.yml
```

Configure a protected GitHub Environment named `production-readiness` with a **read-only** PostgreSQL user and the Supabase public API values. Run this gate before cutover.

## Step 10 — only then configure the final host

Do not change the TanStack deployment adapter blindly. The final adapter/configuration depends on whether the production target is Cloudflare, Vercel, Railway, Render, a Node/Bun server, etc.

When the localhost and GitHub gates are green, choose the host. Then make the host-specific deployment change in a small, isolated commit and repeat the same build/smoke checks.

## Step 11 — final-domain cutover values

At the final host set:

```text
VITE_PUBLIC_SITE_URL=https://YOUR_FINAL_DOMAIN
PUBLIC_SITE_URL=https://YOUR_FINAL_DOMAIN
SITE_URL=https://YOUR_FINAL_DOMAIN
```

Then update Supabase Auth Site URL/redirect URLs, publish the repository auth email template, and only then repoint live M-Pesa/payment/delivery callbacks.

Add the final absolute sitemap line back to `public/robots.txt` once the domain is known:

```text
Sitemap: https://YOUR_FINAL_DOMAIN/sitemap.xml
```

## Step 12 — production acceptance

Use `PRODUCTION_HANDOFF.md` for the complete release gate. Do not retire the old deployment until the new public hostname passes the full hospitality lifecycle checks and Finance reconciliation.
