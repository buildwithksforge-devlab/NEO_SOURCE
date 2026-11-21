import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const read = (path) => readFileSync(path,"utf8").replaceAll("\r\n","\n");
const extract = (source,name) => source.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$\\s*;`))?.[0];
const original = extract(read("scripts/fixtures/queue-batch-29/original-inventory_apply_movement.sql"),"inventory_apply_movement");
const earlier = extract(read("supabase/migrations/20260921070329_8190d71a-fe59-4f44-8a73-5eef62ba800b.sql"),"inventory_apply_movement");
const receipt = extract(read("supabase/migrations/20260831050052_abb267b0-992c-448b-9292-715775ac34ba.sql"),"inventory_post_receipt");
if(!original || !earlier || !receipt) throw new Error("Reviewed movement/receipt source missing");
const replace = (sql,from,to) => { if(sql.split(from).length!==2) throw new Error(`Missing/ambiguous inventory boundary: ${from}`); return sql.replace(from,to); };
let repaired = replace(original,"  v_store text;",`  v_store text;
  v_location record;
  v_prior record;
  v_batch_row record;
  v_remaining numeric;
  v_take numeric;
  v_global_onhand numeric;
  v_allocations jsonb := '[]'::jsonb;`);
repaired = replace(repaired,"IF v_org IS NULL THEN", "IF auth.uid() IS NULL OR v_org IS NULL THEN");
repaired = replace(repaired,"  IF NOT public.neo_system_posting()\n     AND NOT (has_permission('inventory','stock.manage') OR has_permission('procurement','receiving.manage')) THEN", "  IF NOT coalesce(public.neo_system_posting() OR has_permission('inventory','stock.manage') OR has_permission('procurement','receiving.manage'),false) THEN");
const replayStart = repaired.indexOf("  IF _idempotency_key IS NOT NULL THEN");
const levelStart = repaired.indexOf("  INSERT INTO stock_levels",replayStart);
if(replayStart<0 || levelStart<0) throw new Error("Movement validation boundary missing");
repaired = repaired.slice(0,replayStart)+`  IF _quantity IS NULL OR _quantity=0 OR _quantity::text IN ('NaN','Infinity','-Infinity')
     OR _unit_cost<0 OR _unit_cost::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Stock movement requires finite nonzero quantity and nonnegative cost';
  END IF;
  SELECT * INTO v_location FROM public.stock_locations WHERE id=_location AND organization_id=v_org;
  IF v_location.id IS NULL OR v_location.active IS NOT TRUE OR v_location.branch_id IS NULL
     OR NOT coalesce(public.neo_branch_in_scope(v_location.branch_id),false) THEN
    RAISE EXCEPTION 'Stock location is not active in your authorized property' USING ERRCODE='42501';
  END IF;
  -- Serialize an item's movements across stores before calculating its shared average cost.
  SELECT * INTO v_item FROM public.stock_items WHERE id=_item AND organization_id=v_org FOR UPDATE;
  IF v_item.id IS NULL OR (v_item.branch_id IS NOT NULL AND v_item.branch_id<>v_location.branch_id) THEN
    RAISE EXCEPTION 'Stock item does not belong to this property' USING ERRCODE='42501';
  END IF;
  v_qty_base := public.inventory_convert_strict(_quantity,coalesce(nullif(btrim(_unit),''),v_item.base_unit),v_item.base_unit);
  IF v_qty_base IS NULL OR v_qty_base=0 OR v_qty_base::text IN ('NaN','Infinity','-Infinity') OR (v_qty_base>0)<>(_quantity>0) THEN
    RAISE EXCEPTION 'Stock unit conversion must produce a finite nonzero quantity';
  END IF;
  IF nullif(btrim(_movement_type),'') IS NULL THEN RAISE EXCEPTION 'Stock movement type is required'; END IF;
  IF _idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_org::text||':movement:'||_idempotency_key,0));
    SELECT * INTO v_prior FROM public.stock_movements WHERE organization_id=v_org AND idempotency_key=_idempotency_key;
    IF v_prior.id IS NOT NULL THEN
      IF v_prior.stock_item_id IS DISTINCT FROM _item OR v_prior.location_id IS DISTINCT FROM _location
        OR v_prior.quantity IS DISTINCT FROM v_qty_base OR v_prior.movement_type IS DISTINCT FROM _movement_type
        OR (_unit_cost IS NOT NULL AND v_prior.unit_cost IS DISTINCT FROM _unit_cost)
        OR v_prior.reference_type IS DISTINCT FROM _reference_type OR v_prior.reference_id IS DISTINCT FROM _reference_id
        OR v_prior.reason IS DISTINCT FROM _reason
        OR (v_qty_base>0 AND v_prior.batch_id IS NULL AND (_batch_number IS NOT NULL OR _expiry IS NOT NULL))
        OR (v_qty_base>0 AND EXISTS(SELECT 1 FROM public.stock_batches saved WHERE saved.id=v_prior.batch_id
          AND (saved.batch_number IS DISTINCT FROM _batch_number OR saved.expiry_date IS DISTINCT FROM _expiry))) THEN
        RAISE EXCEPTION 'Stock movement identity belongs to different work';
      END IF;
      RETURN v_prior.id;
    END IF;
  END IF;
  v_cost := coalesce(_unit_cost,v_item.average_cost);
  IF v_cost<0 OR v_cost::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Stock cost needs reconciliation'; END IF;
  SELECT coalesce(sum(greatest(quantity_on_hand,0)),0) INTO v_global_onhand FROM public.stock_levels
    WHERE stock_item_id=_item AND organization_id=v_org;
  IF v_global_onhand::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Stock balances need reconciliation'; END IF;
  IF v_qty_base>0 AND _unit_cost IS NOT NULL AND v_global_onhand>0 AND v_item.average_cost IS NULL THEN
    RAISE EXCEPTION 'Existing stock cost needs reconciliation before receiving more stock';
  END IF;

