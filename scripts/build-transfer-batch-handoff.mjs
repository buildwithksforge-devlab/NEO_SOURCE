import { readFileSync,writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const source=readFileSync("supabase/migrations/20261116235000_store_transfer_scope_and_replay.sql","utf8").replaceAll("\r\n","\n");
const names=["neo_stores_transfer_create","neo_stores_transfer_receive","neo_stores_transfer_cancel"];
const signatures=["uuid,uuid,uuid,jsonb,text,uuid","uuid","uuid,text"];
const originals=names.map(name=>source.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?END \\$function\\$;`))?.[0]);
if(originals.some(sql=>!sql))throw new Error("Reviewed transfer handoff definitions missing");
const replace=(sql,from,to)=>{if(sql.split(from).length!==2)throw new Error(`Missing/ambiguous transfer batch boundary: ${from}`);return sql.replace(from,to);};
const repaired=originals.map((body,index)=>{
  if(index===0){
    let sql=replace(body,"  v_qty numeric;","  v_qty numeric;\n  v_qty_base numeric;");
    sql=replace(sql,"    IF coalesce(v_onhand, 0) < v_qty THEN",`    v_qty_base:=public.inventory_convert_strict(v_qty,coalesce(v_unit,(SELECT base_unit FROM public.stock_items WHERE id=v_item)),(SELECT base_unit FROM public.stock_items WHERE id=v_item));
    IF v_qty_base IS NULL OR v_qty_base<=0 OR v_qty_base::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invalid transfer unit conversion'; END IF;
    IF coalesce(v_onhand, 0) < v_qty_base THEN`);
    return sql;
  }
  let sql=replace(body,"  l record;",`  l record;
  dispatch record;
  allocation record;
  batch_record record;
  saved_allocations jsonb;
  base_quantity numeric;
  tracks_batches boolean;`);
  const start=sql.indexOf("    PERFORM public.inventory_apply_movement(");
  const end=sql.indexOf(");",start)+2;
  if(start<0||end<2)throw new Error("Transfer movement handoff missing");
  const destination=index===1?"t.to_location_id":"t.from_location_id";
  const action=index===1?"transfer-in":"transfer-cancel";
  const reason=index===1?"t.reason":"btrim(_reason)";
  const movement=`    SELECT * INTO dispatch FROM public.stock_movements
      WHERE organization_id=v_org AND idempotency_key='transfer-out:'||_transfer::text||':'||l.id::text;
    base_quantity:=public.inventory_convert_strict(l.quantity,l.unit,(SELECT base_unit FROM public.stock_items WHERE id=l.stock_item_id));
    SELECT track_batches INTO tracks_batches FROM public.stock_items WHERE id=l.stock_item_id AND organization_id=v_org;
    IF dispatch.id IS NULL OR dispatch.stock_item_id IS DISTINCT FROM l.stock_item_id
      OR dispatch.location_id IS DISTINCT FROM t.from_location_id OR dispatch.branch_id IS DISTINCT FROM t.branch_id
      OR dispatch.reference_type IS DISTINCT FROM 'stock_transfer' OR dispatch.reference_id IS DISTINCT FROM _transfer
      OR dispatch.movement_type IS DISTINCT FROM 'transfer-out' OR dispatch.quantity IS DISTINCT FROM -base_quantity
      OR dispatch.unit_cost IS NULL OR dispatch.unit_cost<0 OR dispatch.unit_cost::text IN ('NaN','Infinity','-Infinity') THEN
      RAISE EXCEPTION 'Saved transfer dispatch quantity, source or cost needs reconciliation';
    END IF;
    saved_allocations:=coalesce(dispatch.batch_allocations,'[]'::jsonb);
    IF jsonb_typeof(saved_allocations) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Saved dispatch batches need reconciliation'; END IF;
    IF jsonb_array_length(saved_allocations)=0 THEN
      IF tracks_batches THEN RAISE EXCEPTION 'Saved dispatch has no batch allocations; reconcile before receipt or cancellation'; END IF;
      saved_allocations:=jsonb_build_array(jsonb_build_object('batch_id',null,'quantity',dispatch.quantity));
    END IF;
    IF (SELECT sum((part->>'quantity')::numeric) FROM jsonb_array_elements(saved_allocations) part) IS DISTINCT FROM dispatch.quantity
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(saved_allocations) part WHERE nullif(part->>'quantity','') IS NULL
        OR (part->>'quantity')::numeric>=0 OR ((part->>'quantity')::numeric)::text IN ('NaN','Infinity','-Infinity')) THEN
      RAISE EXCEPTION 'Saved dispatch batch quantities do not reconcile';
    END IF;
    FOR allocation IN SELECT value,ordinality FROM jsonb_array_elements(saved_allocations) WITH ORDINALITY LOOP
      IF nullif(allocation.value->>'batch_id','') IS NOT NULL THEN
        SELECT * INTO batch_record FROM public.stock_batches WHERE id=(allocation.value->>'batch_id')::uuid
          AND organization_id=v_org AND stock_item_id=l.stock_item_id AND location_id=t.from_location_id;
        IF batch_record.id IS NULL OR NOT (allocation.value ? 'batch_number' AND allocation.value ? 'expiry_date') THEN
          RAISE EXCEPTION 'Saved dispatch batch identity and expiry need reconciliation';
        END IF;
      ELSIF tracks_batches THEN RAISE EXCEPTION 'Tracked transfer has an unidentified source batch';
      END IF;
      PERFORM public.inventory_apply_movement(
        l.stock_item_id,${destination},-(allocation.value->>'quantity')::numeric,dispatch.unit,'${action}',dispatch.unit_cost,
        'stock_transfer',_transfer,${reason},
        '${action}:'||_transfer::text||':'||l.id::text||':batch:'||allocation.ordinality::text,
        allocation.value->>'batch_number',nullif(allocation.value->>'expiry_date','')::date);
    END LOOP;`;
  sql=sql.slice(0,start)+movement+sql.slice(end);
  return sql;
});
const hash=sql=>createHash("md5").update(sql.split("$function$")[1].replace(/--[^\n]*/g,"").replace(/\s/g,"")).digest("hex");
writeFileSync("supabase/migrations/20261116235930_transfer_batch_cost_handoff.sql",`-- STAGED ONLY: preserve saved dispatch cost, batches and expiry on transfer receipt/cancellation.
-- Requires inventory_batch_cost_integrity; legacy untraceable transfers fail for explicit reconciliation.
BEGIN;
DO $column$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.stock_movements'::regclass AND attname='batch_allocations' AND atttypid='jsonb'::regtype AND NOT attisdropped) THEN
 RAISE EXCEPTION 'Install inventory batch allocation support first'; END IF;
END $column$;
${names.map((name,i)=>`DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid=to_regprocedure('public.${name}(${signatures[i]})') AND r.rolname NOT IN ('anon','authenticated')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN ('${hash(originals[i])}','${hash(repaired[i])}')) THEN
 RAISE EXCEPTION '${name} differs from reviewed batch handoff source; nothing replaced'; END IF;
END $guard$;`).join("\n")}
CREATE TEMP TABLE neo_transfer_batch_acl ON COMMIT DROP AS SELECT oid,proowner,coalesce(proacl::text,'') acl FROM pg_proc
 WHERE oid IN (${names.map((name,i)=>`'public.${name}(${signatures[i]})'::regprocedure`).join(",")});
${repaired.join("\n\n")}
DO $verify$ BEGIN
 IF EXISTS(SELECT 1 FROM neo_transfer_batch_acl old LEFT JOIN pg_proc p ON p.oid=old.oid
 WHERE p.oid IS NULL OR p.proowner<>old.proowner OR coalesce(p.proacl::text,'')<>old.acl) THEN
 RAISE EXCEPTION 'Transfer batch handoff owner or grants changed'; END IF;
END $verify$;
COMMIT;
`);
console.log("Generated guarded transfer batch and dispatch-cost handoff.");
