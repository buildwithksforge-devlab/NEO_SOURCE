import {readFileSync,writeFileSync} from "node:fs";
const path="supabase/repair/2026-11-18/INSTALL-RECIPE-SAVE-AND-IMPORT.sql";
let contract=readFileSync("supabase/migrations/20261113100000_atomic_recipe_sheets.sql","utf8").replaceAll("\r\n","\n");
const oldBinding="stock_item_id=CASE WHEN r.recipe_type='direct_sale' THEN r.output_stock_item_id ELSE NULL END WHERE id=target AND organization_id=org;";
const newBinding=`stock_item_id=CASE WHEN r.recipe_type='direct_sale' THEN r.output_stock_item_id ELSE NULL END,
      stock_quantity_per_sale=CASE WHEN r.recipe_type='direct_sale' THEN r.yield_quantity ELSE stock_quantity_per_sale END,
      stock_unit=CASE WHEN r.recipe_type='direct_sale' THEN r.yield_unit ELSE stock_unit END
      WHERE id=target AND organization_id=org;`;
if(contract.split(oldBinding).length!==2)throw Error("Reviewed recipe binding source changed; inspect before generating");
contract=contract.replace(oldBinding,newBinding).replace(/^--[^\n]*\nBEGIN;\n/,"").replace(/\nCOMMIT;\s*$/,"");
const guard=`-- Targeted installer for the 18 Nov Lovable inspection: all three objects absent,
-- no duplicate active menu versions. Installs commands only; no history rewrite.
BEGIN;
DO $preflight$
DECLARE required text; missing text[]:=ARRAY[]::text[];
BEGIN
  IF to_regprocedure('public.neo_recipe_sheet_save(jsonb,jsonb,uuid)') IS NOT NULL
     OR to_regprocedure('public.neo_recipe_activate(uuid,uuid)') IS NOT NULL
     OR to_regclass('public.neo_recipe_sheet_attempts') IS NOT NULL THEN
    RAISE EXCEPTION 'Recipe contract is already present or partially installed; inspect instead of overwriting';
  END IF;
  FOREACH required IN ARRAY ARRAY[
    'auth.uid()', 'public.current_org_id()', 'public.is_org_admin()',
    'public.neo_branch_in_scope(uuid)', 'public.has_permission(text,text)',
    'public.recipe_expand_to_stock_kinds(uuid,numeric,uuid,uuid[])'
  ] LOOP
    IF to_regprocedure(required) IS NULL THEN missing:=array_append(missing,required); END IF;
  END LOOP;
  IF cardinality(missing)>0 THEN
    RAISE EXCEPTION 'Required existing functions missing: %',array_to_string(missing,', ');
  END IF;
  IF EXISTS(SELECT 1 FROM public.recipes WHERE status='active' AND menu_item_id IS NOT NULL
    GROUP BY organization_id,menu_item_id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Duplicate active menu recipe versions require review; no changes applied';
  END IF;
END $preflight$;
`;
const postcheck=`
NOTIFY pgrst,'reload schema';
COMMIT;

SELECT jsonb_build_object(
  'save_function',to_regprocedure('public.neo_recipe_sheet_save(jsonb,jsonb,uuid)')::text,
  'approval_function',to_regprocedure('public.neo_recipe_activate(uuid,uuid)')::text,
  'retry_history',to_regclass('public.neo_recipe_sheet_attempts')::text,
  'staff_save',has_function_privilege('authenticated','public.neo_recipe_sheet_save(jsonb,jsonb,uuid)','EXECUTE'),
  'anonymous_save',has_function_privilege('anon','public.neo_recipe_sheet_save(jsonb,jsonb,uuid)','EXECUTE'),
  'staff_approve',has_function_privilege('authenticated','public.neo_recipe_activate(uuid,uuid)','EXECUTE'),
  'anonymous_approve',has_function_privilege('anon','public.neo_recipe_activate(uuid,uuid)','EXECUTE')
) AS recipe_installation_result;
`;
writeFileSync(path,guard+contract+postcheck);
console.log(`Prepared ${path}; no live database contacted.`);
