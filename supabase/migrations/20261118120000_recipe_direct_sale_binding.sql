-- Forward-only: future approvals bind the reviewed quantity/unit as well as ID.
-- Existing approved recipes and stock history are unchanged by installation.
BEGIN;
DO $repair$
DECLARE routine oid:=to_regprocedure('public.neo_recipe_activate(uuid,uuid)');
  source text; repaired text; old_owner oid; old_acl text;
  old_binding text:=$old$stock_item_id=CASE WHEN r.recipe_type='direct_sale' THEN r.output_stock_item_id ELSE NULL END WHERE id=target AND organization_id=org;$old$;
  new_binding text:=$new$stock_item_id=CASE WHEN r.recipe_type='direct_sale' THEN r.output_stock_item_id ELSE NULL END,
      stock_quantity_per_sale=CASE WHEN r.recipe_type='direct_sale' THEN r.yield_quantity ELSE stock_quantity_per_sale END,
      stock_unit=CASE WHEN r.recipe_type='direct_sale' THEN r.yield_unit ELSE stock_unit END
      WHERE id=target AND organization_id=org;$new$;
BEGIN
  IF routine IS NULL THEN RAISE EXCEPTION 'Install the reviewed atomic recipe contract first'; END IF;
  SELECT pg_get_functiondef(oid),proowner,coalesce(proacl::text,'')
    INTO source,old_owner,old_acl FROM pg_proc WHERE oid=routine;
  IF position(new_binding IN source)>0 THEN RETURN; END IF;
  IF position(old_binding IN source)=0
     OR position('recipes.approve' IN source)=0
     OR position('neo_branch_in_scope' IN source)=0
     OR position('recipe_expand_to_stock_kinds' IN source)=0 THEN
    RAISE EXCEPTION 'Unrecognized recipe approval contract; inspect before replacing';
  END IF;
  repaired:=replace(source,old_binding,new_binding);
  EXECUTE repaired;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=routine AND proowner=old_owner
    AND coalesce(proacl::text,'')=old_acl) THEN
    RAISE EXCEPTION 'Recipe approval owner or grants changed';
  END IF;
END $repair$;
NOTIFY pgrst,'reload schema';
COMMIT;