`+repaired.slice(levelStart);
repaired = replace(repaired,"public.neo_inventory_allows_negative(v_org, v_item.branch_id)","public.neo_inventory_allows_negative(v_org, v_location.branch_id)");
repaired = replace(repaired,"  SELECT * INTO v_level FROM stock_levels WHERE stock_item_id = _item AND location_id = _location FOR UPDATE;",`  SELECT * INTO v_level FROM stock_levels WHERE stock_item_id = _item AND location_id = _location FOR UPDATE;
  IF v_level.organization_id IS DISTINCT FROM v_org OR v_level.quantity_on_hand IS NULL
    OR v_level.quantity_on_hand::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Store stock balance ownership or quantity needs reconciliation';
  END IF;`);
const batchStart = repaired.indexOf("  IF v_qty_base > 0 AND (v_item.track_batches");
const updateStart = repaired.indexOf("  UPDATE stock_levels",batchStart);
if(batchStart<0 || updateStart<0) throw new Error("Batch boundary missing");
repaired = repaired.slice(0,batchStart)+`  IF v_qty_base > 0 AND (v_item.track_batches OR _batch_number IS NOT NULL OR _expiry IS NOT NULL) THEN
    INSERT INTO stock_batches(organization_id,stock_item_id,location_id,batch_number,expiry_date,quantity,unit_cost)
    VALUES(v_org,_item,_location,_batch_number,_expiry,v_qty_base,v_cost) RETURNING id INTO v_batch;
    v_allocations:=jsonb_build_array(jsonb_build_object('batch_id',v_batch,'quantity',v_qty_base,'batch_number',_batch_number,'expiry_date',_expiry));
  ELSIF v_qty_base < 0 THEN
    IF EXISTS(SELECT 1 FROM public.stock_batches WHERE organization_id=v_org AND stock_item_id=_item AND location_id=_location
      AND status='active' AND (quantity IS NULL OR quantity<0 OR quantity::text IN ('NaN','Infinity','-Infinity'))) THEN
      RAISE EXCEPTION 'Batch quantities need reconciliation';
    END IF;
    v_remaining:=abs(v_qty_base);
    FOR v_batch_row IN SELECT * FROM public.stock_batches
      WHERE organization_id=v_org AND stock_item_id=_item AND location_id=_location AND quantity>0 AND status='active'
      ORDER BY expiry_date NULLS LAST,received_at,id FOR UPDATE LOOP
      v_take:=least(v_remaining,v_batch_row.quantity);
      UPDATE public.stock_batches SET quantity=quantity-v_take WHERE id=v_batch_row.id;
      v_allocations:=v_allocations||jsonb_build_array(jsonb_build_object('batch_id',v_batch_row.id,'quantity',-v_take,'batch_number',v_batch_row.batch_number,'expiry_date',v_batch_row.expiry_date));
      v_remaining:=v_remaining-v_take;
      EXIT WHEN v_remaining=0;
    END LOOP;
    IF v_remaining>0 AND v_item.track_batches THEN
      RAISE EXCEPTION 'Batch balances do not cover this stock movement; reconcile batches before issuing';
    END IF;
    IF v_remaining>0 THEN
      v_allocations:=v_allocations||jsonb_build_array(jsonb_build_object('batch_id',null,'quantity',-v_remaining));
    END IF;
    IF jsonb_array_length(v_allocations)=1 THEN v_batch:=nullif(v_allocations->0->>'batch_id','')::uuid; END IF;
  END IF;

