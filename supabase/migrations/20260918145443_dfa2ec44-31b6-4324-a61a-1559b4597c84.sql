
CREATE OR REPLACE FUNCTION public.neo_stock_location_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _dept record;
BEGIN
  -- The mini-store classification and the behaviour flag stay in step.
  IF NEW.location_type = 'mini' THEN NEW.is_mini_store := true; END IF;

  IF NEW.is_mini_store THEN
    IF NEW.department_id IS NULL THEN
      RAISE EXCEPTION 'A store that issues to a department must name that department'
        USING ERRCODE = '22023';
    END IF;
    SELECT * INTO _dept FROM public.departments WHERE id = NEW.department_id;
    IF _dept IS NULL OR _dept.organization_id <> NEW.organization_id THEN
      RAISE EXCEPTION 'The department must belong to this workspace' USING ERRCODE = '42501';
    END IF;
    IF _dept.branch_id IS NOT NULL AND NEW.branch_id IS NOT NULL AND _dept.branch_id <> NEW.branch_id THEN
      RAISE EXCEPTION 'The department must belong to the same property as the store'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    -- Switched off: the relationship is cleared so stale routing cannot remain.
    NEW.department_id := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_location_guard ON public.stock_locations;
CREATE TRIGGER trg_stock_location_guard
BEFORE INSERT OR UPDATE ON public.stock_locations
FOR EACH ROW EXECUTE FUNCTION public.neo_stock_location_guard();

CREATE OR REPLACE FUNCTION public.neo_stock_location_single_main()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_main AND NEW.branch_id IS NOT NULL THEN
    UPDATE public.stock_locations
       SET is_main = false, updated_at = now()
     WHERE organization_id = NEW.organization_id
       AND branch_id = NEW.branch_id
       AND id <> NEW.id
       AND is_main;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_location_single_main ON public.stock_locations;
CREATE TRIGGER trg_stock_location_single_main
AFTER INSERT OR UPDATE OF is_main ON public.stock_locations
FOR EACH ROW WHEN (NEW.is_main) EXECUTE FUNCTION public.neo_stock_location_single_main();

CREATE INDEX IF NOT EXISTS idx_stock_locations_department
  ON public.stock_locations (organization_id, department_id) WHERE is_mini_store;

-- Department requisitions: resolve the destination from the department's own
-- mini-store when the caller did not choose one, so issues reach departmental
-- stock instead of only leaving the issuing store.
CREATE OR REPLACE FUNCTION public.neo_department_requisition_create(
  _branch uuid,
  _lines jsonb,
  _department uuid DEFAULT NULL,
  _required_date date DEFAULT NULL,
  _priority text DEFAULT 'normal',
  _reason text DEFAULT NULL,
  _destination uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := current_org_id();
  v_req uuid;
  v_line jsonb;
  v_count int := 0;
  v_number text;
  v_status text;
  v_dest uuid := _destination;
  v_self boolean := public.neo_requisition_supervisor_authority();
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT (has_permission('restaurant','requisitions.create')
          OR has_permission('restaurant','create')
          OR has_permission('stores','create')
          OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to raise a requisition';
  END IF;
  IF _branch IS NULL OR NOT (_branch = ANY (current_branch_ids())) THEN
    RAISE EXCEPTION 'Requisitions may only be raised for your own property';
  END IF;
  IF _lines IS NULL OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'Add at least one item';
  END IF;

  IF v_dest IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.stock_locations sl
                    WHERE sl.id = v_dest AND sl.organization_id = v_org
                      AND (sl.branch_id IS NULL OR sl.branch_id = _branch)) THEN
      RAISE EXCEPTION 'The receiving store must belong to this property';
    END IF;
  ELSIF _department IS NOT NULL THEN
    SELECT sl.id INTO v_dest
      FROM public.stock_locations sl
     WHERE sl.organization_id = v_org
       AND sl.department_id = _department
       AND sl.is_mini_store
       AND sl.active
       AND (sl.branch_id IS NULL OR sl.branch_id = _branch)
     ORDER BY sl.created_at
     LIMIT 1;
  END IF;

  v_number := 'REQ-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''), 1, 5));
  v_status := CASE WHEN v_self THEN 'awaiting-stores' ELSE 'pending-supervisor' END;

  INSERT INTO public.internal_requisitions
    (organization_id, branch_id, request_number, department_id, destination_location_id,
     fulfilment_model, requested_by, request_date, required_date, priority, reason, status,
     supervisor_approved_by, supervisor_approved_at)
  VALUES (v_org, _branch, v_number, _department, v_dest,
          'stores-issue', auth.uid(), current_date, _required_date,
          coalesce(_priority, 'normal'), _reason, v_status,
          CASE WHEN v_self THEN auth.uid() END,
          CASE WHEN v_self THEN now() END)
  RETURNING id INTO v_req;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    IF coalesce((v_line->>'quantity_requested')::numeric, 0) <= 0 THEN CONTINUE; END IF;
    INSERT INTO public.internal_requisition_lines
      (organization_id, requisition_id, stock_item_id, description, unit, quantity_requested, notes)
    VALUES (v_org, v_req,
            nullif(v_line->>'stock_item_id','')::uuid,
            nullif(v_line->>'description',''),
            nullif(v_line->>'unit',''),
            (v_line->>'quantity_requested')::numeric,
            nullif(v_line->>'notes',''));
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN RAISE EXCEPTION 'Add at least one item with a quantity'; END IF;

  PERFORM public.neo_notify(v_org, NULL, _branch, 'operational-alert',
    CASE WHEN v_self THEN 'Requisition awaiting Stores — ' || v_number
         ELSE 'Requisition awaiting departmental approval — ' || v_number END,
    coalesce(_reason, 'A department has requested stock from Stores.'),
    '/inventory/requisitions', coalesce(_priority,'normal'), true,
    'stores', v_req, 'stores.requisition_raised', 'req:' || v_req::text || ':raised');

  RETURN jsonb_build_object('ok', true, 'requisition_id', v_req,
                            'request_number', v_number, 'lines', v_count,
                            'destination_location_id', v_dest,
                            'status', v_status);
END;
$$;
