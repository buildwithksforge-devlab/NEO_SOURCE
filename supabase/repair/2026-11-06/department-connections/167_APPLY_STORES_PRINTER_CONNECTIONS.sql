BEGIN;
DO $guard$ BEGIN IF EXISTS(SELECT 1 FROM unnest(ARRAY['public.neo_requisition_assign_stock_item(uuid,uuid,uuid)','public.neo_print_discovery_authorize(uuid)','public.neo_print_discovery_request(uuid,text)','public.neo_print_discovery_status(uuid)','public.neo_print_agent_discovery_poll(text)','public.neo_print_agent_discovery_report(text,uuid,jsonb)']) s WHERE to_regprocedure(s) IS NOT NULL) THEN RAISE EXCEPTION 'A connection repair already exists; use postcheck before reinstalling'; END IF; END $guard$;
-- NEØ E07-A: Secure stock-item allocation for departmental requisitions.
-- Forward-only migration.
-- No operational records are modified by installing this function.

CREATE OR REPLACE FUNCTION public.neo_requisition_assign_stock_item(
    _requisition uuid,
    _line uuid,
    _stock_item uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_req public.internal_requisitions;
    v_line public.internal_requisition_lines;
    v_item public.stock_items;
BEGIN
    -- Authentication and Stores authorization.
    IF auth.uid() IS NULL
       OR v_org IS NULL
       OR public.is_active_staff() IS NOT TRUE THEN
        RAISE EXCEPTION 'An active staff session is required';
    END IF;

    IF NOT (
        public.has_permission('stores', 'edit')
        OR public.has_permission('stores', 'approve')
        OR public.is_org_admin()
    ) THEN
        RAISE EXCEPTION 'Stores authorization is required';
    END IF;

    -- Lock the requisition to serialize allocation against approval.
    SELECT *
      INTO v_req
      FROM public.internal_requisitions
     WHERE id = _requisition
       AND organization_id = v_org
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Requisition not found';
    END IF;

    -- Property access.
    IF v_req.branch_id IS NULL
       OR NOT (
           coalesce(public.neo_branch_in_scope(v_req.branch_id),false)
       ) THEN
        RAISE EXCEPTION 'Requisition is outside your property access';
    END IF;

    -- Mapping must happen before Stores quantity approval.
    IF v_req.status NOT IN (
        'pending-supervisor',
        'awaiting-stores'
    ) THEN
        RAISE EXCEPTION
            'Stock items cannot be changed after Stores approval';
    END IF;

    -- Lock the selected requisition line.
    SELECT *
      INTO v_line
      FROM public.internal_requisition_lines
     WHERE id = _line
       AND requisition_id = _requisition
       AND organization_id = v_org
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Requisition line not found';
    END IF;

    -- Never change stock identity after issuing starts.
    IF COALESCE(v_line.quantity_issued, 0) > 0 OR COALESCE(v_line.quantity_received,0)>0 THEN
        RAISE EXCEPTION
            'Cannot change an inventory item after stock has been issued';
    END IF;

    -- Validate the inventory item.
    SELECT *
      INTO v_item
      FROM public.stock_items
     WHERE id = _stock_item
       AND organization_id = v_org
       AND (
           branch_id = v_req.branch_id
           OR branch_id IS NULL
       );

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Inventory item does not belong to this organization or property';
    END IF;

    IF v_item.active IS NOT TRUE THEN
        RAISE EXCEPTION 'Cannot allocate an inactive inventory item';
    END IF;

    -- Safe repeat: no duplicate records or movements.
    IF v_line.stock_item_id = _stock_item THEN
        RETURN jsonb_build_object(
            'ok', true,
            'already_assigned', true,
            'requisition_id', _requisition,
            'line_id', _line,
            'stock_item_id', _stock_item
        );
    END IF;

    -- Allocation does NOT issue or deduct inventory.
    UPDATE public.internal_requisition_lines
       SET stock_item_id = _stock_item
     WHERE id = _line
       AND requisition_id = _requisition
       AND organization_id = v_org;

    RETURN jsonb_build_object(
        'ok', true,
        'already_assigned', false,
        'requisition_id', _requisition,
        'line_id', _line,
        'stock_item_id', _stock_item
    );
END;
$function$;

REVOKE ALL ON FUNCTION
public.neo_requisition_assign_stock_item(uuid, uuid, uuid)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
public.neo_requisition_assign_stock_item(uuid, uuid, uuid)
TO authenticated;
ALTER TABLE public.neo_print_agents
 ADD COLUMN IF NOT EXISTS discovery_request_id uuid,
 ADD COLUMN IF NOT EXISTS discovery_kind text,
 ADD COLUMN IF NOT EXISTS discovery_requested_at timestamptz,
 ADD COLUMN IF NOT EXISTS discovery_reported_request_id uuid,
 ADD COLUMN IF NOT EXISTS discovery_reported_at timestamptz,
 ADD COLUMN IF NOT EXISTS discovery_result jsonb;

CREATE OR REPLACE FUNCTION public.neo_print_discovery_authorize(_agent uuid)
RETURNS public.neo_print_agents LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $function$
DECLARE v_row public.neo_print_agents; v_org uuid:=public.current_org_id();
BEGIN
 IF auth.uid() IS NULL OR v_org IS NULL OR NOT (
  public.is_org_admin_for(v_org) OR public.has_permission('integrations','edit')
  OR public.has_permission('pos','settings.manage')) THEN
  RAISE EXCEPTION 'Printer configuration permission required' USING ERRCODE='42501';
 END IF;
 SELECT * INTO v_row FROM public.neo_print_agents WHERE id=_agent AND organization_id=v_org AND active;
 IF v_row.id IS NULL OR v_row.branch_id IS NULL OR NOT public.neo_branch_in_scope(v_row.branch_id) THEN
  RAISE EXCEPTION 'Print agent outside authorised property' USING ERRCODE='42501';
 END IF;
 RETURN v_row;
END
$function$;

CREATE OR REPLACE FUNCTION public.neo_print_discovery_request(_agent uuid,_kind text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $function$
DECLARE v_row public.neo_print_agents; v_id uuid;
BEGIN
 v_row:=public.neo_print_discovery_authorize(_agent);
 IF _kind IS NULL OR _kind NOT IN ('network','windows','usb','bluetooth') THEN RAISE EXCEPTION 'Unsupported discovery kind'; END IF;
 SELECT * INTO v_row FROM public.neo_print_agents WHERE id=_agent FOR UPDATE;
 IF v_row.discovery_request_id IS NOT NULL
  AND v_row.discovery_reported_request_id IS DISTINCT FROM v_row.discovery_request_id
  AND v_row.discovery_requested_at>now()-interval '2 minutes' THEN
  IF v_row.discovery_kind<>_kind THEN RAISE EXCEPTION 'Wait for the current printer search to finish'; END IF;
  RETURN jsonb_build_object('ok',true,'request_id',v_row.discovery_request_id,'requested_at',v_row.discovery_requested_at);
 END IF;
 IF v_row.discovery_requested_at>now()-interval '10 seconds' THEN RAISE EXCEPTION 'Wait ten seconds before searching again'; END IF;
 v_id:=gen_random_uuid();
 UPDATE public.neo_print_agents SET discovery_request_id=v_id,discovery_kind=_kind,
  discovery_requested_at=now(),discovery_result=NULL WHERE id=_agent;
 RETURN jsonb_build_object('ok',true,'request_id',v_id,'requested_at',now());
END
$function$;

CREATE OR REPLACE FUNCTION public.neo_print_discovery_status(_agent uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $function$
DECLARE v_row public.neo_print_agents;
BEGIN
 v_row:=public.neo_print_discovery_authorize(_agent);
 RETURN jsonb_build_object('agent_id',v_row.id,'branch_id',v_row.branch_id,'last_seen_at',v_row.last_seen_at,
  'request_id',v_row.discovery_request_id,'kind',v_row.discovery_kind,'requested_at',v_row.discovery_requested_at,
  'reported_request_id',v_row.discovery_reported_request_id,'reported_at',v_row.discovery_reported_at,
  'result',CASE WHEN v_row.discovery_reported_request_id=v_row.discovery_request_id THEN v_row.discovery_result ELSE NULL END);
END
$function$;

CREATE OR REPLACE FUNCTION public.neo_print_agent_discovery_poll(_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $function$
DECLARE v_row public.neo_print_agents;
BEGIN
 SELECT * INTO v_row FROM public.neo_print_agents WHERE token_hash=lower(coalesce(_token_hash,'')) AND active;
 IF v_row.id IS NULL OR v_row.branch_id IS NULL THEN RAISE EXCEPTION 'invalid_print_agent_token' USING ERRCODE='42501'; END IF;
 UPDATE public.neo_print_agents SET last_seen_at=now() WHERE id=v_row.id;
 IF v_row.discovery_request_id IS NULL OR v_row.discovery_reported_request_id=v_row.discovery_request_id
  OR v_row.discovery_requested_at<now()-interval '2 minutes' THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('request_id',v_row.discovery_request_id,'kind',v_row.discovery_kind);
END
$function$;

CREATE OR REPLACE FUNCTION public.neo_print_agent_discovery_report(_token_hash text,_request uuid,_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $function$
DECLARE v_row public.neo_print_agents; v_item jsonb;
BEGIN
 SELECT * INTO v_row FROM public.neo_print_agents WHERE token_hash=lower(coalesce(_token_hash,'')) AND active FOR UPDATE;
 IF v_row.id IS NULL OR v_row.branch_id IS NULL THEN RAISE EXCEPTION 'invalid_print_agent_token' USING ERRCODE='42501'; END IF;
 IF _request IS NULL OR _request IS DISTINCT FROM v_row.discovery_request_id
  OR v_row.discovery_requested_at<now()-interval '2 minutes' THEN
  RAISE EXCEPTION 'invalid_or_stale_discovery_request' USING ERRCODE='40001';
 END IF;
 IF _result IS NULL OR jsonb_typeof(_result)<>'object' OR octet_length(_result::text)>64000
  OR jsonb_typeof(_result->'printers') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid printer discovery result'; END IF;
 IF jsonb_array_length(_result->'printers')>100 THEN RAISE EXCEPTION 'Too many discovered printers'; END IF;
 FOR v_item IN SELECT * FROM jsonb_array_elements(_result->'printers') LOOP
  IF jsonb_typeof(v_item)<>'object' OR length(coalesce(v_item->>'name','')) NOT BETWEEN 1 AND 240
   OR length(coalesce(v_item->>'address',''))>500
   OR coalesce(v_item->>'connection_type','') NOT IN ('network','windows','unsupported') THEN
   RAISE EXCEPTION 'Invalid discovered printer';
  END IF;
 END LOOP;
 -- A repeated acknowledgement never replaces the already recorded result.
 IF v_row.discovery_reported_request_id=_request THEN RETURN jsonb_build_object('ok',true,'already_recorded',true); END IF;
 UPDATE public.neo_print_agents SET discovery_reported_request_id=_request,discovery_reported_at=now(),
  discovery_result=_result,last_seen_at=now() WHERE id=v_row.id;
 RETURN jsonb_build_object('ok',true);
END
$function$;
REVOKE ALL ON FUNCTION public.neo_print_discovery_authorize(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.neo_print_discovery_request(uuid,text),public.neo_print_discovery_status(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_print_discovery_request(uuid,text),public.neo_print_discovery_status(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.neo_print_agent_discovery_poll(text),public.neo_print_agent_discovery_report(text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.neo_print_agent_discovery_poll(text),public.neo_print_agent_discovery_report(text,uuid,jsonb) TO service_role;

NOTIFY pgrst,'reload schema';
WITH expected(signature,hash) AS (VALUES ('public.neo_print_agent_discovery_poll(text)','c5f0f6ef124a3ea3dde83ea9282896cc'),
('public.neo_print_agent_discovery_report(text,uuid,jsonb)','596769177ea4ea190453b9cee65e5f36'),
('public.neo_print_discovery_authorize(uuid)','848e29ba27b4ac608f292021182293ff'),
('public.neo_print_discovery_request(uuid,text)','c23619900245ac6a4e55fe4031f02715'),
('public.neo_print_discovery_status(uuid)','1043b2bc0c3102b358632d38e634dd3d'),
('public.neo_requisition_assign_stock_item(uuid,uuid,uuid)','ad435a6da566cdaa79a57303c590d8e5')), checked AS(SELECT signature,coalesce(md5(pg_get_functiondef(to_regprocedure(signature)))=hash,false) matches FROM expected) SELECT jsonb_build_object('diagnostic_version','stores-printer-connections-v1','definitions_match',(SELECT bool_and(matches) FROM checked),'definition_checks',(SELECT jsonb_agg(to_jsonb(checked)) FROM checked),'scope','Adds missing Stores allocation and property-printer discovery commands only. No stock issued, request approved, printer paired, device search run or print job queued by installation.') result;
COMMIT;
