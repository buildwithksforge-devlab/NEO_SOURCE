BEGIN;

ALTER TABLE public.tax_codes
  ADD COLUMN sales_calculation text NOT NULL DEFAULT 'percentage'
    CHECK (sales_calculation IN ('percentage','fixed')),
  ADD COLUMN sales_fixed_amount numeric(12,2) NOT NULL DEFAULT 0
    CHECK (sales_fixed_amount >= 0 AND sales_fixed_amount::text NOT IN ('NaN','Infinity','-Infinity')),
  ADD COLUMN sales_description text NOT NULL DEFAULT '';

CREATE TABLE public.sales_tax_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  treatment text NOT NULL DEFAULT 'standard' CHECK (treatment IN ('standard','exempt','none')),
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'array'),
  active boolean NOT NULL DEFAULT true,
  workspace_default boolean NOT NULL DEFAULT false CHECK (active OR NOT workspace_default),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name),
  UNIQUE (organization_id, id),
  CHECK ((treatment = 'standard') = (jsonb_array_length(rules) > 0))
);
CREATE UNIQUE INDEX sales_tax_one_workspace_default ON public.sales_tax_profiles(organization_id)
  WHERE workspace_default;
ALTER TABLE public.sales_tax_profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.sales_tax_profiles TO authenticated;
GRANT ALL ON public.sales_tax_profiles TO service_role;
CREATE POLICY sales_tax_profile_read ON public.sales_tax_profiles FOR SELECT TO authenticated USING (
  organization_id = public.current_org_id() AND
  (public.is_org_admin() OR public.has_permission('finance','view') OR public.has_permission('pos','view'))
);
CREATE POLICY sales_tax_profile_create ON public.sales_tax_profiles FOR INSERT TO authenticated WITH CHECK (
  organization_id = public.current_org_id() AND (public.is_org_admin() OR public.has_permission('finance','create'))
);
CREATE POLICY sales_tax_profile_update ON public.sales_tax_profiles FOR UPDATE TO authenticated USING (
  organization_id = public.current_org_id() AND (public.is_org_admin() OR public.has_permission('finance','edit'))
) WITH CHECK (organization_id = public.current_org_id());

ALTER TABLE public.menu_items ADD COLUMN sales_tax_profile_id uuid;
ALTER TABLE public.menu_items ADD CONSTRAINT menu_items_sales_tax_profile
  FOREIGN KEY (organization_id, sales_tax_profile_id)
  REFERENCES public.sales_tax_profiles(organization_id,id);
ALTER TABLE public.menu_categories ADD COLUMN sales_tax_profile_id uuid;
ALTER TABLE public.menu_categories ADD CONSTRAINT menu_categories_sales_tax_profile
  FOREIGN KEY (organization_id, sales_tax_profile_id)
  REFERENCES public.sales_tax_profiles(organization_id,id);
ALTER TABLE public.pos_order_items ADD COLUMN sales_tax_snapshot jsonb;

CREATE FUNCTION public.neo_sales_tax_guard_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE rule jsonb; codes text[] := '{}'; key text;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.organization_id,OLD.id) IS DISTINCT FROM (NEW.organization_id,NEW.id) THEN
    RAISE EXCEPTION 'A tax profile cannot move to a different workspace or identity';
  END IF;
  IF NOT NEW.active AND (EXISTS(SELECT 1 FROM public.menu_items WHERE sales_tax_profile_id=NEW.id)
    OR EXISTS(SELECT 1 FROM public.menu_categories WHERE sales_tax_profile_id=NEW.id)) THEN
    RAISE EXCEPTION 'Remove this profile from menu items and categories before archiving it';
  END IF;
  NEW.updated_at := now();
  FOR rule IN SELECT value FROM jsonb_array_elements(NEW.rules) LOOP
    key := nullif(btrim(rule->>'code'),'');
    IF key IS NULL OR key = ANY(codes) OR jsonb_typeof(rule) <> 'object'
      OR (rule ? 'compound_on_prior' AND jsonb_typeof(rule->'compound_on_prior') <> 'boolean')
      OR NOT EXISTS (
        SELECT 1 FROM public.tax_codes t WHERE t.organization_id=NEW.organization_id
        AND t.code=key AND t.treatment IN ('standard','zero_rated','exempt')
      ) THEN
      RAISE EXCEPTION 'Choose distinct sales tax codes in the order they apply';
    END IF;
    codes := array_append(codes,key);
  END LOOP;
  RETURN NEW;
END
$$;
CREATE TRIGGER sales_tax_profile_validate BEFORE INSERT OR UPDATE ON public.sales_tax_profiles
  FOR EACH ROW EXECUTE FUNCTION public.neo_sales_tax_guard_profile();

