import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const source = readFileSync(
  "supabase/migrations/20261115020000_supplier_matching_quantity_parity.sql",
  "utf8",
).replaceAll("\r\n", "\n").replace(/[ \t]+$/gm, "");
const original = source.match(
  /CREATE OR REPLACE FUNCTION public\.proc_three_way_match\([\s\S]*?\$function\$\s*;/,
)?.[0];
if (!original) throw new Error("Reviewed supplier matcher missing");
const marker = "    IF po.status IN ('cancelled','voided') THEN";
if (!original.includes(marker)) throw new Error("Reviewed purchase-order status boundary missing");
const repaired = original.replace(
  marker,
  `    -- An override reason may resolve a matching variance, never authorize a draft purchase.
    IF po.status IS NULL OR po.status NOT IN (
      'approved','pending-delivery','sent','partially-received','partially_received',
      'received','fully-received','fully_received','completed','closed',
      'partially-invoiced','partially_invoiced','invoiced','fully-invoiced','paid') THEN
      RAISE EXCEPTION 'Purchase order must be approved before its supplier invoice can be matched or accepted (current status: %)', coalesce(po.status,'missing') USING ERRCODE='23514';
    END IF;
${marker}`,
);
const hash = (sql) =>
  createHash("md5")
    .update(
      sql
        .split("$function$")[1]
        .replace(/--[^\n]*/g, "")
        .replace(/\s/g, ""),
    )
    .digest("hex");
writeFileSync(
  "supabase/migrations/20261116231500_supplier_purchase_approval_guard.sql",
  `-- STAGED ONLY: require an approved purchase lifecycle for future order-linked invoice matching.
-- No invoice, payable, stock or historical accounting row is changed by installation.
BEGIN;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
   WHERE p.oid=to_regprocedure('public.proc_three_way_match(uuid)') AND r.rolname NOT IN ('anon','authenticated')
   AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('${hash(original)}','${hash(repaired)}')) THEN
   RAISE EXCEPTION 'Supplier matcher differs from reviewed source; nothing replaced';
 END IF;
END $guard$;
CREATE TEMP TABLE neo_supplier_order_guard_acl ON COMMIT DROP AS SELECT proowner,coalesce(proacl::text,'') AS acl
 FROM pg_proc WHERE oid='public.proc_three_way_match(uuid)'::regprocedure;
${repaired}
DO $verify$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN neo_supplier_order_guard_acl old
   WHERE p.oid='public.proc_three_way_match(uuid)'::regprocedure AND p.proowner=old.proowner AND coalesce(p.proacl::text,'')=old.acl) THEN
   RAISE EXCEPTION 'Supplier matcher owner or grants changed';
 END IF;
END $verify$;
COMMIT;
`,
);
console.log("Generated staged purchase approval guard with installed-body and ACL checks.");
