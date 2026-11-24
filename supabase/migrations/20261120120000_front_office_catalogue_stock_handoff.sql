BEGIN;

-- Front Office routing uses the assigned manager first. A departmental manager
-- role also counts when its active holder belongs to this department and property.
CREATE FUNCTION public.neo_front_office_stock_managers(_org uuid, _branch uuid, _department uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT p.id), '{}'::uuid[])
  FROM public.departments d
  JOIN public.profiles p ON p.organization_id = d.organization_id
  WHERE d.id = _department AND d.organization_id = _org AND d.active IS TRUE
    AND (d.branch_id IS NULL OR d.branch_id = _branch)
    AND p.account_status = 'active'
    AND (p.branch_id = _branch OR EXISTS (
      SELECT 1 FROM public.user_branches ub
      WHERE ub.user_id = p.id AND ub.organization_id = _org AND ub.branch_id = _branch
    ))
    AND (p.id = d.manager_id OR (
      (p.department_id = d.id OR EXISTS (
        SELECT 1 FROM public.user_departments ud
        WHERE ud.user_id = p.id AND ud.organization_id = _org AND ud.department_id = d.id
      ))
      AND EXISTS (
        SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
        WHERE ur.user_id = p.id AND ur.organization_id = _org AND r.organization_id = _org
          AND r.active IS TRUE
          AND (
            r.normalized_role_key IN ('front-office-manager','front-office-supervisor')
            OR btrim(regexp_replace(lower(r.name), '[^a-z]+', ' ', 'g')) IN
              ('front office manager', 'front office supervisor', 'front desk manager')
          )
      )
    ));
$$;