CREATE FUNCTION public.neo_menu_sales_tax_profile(_org uuid,_branch uuid,_item uuid,_inherit_only boolean DEFAULT false)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(CASE WHEN NOT _inherit_only THEN m.sales_tax_profile_id END,c.sales_tax_profile_id,p.id)
  FROM public.menu_items m
  LEFT JOIN public.menu_categories c ON c.id=m.category_id AND c.organization_id=m.organization_id
  LEFT JOIN public.sales_tax_profiles p ON p.organization_id=m.organization_id AND p.workspace_default
  WHERE m.id=_item AND m.organization_id=_org AND (m.branch_id IS NULL OR m.branch_id=_branch)
$$;

CREATE FUNCTION public.neo_sales_tax_price(
  _org uuid, _branch uuid, _profile uuid, _date date, _price numeric, _qty numeric, _discount numeric
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE profile public.sales_tax_profiles; configured jsonb; tax_code public.tax_codes;
  rules jsonb := '[]'; accounts jsonb := '{}'; versions jsonb := '{}'; result jsonb;
BEGIN
  IF _profile IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO STRICT profile FROM public.sales_tax_profiles p
    WHERE p.id=_profile AND p.organization_id=_org AND p.active;
  FOR configured IN SELECT value FROM jsonb_array_elements(profile.rules) LOOP
    SELECT * INTO tax_code FROM public.tax_codes t WHERE t.organization_id=_org
      AND (t.branch_id IS NULL OR t.branch_id=_branch)
      AND t.code=configured->>'code' AND t.active AND t.effective_from<=_date
      AND (t.effective_to IS NULL OR t.effective_to>=_date)
    ORDER BY (t.branch_id IS NOT NULL) DESC,t.effective_from DESC,t.id LIMIT 1;
    IF NOT FOUND OR tax_code.treatment NOT IN ('standard','zero_rated','exempt') THEN
      RAISE EXCEPTION 'No effective sales tax rule for %', configured->>'code';
    END IF;
    IF tax_code.treatment='standard' AND (tax_code.rate>0 OR tax_code.sales_fixed_amount>0) AND NOT EXISTS (
      SELECT 1 FROM public.chart_of_accounts a WHERE a.id=tax_code.tax_account_id
      AND a.organization_id=_org AND a.active AND a.postable AND NOT a.is_header AND a.category='liability'
    ) THEN RAISE EXCEPTION 'Configure an active tax liability account for %', tax_code.code; END IF;
    accounts := accounts || jsonb_build_object(tax_code.code,tax_code.tax_account_id);
    versions := versions || jsonb_build_object(tax_code.code,tax_code.id);
    rules := rules || jsonb_build_array(jsonb_build_object(
      'code', tax_code.code, 'name', tax_code.name, 'treatment', tax_code.treatment,
      'value', CASE WHEN tax_code.sales_calculation='fixed' THEN tax_code.sales_fixed_amount ELSE tax_code.rate END,
      'method', tax_code.sales_calculation,
      'inclusive', tax_code.inclusive, 'compound_on_prior', coalesce((configured->>'compound_on_prior')::boolean,false)
    ));
  END LOOP;
  result := public.neo_tax_calculate_line(_price,_qty,_discount,rules);
  RETURN result || jsonb_build_object('profile_id',_profile,'treatment',profile.treatment,
    'rules',rules,'accounts',accounts,'versions',versions);
END
$$;

CREATE FUNCTION public.neo_sales_tax_pos_line()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE sale public.pos_orders; profile uuid; snapshot jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.sales_tax_snapshot IS DISTINCT FROM OLD.sales_tax_snapshot THEN
      RAISE EXCEPTION 'Saved tax evidence cannot be supplied or replaced';
    END IF;
    IF OLD.sales_tax_snapshot IS NULL THEN RETURN NEW; END IF;
    IF NEW.menu_item_id IS DISTINCT FROM OLD.menu_item_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.order_id IS DISTINCT FROM OLD.order_id THEN RAISE EXCEPTION 'Saved tax scope cannot change'; END IF;
    IF
      (NEW.quantity,NEW.unit_price,NEW.modifier_total,NEW.discount_amount,NEW.tax_amount,NEW.line_total)
      IS NOT DISTINCT FROM
      (OLD.quantity,OLD.unit_price,OLD.modifier_total,OLD.discount_amount,OLD.tax_amount,OLD.line_total) THEN
      RETURN NEW;
    END IF;
    snapshot := public.neo_tax_calculate_line(NEW.unit_price+NEW.modifier_total,NEW.quantity,
      NEW.discount_amount,OLD.sales_tax_snapshot->'rules');
    snapshot := OLD.sales_tax_snapshot || snapshot;
  ELSE
    IF NEW.sales_tax_snapshot IS NOT NULL THEN RAISE EXCEPTION 'Saved tax evidence is calculated by the server'; END IF;
    SELECT * INTO STRICT sale FROM public.pos_orders o WHERE o.id=NEW.order_id AND o.organization_id=NEW.organization_id;
    profile := public.neo_menu_sales_tax_profile(sale.organization_id,sale.branch_id,NEW.menu_item_id);
    IF profile IS NULL THEN RETURN NEW; END IF;
    snapshot := public.neo_sales_tax_price(sale.organization_id,sale.branch_id,profile,
      (now() AT TIME ZONE public.neo_fact_timezone(sale.organization_id,sale.branch_id))::date,
      NEW.unit_price+NEW.modifier_total,NEW.quantity,NEW.discount_amount);
  END IF;
  NEW.sales_tax_snapshot := snapshot;
  NEW.tax_amount := (snapshot->>'included_tax')::numeric + (snapshot->>'added_tax')::numeric;
  NEW.line_total := (snapshot->>'total')::numeric;
  RETURN NEW;
END
$$;
CREATE TRIGGER zz_neo_sales_tax_pos_line BEFORE INSERT OR UPDATE ON public.pos_order_items
  FOR EACH ROW EXECUTE FUNCTION public.neo_sales_tax_pos_line();

CREATE FUNCTION public.neo_sales_tax_guard_code() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM public.pos_order_items i
      CROSS JOIN LATERAL jsonb_each_text(i.sales_tax_snapshot->'versions') v
      WHERE i.organization_id=OLD.organization_id AND v.value=OLD.id::text)
      OR EXISTS(SELECT 1 FROM public.sales_tax_profiles p WHERE p.organization_id=OLD.organization_id
        AND p.rules @> jsonb_build_array(jsonb_build_object('code',OLD.code))) THEN
      RAISE EXCEPTION 'This code is referenced by a sales profile or a posted sale. Preserve its history.';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.sales_calculation='fixed' AND NEW.rate<>0 THEN
    RAISE EXCEPTION 'A fixed sales tax stores its per-unit amount separately from the percentage rate';
  END IF;
  IF NEW.rate::text IN ('NaN','Infinity','-Infinity') OR NEW.rate<0
    OR (NEW.effective_to IS NOT NULL AND NEW.effective_to<NEW.effective_from) THEN
    RAISE EXCEPTION 'Invalid tax rate or effective date range';
  END IF;
  IF NEW.tax_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts a WHERE a.id=NEW.tax_account_id AND a.organization_id=NEW.organization_id
  ) THEN RAISE EXCEPTION 'Tax account belongs to a different workspace'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER neo_sales_tax_preserve_code BEFORE INSERT OR UPDATE OR DELETE ON public.tax_codes
  FOR EACH ROW EXECUTE FUNCTION public.neo_sales_tax_guard_code();

