import {readFileSync,writeFileSync} from "node:fs";
const source=readFileSync("supabase/migrations/20261114013000_shared_workspace_workflows.sql","utf8");
const header=source.slice(0,source.indexOf("END $guard$;"));
const expected=[...header.matchAll(/\('(public\.[^']+)','([a-f0-9]{32})','([a-f0-9]{32})'\)/g)];
if(expected.length!==23)throw Error("Shared workflow source changed; review the inspection generator");
const later=new Map();
// Canonical pg_get_functiondef hash verified by the local PostgreSQL checker
// against the explicit 16 Nov M-Pesa receipt-review payment definition.
later.set("public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid)",new Set(["915008ca2eb86bd57147bb54230b7817"]));
for(const file of ["20261115013000_finance_checkout_ledger_parity.sql","20261115020000_supplier_matching_quantity_parity.sql"]){
 const text=readFileSync(`supabase/migrations/${file}`,"utf8");
 for(const match of text.matchAll(/\$([a-z_]+)\$(\[[\s\S]*?\])\$\1\$/g)){
  let records;try{records=JSON.parse(match[2]);}catch{continue;}
  for(const record of records){const hash=record.definition_hash??record.hash;
   if(record.sig&&/^[a-f0-9]{32}$/.test(hash??"")){
    if(!later.has(record.sig))later.set(record.sig,new Set());later.get(record.sig).add(hash);
   }
  }
 }
}
const rows=expected.map(([,signature,original,shared])=>`('${signature}','${original}','${shared}','${JSON.stringify([...(later.get(signature)??[])])}'::jsonb)`).join(",\n");
const sql=`-- READ ONLY, all organisations in this managed database. No balance, policy,
-- configuration or business-record changes. Run in the original Lovable SQL editor.
WITH expected(signature,earlier_hash,shared_hash,later_hashes) AS (VALUES
${rows}
), installed AS (
 SELECT expected.*,p.oid,p.prosecdef,p.proowner,
   CASE WHEN p.oid IS NOT NULL THEN pg_get_functiondef(p.oid) END AS definition
 FROM expected LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)
)
SELECT jsonb_build_object(
 'shared_workflow_checks',(SELECT jsonb_agg(jsonb_build_object(
   'signature',signature,'installed',oid IS NOT NULL,
   'body_hash',md5(definition),
   'review_status',CASE WHEN oid IS NULL THEN 'missing'
     WHEN md5(definition)=shared_hash THEN 'known_shared_definition'
     WHEN later_hashes ? md5(definition) THEN 'known_reviewed_followup_definition'
     WHEN md5(definition)=earlier_hash THEN 'earlier_definition_review_required'
     ELSE 'different_or_newer_definition_review_required' END,
   'contains_known_tenant_gate',coalesce(definition ~* '(aa17d427-f816-49bc-b02e-1a89e44806a2|c10e5d20-dc04-4959-9db4-4c2afb9d2f8c)',false)
 )) FROM installed),
 'other_workflow_routines',(
   SELECT jsonb_agg(jsonb_build_object('name',wanted.name,'signatures',coalesce((
     SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,
       'body_hash',md5(pg_get_functiondef(p.oid)),
       'authenticated_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'),
       'anonymous_execute',has_function_privilege('anon',p.oid,'EXECUTE')))
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=wanted.name),'[]'::jsonb)))
   FROM (VALUES ('neo_recipe_sheet_save'),('neo_recipe_activate'),('pms_check_out'),
     ('neo_minibar_post_once'),('neo_blind_receiving_decide'),
     ('neo_blind_receiving_approved_queue'),('neo_document_payload'),
     ('neo_station_consumption_location')) wanted(name)
 ),
 'organisation_mapping_checks',(
   SELECT coalesce(jsonb_agg(to_jsonb(report)),'[]'::jsonb) FROM (
     SELECT org.id AS organization_id,org.name AS organization_name,
       (SELECT count(*) FROM public.recipes r WHERE r.organization_id=org.id AND r.status='active') AS active_recipes,
       (SELECT count(*) FROM public.recipes r LEFT JOIN public.stock_items s ON s.id=r.output_stock_item_id
        WHERE r.organization_id=org.id AND r.status='active' AND r.recipe_type='direct_sale'
          AND (s.id IS NULL OR s.organization_id IS DISTINCT FROM r.organization_id
            OR (s.branch_id IS NOT NULL AND s.branch_id IS DISTINCT FROM r.branch_id))) AS invalid_active_direct_sale_outputs,
       (SELECT count(*) FROM public.menu_items m LEFT JOIN public.stock_items s ON s.id=m.stock_item_id
        WHERE m.organization_id=org.id AND m.consumption_mode='direct_stock'
          AND (s.id IS NULL OR s.organization_id IS DISTINCT FROM m.organization_id
            OR (s.branch_id IS NOT NULL AND s.branch_id IS DISTINCT FROM m.branch_id))) AS invalid_direct_stock_menu_ownership,
       (SELECT count(*) FROM public.operational_stations station WHERE station.organization_id=org.id AND station.active
          AND NOT EXISTS(SELECT 1 FROM public.station_consumption_stores mapping
            JOIN public.stock_locations location ON location.id=mapping.location_id
            WHERE mapping.station_id=station.id AND mapping.organization_id=station.organization_id
              AND mapping.branch_id IS NOT DISTINCT FROM station.branch_id
              AND location.organization_id=station.organization_id AND location.active
              AND NOT coalesce(location.is_main,false)
              AND location.branch_id IS NOT DISTINCT FROM station.branch_id)) AS active_stations_without_canonical_consumption_store
     FROM public.organizations org ORDER BY org.name,org.id
   ) report
 )
) AS system_workflow_inspection;
`;
writeFileSync("supabase/repair/2026-11-18/SYSTEM-WIDE-WORKFLOW-INSPECTION.sql",sql);
console.log(`Prepared read-only inspection of ${expected.length} shared workflow definitions and every organisation; no live query executed.`);