`+repaired.slice(updateStart);
repaired = replace(repaired,"WHEN COALESCE(v_level.quantity_on_hand, 0) + v_qty_base <= 0 THEN v_cost", "WHEN v_global_onhand + v_qty_base <= 0 THEN v_cost");
repaired = replace(repaired,"ELSE ((GREATEST(v_level.quantity_on_hand, 0) * average_cost) + (v_qty_base * v_cost))\n                  / (GREATEST(v_level.quantity_on_hand, 0) + v_qty_base)","ELSE ((v_global_onhand * coalesce(average_cost,0)) + (v_qty_base * v_cost)) / (v_global_onhand + v_qty_base)");
repaired = replace(repaired,"reason, idempotency_key, performed_by","reason, idempotency_key, performed_by, batch_allocations");
repaired = replace(repaired,"v_org, v_item.branch_id, _item, _location, v_batch, _movement_type","v_org, v_location.branch_id, _item, _location, v_batch, _movement_type");
repaired = replace(repaired,"_reason, _idempotency_key, auth.uid()","_reason, _idempotency_key, auth.uid(), v_allocations");

let fixedReceipt = replace(receipt," IF NOT has_permission('procurement','receiving.manage') THEN", " IF auth.uid() IS NULL OR NOT coalesce(has_permission('procurement','receiving.manage'),false) THEN");
fixedReceipt = replace(fixedReceipt," IF r IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;",` IF r IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
 IF NOT coalesce(public.neo_branch_in_scope(r.branch_id),false) THEN RAISE EXCEPTION 'Receipt outside authorized property'; END IF;
 IF r.status IS NULL OR r.status NOT IN ('received','approved','posted') THEN RAISE EXCEPTION 'Receipt is not approved for stock posting'; END IF;`);
fixedReceipt = replace(fixedReceipt,"   IF v_accepted>0 THEN",`   IF EXISTS(SELECT 1 FROM unnest(ARRAY[l.quantity_received,l.quantity_rejected,l.quantity_damaged,l.quantity_returned]) q
       WHERE q<0 OR q::text IN ('NaN','Infinity','-Infinity'))
     OR l.organization_id IS DISTINCT FROM v_org
     OR v_accepted IS NULL OR v_accepted<0 OR v_accepted::text IN ('NaN','Infinity','-Infinity')
     OR l.unit_price IS NULL OR l.unit_price<0 OR l.unit_price::text IN ('NaN','Infinity','-Infinity')
     OR v_accepted>coalesce(l.quantity_received,0)-coalesce(l.quantity_rejected,0)-coalesce(l.quantity_damaged,0)-coalesce(l.quantity_returned,0) THEN
     RAISE EXCEPTION 'Receipt accepted quantities and cost need reconciliation';
   END IF;
   IF l.order_line_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.purchase_order_lines pl
     WHERE pl.id=l.order_line_id AND pl.order_id=r.order_id AND pl.stock_item_id=l.stock_item_id
       AND lower(btrim(pl.unit))=lower(btrim(l.unit))) THEN
     RAISE EXCEPTION 'Receipt line item or unit differs from its original purchase line';
   END IF;
   IF v_accepted>0 THEN`);
fixedReceipt = replace(fixedReceipt,"CASE WHEN l.unit_price>0 THEN l.unit_price/NULLIF(inventory_convert(1,l.unit,(SELECT base_unit FROM stock_items WHERE id=l.stock_item_id)),0) ELSE NULL END", "l.unit_price/NULLIF(public.inventory_convert_strict(1,l.unit,(SELECT base_unit FROM stock_items WHERE id=l.stock_item_id)),0)");
const hash = (sql) => createHash("md5").update(sql.split("$function$")[1].replace(/--[^\n]*/g,"").replace(/\s/g,"")).digest("hex");
const functions=[{name:"inventory_apply_movement",sig:"uuid,uuid,numeric,text,text,numeric,text,uuid,text,text,text,date",old:[original,earlier],fixed:repaired},{name:"inventory_post_receipt",sig:"uuid",old:[receipt],fixed:fixedReceipt}];
writeFileSync("supabase/migrations/20261116235900_inventory_batch_cost_integrity.sql",`-- STAGED ONLY: future batch depletion, receipt conversion, retry and shared cost integrity.
-- No historical batch quantity, cost, movement, GRN or journal is recalculated by installation.
BEGIN;
${functions.map((f)=>`DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE p.oid=to_regprocedure('public.${f.name}(${f.sig})') AND r.rolname NOT IN ('anon','authenticated')
 AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g')) IN (${[...f.old,f.fixed].map(s=>`'${hash(s)}'`).join(",")})) THEN
 RAISE EXCEPTION '${f.name} differs from reviewed source; nothing replaced'; END IF;
END $guard$;`).join("\n")}
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS batch_allocations jsonb NOT NULL DEFAULT '[]'::jsonb;
DO $column$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.stock_movements'::regclass AND attname='batch_allocations' AND atttypid='jsonb'::regtype AND NOT attisdropped) THEN
 RAISE EXCEPTION 'Stock batch allocation column has an unexpected type'; END IF;
END $column$;
CREATE TEMP TABLE neo_batch_cost_acl ON COMMIT DROP AS SELECT oid,proowner,coalesce(proacl::text,'') acl FROM pg_proc
 WHERE oid IN (${functions.map(f=>`'public.${f.name}(${f.sig})'::regprocedure`).join(",")});
${functions.map(f=>f.fixed).join("\n\n")}
DO $verify$ BEGIN
 IF EXISTS(SELECT 1 FROM neo_batch_cost_acl old LEFT JOIN pg_proc p ON p.oid=old.oid WHERE p.oid IS NULL OR p.proowner<>old.proowner OR coalesce(p.proacl::text,'')<>old.acl) THEN
 RAISE EXCEPTION 'Inventory movement/receipt owner or grants changed'; END IF;
END $verify$;
COMMIT;
`);
console.log("Generated guarded stock batch, cost and receiving-unit repair.");