CREATE FUNCTION public.neo_preview_menu_sales_tax(_item uuid, _profile uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE item public.menu_items;
BEGIN
  SELECT * INTO STRICT item FROM public.menu_items m WHERE m.id=_item AND m.organization_id=public.current_org_id();
  IF NOT (public.is_org_admin() OR public.has_permission('finance','view') OR public.has_permission('pos','view'))
    OR (item.branch_id IS NOT NULL AND NOT coalesce(public.neo_branch_in_scope(item.branch_id),false)) THEN
    RAISE EXCEPTION 'Menu tax is out of scope' USING ERRCODE='42501';
  END IF;
  RETURN public.neo_sales_tax_price(item.organization_id,item.branch_id,
    coalesce(_profile,public.neo_menu_sales_tax_profile(item.organization_id,item.branch_id,item.id,true)),
    (now() AT TIME ZONE public.neo_fact_timezone(item.organization_id,item.branch_id))::date,item.base_price,1,0);
END
$$;
REVOKE ALL ON FUNCTION public.neo_sales_tax_guard_profile(), public.neo_sales_tax_guard_code(), public.neo_sales_tax_pos_line(),
  public.neo_menu_sales_tax_profile(uuid,uuid,uuid,boolean),
  public.neo_sales_tax_price(uuid,uuid,uuid,date,numeric,numeric,numeric),
  public.neo_preview_menu_sales_tax(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_preview_menu_sales_tax(uuid,uuid) TO authenticated;
COMMIT;
