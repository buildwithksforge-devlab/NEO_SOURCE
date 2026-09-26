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
  _jnum text;
  _jstatus text;
BEGIN
  SELECT * INTO p FROM public.payments
   WHERE id = _payment
     AND organization_id = current_org_id()
     AND (in_my_branch_scope(organization_id, branch_id) OR is_org_admin_for(organization_id));
  IF p.id IS NULL THEN RETURN jsonb_build_object('found', false); END IF;

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

  SELECT j.journal_number, j.status INTO _jnum, _jstatus
    FROM public.journal_entries j WHERE j.id = p.posted_journal_id;

  RETURN jsonb_build_object(
    'found', true,
    'payment_id', p.id,
    'reference', p.receipt_number,
    'record_id', p.folio_id,
    'amount', p.amount,
    'method', p.method,
    'recorded_at', p.paid_at,
    'captured_actor_id', p.received_by,
    'captured_actor_name', (SELECT full_name FROM public.profiles WHERE id = p.received_by),
    'journal_id', p.posted_journal_id,
    'journal_number', _jnum,
    'journal_status', _jstatus,
    'financial_consequence', _journal,
    'events', _events
  );
END;
$function$;