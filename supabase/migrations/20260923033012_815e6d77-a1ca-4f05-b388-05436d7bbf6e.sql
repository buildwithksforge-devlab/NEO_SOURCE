CREATE OR REPLACE FUNCTION public.neo_stock_item_save(_id uuid, _branch uuid, _payload jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_scope uuid[] := public.current_branch_ids();
  v_name text := nullif(btrim(coalesce(_payload->>'name','')), '');
  v_sku text := nullif(btrim(coalesce(_payload->>'sku','')), '');
  v_barcode text := nullif(btrim(coalesce(_payload->>'barcode','')), '');
  v_category uuid := nullif(_payload->>'category_id','')::uuid;
  v_location uuid := nullif(_payload->>'default_location_id','')::uuid;
  v_supplier uuid := nullif(_payload->>'preferred_supplier_id','')::uuid;
  v_existing public.stock_items;
  v_id uuid;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'No workspace in context.';
  END IF;
  IF NOT public.has_permission('inventory', '*', 'items.manage') THEN
    RAISE EXCEPTION 'Not permitted to create or change inventory items.';
  END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'An item name is required.';
  END IF;

  IF _branch IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = _branch AND b.organization_id = v_org) THEN
      RAISE EXCEPTION 'That property does not belong to this workspace.';
    END IF;
    IF v_scope IS NOT NULL AND array_length(v_scope, 1) IS NOT NULL AND NOT (_branch = ANY (v_scope)) THEN
      RAISE EXCEPTION 'You do not have access to that property.';
    END IF;
  END IF;

  IF v_category IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.stock_categories c WHERE c.id = v_category AND c.organization_id = v_org
  ) THEN
    RAISE EXCEPTION 'That stock category does not belong to this workspace.';
  END IF;

  IF v_location IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.stock_locations l
    WHERE l.id = v_location AND l.organization_id = v_org
      AND (_branch IS NULL OR l.branch_id IS NULL OR l.branch_id = _branch)
  ) THEN
    RAISE EXCEPTION 'That store does not belong to the selected property.';
  END IF;

  IF v_supplier IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.suppliers s WHERE s.id = v_supplier AND s.organization_id = v_org
  ) THEN
    RAISE EXCEPTION 'That supplier does not belong to this workspace.';
  END IF;

  IF _id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.stock_items WHERE id = _id;
    IF v_existing.id IS NULL OR v_existing.organization_id <> v_org THEN
      RAISE EXCEPTION 'That inventory item is not in this workspace.';
    END IF;
  END IF;

  -- Duplicate protection: name within the property, SKU and barcode within the workspace.
  IF EXISTS (
    SELECT 1 FROM public.stock_items i
    WHERE i.organization_id = v_org
      AND (_id IS NULL OR i.id <> _id)
      AND lower(i.name) = lower(v_name)
      AND i.branch_id IS NOT DISTINCT FROM _branch
  ) THEN
    RAISE EXCEPTION 'An item called "%" already exists for this property.', v_name;
  END IF;

  IF v_sku IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.stock_items i
    WHERE i.organization_id = v_org AND (_id IS NULL OR i.id <> _id) AND lower(i.sku) = lower(v_sku)
  ) THEN
    RAISE EXCEPTION 'SKU "%" is already used by another item.', v_sku;
  END IF;

  IF v_barcode IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.stock_items i
    WHERE i.organization_id = v_org AND (_id IS NULL OR i.id <> _id) AND lower(i.barcode) = lower(v_barcode)
  ) THEN
    RAISE EXCEPTION 'Barcode "%" is already used by another item.', v_barcode;
  END IF;

  IF _id IS NULL THEN
    INSERT INTO public.stock_items (
      organization_id, branch_id, name, sku, barcode, description, category_id,
      base_unit, purchase_unit, purchase_to_base, min_level, max_level, reorder_point,
      par_level, reorder_quantity, shelf_life_days, track_batches, track_expiry,
      preferred_supplier_id, default_location_id, container_type, container_volume_ml,
      tracking_method, may_open_for_pours, default_pour_ml, is_divisible, active, created_by
    ) VALUES (
      v_org, _branch, v_name, v_sku, v_barcode, nullif(btrim(coalesce(_payload->>'description','')), ''), v_category,
      coalesce(nullif(btrim(coalesce(_payload->>'base_unit','')), ''), 'each'),
      coalesce(nullif(btrim(coalesce(_payload->>'purchase_unit','')), ''), coalesce(nullif(btrim(coalesce(_payload->>'base_unit','')), ''), 'each')),
      coalesce(nullif(_payload->>'purchase_to_base','')::numeric, 1),
      coalesce(nullif(_payload->>'min_level','')::numeric, 0),
      nullif(_payload->>'max_level','')::numeric,
      nullif(_payload->>'reorder_point','')::numeric,
      nullif(_payload->>'par_level','')::numeric,
      coalesce(nullif(_payload->>'reorder_quantity','')::numeric, 0),
      nullif(_payload->>'shelf_life_days','')::integer,
      coalesce(nullif(_payload->>'track_batches','')::boolean, false),
      coalesce(nullif(_payload->>'track_expiry','')::boolean, false),
      v_supplier, v_location,
      coalesce(nullif(btrim(coalesce(_payload->>'container_type','')), ''), 'other'),
      nullif(_payload->>'container_volume_ml','')::numeric,
      coalesce(nullif(btrim(coalesce(_payload->>'tracking_method','')), ''), 'whole'),
      coalesce(nullif(_payload->>'may_open_for_pours','')::boolean, false),
      nullif(_payload->>'default_pour_ml','')::numeric,
      coalesce(nullif(_payload->>'is_divisible','')::boolean, false),
      coalesce(nullif(_payload->>'active','')::boolean, true),
      auth.uid()
    ) RETURNING id INTO v_id;

    PERFORM public.log_audit_event(
      'inventory.item_created', 'inventory', v_id::text, NULL::jsonb,
      jsonb_build_object('name', v_name, 'sku', v_sku, 'branch_id', _branch), NULL::text
    );
  ELSE
    UPDATE public.stock_items SET
      branch_id = coalesce(_branch, branch_id),
      name = v_name,
      sku = coalesce(v_sku, sku),
      barcode = coalesce(v_barcode, barcode),
      description = coalesce(nullif(btrim(coalesce(_payload->>'description','')), ''), description),
      category_id = coalesce(v_category, category_id),
      base_unit = coalesce(nullif(btrim(coalesce(_payload->>'base_unit','')), ''), base_unit),
      purchase_unit = coalesce(nullif(btrim(coalesce(_payload->>'purchase_unit','')), ''), purchase_unit),
      purchase_to_base = coalesce(nullif(_payload->>'purchase_to_base','')::numeric, purchase_to_base),
      min_level = coalesce(nullif(_payload->>'min_level','')::numeric, min_level),
      max_level = coalesce(nullif(_payload->>'max_level','')::numeric, max_level),
      reorder_point = coalesce(nullif(_payload->>'reorder_point','')::numeric, reorder_point),
      par_level = coalesce(nullif(_payload->>'par_level','')::numeric, par_level),
      preferred_supplier_id = coalesce(v_supplier, preferred_supplier_id),
      default_location_id = coalesce(v_location, default_location_id),
      container_type = coalesce(nullif(btrim(coalesce(_payload->>'container_type','')), ''), container_type),
      container_volume_ml = coalesce(nullif(_payload->>'container_volume_ml','')::numeric, container_volume_ml),
      updated_at = now()
    WHERE id = _id
    RETURNING id INTO v_id;

    PERFORM public.log_audit_event(
      'inventory.item_updated', 'inventory', v_id::text,
      jsonb_build_object('name', v_existing.name, 'sku', v_existing.sku),
      jsonb_build_object('name', v_name, 'sku', v_sku), NULL::text
    );
  END IF;

  RETURN v_id;
END;
$function$