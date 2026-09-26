-- NEØ certification hardening: department requisition wrappers.
-- Fixes UUID aggregation, mixed-scope selection, and domain authority handoff to Stores.

CREATE OR REPLACE FUNCTION public.neo_department_requisition_create(
  _branch uuid,
  _lines jsonb,
  _department uuid DEFAULT NULL,
  _required_date date DEFAULT NULL,
  _priority text DEFAULT 'normal',
  _reason text DEFAULT NULL,
  _destination uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid := current_org_id(); v_req uuid; v_line jsonb; v_count int := 0;
  v_number text; v_status text; v_dest uuid := _destination;
  v_self boolean := public.neo_requisition_supervisor_authority();
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT (
    has_permission('restaurant','requisitions.create') OR has_permission('restaurant','create') OR
    has_permission('stores','create') OR
    has_permission('pms','requisitions.create') OR has_permission('front-office','requisitions','create') OR
    has_permission('kitchen','requisition','create') OR has_permission('kitchen','requisitions','create') OR
    has_permission('kitchen','pastry-requisition','create') OR
    has_permission('security','requisition','create') OR
    is_org_admin()
  ) THEN RAISE EXCEPTION 'Not permitted to raise a requisition'; END IF;
  IF _branch IS NULL OR NOT (_branch = ANY(current_branch_ids())) THEN
    RAISE EXCEPTION 'Requisitions may only be raised for your own property';
  END IF;
  IF _lines IS NULL OR jsonb_array_length(_lines)=0 THEN RAISE EXCEPTION 'Add at least one item'; END IF;

  IF v_dest IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.stock_locations sl WHERE sl.id=v_dest AND sl.organization_id=v_org AND (sl.branch_id IS NULL OR sl.branch_id=_branch)) THEN
      RAISE EXCEPTION 'The receiving store must belong to this property';
    END IF;
  ELSIF _department IS NOT NULL THEN
    SELECT sl.id INTO v_dest FROM public.stock_locations sl
     WHERE sl.organization_id=v_org AND sl.department_id=_department AND sl.is_mini_store AND sl.active
       AND (sl.branch_id IS NULL OR sl.branch_id=_branch)
     ORDER BY sl.created_at LIMIT 1;
  END IF;

  v_number := 'REQ-'||to_char(now(),'YYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,5));
  v_status := CASE WHEN v_self THEN 'awaiting-stores' ELSE 'pending-supervisor' END;
  INSERT INTO public.internal_requisitions(
    organization_id,branch_id,request_number,department_id,destination_location_id,fulfilment_model,
    requested_by,request_date,required_date,priority,reason,status,supervisor_approved_by,supervisor_approved_at)
  VALUES(v_org,_branch,v_number,_department,v_dest,'stores-issue',auth.uid(),current_date,_required_date,
    coalesce(_priority,'normal'),_reason,v_status,
    CASE WHEN v_self THEN auth.uid() END,CASE WHEN v_self THEN now() END)
  RETURNING id INTO v_req;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    IF coalesce((v_line->>'quantity_requested')::numeric,0)<=0 THEN CONTINUE; END IF;
    INSERT INTO public.internal_requisition_lines(organization_id,requisition_id,stock_item_id,description,unit,quantity_requested,notes)
    VALUES(v_org,v_req,nullif(v_line->>'stock_item_id','')::uuid,nullif(v_line->>'description',''),nullif(v_line->>'unit',''),
      (v_line->>'quantity_requested')::numeric,nullif(v_line->>'notes',''));
    v_count := v_count+1;
  END LOOP;
  IF v_count=0 THEN RAISE EXCEPTION 'Add at least one item with a quantity'; END IF;

  PERFORM public.neo_notify(v_org,NULL,_branch,'operational-alert',
    CASE WHEN v_self THEN 'Requisition awaiting Stores — '||v_number ELSE 'Requisition awaiting departmental approval — '||v_number END,
    coalesce(_reason,'A department has requested stock from Stores.'),'/inventory/requisitions',coalesce(_priority,'normal'),true,
    'stores',v_req,'stores.requisition_raised','req:'||v_req::text||':raised');
  RETURN jsonb_build_object('ok',true,'requisition_id',v_req,'request_number',v_number,'lines',v_count,
    'destination_location_id',v_dest,'status',v_status);
END; $$;

CREATE OR REPLACE FUNCTION public.neo_department_requisition_lines_from_needs(
  _needs uuid[], _module text, _allowed_statuses text[]
) RETURNS TABLE(lines jsonb, branch_id uuid, department_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_branches int; v_departments int;
BEGIN
  IF _needs IS NULL OR array_length(_needs,1) IS NULL THEN RAISE EXCEPTION 'Select at least one reported need'; END IF;
  SELECT count(DISTINCT n.branch_id), count(DISTINCT n.department_id)
    INTO v_branches,v_departments
  FROM public.department_stock_needs n
  WHERE n.id=ANY(_needs) AND n.organization_id=current_org_id() AND n.module=_module AND n.status=ANY(_allowed_statuses);
  IF v_branches=0 THEN RAISE EXCEPTION 'No open % needs match that selection',_module; END IF;
  IF v_branches>1 THEN RAISE EXCEPTION 'Selected needs must belong to one property'; END IF;
  IF v_departments>1 THEN RAISE EXCEPTION 'Selected needs must belong to one department'; END IF;
  RETURN QUERY
  SELECT jsonb_agg(jsonb_build_object('description',n.item,'quantity_requested',n.quantity,'unit',n.unit,'notes',n.notes) ORDER BY n.created_at),
         (array_agg(n.branch_id ORDER BY n.created_at))[1],
         (array_agg(n.department_id ORDER BY n.created_at))[1]
  FROM public.department_stock_needs n
  WHERE n.id=ANY(_needs) AND n.organization_id=current_org_id() AND n.module=_module AND n.status=ANY(_allowed_statuses);
END; $$;

CREATE OR REPLACE FUNCTION public.neo_pastry_requisition_from_needs(_needs uuid[],_required_date date DEFAULT NULL,_priority text DEFAULT 'normal',_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_lines jsonb; v_req jsonb; v_branch uuid; v_dept uuid; v_id uuid;
BEGIN
  IF NOT public.has_permission('kitchen','pastry-requisition','create') THEN RAISE EXCEPTION 'Only the Head Pastry Chef can send a Stores requisition for Pastry & Bakery'; END IF;
  SELECT x.lines,x.branch_id,x.department_id INTO v_lines,v_branch,v_dept
  FROM public.neo_department_requisition_lines_from_needs(_needs,'pastry',ARRAY['reported','acknowledged']) x;
  v_req := public.neo_department_requisition_create(v_branch,v_lines,v_dept,_required_date,coalesce(nullif(btrim(_priority),''),'normal'),coalesce(nullif(btrim(_reason),''),'Pastry & Bakery consolidated requisition'),NULL);
  v_id:=nullif(v_req->>'requisition_id','')::uuid;
  UPDATE public.department_stock_needs SET status='requisitioned',reviewed_by=auth.uid(),reviewed_at=now(),requisition_id=v_id,updated_at=now()
   WHERE id=ANY(_needs) AND organization_id=current_org_id() AND module='pastry' AND status IN ('reported','acknowledged');
  RETURN v_req;
END; $$;

CREATE OR REPLACE FUNCTION public.neo_kitchen_requisition_from_needs(_needs uuid[],_required_date date DEFAULT NULL,_priority text DEFAULT 'normal',_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_lines jsonb; v_req jsonb; v_branch uuid; v_dept uuid; v_id uuid;
BEGIN
  IF NOT (public.has_permission('kitchen','requisition','create') OR public.has_permission('kitchen','requisitions','create')) THEN RAISE EXCEPTION 'Only the Kitchen Manager / Head Chef can send a Stores requisition for the Main Kitchen'; END IF;
  SELECT x.lines,x.branch_id,x.department_id INTO v_lines,v_branch,v_dept
  FROM public.neo_department_requisition_lines_from_needs(_needs,'kitchen',ARRAY['pending','reported','acknowledged']) x;
  v_req := public.neo_department_requisition_create(v_branch,v_lines,v_dept,_required_date,coalesce(nullif(btrim(_priority),''),'normal'),coalesce(nullif(btrim(_reason),''),'Main Kitchen consolidated requisition'),NULL);
  v_id:=nullif(v_req->>'requisition_id','')::uuid;
  UPDATE public.department_stock_needs SET status='requisitioned',reviewed_by=auth.uid(),reviewed_at=now(),requisition_id=v_id,updated_at=now()
   WHERE id=ANY(_needs) AND organization_id=current_org_id() AND module='kitchen' AND status IN ('pending','reported','acknowledged');
  RETURN v_req;
END; $$;

CREATE OR REPLACE FUNCTION public.neo_security_requisition_from_needs(_needs uuid[],_required_date date DEFAULT NULL,_priority text DEFAULT 'normal',_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_lines jsonb; v_req jsonb; v_branch uuid; v_dept uuid; v_id uuid;
BEGIN
  IF NOT public.has_permission('security','requisition','create') THEN RAISE EXCEPTION 'Only the Security Supervisor can send a Stores requisition for Security'; END IF;
  SELECT x.lines,x.branch_id,x.department_id INTO v_lines,v_branch,v_dept
  FROM public.neo_department_requisition_lines_from_needs(_needs,'security',ARRAY['reported','acknowledged']) x;
  v_req := public.neo_department_requisition_create(v_branch,v_lines,v_dept,_required_date,coalesce(nullif(btrim(_priority),''),'normal'),coalesce(nullif(btrim(_reason),''),'Security consolidated requisition'),NULL);
  v_id:=nullif(v_req->>'requisition_id','')::uuid;
  UPDATE public.department_stock_needs SET status='requisitioned',reviewed_by=auth.uid(),reviewed_at=now(),requisition_id=v_id,updated_at=now()
   WHERE id=ANY(_needs) AND organization_id=current_org_id() AND module='security' AND status IN ('reported','acknowledged');
  RETURN v_req;
END; $$;
