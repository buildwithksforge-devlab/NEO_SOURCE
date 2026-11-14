-- Existing item insert endpoint; no new RPC/API. The selected modifiers and
-- their item are committed together, before totals and ticket routing triggers.
BEGIN;
ALTER TABLE public.pos_order_items ADD COLUMN IF NOT EXISTS selection_modifiers jsonb;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='pos_order_items'
     AND column_name='selection_modifiers' AND data_type='jsonb') THEN
  RAISE EXCEPTION 'POS selection snapshot column has an unexpected type';
 END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.neo_pos_selection_modifiers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE choice jsonb; option_row record; group_row record;
 total numeric:=0; choices jsonb:='[]'; selected_count integer;
BEGIN
 IF TG_WHEN='BEFORE' THEN
  IF TG_OP='UPDATE' THEN
   IF NEW.selection_modifiers IS DISTINCT FROM OLD.selection_modifiers THEN
    RAISE EXCEPTION 'Saved item selections cannot be rewritten. Remove an unpaid draft and add the corrected selection.';
   END IF;
   RETURN NEW;
  END IF;
  -- NULL preserves existing server-side order creators that already write
  -- their own complete selections in one database transaction.
  IF NEW.selection_modifiers IS NULL THEN RETURN NEW; END IF;
  IF jsonb_typeof(NEW.selection_modifiers)<>'array' OR jsonb_array_length(NEW.selection_modifiers)>100 THEN
   RAISE EXCEPTION 'Item selections must be a bounded array';
  END IF;
  IF NEW.quantity IS NULL OR NEW.quantity<=0 OR NEW.quantity::text IN ('NaN','Infinity','-Infinity')
     OR NEW.unit_price IS NULL OR NEW.unit_price<0 OR NEW.unit_price::text IN ('NaN','Infinity','-Infinity')
     OR NEW.tax_rate IS NULL OR NEW.tax_rate<0 OR NEW.tax_rate::text IN ('NaN','Infinity','-Infinity') THEN
   RAISE EXCEPTION 'Item quantity, price and tax must be finite and valid';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(NEW.selection_modifiers)) <>
     (SELECT count(DISTINCT x->>'option_id') FROM jsonb_array_elements(NEW.selection_modifiers)x) THEN
   RAISE EXCEPTION 'Each modifier option may be selected only once';
  END IF;
  FOR choice IN SELECT value FROM jsonb_array_elements(NEW.selection_modifiers) LOOP
   SELECT o.id,o.group_id,o.name,o.extra_charge,g.name group_name INTO option_row
   FROM public.modifier_options o JOIN public.modifier_groups g
     ON g.id=o.group_id AND g.organization_id=o.organization_id
   JOIN public.menu_item_modifier_groups m ON m.group_id=g.id AND m.organization_id=g.organization_id
   WHERE o.id=(choice->>'option_id')::uuid AND g.id=(choice->>'group_id')::uuid
     AND o.organization_id=NEW.organization_id AND m.menu_item_id=NEW.menu_item_id
     AND o.active IS TRUE AND g.active IS TRUE FOR SHARE OF o,g,m;
   IF NOT FOUND THEN RAISE EXCEPTION 'Selected modifier is unavailable or does not belong to this menu item'; END IF;
   IF option_row.extra_charge IS NULL OR option_row.extra_charge<0
      OR option_row.extra_charge::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Selected modifier has an invalid catalogue price';
   END IF;
   total:=total+option_row.extra_charge;
   choices:=choices||jsonb_build_array(jsonb_build_object('group_id',option_row.group_id,
    'option_id',option_row.id,'group_name',option_row.group_name,
    'option_name',option_row.name,'extra_charge',option_row.extra_charge));
  END LOOP;
  FOR group_row IN SELECT g.* FROM public.modifier_groups g
    JOIN public.menu_item_modifier_groups m ON m.group_id=g.id AND m.organization_id=g.organization_id
    WHERE m.menu_item_id=NEW.menu_item_id AND g.organization_id=NEW.organization_id
      AND g.active IS TRUE FOR SHARE OF g,m LOOP
   SELECT count(*) INTO selected_count FROM jsonb_array_elements(choices)x
     WHERE (x->>'group_id')::uuid=group_row.id;
   IF selected_count<greatest(coalesce(group_row.min_select,0),CASE WHEN group_row.required THEN 1 ELSE 0 END)
      OR (group_row.multi_select IS NOT TRUE AND selected_count>1)
      OR (coalesce(group_row.max_select,0)>0 AND selected_count>group_row.max_select) THEN
    RAISE EXCEPTION 'Selection count is outside the configured limits for %',group_row.name;
   END IF;
  END LOOP;
  NEW.selection_modifiers:=choices;
  NEW.modifier_total:=total;
  IF coalesce(NEW.discount_amount,0)<0 OR coalesce(NEW.discount_amount,0)::text IN ('NaN','Infinity','-Infinity') THEN
   RAISE EXCEPTION 'Invalid item discount';
  END IF;
  NEW.line_total:=round(greatest(0,NEW.quantity*(NEW.unit_price+total)-coalesce(NEW.discount_amount,0)),2);
  NEW.tax_amount:=round(NEW.line_total*NEW.tax_rate/(100+NEW.tax_rate),2);
  RETURN NEW;
 END IF;
 IF NEW.selection_modifiers IS NOT NULL THEN
  INSERT INTO public.pos_order_item_modifiers
   (organization_id,order_item_id,group_id,option_id,group_name,option_name,extra_charge)
  SELECT NEW.organization_id,NEW.id,(x->>'group_id')::uuid,(x->>'option_id')::uuid,
    x->>'group_name',x->>'option_name',(x->>'extra_charge')::numeric
  FROM jsonb_array_elements(NEW.selection_modifiers)x;
 END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.neo_pos_selection_modifiers() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS neo_pos_selection_validate_trg ON public.pos_order_items;
CREATE TRIGGER neo_pos_selection_validate_trg BEFORE INSERT OR UPDATE ON public.pos_order_items
 FOR EACH ROW EXECUTE FUNCTION public.neo_pos_selection_modifiers();
DROP TRIGGER IF EXISTS neo_pos_selection_persist_trg ON public.pos_order_items;
CREATE TRIGGER neo_pos_selection_persist_trg AFTER INSERT ON public.pos_order_items
 FOR EACH ROW EXECUTE FUNCTION public.neo_pos_selection_modifiers();
NOTIFY pgrst,'reload schema';
COMMIT;
