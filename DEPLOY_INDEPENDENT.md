# Run and publish the edited NEØ source without Lovable

The `horizon-prime-os.lovable.app` domain serves Lovable's prior deployment. Extracting a ZIP, building on a computer, or applying database grants cannot update that URL. Publish this source to a separate host first, test it there, then change the public domain after it works.

## 1. View this exact source on your computer

Extract the source archive so that `package.json` is in the project folder. In PowerShell, from that folder:

```powershell
node --version                       # Node 22 is specified in .nvmrc
npm ci
Copy-Item .env.example .env.local
notepad .env.local
npm run dev -- --host 127.0.0.1
```

Set the following in `.env.local` using the **existing NEØ Supabase project's** API values and server secret. Get them from its owner's project dashboard or a trusted credential manager; do not paste secrets into a chat or commit them:

```text
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<publishable key>
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable key>
SUPABASE_SERVICE_ROLE_KEY=<server-only secret>
VITE_PUBLIC_SITE_URL=http://localhost:3000
PUBLIC_SITE_URL=http://localhost:3000
SITE_URL=http://localhost:3000
```

Open the address Vite prints, normally <http://127.0.0.1:3000>. This shows the edited source on **your own computer**. `localhost` is not an internet URL. If sign-in redirects incorrectly, add the local origin to Supabase Auth's allowed redirect URLs. Keep provider sending and push dispatch disabled during this preview.

## 2. Publish an independent HTTPS preview

This project already builds a Cloudflare Worker in `.output/server` plus static assets in `.output/public`. Create or use **your own Cloudflare account**. Choose a Worker name, for example `neo-preview`, and determine its actual `*.workers.dev` URL from your Cloudflare account before building. In the project folder, set `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and `VITE_PUBLIC_SITE_URL` to the existing project's public API values and the preview URL in `.env.production.local`. Do **not** put `SUPABASE_SERVICE_ROLE_KEY` in any `VITE_` variable.

```powershell
npx wrangler login
npm ci
npm run typecheck
npm run test:offline
npm run build
npx wrangler deploy --config .output/server/wrangler.json --name neo-preview
```

Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PUBLIC_SITE_URL`, and `SITE_URL` as Worker runtime values in the Cloudflare dashboard; set the service-role key as an encrypted **secret**. Set `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and `VITE_PUBLIC_SITE_URL` **before** building because Vite embeds them in the client bundle. If you first deployed without the correct origin, rebuild and deploy again. Leave `NEO_OUTBOUND_ENABLED=false` and `NEO_PUSH_DISPATCH_ENABLED=false` until the separate release gates pass.

Add the new preview origin to the existing Supabase project's Auth allowed redirect URLs. If sign-in, guest checkout or payment callbacks use absolute URLs, update their provider-side allowlists and test against the preview origin without real charges. The existing production domain remains unchanged and is your rollback.

## 3. Verify before telling anyone to use it

On the independent HTTPS URL, confirm `/`, `/auth`, the Zuri guest home, no menu CTA when Zuri has no published menu, and one signed-in page from each staff module. Hard-refresh while signed in, sign out, and check another tenant cannot read the first tenant's data. Verify server logs and real database record transitions. The new push schema is in `supabase/migrations/20260925060000_worker_web_push.sql`; do not replay the full historical migrations against the already-running database. Apply and test that single new migration separately when device push is ready.

The independent deployment cannot be completed from this session: it has no Cloudflare account authorization and no NEØ Supabase deployment credentials. Those values must be configured at the host by someone who owns them. Do not publish a dummy-key build as a functioning application.
