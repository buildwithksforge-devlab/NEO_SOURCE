import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=path=>readFileSync(path,"utf8").replaceAll("\r\n","\n");
const original=read("supabase/migrations/20261116221500_minibar_property_store_guards.sql").match(/CREATE OR REPLACE FUNCTION public\.neo_minibar_post\([\s\S]*?\$function\$;/)?.[0];
const wrapper=read("supabase/repair/2026-11-18/minibar-post-once.sql").match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/)?.[0];
if(!original||!wrapper)throw new Error("Reviewed minibar dependencies missing");
const anchor="  IF v_folio.status IS DISTINCT FROM 'open' THEN";
if(original.split(anchor).length!==2)throw new Error("Minibar attempt boundary differs");
let repaired=original.replace(anchor,`  IF nullif(current_setting('neo.minibar_attempt',true),'') IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.minibar_posting_attempts a WHERE a.organization_id=v_folio.organization_id
      AND a.attempt_id=nullif(current_setting('neo.minibar_attempt',true),'')::uuid AND a.submitted_by=auth.uid()
      AND a.result IS NULL AND a.folio_id=_folio AND a.location_id=_location AND a.room_id=_room
      AND a.request->'lines' IS NOT DISTINCT FROM _lines AND a.request->>'notes' IS NOT DISTINCT FROM _notes
  ) THEN RETURN jsonb_build_object('ok',false,'reason','attempt_required'); END IF;
${anchor}`);
const numbering=/  SELECT 'MB-'[\s\S]*?WHERE organization_id = v_folio\.organization_id;/;
if(!numbering.test(repaired))throw new Error("Minibar numbering boundary differs");
repaired=repaired.replace(numbering,"  SELECT public.next_document_number('minibar_posting','MB',v_folio.branch_id,v_folio.organization_id) INTO v_number;");
const hash=sql=>createHash("md5").update(sql.split("$function$")[1].replace(/--[^\n]*/g,"").replace(/\s/g,"")).digest("hex");
const baseline=read("supabase/migrations/20260924153000_front_office_connected_guards.sql").match(/CREATE OR REPLACE FUNCTION public\.neo_minibar_post\([\s\S]*?\$function\$;/)?.[0];
if(!baseline)throw Error("Reviewed baseline minibar source missing");
const liveVariant=baseline.replace("public.neo_item_group_store(v_folio.organization_id, v_comp.item_id, v_folio.branch_id)","public.neo_stock_resolve_location(v_folio.organization_id, v_comp.item_id, v_folio.branch_id, NULL)")
 .replace(/^\s*PERFORM set_config\('neo\.system_posting', '(?:on|off)', true\);\s*$/gm,"");
if(hash(liveVariant)!=="02e573b16d42f6eadb1a8fbc3ee9c80a")throw Error("Live minibar source reconstruction differs; stop before generating");
const accepted=[hash(baseline),hash(liveVariant),hash(original),hash(repaired)].map(value=>`'${value}'`).join(",");
writeFileSync("supabase/migrations/20261118110000_minibar_durable_attempts.sql",`-- STAGED ONLY. Coordinated client/server release: new requests use neo_minibar_post_once.
-- Old posting signature refuses direct unkeyed requests; grants/owner are retained.
-- Installation performs no stock movement, folio charge or historical rewrite.
BEGIN;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=to_regprocedure('public.neo_minibar_post(uuid,uuid,jsonb,uuid,text)')
 AND r.rolname NOT IN ('anon','authenticated') AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN (${accepted})) THEN
 RAISE EXCEPTION 'Minibar engine differs from reviewed attempt source; nothing replaced'; END IF;
 IF to_regprocedure('public.next_document_number(text,text,uuid,uuid)') IS NULL THEN RAISE EXCEPTION 'Organization-scoped durable document numbering is missing'; END IF;
 IF to_regprocedure('public.neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid)') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_proc p
 WHERE p.oid=to_regprocedure('public.neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid)')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='${hash(wrapper)}') THEN
 RAISE EXCEPTION 'Minibar attempt wrapper differs from reviewed source'; END IF;
END $guard$;
DO $table_guard$ DECLARE columns_signature text[]; BEGIN
 IF to_regclass('public.minibar_posting_attempts') IS NOT NULL AND coalesce(obj_description(to_regclass('public.minibar_posting_attempts')),'')<>'neo.minibar.durable-attempts.v1' THEN
 RAISE EXCEPTION 'Unexpected preexisting minibar request table; reconcile before installation'; END IF;
 IF to_regclass('public.minibar_posting_attempts') IS NOT NULL THEN
  SELECT array_agg(a.attname::text||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text ORDER BY a.attnum)
   INTO columns_signature FROM pg_attribute a WHERE a.attrelid=to_regclass('public.minibar_posting_attempts') AND a.attnum>0 AND NOT a.attisdropped;
  IF columns_signature IS DISTINCT FROM ARRAY['organization_id:uuid:true','attempt_id:uuid:true','submitted_by:uuid:true','folio_id:uuid:true','location_id:uuid:true','room_id:uuid:true','request:jsonb:true','result:jsonb:false','created_at:timestamp with time zone:true']
   OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.minibar_posting_attempts') AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (organization_id, attempt_id)')
   OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.minibar_posting_attempts'))
   OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.minibar_posting_attempts') AND NOT tgisinternal) THEN
   RAISE EXCEPTION 'Minibar request table differs from reviewed schema';
  END IF;
 END IF;
END $table_guard$;
CREATE TEMP TABLE neo_minibar_attempt_acl ON COMMIT DROP AS SELECT proowner,coalesce(proacl::text,'') acl FROM pg_proc WHERE oid='public.neo_minibar_post(uuid,uuid,jsonb,uuid,text)'::regprocedure;
CREATE TABLE IF NOT EXISTS public.minibar_posting_attempts(
 organization_id uuid NOT NULL,attempt_id uuid NOT NULL,submitted_by uuid NOT NULL,folio_id uuid NOT NULL,
 location_id uuid NOT NULL,room_id uuid NOT NULL,request jsonb NOT NULL,result jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,attempt_id)
);
COMMENT ON TABLE public.minibar_posting_attempts IS 'neo.minibar.durable-attempts.v1';
ALTER TABLE public.minibar_posting_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.minibar_posting_attempts FROM PUBLIC,anon,authenticated;
${repaired}
${wrapper}
DO $owner$ DECLARE engine_owner text; BEGIN
 SELECT r.rolname INTO engine_owner FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.neo_minibar_post(uuid,uuid,jsonb,uuid,text)'::regprocedure;
 EXECUTE format('ALTER TABLE public.minibar_posting_attempts OWNER TO %I',engine_owner);
 EXECUTE format('ALTER FUNCTION public.neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid) OWNER TO %I',engine_owner);
END $owner$;
REVOKE ALL ON FUNCTION public.neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_minibar_post_once(uuid,uuid,jsonb,uuid,text,uuid) TO authenticated;
DO $verify$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN neo_minibar_attempt_acl old WHERE p.oid='public.neo_minibar_post(uuid,uuid,jsonb,uuid,text)'::regprocedure
 AND p.proowner=old.proowner AND coalesce(p.proacl::text,'')=old.acl) THEN RAISE EXCEPTION 'Minibar engine owner or grants changed'; END IF;
END $verify$;
NOTIFY pgrst,'reload schema';
COMMIT;
`);
console.log("Generated guarded minibar attempts, room association and explicit-store repair.");
