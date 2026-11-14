-- Forward-only candidate. No stock movement or historical recipe rewrite.
BEGIN;

CREATE TABLE IF NOT EXISTS public.neo_recipe_sheet_attempts (
  organization_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  recipe_id uuid NOT NULL REFERENCES public.recipes(id),
  request jsonb NOT NULL,
  created_by uuid NOT NULL,
  PRIMARY KEY (organization_id, attempt_id)
);
ALTER TABLE public.neo_recipe_sheet_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recipe_sheet_attempt_scope ON public.neo_recipe_sheet_attempts;
CREATE POLICY recipe_sheet_attempt_scope ON public.neo_recipe_sheet_attempts TO authenticated
USING (organization_id=public.current_org_id() AND EXISTS (
  SELECT 1 FROM public.recipes r WHERE r.id=recipe_id
    AND r.organization_id=public.current_org_id()
    AND (r.branch_id IS NULL OR public.neo_branch_in_scope(r.branch_id))))
WITH CHECK (organization_id=public.current_org_id() AND created_by=auth.uid()
  AND EXISTS (SELECT 1 FROM public.recipes r WHERE r.id=recipe_id AND r.organization_id=public.current_org_id()
    AND (r.branch_id IS NULL OR public.neo_branch_in_scope(r.branch_id))));
REVOKE ALL ON public.neo_recipe_sheet_attempts FROM PUBLIC, anon;
GRANT SELECT,INSERT ON public.neo_recipe_sheet_attempts TO authenticated;

-- Existing duplicates must be reviewed, not silently deleted or superseded.
CREATE UNIQUE INDEX IF NOT EXISTS neo_recipe_one_active_menu_version
  ON public.recipes(organization_id,menu_item_id)
  WHERE status='active' AND menu_item_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.neo_recipe_component_draft_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r public.recipes; item record; component public.recipes;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.recipe_id IS DISTINCT FROM OLD.recipe_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id) THEN
    RAISE EXCEPTION 'An ingredient cannot be moved out of its recipe history';
  END IF;
  SELECT * INTO r FROM public.recipes WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.recipe_id ELSE NEW.recipe_id END FOR UPDATE;
  IF r.id IS NULL OR r.organization_id IS DISTINCT FROM public.current_org_id()
     OR NOT (r.branch_id IS NULL OR public.neo_branch_in_scope(r.branch_id)) THEN
    RAISE EXCEPTION 'Recipe is outside your workspace/property' USING ERRCODE='42501';
  END IF;
  IF r.status <> 'draft' THEN
    RAISE EXCEPTION 'Create a draft version before changing an approved recipe';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.organization_id IS DISTINCT FROM r.organization_id OR NEW.quantity IS NULL OR NEW.quantity<=0
     OR NEW.quantity::text IN ('NaN','Infinity','-Infinity') OR nullif(btrim(NEW.unit),'') IS NULL
     OR COALESCE(NEW.waste_allowance,0)<0 OR COALESCE(NEW.waste_allowance,0)::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Every component needs a positive finite quantity, valid unit and nonnegative waste allowance';
  END IF;
  IF lower(NEW.unit) IN ('piece','pieces','pc','pcs','unit','units','each') AND NEW.quantity<>trunc(NEW.quantity) THEN
    RAISE EXCEPTION 'Whole-item components require a whole quantity';
  END IF;
  IF NEW.component_type='stock_item' THEN
    SELECT id INTO item FROM public.stock_items WHERE id=NEW.stock_item_id AND organization_id=r.organization_id
      AND (branch_id IS NULL OR branch_id=r.branch_id);
    IF item.id IS NULL OR NEW.sub_recipe_id IS NOT NULL THEN RAISE EXCEPTION 'Choose an in-scope stock component'; END IF;
  ELSIF NEW.component_type='sub_recipe' THEN
    SELECT * INTO component FROM public.recipes WHERE id=NEW.sub_recipe_id AND organization_id=r.organization_id
      AND (branch_id IS NULL OR branch_id=r.branch_id);
    IF component.id IS NULL OR component.id=r.id OR NEW.stock_item_id IS NOT NULL THEN
      RAISE EXCEPTION 'Choose an in-scope prepared sub-recipe; a recipe cannot contain itself';
    END IF;
  ELSE RAISE EXCEPTION 'Unsupported recipe component type'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS neo_recipe_components_draft_only ON public.recipe_ingredients;
