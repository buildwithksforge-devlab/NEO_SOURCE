import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const read = (path) => readFileSync(path, "utf8").replaceAll("\r\n", "\n").replace(/[ \t]+$/gm, "");
const extract = (source, name) => {
  const match = source.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$\\s*;`));
  if (!match) throw new Error(`Missing reviewed ${name}`);
  return match[0];
};
const hash = (sql) => createHash("md5").update(sql.split("$function$")[1]
  .replace(/--[^\n]*/g, "").replace(/\s/g, "")).digest("hex");
const replace = (source, from, to) => {
  if (source.split(from).length !== 2) throw new Error(`Expected one repair boundary: ${from}`);
  return source.replace(from, to);
};
function migration(path, name, signature, original, repaired) {
  writeFileSync(path, `-- STAGED ONLY: preserve installed owner/grants; refuse unreviewed definitions.
-- No stock, purchase, payment or document identity is created by installation.
BEGIN;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid=to_regprocedure('public.${signature}') AND r.rolname NOT IN ('anon','authenticated')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('${hash(original)}','${hash(repaired)}')) THEN
 RAISE EXCEPTION '${name} differs from reviewed source; nothing replaced';
 END IF;
END $guard$;
CREATE TEMP TABLE neo_receiving_document_acl ON COMMIT DROP AS
 SELECT proowner,coalesce(proacl::text,'') acl FROM pg_proc WHERE oid='public.${signature}'::regprocedure;
${repaired}
DO $verify$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN neo_receiving_document_acl old
 WHERE p.oid='public.${signature}'::regprocedure AND p.proowner=old.proowner AND coalesce(p.proacl::text,'')=old.acl) THEN
 RAISE EXCEPTION '${name} owner or grants changed';
 END IF;
END $verify$;
COMMIT;
`);
}

const queue = extract(read("supabase/migrations/20261112090000_block_virtual_blind_receiving.sql"), "neo_blind_receiving_approved_queue");
let fixedQueue = replace(queue, "IF NOT public.is_org_admin() THEN",
  "IF NOT coalesce(public.is_org_admin() OR public.has_permission('procurement', 'receiving.manage'), false) THEN");
fixedQueue = replace(fixedQueue, "'count_id', c.id,", "'count_id', c.id,\n                'purchase_order_id', c.purchase_order_id,\n                'branch_id', c.branch_id,");
migration("supabase/migrations/20261116234000_receiving_queue_handoff.sql", "Receiving queue", "neo_blind_receiving_approved_queue()", queue, fixedQueue);

const payload = extract(read("supabase/migrations/20261110173000_scoped_waiter_receipt_printing.sql"), "neo_document_payload");
let fixedPayload = replace(payload,
  "'ordered ' || coalesce(l.quantity_ordered,0)::text,\n                 case when coalesce(l.quantity_rejected,0) > 0 then 'rejected ' || l.quantity_rejected::text end",
  ` 'ordered ' || coalesce(l.quantity_ordered,0)::text,
                 'accepted ' || coalesce(l.quantity_accepted,l.quantity_received)::text,
                 'rejected ' || coalesce(l.quantity_rejected,0)::text,
                 case when nullif(btrim(l.rejection_reason),'') is not null then 'reason: ' || l.rejection_reason end,
                 case when nullif(btrim(l.batch_number),'') is not null then 'batch: ' || l.batch_number end,
                 case when l.expiry_date is not null then 'expiry: ' || l.expiry_date::text end`);
migration("supabase/migrations/20261116234500_grn_inspection_document_details.sql", "Document payload", "neo_document_payload(text,uuid)", payload, fixedPayload);
console.log("Generated guarded receiving queue and GRN inspection document migrations.");
