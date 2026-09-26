-- 1. Guest request -> folio charge, through the canonical posting routine.
CREATE OR REPLACE FUNCTION public.neo_request_charge_post(
  _request uuid,
  _description text,
  _quantity numeric,
  _unit_price numeric,
  _tax_rate numeric DEFAULT 0,
  _reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  r public.guest_requests%ROWTYPE;
  f public.folios%ROWTYPE;
  v_org uuid := public.current_org_id();
  v_net numeric;
  v_tax numeric;
  v_line uuid;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in'); END IF;

  SELECT * INTO r FROM public.guest_requests WHERE id = _request AND organization_id = v_org;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_request'); END IF;

  IF NOT (public.has_permission('pms','edit') OR public.has_permission('finance','create')
          OR public.is_org_admin_for(r.organization_id)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;

  IF coalesce(_quantity,0) <= 0 OR coalesce(_unit_price,0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_amount');
  END IF;
  IF _description IS NULL OR btrim(_description) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_description');
  END IF;

  IF r.reservation_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_stay');
  END IF;

  SELECT * INTO f FROM public.folios
   WHERE reservation_id = r.reservation_id
     AND organization_id = r.organization_id
     AND status IN ('open','reopened')
   ORDER BY opened_at DESC NULLS LAST
   LIMIT 1;
  IF f.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_open_folio'); END IF;

  v_net := round(_quantity * _unit_price, 2);
  v_tax := round(v_net * coalesce(_tax_rate,0) / 100.0, 2);

  v_line := public.folio_post_charge(
    _folio => f.id,
    _category => 'service',
    _description => btrim(_description),
    _quantity => _quantity,
    _unit_price => _unit_price,
    _tax => v_tax,
    _service_charge => 0,
    _discount => 0,
    _source_module => 'guest_requests',
    _source_record => r.id,
    _revenue_centre => 'guest_services',
    _idempotency_key => 'guest-request:' || r.id::text,
    _correlation => r.correlation_id
  );

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module,
    record_id, previous_value, new_value, reason)
  VALUES (r.organization_id, r.branch_id, auth.uid(),
    coalesce((SELECT full_name FROM public.profiles WHERE id = auth.uid()), ''),
    'guest.request.charged', 'pms', r.id::text,
    jsonb_build_object('category', r.category, 'status', r.status),
    jsonb_build_object('folio_id', f.id, 'folio_number', f.folio_number,
      'description', btrim(_description), 'quantity', _quantity, 'unit_price', _unit_price,
      'tax', v_tax, 'total', v_net + v_tax),
    nullif(btrim(coalesce(_reason,'')),''));

  RETURN jsonb_build_object('ok', true, 'folio_id', f.id, 'folio_number', f.folio_number,
    'line_id', v_line, 'net', v_net, 'tax', v_tax, 'total', v_net + v_tax);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_request_charge_post(uuid, text, numeric, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_request_charge_post(uuid, text, numeric, numeric, numeric, text) TO authenticated;

-- 2. Hotel raises a credit invoice against a partner's corporate account.
CREATE OR REPLACE FUNCTION public.neo_partner_invoice_raise(
  _relationship uuid,
  _lines jsonb,
  _due date DEFAULT NULL,
  _notes text DEFAULT NULL,
  _message text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  rel public.neo_access_relationships%ROWTYPE;
  acct public.corporate_accounts%ROWTYPE;
  v_org uuid := public.current_org_id();
  v_branch uuid;
  v_number text;
  v_invoice uuid;
  v_journal uuid;
  v_jnum text;
  v_ar uuid;
  v_revenue uuid;
  v_vat uuid;
  v_sub numeric := 0;
  v_tax numeric := 0;
  v_total numeric := 0;
  v_i int := 0;
  v_thread uuid;
  L jsonb;
  v_net numeric;
  v_ltax numeric;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in'); END IF;

  SELECT * INTO rel FROM public.neo_access_relationships
   WHERE id = _relationship AND organization_id = v_org AND door = 'partner' AND status = 'active';
  IF rel.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_relationship'); END IF;

  IF NOT (public.has_permission('finance','create') OR public.is_org_admin_for(rel.organization_id)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;

  IF rel.corporate_account_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_credit_account');
  END IF;

  SELECT * INTO acct FROM public.corporate_accounts
   WHERE id = rel.corporate_account_id AND organization_id = v_org;
  IF acct.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_a_credit_account'); END IF;

  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_lines');
  END IF;

  v_branch := coalesce(rel.branch_id, acct.branch_id);
  IF v_branch IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_property'); END IF;

  FOR L IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    IF coalesce((L->>'quantity')::numeric,0) <= 0 OR coalesce((L->>'unit_price')::numeric,0) <= 0
       OR btrim(coalesce(L->>'description','')) = '' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_line');
    END IF;
    v_net := round((L->>'quantity')::numeric * (L->>'unit_price')::numeric, 2);
    v_ltax := round(v_net * coalesce((L->>'tax_rate')::numeric, 0) / 100.0, 2);
    v_sub := v_sub + v_net;
    v_tax := v_tax + v_ltax;
  END LOOP;
  v_total := v_sub + v_tax;

  SELECT a.id INTO v_ar FROM public.chart_of_accounts a
   WHERE a.organization_id = v_org AND a.active AND coalesce(a.postable, true)
     AND a.name ILIKE 'Accounts Receivable' ORDER BY a.code LIMIT 1;
  IF v_ar IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_receivable_account'); END IF;

  SELECT a.id INTO v_revenue FROM public.chart_of_accounts a
   WHERE a.organization_id = v_org AND a.active AND coalesce(a.postable, true)
     AND a.category IN ('revenue','income') ORDER BY a.code LIMIT 1;
  IF v_revenue IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_revenue_account'); END IF;

  IF v_tax > 0 THEN
    SELECT a.id INTO v_vat FROM public.chart_of_accounts a
     WHERE a.organization_id = v_org AND a.active AND coalesce(a.postable, true)
       AND a.name ILIKE '%VAT Payable%' ORDER BY a.code LIMIT 1;
    IF v_vat IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_vat_account'); END IF;
  END IF;

  v_number := public.next_document_number('invoice', NULL, v_branch);

  INSERT INTO public.invoices (organization_id, branch_id, invoice_number, document_type,
    corporate_account_id, issue_date, due_date, currency, bill_to_snapshot, subtotal, tax_total,
    total, amount_paid, balance, status, notes, created_by, issued_at)
  VALUES (v_org, v_branch, v_number, 'tax_invoice', acct.id, CURRENT_DATE, _due,
    coalesce(acct.currency, 'KES'),
    jsonb_build_object('account_number', acct.account_number, 'name', acct.legal_name,
                       'email', acct.email, 'phone', acct.phone),
    v_sub, v_tax, v_total, 0, v_total, 'issued',
    coalesce(nullif(btrim(coalesce(_notes,'')),''), ''), auth.uid(), now())
  RETURNING id INTO v_invoice;

  FOR L IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    v_i := v_i + 1;
    v_net := round((L->>'quantity')::numeric * (L->>'unit_price')::numeric, 2);
    v_ltax := round(v_net * coalesce((L->>'tax_rate')::numeric, 0) / 100.0, 2);
    INSERT INTO public.invoice_lines (organization_id, invoice_id, line_number, description,
      source_module, source_record_id, revenue_account_id, quantity, unit_price,
      tax_rate, tax_amount, net_amount, total_amount)
    VALUES (v_org, v_invoice, v_i, btrim(L->>'description'), 'partner', rel.id, v_revenue,
      (L->>'quantity')::numeric, (L->>'unit_price')::numeric,
      coalesce((L->>'tax_rate')::numeric, 0), v_ltax, v_net, v_net + v_ltax);
  END LOOP;

  v_jnum := public.next_document_number('journal');
  INSERT INTO public.journal_entries (organization_id, branch_id, journal_number, journal_type,
    accounting_date, source_module, source_document_type, source_document_id, document_number,
    idempotency_key, description, currency, created_by, status)
  VALUES (v_org, v_branch, v_jnum, 'sales', CURRENT_DATE, 'partner', 'partner_invoice',
    v_invoice, v_number, 'partner-invoice:' || v_invoice::text,
    'Credit invoice ' || v_number || ' to ' || acct.legal_name,
    coalesce(acct.currency,'KES'), auth.uid(), 'draft')
  RETURNING id INTO v_journal;

  INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
    description, debit, credit, branch_id, revenue_centre)
  VALUES (v_org, v_journal, 1, v_ar, 'Receivable ' || v_number, v_total, 0, v_branch, 'partner');

  INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
    description, debit, credit, branch_id, revenue_centre)
  VALUES (v_org, v_journal, 2, v_revenue, 'Partner billing ' || v_number, 0, v_sub, v_branch, 'partner');

  IF v_tax > 0 THEN
    INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
      description, debit, credit, branch_id, revenue_centre)
    VALUES (v_org, v_journal, 3, v_vat, 'Output VAT on ' || v_number, 0, v_tax, v_branch, 'partner');
  END IF;

  PERFORM public.fin_post_journal(v_journal);
  UPDATE public.invoices SET journal_id = v_journal, updated_at = now() WHERE id = v_invoice;

  -- The partner is told in the same channel they already use to talk to the hotel.
  INSERT INTO public.partner_message_threads (organization_id, branch_id, relationship_id, subject, created_by)
  VALUES (v_org, v_branch, rel.id, 'Invoice ' || v_number, auth.uid())
  RETURNING id INTO v_thread;

  INSERT INTO public.partner_messages (organization_id, thread_id, sender_side, sender_user_id,
    sender_name, body)
  VALUES (v_org, v_thread, 'hotel', auth.uid(),
    coalesce((SELECT full_name FROM public.profiles WHERE id = auth.uid()), ''),
    coalesce(nullif(btrim(coalesce(_message,'')),''),
      'Invoice ' || v_number || ' for ' || coalesce(acct.currency,'KES') || ' '
        || to_char(v_total, 'FM999999999.00')
        || coalesce(', due ' || to_char(_due, 'DD Mon YYYY'), '') || '.'));

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module,
    record_id, new_value, reason)
  VALUES (v_org, v_branch, auth.uid(),
    coalesce((SELECT full_name FROM public.profiles WHERE id = auth.uid()), ''),
    'partner.invoice.raised', 'finance', v_number,
    jsonb_build_object('invoice_id', v_invoice, 'journal_number', v_jnum,
      'corporate_account', acct.account_number, 'total', v_total, 'tax', v_tax),
    nullif(btrim(coalesce(_notes,'')),''));

  RETURN jsonb_build_object('ok', true, 'invoice_id', v_invoice, 'invoice_number', v_number,
    'journal_number', v_jnum, 'total', v_total, 'tax', v_tax, 'thread_id', v_thread);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_partner_invoice_raise(uuid, jsonb, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_partner_invoice_raise(uuid, jsonb, date, text, text) TO authenticated;

-- 3. Hotel side of partner messaging.
CREATE OR REPLACE FUNCTION public.neo_hotel_partner_threads(_relationship uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  rel public.neo_access_relationships%ROWTYPE;
  v_org uuid := public.current_org_id();
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('allowed', false, 'reason', 'not_signed_in'); END IF;
  SELECT * INTO rel FROM public.neo_access_relationships
   WHERE id = _relationship AND organization_id = v_org AND door = 'partner';
  IF rel.id IS NULL THEN RETURN jsonb_build_object('allowed', false, 'reason', 'unknown_relationship'); END IF;
  IF NOT (public.has_permission('procurement','view') OR public.has_permission('finance','view')
          OR public.is_org_admin_for(rel.organization_id)) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'not_permitted');
  END IF;

  RETURN jsonb_build_object('allowed', true, 'threads', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', t.id, 'subject', t.subject, 'status', t.status, 'last_message_at', t.last_message_at,
      'messages', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', m.id, 'side', m.sender_side,
                 'sender_name', m.sender_name, 'body', m.body, 'at', m.created_at)
               ORDER BY m.created_at)
        FROM public.partner_messages m WHERE m.thread_id = t.id), '[]'::jsonb))
      ORDER BY t.last_message_at DESC)
    FROM public.partner_message_threads t
    WHERE t.relationship_id = rel.id AND t.organization_id = v_org), '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.neo_hotel_partner_threads(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_hotel_partner_threads(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_hotel_partner_send(
  _relationship uuid, _body text, _thread uuid DEFAULT NULL, _subject text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  rel public.neo_access_relationships%ROWTYPE;
  v_org uuid := public.current_org_id();
  v_thread uuid := _thread;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in'); END IF;
  IF _body IS NULL OR btrim(_body) = '' THEN RETURN jsonb_build_object('ok', false, 'reason', 'empty_message'); END IF;

  SELECT * INTO rel FROM public.neo_access_relationships
   WHERE id = _relationship AND organization_id = v_org AND door = 'partner';
  IF rel.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_relationship'); END IF;
  IF NOT (public.has_permission('procurement','edit') OR public.has_permission('finance','edit')
          OR public.has_permission('finance','create') OR public.is_org_admin_for(rel.organization_id)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;

  IF v_thread IS NULL THEN
    INSERT INTO public.partner_message_threads (organization_id, branch_id, relationship_id, subject, created_by)
    VALUES (v_org, rel.branch_id, rel.id,
      coalesce(nullif(btrim(coalesce(_subject,'')),''), 'Message from the hotel'), auth.uid())
    RETURNING id INTO v_thread;
  ELSE
    PERFORM 1 FROM public.partner_message_threads
     WHERE id = v_thread AND relationship_id = rel.id AND organization_id = v_org;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_thread'); END IF;
  END IF;

  INSERT INTO public.partner_messages (organization_id, thread_id, sender_side, sender_user_id, sender_name, body)
  VALUES (v_org, v_thread, 'hotel', auth.uid(),
    coalesce((SELECT full_name FROM public.profiles WHERE id = auth.uid()), ''), btrim(_body));

  UPDATE public.partner_message_threads SET last_message_at = now(), updated_at = now() WHERE id = v_thread;

  RETURN jsonb_build_object('ok', true, 'thread_id', v_thread);
END;
$$;

REVOKE ALL ON FUNCTION public.neo_hotel_partner_send(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_hotel_partner_send(uuid, text, uuid, text) TO authenticated;

-- 4. Partner portal also shows credit invoices raised against their account.
CREATE OR REPLACE FUNCTION public.neo_partner_credit_invoices(_branch uuid, _relationship uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  _uid uuid := auth.uid();
  _rel public.neo_access_relationships%ROWTYPE;
  _org uuid;
BEGIN
  IF _uid IS NULL THEN RETURN jsonb_build_object('allowed', false, 'reason', 'not_signed_in'); END IF;
  SELECT organization_id INTO _org FROM public.branches WHERE id = _branch AND active IS TRUE;
  IF _org IS NULL THEN RETURN jsonb_build_object('allowed', false, 'reason', 'unknown_property'); END IF;

  SELECT * INTO _rel FROM public.neo_access_relationships
   WHERE id = _relationship AND auth_user_id = _uid AND door = 'partner' AND status = 'active'
     AND organization_id = _org AND (branch_id IS NULL OR branch_id = _branch);
  IF _rel.id IS NULL THEN RETURN jsonb_build_object('allowed', false, 'reason', 'no_relationship'); END IF;
  IF _rel.corporate_account_id IS NULL THEN
    RETURN jsonb_build_object('allowed', true, 'invoices', '[]'::jsonb);
  END IF;

  RETURN jsonb_build_object('allowed', true, 'invoices', COALESCE((
    SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT i.invoice_number, i.issue_date, i.due_date, i.currency, i.total,
             i.amount_paid, i.balance, i.status
      FROM public.invoices i
      WHERE i.corporate_account_id = _rel.corporate_account_id
        AND i.organization_id = _org
        AND i.status <> 'draft'
      ORDER BY i.issue_date DESC, i.created_at DESC LIMIT 50
    ) t), '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.neo_partner_credit_invoices(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_partner_credit_invoices(uuid, uuid) TO authenticated;