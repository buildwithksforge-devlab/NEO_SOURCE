-- 1. Purchase request totals always follow their priced lines
CREATE OR REPLACE FUNCTION public.neo_purchase_request_recalc_total()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE _req uuid := COALESCE(NEW.request_id, OLD.request_id);
BEGIN
  IF _req IS NOT NULL THEN
    UPDATE public.purchase_requests pr
       SET estimated_total = COALESCE((
             SELECT sum(l.quantity * COALESCE(l.estimated_unit_price,0))
               FROM public.purchase_request_lines l
              WHERE l.request_id = _req), 0),
           updated_at = now()
     WHERE pr.id = _req;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_purchase_request_lines_total ON public.purchase_request_lines;
CREATE TRIGGER trg_purchase_request_lines_total
AFTER INSERT OR UPDATE OF quantity, estimated_unit_price OR DELETE
ON public.purchase_request_lines
FOR EACH ROW EXECUTE FUNCTION public.neo_purchase_request_recalc_total();

-- 2. Refuse approval when the stored total disagrees with the lines
CREATE OR REPLACE FUNCTION public.neo_procurement_request_decide(_request uuid, _decision text, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _r record; _status text; _lines numeric;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  IF lower(coalesce(_decision,'')) NOT IN ('approve','reject') THEN
    RAISE EXCEPTION 'invalid_decision' USING ERRCODE='22023';
  END IF;
  SELECT * INTO _r FROM public.purchase_requests WHERE id=_request AND organization_id=_org FOR UPDATE;
  IF _r IS NULL THEN RAISE EXCEPTION 'request_not_found' USING ERRCODE='22023'; END IF;
  IF NOT public.neo_branch_in_scope(_r.branch_id) THEN RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE='42501'; END IF;
  IF NOT (public.has_permission('procurement','requests.approve') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;
  IF _r.requested_by = auth.uid() AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'self_approval_refused' USING ERRCODE='42501';
  END IF;
  IF _r.status <> 'pending_approval' THEN RAISE EXCEPTION 'request_not_pending' USING ERRCODE='22023'; END IF;
  IF lower(_decision)='reject' AND nullif(btrim(coalesce(_reason,'')),'') IS NULL THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE='22023';
  END IF;

  IF lower(_decision)='approve' THEN
    SELECT COALESCE(sum(quantity * COALESCE(estimated_unit_price,0)),0) INTO _lines
      FROM public.purchase_request_lines WHERE request_id=_r.id;
    IF round(COALESCE(_r.estimated_total,0),2) <> round(_lines,2) THEN
      RAISE EXCEPTION 'request_total_mismatch' USING ERRCODE='22023';
    END IF;
  END IF;

  _status := CASE WHEN lower(_decision)='approve' THEN 'approved' ELSE 'rejected' END;
  UPDATE public.purchase_requests
     SET status=_status, approved_by=auth.uid(), approved_at=now(),
         justification = COALESCE(justification,'') ||
           CASE WHEN _reason IS NULL THEN '' ELSE E'\n['||_status||'] '||_reason END,
         updated_at=now()
   WHERE id=_request;

  INSERT INTO public.audit_logs (organization_id, branch_id, module, action, record_id, user_id, reason, new_value)
  VALUES (_org, _r.branch_id, 'procurement', 'request.'||_status, _request::text, auth.uid(), _reason,
          jsonb_build_object('status', _status));

  RETURN jsonb_build_object('ok',true,'request_id',_request,'status',_status);
END $function$;

-- 3. Menu catalogue understands direct-from-stock items
DROP FUNCTION IF EXISTS public.neo_menu_catalogue(uuid, boolean);
CREATE FUNCTION public.neo_menu_catalogue(_branch uuid DEFAULT NULL::uuid, _include_drafts boolean DEFAULT false)
 RETURNS TABLE(id uuid, name text, sku text, description text, currency text, image_url text, prep_minutes integer, recipe_status text, recipe_id uuid, direct_stock_item_id uuid, direct_stock_item_name text, direct_stock_unit text, direct_stock_quantity numeric, category_id uuid, category_name text, menu_id uuid, menu_name text, menu_outlet text, base_price numeric, tax_rate numeric, availability text, publish_status text, branch_id uuid, branch_name text, department_id uuid, department_name text, station_id uuid, station_name text, station_source text, station_missing boolean, assigned_station_id uuid, imported boolean, import_batch_id uuid, import_file_name text, import_batch_status text, published_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id();
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  IF NOT public.has_permission('pos','menu','view') THEN
    RAISE EXCEPTION 'Not permitted to view the menu catalogue';
  END IF;

  RETURN QUERY
  WITH src AS (
    SELECT mi.*, mc.name AS cat_name, m.id AS menu_ident, m.name AS menu_nm, m.outlet AS menu_out,
           b.file_name AS batch_file, b.status AS batch_status,
           br.name AS branch_nm,
           rc.id AS rec_id,
           rc.ingredient_count,
           rc.recipe_type AS rec_type,
           rc.output_stock_item_id AS rec_output,
           rc.yield_quantity AS rec_yield,
           rc.yield_unit AS rec_yield_unit,
           public.neo_kitchen_resolve_station(_org, coalesce(mi.branch_id, _branch), mi.id, mi.category_id, NULL, NULL) AS res
      FROM public.menu_items mi
      LEFT JOIN public.menu_categories mc ON mc.id = mi.category_id
      LEFT JOIN public.menus m ON m.id = mc.menu_id
      LEFT JOIN public.menu_import_batches b ON b.id = mi.import_batch_id
      LEFT JOIN public.branches br ON br.id = mi.branch_id
      LEFT JOIN LATERAL (
        SELECT r.id, r.recipe_type, r.output_stock_item_id, r.yield_quantity, r.yield_unit,
               (SELECT count(*) FROM public.recipe_ingredients ri WHERE ri.recipe_id = r.id) AS ingredient_count
          FROM public.recipes r
         WHERE r.menu_item_id = mi.id AND r.organization_id = _org
         ORDER BY r.version DESC NULLS LAST, r.created_at DESC
         LIMIT 1
      ) rc ON true
     WHERE mi.organization_id = _org
       AND (_include_drafts OR mi.publish_status = 'published')
       AND (_branch IS NULL OR mi.branch_id IS NULL OR mi.branch_id = _branch)
       AND public.neo_branch_in_scope(mi.branch_id)
  )
  SELECT r.id, r.name, r.sku, r.description, r.currency, r.image_url, r.prep_minutes,
         CASE WHEN r.rec_id IS NULL THEN 'not-linked'
              WHEN r.rec_type = 'direct_sale' AND r.rec_output IS NOT NULL THEN 'direct-stock'
              WHEN coalesce(r.ingredient_count,0) = 0 THEN 'incomplete'
              ELSE 'linked' END,
         r.rec_id,
         CASE WHEN r.rec_type = 'direct_sale' THEN r.rec_output END,
         CASE WHEN r.rec_type = 'direct_sale' THEN si.name END,
         CASE WHEN r.rec_type = 'direct_sale' THEN coalesce(nullif(r.rec_yield_unit,''), si.base_unit) END,
         CASE WHEN r.rec_type = 'direct_sale' THEN coalesce(r.rec_yield, 1) END,
         r.category_id, r.cat_name, r.menu_ident, r.menu_nm, coalesce(r.menu_out,'all'),
         r.base_price, r.tax_rate, r.availability, r.publish_status,
         r.branch_id, r.branch_nm,
         st.department_id, dp.name,
         nullif(r.res->>'station_id','')::uuid,
         st.name,
         r.res->>'source',
         (r.res->>'missing')::boolean,
         r.station_id,
         r.import_batch_id IS NOT NULL,
         r.import_batch_id, r.batch_file, r.batch_status,
         r.published_at, r.updated_at
    FROM src r
    LEFT JOIN public.stock_items si ON si.id = r.rec_output
    LEFT JOIN public.operational_stations st ON st.id = nullif(r.res->>'station_id','')::uuid
    LEFT JOIN public.departments dp ON dp.id = st.department_id
   ORDER BY r.branch_nm NULLS FIRST, r.cat_name NULLS LAST, r.name;
END $function$;

GRANT EXECUTE ON FUNCTION public.neo_menu_catalogue(uuid, boolean) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.neo_menu_catalogue(uuid, boolean) FROM anon;