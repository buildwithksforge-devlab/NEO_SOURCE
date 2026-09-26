-- 1) can_read_journals: avoid materialising the resolved role_permissions view.
CREATE OR REPLACE FUNCTION public.can_read_journals()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.is_active_staff() AND (
    public.is_org_admin()
    OR EXISTS (
      SELECT 1
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id AND r.active,
      LATERAL public.role_permission_ids(r.id) rpi
      JOIN public.permissions p ON p.id = rpi.permission_id
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = public.current_org_id()
        AND r.organization_id = public.current_org_id()
        AND p.module = 'finance'
        AND p.feature IN ('journals','ledger','gl')
        AND p.action = 'view'
    )
    OR EXISTS (
      SELECT 1
      FROM public.user_permissions up
      JOIN public.permissions p ON p.id = up.permission_id
      WHERE up.user_id = auth.uid()
        AND up.organization_id = public.current_org_id()
        AND up.effect = 'grant'
        AND p.module = 'finance'
        AND p.feature IN ('journals','ledger','gl')
        AND p.action = 'view'
    )
  )
$function$;

-- 2) audit_trail: evaluate the permission gate once (InitPlan) instead of per row.
CREATE OR REPLACE FUNCTION public.audit_trail(
  _from timestamp with time zone DEFAULT (now() - '30 days'::interval),
  _to timestamp with time zone DEFAULT now(),
  _module text DEFAULT NULL::text,
  _branch uuid DEFAULT NULL::uuid,
  _limit integer DEFAULT 500)
 RETURNS TABLE(id uuid, created_at timestamp with time zone, action text, module text, actor_id uuid, actor_name text, record_id text, previous_value jsonb, new_value jsonb, reason text, device text, branch_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT a.id, a.created_at, a.action, a.module,
         a.user_id,
         COALESCE(NULLIF(btrim(pr.full_name), ''), NULLIF(btrim(a.user_name), ''),
                  CASE WHEN a.user_id IS NULL THEN 'System migration' ELSE 'Removed account' END),
         a.record_id, a.previous_value, a.new_value, a.reason, a.device, a.branch_id
  FROM public.audit_logs a
  LEFT JOIN public.profiles pr ON pr.id = a.user_id
  WHERE a.organization_id = public.current_org_id()
    AND public.current_org_id() IS NOT NULL
    AND (
      (SELECT public.is_org_admin() OR public.has_permission('administration','audit','view'))
      OR a.user_id = auth.uid()
    )
    AND a.created_at >= _from AND a.created_at <= _to
    AND (_module IS NULL OR a.module = _module)
    AND (_branch IS NULL OR a.branch_id = _branch)
  ORDER BY a.created_at DESC
  LIMIT GREATEST(COALESCE(_limit, 500), 1);
$function$;

-- 3) neo_payment_audit_trail: audit_logs stores user_id / user_name, not actor_id / actor_name.
CREATE OR REPLACE FUNCTION public.neo_payment_audit_trail(_payment uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p public.payments;
  _events jsonb := '[]'::jsonb;
  _journal jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO p FROM public.payments
   WHERE id = _payment
     AND organization_id = current_org_id()
     AND (in_my_branch_scope(organization_id, branch_id) OR is_org_admin_for(organization_id));
  IF p.id IS NULL THEN RETURN jsonb_build_object('found', false); END IF;

  -- audit_logs is monthly partitioned: always read inside a created_at window.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', al.id,
           'at', al.created_at,
           'action', al.action,
           'module', al.module,
           'record_id', al.record_id,
           'actor_id', al.user_id,
           'actor_name', COALESCE(NULLIF(btrim(pr.full_name), ''), NULLIF(btrim(al.user_name), '')),
           'reason', al.reason
         ) ORDER BY al.created_at), '[]'::jsonb)
    INTO _events
    FROM public.audit_logs al
    LEFT JOIN public.profiles pr ON pr.id = al.user_id
   WHERE al.organization_id = p.organization_id
     AND al.created_at >= p.created_at - interval '2 days'
     AND al.created_at <= p.created_at + interval '30 days'
     AND (al.record_id = p.id::text
          OR al.record_id = p.folio_id::text
          OR (p.receipt_number IS NOT NULL AND al.new_value::text ILIKE '%' || p.receipt_number || '%'));

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'account_code', a.code,
           'account_name', a.name,
           'debit', l.debit,
           'credit', l.credit
         )), '[]'::jsonb)
    INTO _journal
    FROM public.journal_entry_lines l
    LEFT JOIN public.chart_of_accounts a ON a.id = l.account_id
   WHERE l.journal_id = p.posted_journal_id;

  RETURN jsonb_build_object(
    'found', true,
    'payment_id', p.id,
    'reference', p.receipt_number,
    'record_id', p.folio_id,
    'amount', p.amount,
    'recorded_at', p.paid_at,
    'captured_actor_id', p.received_by,
    'captured_actor_name', (SELECT full_name FROM public.profiles WHERE id = p.received_by),
    'journal_id', p.posted_journal_id,
    'financial_consequence', _journal,
    'events', _events
  );
END;
$function$;