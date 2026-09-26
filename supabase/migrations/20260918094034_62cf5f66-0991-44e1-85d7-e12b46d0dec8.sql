
DO $do$
DECLARE
  _def text := pg_get_functiondef('public.neo_my_work(uuid)'::regprocedure);
  _old text := $old$  SELECT count(*) INTO n1 FROM public.approval_requests a
   WHERE a.organization_id = v_org AND (_branch IS NULL OR a.branch_id = _branch)
     AND a.status = 'pending_approval' AND a.approver_id = auth.uid();
  IF n1 > 0 OR public.has_permission('approvals', 'view') THEN
    v_items := v_items || jsonb_build_array(
      jsonb_build_object('id','my-approvals','module','workforce','label','Approvals waiting for my decision',
        'value', n1, 'detail','Routed to me and still pending','route','/approvals',
        'tone', CASE WHEN n1 > 0 THEN 'warning' ELSE 'ok' END));
  END IF;$old$;
  _new text := $new$  -- Maker/checker: a request you raised never counts as yours to approve.
  SELECT count(*) INTO n1 FROM public.approval_requests a
   WHERE a.organization_id = v_org AND (_branch IS NULL OR a.branch_id = _branch)
     AND a.status = 'pending_approval' AND a.approver_id = auth.uid()
     AND a.requester_id IS DISTINCT FROM auth.uid();
  SELECT count(*) INTO n2 FROM public.approval_requests a
   WHERE a.organization_id = v_org AND (_branch IS NULL OR a.branch_id = _branch)
     AND a.status = 'pending_approval' AND a.requester_id = auth.uid();
  IF n1 > 0 OR n2 > 0 OR public.has_permission('approvals', 'view') THEN
    v_items := v_items || jsonb_build_array(
      jsonb_build_object('id','my-approvals','module','workforce','label','Approvals waiting for my decision',
        'value', n1, 'detail','Raised by somebody else and routed to me','route','/approvals',
        'tone', CASE WHEN n1 > 0 THEN 'warning' ELSE 'ok' END),
      jsonb_build_object('id','my-raised-approvals','module','workforce','label','Raised by me — waiting on someone else',
        'value', n2, 'detail','You cannot approve your own request','route','/approvals',
        'tone', CASE WHEN n2 > 0 THEN 'info' ELSE 'ok' END));
  END IF;$new$;
BEGIN
  IF strpos(_def, _old) = 0 THEN
    RAISE EXCEPTION 'neo_my_work approvals block not found; aborting so nothing is guessed.';
  END IF;
  EXECUTE replace(_def, _old, _new);
END $do$;
