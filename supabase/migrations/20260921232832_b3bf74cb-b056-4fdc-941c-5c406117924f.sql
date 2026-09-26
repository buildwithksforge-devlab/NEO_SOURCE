CREATE OR REPLACE FUNCTION public.neo_folio_payment_trace(_folio uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _folio_row public.folios;
  _result jsonb;
BEGIN
  SELECT * INTO _folio_row
  FROM public.folios f
  WHERE f.id = _folio
    AND f.organization_id = public.current_org_id()
    AND (
      public.in_my_branch_scope(f.organization_id, f.branch_id)
      OR public.is_org_admin_for(f.organization_id)
    );

  IF _folio_row.id IS NULL THEN
    RETURN jsonb_build_object('found', false, 'payments', '[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(payment_event ORDER BY payment_event->>'recorded_at' DESC), '[]'::jsonb)
  INTO _result
  FROM (
    SELECT jsonb_build_object(
      'payment_id', p.id,
      'receipt_number', p.receipt_number,
      'amount', p.amount,
      'currency', COALESCE(p.currency, _folio_row.currency, 'KES'),
      'method', p.method,
      'status', p.status,
      'recorded_at', COALESCE(p.paid_at, p.created_at),
      'actor_id', COALESCE(p.received_by, audit_event.user_id, j.posted_by, j.created_by),
      'actor_name', COALESCE(
        NULLIF(btrim(receipt_actor.full_name), ''),
        NULLIF(btrim(audit_actor.full_name), ''),
        NULLIF(btrim(audit_event.user_name), ''),
        NULLIF(btrim(posted_actor.full_name), ''),
        NULLIF(btrim(prepared_actor.full_name), '')
      ),
      'journal_id', j.id,
      'journal_number', j.journal_number,
      'journal_status', j.status,
      'financial_consequence', COALESCE(journal_lines.lines, '[]'::jsonb)
    ) AS payment_event
    FROM public.payments p
    LEFT JOIN public.journal_entries j ON j.id = p.posted_journal_id
    LEFT JOIN public.profiles receipt_actor ON receipt_actor.id = p.received_by
    LEFT JOIN public.profiles posted_actor ON posted_actor.id = j.posted_by
    LEFT JOIN public.profiles prepared_actor ON prepared_actor.id = j.created_by
    LEFT JOIN LATERAL (
      SELECT al.user_id, al.user_name, al.created_at
      FROM public.audit_logs al
      WHERE al.organization_id = p.organization_id
        AND al.created_at >= p.created_at - interval '2 days'
        AND al.created_at <= p.created_at + interval '30 days'
        AND (
          al.record_id = p.id::text
          OR (
            al.record_id = p.folio_id::text
            AND al.action = 'finance.cash.receipt.confirm'
            AND (
              al.new_value->>'amount' = p.amount::text
              OR al.new_value::text ILIKE '%' || COALESCE(p.receipt_number, '') || '%'
            )
          )
        )
      ORDER BY
        CASE WHEN al.record_id = p.id::text THEN 0 ELSE 1 END,
        abs(extract(epoch FROM (al.created_at - COALESCE(p.paid_at, p.created_at))))
      LIMIT 1
    ) audit_event ON true
    LEFT JOIN public.profiles audit_actor ON audit_actor.id = audit_event.user_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'account_code', coa.code,
        'account_name', coa.name,
        'debit', jel.debit,
        'credit', jel.credit
      ) ORDER BY jel.debit DESC, jel.credit DESC, coa.code) AS lines
      FROM public.journal_entry_lines jel
      LEFT JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_id = j.id
    ) journal_lines ON true
    WHERE p.folio_id = _folio_row.id
  ) traced;

  RETURN jsonb_build_object(
    'found', true,
    'folio_id', _folio_row.id,
    'payments', COALESCE(_result, '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_folio_payment_trace(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_folio_payment_trace(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_folio_payment_trace(uuid) TO service_role;