CREATE TRIGGER neo_recipe_components_draft_only BEFORE INSERT OR UPDATE OR DELETE ON public.recipe_ingredients
  FOR EACH ROW EXECUTE FUNCTION public.neo_recipe_component_draft_guard();

CREATE OR REPLACE FUNCTION public.neo_recipe_version_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' THEN RAISE EXCEPTION 'Create a draft before approving a recipe'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.status<>'draft' THEN RAISE EXCEPTION 'Approved recipe history cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status<>'draft' AND (
    NEW.status='draft' OR
    (to_jsonb(NEW)-ARRAY['status','effective_to','updated_at','approved_at','approved_by']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','effective_to','updated_at','approved_at','approved_by'])
  ) THEN RAISE EXCEPTION 'Create a new draft version before changing approved recipe data'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (NEW.status='active' OR OLD.status='active')
    AND NOT(public.is_org_admin() OR public.has_permission('kitchen','recipes.approve')) THEN
    RAISE EXCEPTION 'Recipe approval authority required' USING ERRCODE='42501'; END IF;
  IF NEW.status='active' AND OLD.status<>'active'
    AND current_setting('neo.recipe.activation',true) IS DISTINCT FROM NEW.id::text THEN
    RAISE EXCEPTION 'Use atomic recipe approval to activate this version'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS neo_recipe_version_write_guard ON public.recipes;
CREATE TRIGGER neo_recipe_version_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recipes
  FOR EACH ROW EXECUTE FUNCTION public.neo_recipe_version_guard();

CREATE OR REPLACE FUNCTION public.neo_recipe_sheet_save(_recipe jsonb,_components jsonb DEFAULT NULL,_attempt uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE org uuid:=public.current_org_id(); rid uuid; bid uuid; mid uuid; sid uuid; output_id uuid;
  r public.recipes; prior public.neo_recipe_sheet_attempts; request jsonb; key uuid;
  row jsonb; kind text; qty numeric; menu jsonb; ver integer; canonical_components jsonb;
BEGIN
  IF org IS NULL OR auth.uid() IS NULL OR NOT (public.is_org_admin() OR public.has_permission('kitchen','recipes.create')
    OR public.has_permission('kitchen','recipes.edit')) THEN RAISE EXCEPTION 'Not permitted to save recipes' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(_recipe) IS DISTINCT FROM 'object' OR (_components IS NOT NULL AND jsonb_typeof(_components)<>'array') THEN
    RAISE EXCEPTION 'Recipe and complete ingredient array required';
  END IF;
  canonical_components:=CASE WHEN _components IS NULL THEN NULL ELSE (
    SELECT COALESCE(jsonb_agg(value ORDER BY value->>'component_type',value->>'stock_item_id',value->>'sub_recipe_id',value->>'unit'),'[]'::jsonb)
      FROM jsonb_array_elements(_components)) END;
  request:=jsonb_build_object('recipe',_recipe,'components',canonical_components);
  key:=COALESCE(_attempt,md5(request::text)::uuid);
  PERFORM pg_advisory_xact_lock(hashtextextended('recipe-attempt:'||org::text||':'||key::text,17));
  SELECT * INTO prior FROM public.neo_recipe_sheet_attempts WHERE organization_id=org AND attempt_id=key;
  IF prior.recipe_id IS NOT NULL THEN
    IF prior.request IS DISTINCT FROM request THEN RAISE EXCEPTION 'Recipe attempt was reused for different input'; END IF;
    RETURN jsonb_build_object('recipe_id',prior.recipe_id,'replayed',true);
  END IF;
  rid:=NULLIF(_recipe->>'id','')::uuid;
  IF rid IS NOT NULL THEN
    SELECT * INTO r FROM public.recipes WHERE id=rid AND organization_id=org FOR UPDATE;
    IF r.id IS NULL OR NOT (r.branch_id IS NULL OR public.neo_branch_in_scope(r.branch_id)) THEN
      RAISE EXCEPTION 'Recipe not found in your property access' USING ERRCODE='42501'; END IF;
    IF r.status<>'draft' THEN RAISE EXCEPTION 'Create a new draft version before editing an approved recipe'; END IF;
  END IF;
  IF _recipe->>'operation'='append_components' THEN
    IF rid IS NULL OR _components IS NULL OR jsonb_array_length(_components)=0 THEN RAISE EXCEPTION 'Choose a draft and ingredient rows'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(_components) c JOIN public.recipe_ingredients i ON i.recipe_id=rid
      AND i.component_type=COALESCE(c->>'component_type','stock_item')
      AND COALESCE(i.stock_item_id,i.sub_recipe_id)=COALESCE(NULLIF(c->>'stock_item_id',''),NULLIF(c->>'sub_recipe_id',''))::uuid) THEN
      RAISE EXCEPTION 'This component already exists; edit its quantity instead of duplicating it'; END IF;
  ELSE
    bid:=NULLIF(_recipe->>'branch_id','')::uuid; mid:=NULLIF(_recipe->>'menu_item_id','')::uuid;
    sid:=NULLIF(_recipe->>'station_id','')::uuid; output_id:=NULLIF(_recipe->>'output_stock_item_id','')::uuid;
    kind:=COALESCE(_recipe->>'recipe_type','menu_item'); qty:=(_recipe->>'yield_quantity')::numeric;
    IF nullif(btrim(_recipe->>'name'),'') IS NULL OR qty IS NULL OR qty<=0 OR qty::text IN ('NaN','Infinity','-Infinity')
      OR nullif(btrim(_recipe->>'yield_unit'),'') IS NULL OR kind NOT IN ('menu_item','direct_sale','sub_recipe') THEN
      RAISE EXCEPTION 'Recipe needs a name, type and positive finite yield with unit'; END IF;
    IF rid IS NOT NULL AND bid IS DISTINCT FROM r.branch_id THEN RAISE EXCEPTION 'A recipe version cannot be moved between properties'; END IF;
    IF bid IS NULL AND NOT public.is_org_admin() THEN RAISE EXCEPTION 'Choose a property for this recipe' USING ERRCODE='42501'; END IF;
    IF bid IS NOT NULL AND NOT public.neo_branch_in_scope(bid) THEN RAISE EXCEPTION 'Property outside your access' USING ERRCODE='42501'; END IF;
    IF sid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.operational_stations WHERE id=sid AND organization_id=org AND (branch_id IS NULL OR branch_id=bid)) THEN
      RAISE EXCEPTION 'Production station does not belong to this property'; END IF;
    IF output_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.stock_items WHERE id=output_id AND organization_id=org AND (branch_id IS NULL OR branch_id=bid)) THEN
      RAISE EXCEPTION 'Output stock item does not belong to this property'; END IF;
    menu:=_recipe->'new_menu_item';
    IF mid IS NULL AND kind<>'sub_recipe' AND menu IS NOT NULL AND jsonb_typeof(menu)='object' THEN
      IF NULLIF(menu->>'category_id','') IS NULL OR NOT EXISTS(SELECT 1 FROM public.menu_categories WHERE id=(menu->>'category_id')::uuid AND organization_id=org)
        OR (menu->>'price')::numeric IS NULL OR (menu->>'price')::numeric<0 OR (menu->>'price')::numeric::text IN ('NaN','Infinity','-Infinity') THEN
        RAISE EXCEPTION 'New menu item needs an in-scope category and finite nonnegative price'; END IF;
      INSERT INTO public.menu_items(organization_id,branch_id,category_id,name,base_price,station_id,consumption_mode,publish_status,created_by)
        VALUES(org,bid,(menu->>'category_id')::uuid,btrim(_recipe->>'name'),(menu->>'price')::numeric,sid,'none','draft',auth.uid()) RETURNING id INTO mid;
    END IF;
    IF kind<>'sub_recipe' AND (mid IS NULL OR NOT EXISTS(SELECT 1 FROM public.menu_items WHERE id=mid AND organization_id=org AND branch_id IS NOT DISTINCT FROM bid)) THEN
      RAISE EXCEPTION 'Choose a menu item in the recipe property'; END IF;
    IF kind='direct_sale' AND output_id IS NULL THEN RAISE EXCEPTION 'Direct-sale recipe requires its stock item'; END IF;
    IF kind='sub_recipe' THEN mid:=NULL; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('recipe-version:'||org::text||':'||COALESCE(mid::text,btrim(_recipe->>'name')),18));
    IF rid IS NULL THEN
      SELECT COALESCE(max(version),0)+1 INTO ver FROM public.recipes WHERE organization_id=org AND
        ((mid IS NOT NULL AND menu_item_id=mid) OR (mid IS NULL AND name=btrim(_recipe->>'name') AND branch_id IS NOT DISTINCT FROM bid));
      INSERT INTO public.recipes(organization_id,branch_id,name,recipe_code,recipe_type,menu_item_id,station_id,output_stock_item_id,
        yield_quantity,yield_unit,prep_target_minutes,preparation_steps,status,version,created_by)
      VALUES(org,bid,btrim(_recipe->>'name'),NULLIF(btrim(_recipe->>'recipe_code'),''),kind,mid,sid,output_id,qty,btrim(_recipe->>'yield_unit'),
        NULLIF(_recipe->>'prep_target_minutes','')::integer,_recipe->>'preparation_steps','draft',ver,auth.uid()) RETURNING id INTO rid;
    ELSE
      UPDATE public.recipes SET name=btrim(_recipe->>'name'),recipe_code=NULLIF(btrim(_recipe->>'recipe_code'),''),recipe_type=kind,menu_item_id=mid,
        station_id=sid,output_stock_item_id=output_id,yield_quantity=qty,yield_unit=btrim(_recipe->>'yield_unit'),
        prep_target_minutes=NULLIF(_recipe->>'prep_target_minutes','')::integer,preparation_steps=_recipe->>'preparation_steps'
        WHERE id=rid AND organization_id=org;
    END IF;
    IF _components IS NOT NULL THEN DELETE FROM public.recipe_ingredients WHERE recipe_id=rid; END IF;
  END IF;
  IF _components IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(_components) c GROUP BY c->>'component_type',COALESCE(c->>'stock_item_id',c->>'sub_recipe_id') HAVING count(*)>1) THEN
      RAISE EXCEPTION 'Duplicate ingredient in this recipe sheet; review quantities before saving'; END IF;
    FOR row IN SELECT * FROM jsonb_array_elements(_components) LOOP
      INSERT INTO public.recipe_ingredients(organization_id,recipe_id,component_type,stock_item_id,sub_recipe_id,ingredient_name,quantity,unit,waste_allowance)
      VALUES(org,rid,COALESCE(row->>'component_type','stock_item'),NULLIF(row->>'stock_item_id','')::uuid,NULLIF(row->>'sub_recipe_id','')::uuid,
        row->>'ingredient_name',(row->>'quantity')::numeric,row->>'unit',COALESCE((row->>'waste_allowance')::numeric,0));
    END LOOP;
  END IF;
  INSERT INTO public.neo_recipe_sheet_attempts VALUES(org,key,rid,request,auth.uid());
  RETURN jsonb_build_object('recipe_id',rid,'menu_item_id',mid,'status','draft','replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.neo_recipe_sheet_save(jsonb,jsonb,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_recipe_sheet_save(jsonb,jsonb,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_recipe_activate(_recipe uuid,_menu_item uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE org uuid:=public.current_org_id(); r public.recipes; target uuid; previous uuid; prior_activation text;
BEGIN
  IF org IS NULL OR auth.uid() IS NULL OR NOT (public.is_org_admin() OR public.has_permission('kitchen','recipes.approve')) THEN
    RAISE EXCEPTION 'Not permitted to approve recipes' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM public.recipes WHERE id=_recipe AND organization_id=org;
  IF r.id IS NULL OR NOT (r.branch_id IS NULL OR public.neo_branch_in_scope(r.branch_id)) THEN RAISE EXCEPTION 'Recipe outside property access' USING ERRCODE='42501'; END IF;
  target:=COALESCE(_menu_item,r.menu_item_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('recipe-activation:'||org::text||':'||COALESCE(target::text,r.id::text),19));
  SELECT * INTO r FROM public.recipes WHERE id=_recipe AND organization_id=org FOR UPDATE;
  IF r.status='active' AND target IS NOT DISTINCT FROM r.menu_item_id THEN RETURN jsonb_build_object('recipe_id',r.id,'replayed',true); END IF;
  IF r.status<>'draft' THEN RAISE EXCEPTION 'Only a reviewed draft can be activated; do not move an approved version'; END IF;
  IF r.branch_id IS NULL AND NOT public.is_org_admin() THEN RAISE EXCEPTION 'Global recipe approval requires organization administration' USING ERRCODE='42501'; END IF;
  IF r.yield_quantity IS NULL OR r.yield_quantity<=0 OR r.yield_quantity::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Recipe has no valid finite yield'; END IF;
  IF r.station_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.operational_stations WHERE id=r.station_id AND organization_id=org AND (branch_id IS NULL OR branch_id=r.branch_id)) THEN
    RAISE EXCEPTION 'Recipe station is outside this property'; END IF;
  IF r.recipe_type='direct_sale' AND (r.output_stock_item_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.stock_items WHERE id=r.output_stock_item_id AND organization_id=org AND (branch_id IS NULL OR branch_id=r.branch_id))) THEN
    RAISE EXCEPTION 'Direct-sale recipe needs an in-scope stock item'; END IF;
  IF r.recipe_type='direct_sale' AND EXISTS(SELECT 1 FROM public.recipe_ingredients WHERE recipe_id=r.id) THEN
    RAISE EXCEPTION 'Direct-sale mapping cannot also contain a recipe ingredient sheet'; END IF;
  IF r.recipe_type<>'sub_recipe' THEN
    PERFORM 1 FROM public.menu_items WHERE id=target AND organization_id=org AND branch_id IS NOT DISTINCT FROM r.branch_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Menu item outside recipe property'; END IF;
  ELSIF target IS NOT NULL THEN RAISE EXCEPTION 'A batch sub-recipe does not attach to a menu item'; END IF;
  IF r.recipe_type<>'direct_sale' AND NOT EXISTS(SELECT 1 FROM public.recipe_ingredients WHERE recipe_id=r.id) THEN
    RAISE EXCEPTION 'A recipe needs its complete ingredient sheet before approval'; END IF;
  IF EXISTS(
    WITH RECURSIVE walk(id,path,cycle) AS (
      SELECT r.id,ARRAY[r.id],false UNION ALL
      SELECT i.sub_recipe_id,w.path||i.sub_recipe_id,i.sub_recipe_id=ANY(w.path)
      FROM walk w JOIN public.recipe_ingredients i ON i.recipe_id=w.id
      WHERE i.component_type='sub_recipe' AND NOT w.cycle AND cardinality(w.path)<=11
    ) SELECT 1 FROM walk w LEFT JOIN public.recipes child ON child.id=w.id
      WHERE w.cycle OR cardinality(w.path)>11 OR child.id IS NULL OR child.organization_id IS DISTINCT FROM org
        OR NOT(child.branch_id IS NULL OR child.branch_id=r.branch_id)
        OR (child.id<>r.id AND child.status<>'active')
  ) THEN RAISE EXCEPTION 'Recipe contains a cycle, excessive nesting or an out-of-scope sub-recipe'; END IF;
  IF EXISTS(
    WITH RECURSIVE walk(id) AS (SELECT r.id UNION SELECT i.sub_recipe_id FROM walk w JOIN public.recipe_ingredients i ON i.recipe_id=w.id WHERE i.component_type='sub_recipe')
    SELECT 1 FROM walk w JOIN public.recipe_ingredients i ON i.recipe_id=w.id LEFT JOIN public.stock_items s ON s.id=i.stock_item_id
      WHERE i.component_type='stock_item' AND (s.id IS NULL OR s.organization_id IS DISTINCT FROM org OR NOT(s.branch_id IS NULL OR s.branch_id=r.branch_id))
  ) THEN RAISE EXCEPTION 'Recipe contains an out-of-scope stock component'; END IF;
  IF target IS NOT NULL THEN
    SELECT id INTO previous FROM public.recipes WHERE organization_id=org AND menu_item_id=target AND status='active' FOR UPDATE;
    UPDATE public.recipes SET status='superseded',effective_to=now() WHERE organization_id=org AND menu_item_id=target AND status='active';
  END IF;
  prior_activation:=COALESCE(current_setting('neo.recipe.activation',true),'');
  PERFORM set_config('neo.recipe.activation',r.id::text,true);
  UPDATE public.recipes SET status='active',menu_item_id=target,approved_by=auth.uid(),approved_at=now(),supersedes_id=previous WHERE id=r.id;
  -- Canonical expansion validates units, yields, cycles and active sub-recipes.
  -- An exception rolls back superseding, activation and menu binding together.
  PERFORM * FROM public.recipe_expand_to_stock_kinds(r.id,1,r.branch_id,'{}'::uuid[]);
  IF target IS NOT NULL THEN
    UPDATE public.menu_items SET consumption_mode=CASE WHEN r.recipe_type='direct_sale' THEN 'direct_stock' ELSE 'recipe' END,
      stock_item_id=CASE WHEN r.recipe_type='direct_sale' THEN r.output_stock_item_id ELSE NULL END WHERE id=target AND organization_id=org;
  END IF;
  PERFORM set_config('neo.recipe.activation',prior_activation,true);
  RETURN jsonb_build_object('recipe_id',r.id,'status','active','previous_recipe_id',previous,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.neo_recipe_activate(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_recipe_activate(uuid,uuid) TO authenticated;
COMMIT;
