import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
const root="supabase/repair/2026-11-19";mkdirSync(root,{recursive:true});
const strip=path=>{
 const text=readFileSync(path,"utf8").replaceAll("\r\n","\n");
 const begin=text.indexOf("BEGIN;"),end=text.lastIndexOf("COMMIT;");
 if(begin<0||end<begin)throw Error(`Expected reviewed migration transaction: ${path}`);
 return text.slice(begin+6,end);
};
const output=`-- Shared checkout + durable minibar rollout for EVERY organisation.
-- Installs code and private retry storage only. No stock, guest, payment,
-- room-state, store mapping or historical business record is created/changed.
-- User-supplied installed body hashes checked by each migration guard.
BEGIN;
DO $prerequisites$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.stock_locations')
   AND attname='location_type' AND NOT attisdropped) THEN
  RAISE EXCEPTION 'Store location_type column is missing; installation rolled back';
 END IF;
 IF to_regprocedure('public.neo_recipe_sheet_save(jsonb,jsonb,uuid)') IS NULL THEN
  RAISE EXCEPTION 'Installed shared recipe contract is missing; reconcile project before rollout';
 END IF;
END $prerequisites$;
${strip("supabase/migrations/20261118100000_pms_multi_folio_checkout.sql")}
${strip("supabase/migrations/20261118110000_minibar_durable_attempts.sql")}
NOTIFY pgrst,'reload schema';
COMMIT;
SELECT jsonb_build_object(
 'checkout_body_hash',(SELECT md5(regexp_replace(regexp_replace(prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) FROM pg_proc WHERE oid=to_regprocedure('public.pms_check_out(uuid,boolean,text)')),
 'minibar_retry_function',to_regprocedure('public.neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid)')::text,
 'retry_table',to_regclass('public.minibar_posting_attempts')::text,
 'staff_minibar',has_function_privilege('authenticated','public.neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid)','EXECUTE'),
 'anonymous_minibar',has_function_privilege('anon','public.neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid)','EXECUTE')
) AS shared_rollout_result;
`;
writeFileSync(`${root}/INSTALL-SHARED-CHECKOUT-MINIBAR.sql`,output);
console.log(`Prepared ${root}/INSTALL-SHARED-CHECKOUT-MINIBAR.sql; no live database modified.`);