CREATE FUNCTION public.neo_front_office_stock_need_to_stores(_need uuid, _item uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n public.department_stock_needs%ROWTYPE;
  item public.stock_items%ROWTYPE;
  destination uuid;
  request_id uuid;
  request_number text;
BEGIN
  SELECT * INTO n FROM public.department_stock_needs
  WHERE id = _need AND organization_id = public.current_org_id()
    AND module = 'front-office' FOR UPDATE;
  IF NOT FOUND OR public.neo_branch_in_scope(n.branch_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'Stock need is outside your property' USING ERRCODE = '42501';
  END IF;
  IF n.requisition_id IS NOT NULL THEN
    IF n.stock_item_id IS DISTINCT FROM _item THEN RAISE EXCEPTION 'This need already has a different inventory item'; END IF;
    SELECT r.request_number INTO request_number FROM public.internal_requisitions r WHERE r.id = n.requisition_id;
    RETURN jsonb_build_object('id',n.id,'status','requisitioned','requisition_id',n.requisition_id,'request_number',request_number);
  END IF;
  IF n.status NOT IN ('reported','pending','acknowledged') THEN RAISE EXCEPTION 'This stock need is no longer open'; END IF;
  IF n.stock_item_id IS NOT NULL AND n.stock_item_id <> _item THEN RAISE EXCEPTION 'Use the inventory item requested by Front Office'; END IF;
  SELECT * INTO item FROM public.stock_items s
  WHERE s.id = _item AND s.organization_id = n.organization_id
    AND (s.branch_id IS NULL OR s.branch_id = n.branch_id) AND s.active IS TRUE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Select an active inventory catalogue item for this property'; END IF;
  IF n.quantity IS NULL OR n.quantity <= 0 OR n.quantity::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Quantity must be finite and greater than zero';
  END IF;
  -- Legacy needs may be linked explicitly. The manager must confirm compatible units.
  IF n.stock_item_id IS NULL AND lower(btrim(n.unit)) IS DISTINCT FROM lower(btrim(item.base_unit)) THEN
    RAISE EXCEPTION 'The requested unit differs from the catalogue unit. Confirm the correct item and unit before requisitioning.';
  END IF;
  SELECT sl.id INTO destination FROM public.stock_locations sl
  WHERE sl.organization_id = n.organization_id AND sl.department_id = n.department_id
    AND sl.is_mini_store AND sl.active AND (sl.branch_id = n.branch_id OR sl.branch_id IS NULL)
  ORDER BY (sl.branch_id IS NOT NULL) DESC, sl.created_at, sl.id LIMIT 1;
  request_number := 'REQ-' || to_char(now(),'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,5));
  INSERT INTO public.internal_requisitions (
    organization_id,branch_id,request_number,department_id,destination_location_id,
    fulfilment_model,requested_by,request_date,priority,reason,status,supervisor_approved_by,supervisor_approved_at
  ) VALUES (
    n.organization_id,n.branch_id,request_number,n.department_id,destination,'stores-issue',
    n.requested_by,current_date,n.priority,coalesce(n.notes,'Front Office stock need'),'awaiting-stores',
    CASE WHEN auth.uid() <> n.requested_by OR auth.uid() = ANY(public.neo_front_office_stock_managers(n.organization_id,n.branch_id,n.department_id)) THEN auth.uid() END,
    CASE WHEN auth.uid() <> n.requested_by OR auth.uid() = ANY(public.neo_front_office_stock_managers(n.organization_id,n.branch_id,n.department_id)) THEN now() END
  ) RETURNING id INTO request_id;
  INSERT INTO public.internal_requisition_lines (
    organization_id,requisition_id,stock_item_id,description,unit,quantity_requested,notes
  ) VALUES (n.organization_id,request_id,item.id,item.name,item.base_unit,n.quantity,n.notes);
  UPDATE public.department_stock_needs SET status='requisitioned',stock_item_id=item.id,
    requisition_id=request_id,reviewed_by=CASE WHEN auth.uid() <> n.requested_by THEN auth.uid() END,
    reviewed_at=CASE WHEN auth.uid() <> n.requested_by THEN now() END,updated_at=now() WHERE id=n.id;
  PERFORM public.neo_notify(n.organization_id,NULL,n.branch_id,'operational-alert',
    'Requisition awaiting Stores — '||request_number,item.name,'/inventory/requisitions',n.priority,true,
    'stores',request_id,'stores.requisition_raised','req:'||request_id::text||':raised');
  RETURN jsonb_build_object('id',n.id,'status','requisitioned','requisition_id',request_id,'request_number',request_number);
END;
$$;

CREATE FUNCTION public.neo_front_office_report_catalogue_need(
  _branch uuid, _department uuid, _item uuid, _quantity numeric, _priority text, _notes text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  org uuid := public.current_org_id();
  item public.stock_items%ROWTYPE;
  managers uuid[];
  manager uuid;
  need_id uuid;
BEGIN
  IF auth.uid() IS NULL OR public.is_active_staff() IS NOT TRUE
    OR NOT (public.has_permission('front-office','stock_needs','create') IS TRUE
      OR public.has_permission('pms','stock_needs.create') IS TRUE)
    OR public.neo_branch_in_scope(_branch) IS NOT TRUE THEN
    RAISE EXCEPTION 'Front Office stock reporting permission required in this property' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.departments d
    WHERE d.id=_department AND d.organization_id=org AND d.active
      AND (d.branch_id=_branch OR d.branch_id IS NULL)
      AND concat_ws(' ',d.catalogue_key,d.code,d.name) ~* 'front.?office|front.?desk|reception') THEN
    RAISE EXCEPTION 'Select the Front Office department for this property';
  END IF;
  IF _quantity IS NULL OR _quantity <= 0 OR _quantity::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Quantity must be finite and greater than zero';
  END IF;
  SELECT * INTO item FROM public.stock_items s
  WHERE s.id=_item AND s.organization_id=org AND (s.branch_id=_branch OR s.branch_id IS NULL) AND s.active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Select an active inventory catalogue item for this property'; END IF;
  managers := public.neo_front_office_stock_managers(org,_branch,_department);
  INSERT INTO public.department_stock_needs (
    organization_id,branch_id,department_id,module,stock_item_id,item,quantity,unit,priority,notes,requested_by,status
  ) VALUES (org,_branch,_department,'front-office',item.id,item.name,_quantity,item.base_unit,
    coalesce(_priority,'normal'),nullif(btrim(_notes),''),auth.uid(),'reported')
  RETURNING id INTO need_id;
  IF cardinality(managers)=0 OR auth.uid()=ANY(managers) THEN
    RETURN public.neo_front_office_stock_need_to_stores(need_id,item.id);
  END IF;
  FOREACH manager IN ARRAY managers LOOP
    PERFORM public.neo_notify(org,manager,_branch,'operational-alert','Front Office stock need awaiting approval',
      item.name,'/pms/supplies',coalesce(_priority,'normal'),true,'front-office',need_id,
      'front-office.stock_need_reported','need:'||need_id::text||':'||manager::text);
  END LOOP;
  RETURN jsonb_build_object('id',need_id,'status','reported');
END;
$$;

CREATE FUNCTION public.neo_front_office_requisition_need(_need uuid, _item uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n public.department_stock_needs%ROWTYPE; managers uuid[];
BEGIN
  SELECT * INTO n FROM public.department_stock_needs
  WHERE id=_need AND organization_id=public.current_org_id() AND module='front-office' FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR public.is_active_staff() IS NOT TRUE
    OR public.neo_branch_in_scope(n.branch_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'Front Office requisition review is outside your property' USING ERRCODE='42501';
  END IF;
  managers := public.neo_front_office_stock_managers(n.organization_id,n.branch_id,n.department_id);
  IF NOT (auth.uid()=ANY(managers) OR public.is_org_admin() IS TRUE) THEN
    RAISE EXCEPTION 'An assigned Front Office manager must approve this request' USING ERRCODE='42501';
  END IF;
  IF n.requested_by=auth.uid() AND NOT auth.uid()=ANY(managers) THEN
    RAISE EXCEPTION 'The requester cannot approve their own need' USING ERRCODE='42501';
  END IF;
  RETURN public.neo_front_office_stock_need_to_stores(n.id,coalesce(n.stock_item_id,_item));
END;
$$;

CREATE FUNCTION public.neo_front_office_need_catalogue(_branch uuid)
RETURNS TABLE (id uuid, name text, base_unit text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id,s.name,s.base_unit FROM public.stock_items s
  WHERE auth.uid() IS NOT NULL AND public.is_active_staff()
    AND public.neo_branch_in_scope(_branch)
    AND (public.has_permission('pms','stock_needs.create')
      OR public.has_permission('front-office','stock_needs','create')
      OR public.has_permission('pms','requisitions.create') OR public.is_org_admin())
    AND s.organization_id=public.current_org_id() AND s.active
    AND (s.branch_id=_branch OR s.branch_id IS NULL)
  ORDER BY s.name,s.id;
$$;

CREATE FUNCTION public.neo_check_requisition_catalogue_line()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r public.internal_requisitions%ROWTYPE;
  item public.stock_items%ROWTYPE;
  matching_ids uuid[];
BEGIN
  SELECT * INTO r FROM public.internal_requisitions WHERE id=NEW.requisition_id;
  IF r.id IS NULL OR NEW.organization_id IS DISTINCT FROM r.organization_id THEN
    RAISE EXCEPTION 'The requisition is outside this inventory scope' USING ERRCODE='42501';
  END IF;
  IF NEW.quantity_requested IS NULL OR NEW.quantity_requested <= 0
     OR NEW.quantity_requested::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Quantity must be finite and greater than zero';
  END IF;
  IF NEW.stock_item_id IS NULL THEN
    -- Older department callers submit descriptions. Accept only an unambiguous
    -- existing catalogue item with that exact name and unit.
    SELECT array_agg(s.id) INTO matching_ids FROM public.stock_items s
    WHERE s.organization_id=r.organization_id AND s.active
      AND (s.branch_id=r.branch_id OR s.branch_id IS NULL)
      AND lower(btrim(s.name))=lower(btrim(NEW.description))
      AND lower(btrim(s.base_unit))=lower(btrim(NEW.unit));
    IF coalesce(cardinality(matching_ids),0) <> 1 THEN
      RAISE EXCEPTION 'Select an existing inventory catalogue item. New items must be added to the catalogue first.';
    END IF;
    NEW.stock_item_id := matching_ids[1];
  END IF;
  SELECT * INTO item FROM public.stock_items s
  WHERE s.id=NEW.stock_item_id AND s.organization_id=r.organization_id AND s.active
    AND (s.branch_id=r.branch_id OR s.branch_id IS NULL);
  IF NOT FOUND THEN RAISE EXCEPTION 'Select an active inventory catalogue item for this property'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER neo_requisition_catalogue_line BEFORE INSERT ON public.internal_requisition_lines
FOR EACH ROW EXECUTE FUNCTION public.neo_check_requisition_catalogue_line();

CREATE FUNCTION public.neo_check_front_office_need_catalogue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE matches uuid[];
BEGIN
  SELECT array_agg(s.id) INTO matches FROM public.stock_items s
  WHERE s.organization_id=NEW.organization_id AND s.active
    AND (s.branch_id=NEW.branch_id OR s.branch_id IS NULL)
    AND (
      s.id=NEW.stock_item_id OR
      (NEW.stock_item_id IS NULL AND lower(btrim(s.name))=lower(btrim(NEW.item))
        AND lower(btrim(s.base_unit))=lower(btrim(NEW.unit)))
    );
  IF coalesce(cardinality(matches),0) <> 1 THEN
    RAISE EXCEPTION 'Select a single existing inventory catalogue item for this property';
  END IF;
  NEW.stock_item_id := matches[1];
  RETURN NEW;
END;
$$;
CREATE TRIGGER neo_front_office_need_catalogue_only BEFORE INSERT ON public.department_stock_needs
FOR EACH ROW WHEN (NEW.module = 'front-office')
EXECUTE FUNCTION public.neo_check_front_office_need_catalogue();

REVOKE ALL ON FUNCTION public.neo_front_office_stock_managers(uuid,uuid,uuid),
  public.neo_front_office_stock_need_to_stores(uuid,uuid),
  public.neo_front_office_report_catalogue_need(uuid,uuid,uuid,numeric,text,text),
  public.neo_front_office_requisition_need(uuid,uuid),
  public.neo_front_office_need_catalogue(uuid),
  public.neo_check_requisition_catalogue_line(),
  public.neo_check_front_office_need_catalogue() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_front_office_report_catalogue_need(uuid,uuid,uuid,numeric,text,text),
  public.neo_front_office_requisition_need(uuid,uuid),
  public.neo_front_office_need_catalogue(uuid) TO authenticated;
CREATE FUNCTION public.neo_department_request_managers(_org uuid, _branch uuid, _department uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(array_agg(DISTINCT p.id),'{}'::uuid[])
 FROM public.departments d JOIN public.profiles p ON p.organization_id=d.organization_id
 WHERE d.id=_department AND d.organization_id=_org AND d.active
 AND (d.branch_id=_branch OR d.branch_id IS NULL) AND p.account_status='active'
 AND (p.branch_id=_branch OR EXISTS(SELECT 1 FROM public.user_branches b WHERE b.user_id=p.id AND b.organization_id=_org AND b.branch_id=_branch))
 AND (d.manager_id=p.id OR (
  (p.department_id=d.id OR EXISTS(SELECT 1 FROM public.user_departments u WHERE u.user_id=p.id AND u.organization_id=_org AND u.department_id=d.id))
  AND EXISTS(SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id=ur.role_id
   WHERE ur.user_id=p.id AND ur.organization_id=_org AND r.organization_id=_org AND r.active
   AND (r.normalized_role_key ~ '(^|[-])(manager|supervisor|head)([-]|$)' OR lower(r.name) ~ 'manager|supervisor|head chef'))
 ));
$$;

CREATE FUNCTION public.neo_route_department_requisition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE managers uuid[];
BEGIN
 IF NEW.status NOT IN ('pending-supervisor','awaiting-stores') THEN RETURN NEW; END IF;
 IF NEW.department_id IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.departments d WHERE d.id=NEW.department_id AND d.organization_id=NEW.organization_id
   AND d.active AND (d.branch_id=NEW.branch_id OR d.branch_id IS NULL)
 ) THEN RAISE EXCEPTION 'Select an active department for the requisition property'; END IF;
 managers:=public.neo_department_request_managers(NEW.organization_id,NEW.branch_id,NEW.department_id);
 IF cardinality(managers)=0 THEN
  NEW.status:='awaiting-stores';
  NEW.supervisor_approved_by:=NULL;
  NEW.supervisor_approved_at:=NULL;
 ELSIF auth.uid()=ANY(managers) THEN
  NEW.status:='awaiting-stores';
  NEW.supervisor_approved_by:=auth.uid();
  NEW.supervisor_approved_at:=now();
 ELSE
  NEW.status:='pending-supervisor';
  NEW.supervisor_approved_by:=NULL;
  NEW.supervisor_approved_at:=NULL;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER neo_department_request_routing BEFORE INSERT ON public.internal_requisitions
FOR EACH ROW EXECUTE FUNCTION public.neo_route_department_requisition();
REVOKE ALL ON FUNCTION public.neo_department_request_managers(uuid,uuid,uuid),public.neo_route_department_requisition()
FROM PUBLIC,anon,authenticated,service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
