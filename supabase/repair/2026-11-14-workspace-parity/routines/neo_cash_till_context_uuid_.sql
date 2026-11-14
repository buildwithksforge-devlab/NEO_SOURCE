CREATE OR REPLACE FUNCTION public.neo_cash_till_context(_branch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _mine public.pos_shifts;
  _can_open boolean;
  _can_confirm boolean;
  _tills jsonb;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('active_tills', '[]'::jsonb); END IF;

  _can_open := public.has_permission('finance','till.create') OR public.has_permission('pos','shifts.open');
  _can_confirm := public.has_permission('finance','till.confirm_cash')
               OR public.has_permission('finance','till.edit')
               OR public.has_permission('pos','shifts.open');

  SELECT * INTO _mine FROM public.pos_shifts s
   WHERE s.organization_id=_org AND s.cashier_id=auth.uid() AND s.status='open'
     AND coalesce(public.neo_branch_in_scope(s.branch_id),false) AND (_branch IS NULL OR s.branch_id=_branch)
   ORDER BY (s.branch_id = _branch) DESC NULLS LAST, s.opened_at DESC LIMIT 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'shift_id', s.id, 'shift_number', s.shift_number,
           'cashier_id', s.cashier_id, 'cashier_name', COALESCE(p.full_name,'Cashier'),
           'branch_id', s.branch_id, 'opened_at', s.opened_at) ORDER BY s.opened_at DESC), '[]'::jsonb)
    INTO _tills
    FROM public.pos_shifts s
    LEFT JOIN public.profiles p ON p.id = s.cashier_id
   WHERE s.organization_id=_org AND s.status='open'
     AND coalesce(public.neo_branch_in_scope(s.branch_id),false) AND (_branch IS NULL OR s.branch_id=_branch);

  RETURN jsonb_build_object(
    'can_open_drawer', _can_open,
    'can_confirm_cash', _can_confirm,
    'my_shift_id', _mine.id,
    'my_shift_number', _mine.shift_number,
    'self_service', (_mine.id IS NOT NULL AND _can_confirm),
    'active_tills', _tills
  );
END; $function$
