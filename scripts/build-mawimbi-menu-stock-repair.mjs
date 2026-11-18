import {readFileSync,writeFileSync} from "node:fs";
const [inspectionPath,catalogPath]=process.argv.slice(2);
if(!inspectionPath||!catalogPath)throw Error("Provide the returned recipe inspection JSON and owned stock catalogue JSON paths");
const inspection=JSON.parse(readFileSync(inspectionPath,"utf8").replace(/^\uFEFF/,""));
const catalog=JSON.parse(readFileSync(catalogPath,"utf8").replace(/^\uFEFF/,""));
const org="c10e5d20-dc04-4959-9db4-4c2afb9d2f8c",branch="c6169bc5-2123-4f2e-a660-c2aa81b83df2";
// User authorized choosing variants, 18 Nov. Name the existing menu entry after
// its actual owned product rather than keep an ambiguous/wrong variant label.
const choices={
 "Amarula":"Amarula 750ml","Beefeater":"Beefeater Original Gin 750ml",
 "Camino silver":"Camino Silver 750ml","Captain Morgan":"Captain Morgan 750ml",
 "Heineken":"Heineken 330ml","Hennessy VS":"Hennessy VS 750ml",
 "Jagermeister":"Jägermeister 700ml","Jameson":"Jameson Triple Distilled 750ml",
 "Johnnie Walker Black Label":"Johnnie Walker Black Label 750ml",
 "Jose Cuervo":"Jose Cuervo Gold 750ml","Malibu":"Malibu Rum Coconut 700ml",
 "Moet & Chandon Imperial Brut":"Moët & Chandon 750ml","Monkey Shoulder":"Monkey Shoulder 750ml",
 "Red bull":"Red Bull","Robertson sweet red":"Robertson Sweet Red 750ml",
 "Still water 500ml":"Water 500 ml","Swartland Winery Cuvee Brut":"Swartland Winery 750ml",
 "Tusker lager":"Tusker Lager 500ml","Versus dry":"Versus Sensation Red 750ml",
};
const rows=inspection.direct_sale_mapping_checks.filter(r=>r.organization_id===org);
if(rows.length!==21)throw Error("Expected the reviewed 21 hotel recipe rows");
const mappings=rows.map(r=>{
 const candidates=catalog.filter(s=>s.name===choices[r.stock_name]&&s.branch_id===branch);
 if(candidates.length!==1||r.branch_id!==branch||r.yield_quantity!==1||!r.stock_organization_mismatch)
   throw Error(`Unrecognized inspection/catalogue for ${r.name}`);
 const s=candidates[0];
 if(!["Bottle","Can"].includes(s.base_unit))throw Error("Review target container unit");
 return {recipe_id:r.id,menu_item_id:r.menu_item_id,old_recipe_stock_id:r.output_stock_item_id,
   old_menu_stock_id:r.menu_stock_item_id,old_unit:r.stock_unit,new_stock_id:s.id,
   new_name:s.name,new_unit:s.base_unit};
}).sort((a,b)=>a.menu_item_id.localeCompare(b.menu_item_id));
if(new Set(mappings.map(m=>m.menu_item_id)).size!==21)throw Error("Repeated menu identity requires review");
const quote=v=>`'${String(v).replaceAll("'","''")}'`;
const values=mappings.map(m=>`    (${[m.recipe_id,m.menu_item_id,m.old_recipe_stock_id,m.old_menu_stock_id,m.old_unit,m.new_stock_id,m.new_name,m.new_unit].map(quote).join(",")})`).join(",\n");
const sql=`-- Reviewed Mawimbi-owned stock: update 21 EXISTING menu rows only.
-- No stock/menu/recipe creation, no stock quantity movement, no history rewrite.
-- Variant choices authorized by user on 18 Nov; exact product names shown on menu.
BEGIN;
CREATE TEMP TABLE neo_mawimbi_map(
  recipe_id uuid,menu_item_id uuid,old_recipe_stock_id uuid,old_menu_stock_id uuid,
  old_unit text,new_stock_id uuid,new_name text,new_unit text
) ON COMMIT DROP;
INSERT INTO neo_mawimbi_map VALUES
${values};
CREATE TEMP TABLE neo_mawimbi_recipe_before ON COMMIT DROP AS
  SELECT r.id,to_jsonb(r) AS snapshot FROM public.recipes r
  JOIN neo_mawimbi_map map ON map.recipe_id=r.id;
DO $repair$
DECLARE entry record; r public.recipes; m public.menu_items; s public.stock_items;
  old_value jsonb; new_value jsonb;
BEGIN
  FOR entry IN SELECT * FROM neo_mawimbi_map ORDER BY menu_item_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('recipe-activation:${org}:'||entry.menu_item_id::text,19));
    SELECT * INTO r FROM public.recipes WHERE id=entry.recipe_id FOR UPDATE;
    IF r.id IS NULL OR r.organization_id IS DISTINCT FROM '${org}'::uuid
      OR r.branch_id IS DISTINCT FROM '${branch}'::uuid OR r.status IS DISTINCT FROM 'active'
      OR r.recipe_type IS DISTINCT FROM 'direct_sale' OR r.menu_item_id IS DISTINCT FROM entry.menu_item_id
      OR r.output_stock_item_id IS DISTINCT FROM entry.old_recipe_stock_id OR r.yield_quantity IS DISTINCT FROM 1::numeric THEN
      RAISE EXCEPTION 'Recipe % changed since inspection; entire batch rolled back',entry.recipe_id;
    END IF;
    SELECT * INTO s FROM public.stock_items WHERE id=entry.new_stock_id FOR UPDATE;
    IF s.id IS NULL OR s.organization_id IS DISTINCT FROM r.organization_id
      OR s.branch_id IS DISTINCT FROM r.branch_id OR s.name IS DISTINCT FROM entry.new_name
      OR s.base_unit IS DISTINCT FROM entry.new_unit THEN
      RAISE EXCEPTION 'Owned stock % identity/owner/unit changed; entire batch rolled back',entry.new_stock_id;
    END IF;
    SELECT * INTO m FROM public.menu_items WHERE id=entry.menu_item_id FOR UPDATE;
    IF m.id IS NULL OR m.organization_id IS DISTINCT FROM r.organization_id
      OR m.branch_id IS DISTINCT FROM r.branch_id OR m.consumption_mode IS DISTINCT FROM 'direct_stock' THEN
      RAISE EXCEPTION 'Menu % identity/owner/mode changed; entire batch rolled back',entry.menu_item_id;
    END IF;
    IF m.stock_item_id=s.id AND m.stock_quantity_per_sale=1 AND m.stock_unit=entry.new_unit AND m.name=entry.new_name THEN CONTINUE; END IF;
    IF m.stock_item_id IS DISTINCT FROM entry.old_menu_stock_id OR m.stock_quantity_per_sale IS DISTINCT FROM 1::numeric
      OR m.stock_unit IS DISTINCT FROM entry.old_unit THEN
      RAISE EXCEPTION 'Menu % mapping changed since inspection; entire batch rolled back',entry.menu_item_id;
    END IF;
    old_value:=jsonb_build_object('name',m.name,'stock_item_id',m.stock_item_id,'quantity',m.stock_quantity_per_sale,'unit',m.stock_unit);
    UPDATE public.menu_items SET name=entry.new_name,stock_item_id=s.id,stock_quantity_per_sale=1,stock_unit=entry.new_unit
      WHERE id=m.id AND organization_id=r.organization_id;
    SELECT jsonb_build_object('name',name,'stock_item_id',stock_item_id,'quantity',stock_quantity_per_sale,'unit',stock_unit)
      INTO new_value FROM public.menu_items WHERE id=m.id;
    IF new_value IS DISTINCT FROM jsonb_build_object('name',entry.new_name,'stock_item_id',s.id,'quantity',1,'unit',entry.new_unit) THEN
      RAISE EXCEPTION 'Menu % update not confirmed; entire batch rolled back',entry.menu_item_id;
    END IF;
    INSERT INTO public.audit_logs(organization_id,branch_id,user_id,user_name,action,module,record_id,previous_value,new_value,reason)
    VALUES(r.organization_id,r.branch_id,auth.uid(),'Lovable SQL repair ('||current_user||')',
      'repair.mawimbi_owned_menu_stock','kitchen',m.id::text,old_value,new_value,
      'Correct existing hotel menu to reviewed existing hotel-owned stock and its container unit. Variant selection authorized 18 Nov. No stock moved; approved recipe history retained for reviewed version correction.');
  END LOOP;
  IF EXISTS(SELECT 1 FROM neo_mawimbi_recipe_before before_row
    LEFT JOIN public.recipes recipe ON recipe.id=before_row.id
    WHERE to_jsonb(recipe) IS DISTINCT FROM before_row.snapshot) THEN
    RAISE EXCEPTION 'Approved recipe history changed during menu repair; entire batch rolled back';
  END IF;
END $repair$;
COMMIT;
SELECT jsonb_build_object('hotel_menus_bound_to_owned_stock',count(*),
  'audit_records',(SELECT count(*) FROM public.audit_logs WHERE organization_id='${org}' AND action='repair.mawimbi_owned_menu_stock'),
  'historical_recipes_unchanged',true) AS mapping_repair_result
FROM public.menu_items m JOIN public.stock_items s ON s.id=m.stock_item_id
WHERE m.id IN (${mappings.map(m=>quote(m.menu_item_id)).join(",")})
  AND m.organization_id='${org}' AND m.branch_id='${branch}'
  AND s.organization_id=m.organization_id AND s.branch_id=m.branch_id
  AND m.consumption_mode='direct_stock' AND m.stock_quantity_per_sale=1 AND m.stock_unit=s.base_unit;
`;
writeFileSync("supabase/repair/2026-11-18/mawimbi-menu-stock-map.json",JSON.stringify(mappings,null,2)+"\n");
writeFileSync("supabase/repair/2026-11-18/REPAIR-MAWIMBI-EXISTING-MENU-STOCK.sql",sql);
console.log("Prepared 21 reviewed existing-menu updates; no live database contacted.");
