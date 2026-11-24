import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=p=>readFileSync(p,"utf8").replaceAll("\r\n","\n");
const original=read("supabase/migrations/20260831045823_d8993219-835b-4244-8912-765e9b835a92.sql").match(/CREATE OR REPLACE FUNCTION public\.pos_post_room_charge\([\s\S]*?\$function\$;/)?.[0];
const template=read("supabase/repair/2026-11-19/pos-room-transfer.sql");
const functions=[...template.matchAll(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/g)].map(m=>m[0]);
if(!original||functions.length!==3)throw Error("Reviewed POS room transfer source missing");
const hash=sql=>createHash("md5").update(sql.split("$function$")[1].replace(/--[^\n]*/g,"").replace(/\s/g,"")).digest("hex");
const liveVariant=original.replaceAll("COALESCE(","coalesce(")
 .replace("  SELECT * INTO _folio FROM public.folios",`  IF coalesce(_order.paid_total, 0) > 0 THEN
    RAISE EXCEPTION 'This bill has a recorded POS payment. Settle the remainder separately before charging it to a room';
  END IF;
  SELECT * INTO _folio FROM public.folios`)
 .replace("  UPDATE public.pos_orders\n     SET folio_post_status",`  IF _order.status <> 'awaiting-payment' THEN
    UPDATE public.pos_orders SET status = 'awaiting-payment' WHERE id = _order_id;
  END IF;
  UPDATE public.pos_orders
     SET folio_post_status`);
if(hash(liveVariant)!=="6814f5ea174aa4cb5a54300b6e66c099")throw Error("Returned installed POS definition is not reproduced; stop before adding it to the guard");
writeFileSync("supabase/repair/2026-11-19/pos-room-transfer-reviewed-installed.sql",`-- Returned live definition, 19 November; normalized body hash independently reproduced.
-- Retains the installed cached-part-payment refusal and legal awaiting-payment transition.
${liveVariant}\n`);
writeFileSync("supabase/migrations/20261119140000_pos_room_transfer_money_integrity.sql",`-- STAGED ONLY: inspect live definitions before coordinated rollout.
-- No balance, receipt, charge, stock or historical row is changed at installation.
BEGIN;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=to_regprocedure('public.pos_post_room_charge(uuid,uuid,text)')
  AND r.rolname NOT IN ('anon','authenticated') AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('${hash(original)}','${hash(liveVariant)}','${hash(functions[0])}')) THEN
  RAISE EXCEPTION 'Room-transfer definition differs from reviewed source; nothing replaced'; END IF;
 ${functions.slice(1).map(fn=>{
 const name=fn.match(/FUNCTION public\.([^\(]+)/)[1];return `IF to_regprocedure('public.${name}()') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_proc p
  WHERE p.oid=to_regprocedure('public.${name}()')
  AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='${hash(fn)}') THEN
  RAISE EXCEPTION 'Room-transfer guard name ${name} is used by unknown code'; END IF;`;
 }).join("\n")}
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.cash_payment_requests') AND tgname='neo_cash_room_transfer_guard'
  AND (tgfoid IS DISTINCT FROM to_regprocedure('public.neo_cash_guard_room_transferred_order()') OR tgtype<>23 OR tgenabled NOT IN ('O','A'))) THEN
  RAISE EXCEPTION 'Unexpected room-transfer cash trigger; inspect before installation'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.pos_payments') AND tgname='neo_pos_room_transfer_receipt_guard'
  AND (tgfoid IS DISTINCT FROM to_regprocedure('public.neo_pos_guard_room_transferred_receipt()') OR tgtype<>23 OR tgenabled NOT IN ('O','A'))) THEN
  RAISE EXCEPTION 'Unexpected room-transfer receipt trigger; inspect before installation'; END IF;
END $guard$;
CREATE TEMP TABLE neo_room_transfer_acl ON COMMIT DROP AS SELECT proowner,coalesce(proacl::text,'') acl FROM pg_proc WHERE oid='public.pos_post_room_charge(uuid,uuid,text)'::regprocedure;
${functions.join("\n")}
REVOKE ALL ON FUNCTION public.neo_cash_guard_room_transferred_order() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.neo_pos_guard_room_transferred_receipt() FROM PUBLIC,anon,authenticated;
DO $owner$ DECLARE trusted_owner text; BEGIN
 SELECT r.rolname INTO trusted_owner FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.pos_post_room_charge(uuid,uuid,text)'::regprocedure;
 EXECUTE format('ALTER FUNCTION public.neo_cash_guard_room_transferred_order() OWNER TO %I',trusted_owner);
 EXECUTE format('ALTER FUNCTION public.neo_pos_guard_room_transferred_receipt() OWNER TO %I',trusted_owner);
END $owner$;
DROP TRIGGER IF EXISTS neo_cash_room_transfer_guard ON public.cash_payment_requests;
CREATE TRIGGER neo_cash_room_transfer_guard BEFORE INSERT OR UPDATE ON public.cash_payment_requests FOR EACH ROW EXECUTE FUNCTION public.neo_cash_guard_room_transferred_order();
DROP TRIGGER IF EXISTS neo_pos_room_transfer_receipt_guard ON public.pos_payments;
CREATE TRIGGER neo_pos_room_transfer_receipt_guard BEFORE INSERT OR UPDATE ON public.pos_payments FOR EACH ROW EXECUTE FUNCTION public.neo_pos_guard_room_transferred_receipt();
DO $verify$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN neo_room_transfer_acl old WHERE p.oid='public.pos_post_room_charge(uuid,uuid,text)'::regprocedure
  AND p.proowner=old.proowner AND coalesce(p.proacl::text,'')=old.acl) THEN RAISE EXCEPTION 'Room-transfer owner or grants changed'; END IF;
END $verify$;
COMMIT;
`);
console.log("Generated guarded unpaid POS room-transfer and routed-cash protection.");
