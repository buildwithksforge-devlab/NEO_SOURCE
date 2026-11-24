import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=path=>readFileSync(path,"utf8").replaceAll("\r\n","\n");
const original=read("supabase/migrations/20260914005249_756324e7-13ed-4ec4-96d5-26b6bec207c5.sql").match(/CREATE OR REPLACE FUNCTION public\.pms_check_out\([\s\S]*?\$function\$;/)?.[0];
const block=read("supabase/migrations/20261116210000_pms_checkout_canonical_balance.sql").match(/v_replacement text := \$replacement\$([\s\S]*?)\$replacement\$/)?.[1];
if(!original||!block)throw new Error("Reviewed checkout dependencies missing");
const canonical=original.replace("_outstanding := round(_charges-_paid-_line_paid,2);",block);
const repaired=read("supabase/repair/2026-11-18/pms-checkout-multi-folio.sql").match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/)?.[0];
if(!repaired)throw new Error("Multi-folio checkout source missing");
const hash=sql=>createHash("md5").update(sql.split("$function$")[1].replace(/--[^\n]*/g,"").replace(/\s/g,"")).digest("hex");
writeFileSync("supabase/migrations/20261118100000_pms_multi_folio_checkout.sql",`-- STAGED ONLY: reconcile each stay folio separately and retain per-folio settlement evidence.
-- Installation changes no guest, payment, charge, room or journal row.
BEGIN;
DO $guard$ BEGIN
 IF to_regprocedure('public.neo_folio_financial_components(uuid,uuid)') IS NULL THEN RAISE EXCEPTION 'Canonical Finance calculation is missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid=to_regprocedure('public.pms_check_out(uuid,boolean,text)') AND r.rolname NOT IN ('anon','authenticated')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN (${[original,canonical,repaired].map(s=>`'${hash(s)}'`).join(",")})) THEN
 RAISE EXCEPTION 'Checkout differs from reviewed source; nothing replaced'; END IF;
END $guard$;
CREATE TEMP TABLE neo_multifolio_checkout_acl ON COMMIT DROP AS SELECT proowner,coalesce(proacl::text,'') acl
 FROM pg_proc WHERE oid='public.pms_check_out(uuid,boolean,text)'::regprocedure;
${repaired}
DO $verify$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN neo_multifolio_checkout_acl old
 WHERE p.oid='public.pms_check_out(uuid,boolean,text)'::regprocedure AND p.proowner=old.proowner AND coalesce(p.proacl::text,'')=old.acl) THEN
 RAISE EXCEPTION 'Checkout owner or grants changed'; END IF;
END $verify$;
COMMIT;
`);
console.log("Generated guarded per-folio checkout migration.");
