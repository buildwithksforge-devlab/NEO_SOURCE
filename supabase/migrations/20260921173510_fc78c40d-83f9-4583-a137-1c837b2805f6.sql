
-- 1. Proof-based backfill: a posted journal that names the payment is proof.
UPDATE public.payments p
   SET posted_journal_id = j.id
  FROM public.journal_entries j
 WHERE p.posted_journal_id IS NULL
   AND j.status = 'posted'
   AND j.organization_id = p.organization_id
   AND j.source_document_id = p.id;

UPDATE public.payment_attempts a
   SET posted_journal_id = p.posted_journal_id,
       state = CASE WHEN a.state IN ('confirmed','pending','requested') THEN 'posted' ELSE a.state END
  FROM public.payments p
 WHERE a.payment_table = 'payments'
   AND a.payment_id = p.id
   AND p.posted_journal_id IS NOT NULL
   AND a.posted_journal_id IS NULL;

-- 2. Canonical folio projection.
CREATE OR REPLACE FUNCTION public.neo_folio_projection(_folio uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f public.folios;
  _net numeric := 0;
  _tax numeric := 0;
  _gross numeric := 0;
  _paid numeric := 0;
  _guest text;
  _res text;
BEGIN
  SELECT * INTO f FROM public.folios
   WHERE id = _folio
     AND organization_id = current_org_id()
     AND (in_my_branch_scope(organization_id, branch_id) OR is_org_admin_for(organization_id));
  IF f.id IS NULL THEN RETURN jsonb_build_object('found', false); END IF;

  SELECT COALESCE(SUM(l.net_amount), 0),
         COALESCE(SUM(l.tax_amount + COALESCE(l.service_charge_amount, 0)), 0),
         COALESCE(SUM(l.gross_amount), 0)
    INTO _net, _tax, _gross
    FROM public.folio_lines l
   WHERE l.folio_id = f.id
     AND COALESCE(l.status, 'posted') <> 'reversed'
     AND COALESCE(l.line_type, 'charge') <> 'payment';

  SELECT COALESCE(SUM(pm.amount), 0) INTO _paid
    FROM public.payments pm
   WHERE pm.folio_id = f.id
     AND pm.status IN ('confirmed', 'posted', 'completed');

  SELECT c.full_name INTO _guest FROM public.customers c WHERE c.id = f.customer_id;
  SELECT r.reservation_number INTO _res FROM public.reservations r WHERE r.id = f.reservation_id;

  RETURN jsonb_build_object(
    'found', true,
    'folio_id', f.id,
    'folio_number', f.folio_number,
    'status', f.status,
    'currency', f.currency,
    'branch_id', f.branch_id,
    'reservation_id', f.reservation_id,
    'reservation_number', _res,
    'customer_id', f.customer_id,
    'guest_name', _guest,
    'net_revenue', _net,
    'tax', _tax,
    'gross_obligation', _gross,
    'collected', _paid,
    'outstanding', _gross - _paid
  );
END;
$$;

-- 3. Canonical payment lifecycle projection.
CREATE OR REPLACE FUNCTION public.neo_payment_lifecycle(
  _branch uuid DEFAULT NULL,
  _from date DEFAULT NULL,
  _to date DEFAULT NULL,
  _payment uuid DEFAULT NULL
)
RETURNS TABLE(
  payment_id uuid,
  receipt_number text,
  branch_id uuid,
  folio_id uuid,
  folio_number text,
  reservation_id uuid,
  customer_id uuid,
  guest_name text,
  amount numeric,
  currency text,
  method text,
  paid_at timestamptz,
  journal_id uuid,
  journal_number text,
  journal_status text,
  accounting_date date,
  stage text,
  stage_label text,
  actor_id uuid,
  actor_name text,
  gl_lines jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id,
         p.receipt_number,
         p.branch_id,
         p.folio_id,
         f.folio_number,
         p.reservation_id,
         p.customer_id,
         c.full_name,
         p.amount,
         COALESCE(p.currency, f.currency, 'KES'),
         p.method,
         p.paid_at,
         j.id,
         j.journal_number,
         j.status,
         j.accounting_date,
         CASE
           WHEN j.id IS NOT NULL AND j.status = 'posted' THEN 'in_ledger'
           WHEN p.status IN ('confirmed', 'completed') THEN 'received'
           WHEN p.status IN ('failed', 'cancelled', 'voided') THEN 'unsuccessful'
           ELSE 'pending'
         END,
         CASE
           WHEN j.id IS NOT NULL AND j.status = 'posted' THEN 'In the ledger'
           WHEN p.status IN ('confirmed', 'completed') THEN 'Money received'
           WHEN p.status IN ('failed', 'cancelled', 'voided') THEN 'Unsuccessful'
           ELSE 'Awaiting confirmation'
         END,
         p.received_by,
         pr.full_name,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'account_code', a.code,
                    'account_name', a.name,
                    'debit', l.debit,
                    'credit', l.credit,
                    'description', l.description
                  ) ORDER BY l.debit DESC)
             FROM public.journal_entry_lines l
             LEFT JOIN public.chart_of_accounts a ON a.id = l.account_id
            WHERE l.journal_id = j.id
         ), '[]'::jsonb)
    FROM public.payments p
    LEFT JOIN public.folios f ON f.id = p.folio_id
    LEFT JOIN public.customers c ON c.id = p.customer_id
    LEFT JOIN public.profiles pr ON pr.id = p.received_by
    LEFT JOIN public.journal_entries j
           ON j.id = COALESCE(p.posted_journal_id,
                              (SELECT je.id FROM public.journal_entries je
                                WHERE je.organization_id = p.organization_id
                                  AND je.source_document_id = p.id
                                  AND je.status = 'posted'
                                ORDER BY je.posted_at DESC LIMIT 1))
   WHERE p.organization_id = current_org_id()
     AND (in_my_branch_scope(p.organization_id, p.branch_id) OR is_org_admin_for(p.organization_id))
     AND (_branch IS NULL OR p.branch_id = _branch)
     AND (_payment IS NULL OR p.id = _payment)
     AND (_from IS NULL OR p.paid_at >= _from::timestamptz)
     AND (_to IS NULL OR p.paid_at < (_to + 1)::timestamptz)
   ORDER BY p.paid_at DESC
   LIMIT 1000;
$$;

-- 4. Journal detail by canonical journal id and property scope.
CREATE OR REPLACE FUNCTION public.neo_journal_detail(_journal uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  j public.journal_entries;
  _lines jsonb;
BEGIN
  SELECT * INTO j FROM public.journal_entries
   WHERE id = _journal
     AND organization_id = current_org_id()
     AND can_read_journals()
     AND (in_my_branch_scope(organization_id, branch_id) OR is_org_admin_for(organization_id));
  IF j.id IS NULL THEN RETURN jsonb_build_object('found', false); END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', l.id,
           'account_id', l.account_id,
           'account_code', a.code,
           'account_name', a.name,
           'debit', l.debit,
           'credit', l.credit,
           'description', l.description
         ) ORDER BY l.debit DESC, l.credit DESC), '[]'::jsonb)
    INTO _lines
    FROM public.journal_entry_lines l
    LEFT JOIN public.chart_of_accounts a ON a.id = l.account_id
   WHERE l.journal_id = j.id;

  RETURN jsonb_build_object(
    'found', true,
    'id', j.id,
    'journal_number', j.journal_number,
    'journal_type', j.journal_type,
    'status', j.status,
    'accounting_date', j.accounting_date,
    'description', j.description,
    'currency', j.currency,
    'branch_id', j.branch_id,
    'source_module', j.source_module,
    'source_document_type', j.source_document_type,
    'source_document_id', j.source_document_id,
    'total_debit', j.total_debit,
    'total_credit', j.total_credit,
    'posted_at', j.posted_at,
    'lines', _lines
  );
END;
$$;

-- 5. Payment audit trail: reference, record, time, actor, financial consequence.
CREATE OR REPLACE FUNCTION public.neo_payment_audit_trail(_payment uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
           'actor_id', al.actor_id,
           'actor_name', COALESCE(al.actor_name, pr.full_name),
           'reason', al.reason
         ) ORDER BY al.created_at), '[]'::jsonb)
    INTO _events
    FROM public.audit_logs al
    LEFT JOIN public.profiles pr ON pr.id = al.actor_id
   WHERE al.organization_id = p.organization_id
     AND al.created_at >= p.created_at - interval '2 days'
     AND al.created_at <= p.created_at + interval '30 days'
     AND (al.record_id = p.id::text
          OR al.record_id = p.folio_id::text
          OR al.new_value::text ILIKE '%' || p.receipt_number || '%');

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
$$;

-- 6. Partner messaging.
CREATE TABLE IF NOT EXISTS public.partner_message_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  relationship_id uuid NOT NULL REFERENCES public.neo_access_relationships(id) ON DELETE CASCADE,
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.partner_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  thread_id uuid NOT NULL REFERENCES public.partner_message_threads(id) ON DELETE CASCADE,
  sender_side text NOT NULL CHECK (sender_side IN ('partner', 'hotel')),
  sender_user_id uuid,
  sender_name text,
  body text NOT NULL,
  read_by_partner_at timestamptz,
  read_by_hotel_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_message_threads_rel_idx
  ON public.partner_message_threads(relationship_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS partner_messages_thread_idx
  ON public.partner_messages(thread_id, created_at);

GRANT SELECT, INSERT, UPDATE ON public.partner_message_threads TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.partner_messages TO authenticated;
GRANT ALL ON public.partner_message_threads TO service_role;
GRANT ALL ON public.partner_messages TO service_role;

ALTER TABLE public.partner_message_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY partner_threads_read ON public.partner_message_threads
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.neo_access_relationships r
             WHERE r.id = relationship_id AND r.auth_user_id = auth.uid()
               AND r.door = 'partner' AND r.status = 'active')
    OR (organization_id = current_org_id()
        AND (in_my_branch_scope(organization_id, branch_id) OR is_org_admin_for(organization_id)))
  );

CREATE POLICY partner_threads_write ON public.partner_message_threads
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.neo_access_relationships r
             WHERE r.id = relationship_id AND r.auth_user_id = auth.uid()
               AND r.door = 'partner' AND r.status = 'active'
               AND r.organization_id = partner_message_threads.organization_id)
    OR (organization_id = current_org_id()
        AND (in_my_branch_scope(organization_id, branch_id) OR is_org_admin_for(organization_id)))
  );

CREATE POLICY partner_threads_update ON public.partner_message_threads
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.neo_access_relationships r
             WHERE r.id = relationship_id AND r.auth_user_id = auth.uid()
               AND r.door = 'partner' AND r.status = 'active')
    OR (organization_id = current_org_id()
        AND (in_my_branch_scope(organization_id, branch_id) OR is_org_admin_for(organization_id)))
  );

CREATE POLICY partner_messages_read ON public.partner_messages
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.partner_message_threads t
       LEFT JOIN public.neo_access_relationships r ON r.id = t.relationship_id
       WHERE t.id = partner_messages.thread_id
         AND ((r.auth_user_id = auth.uid() AND r.door = 'partner' AND r.status = 'active')
              OR (t.organization_id = current_org_id()
                  AND (in_my_branch_scope(t.organization_id, t.branch_id)
                       OR is_org_admin_for(t.organization_id))))
    )
  );

CREATE POLICY partner_messages_write ON public.partner_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.partner_message_threads t
       LEFT JOIN public.neo_access_relationships r ON r.id = t.relationship_id
       WHERE t.id = partner_messages.thread_id
         AND t.organization_id = partner_messages.organization_id
         AND ((r.auth_user_id = auth.uid() AND r.door = 'partner' AND r.status = 'active'
               AND partner_messages.sender_side = 'partner')
              OR (t.organization_id = current_org_id()
                  AND (in_my_branch_scope(t.organization_id, t.branch_id)
                       OR is_org_admin_for(t.organization_id))
                  AND partner_messages.sender_side = 'hotel'))
    )
  );

CREATE POLICY partner_messages_update ON public.partner_messages
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.partner_message_threads t
       LEFT JOIN public.neo_access_relationships r ON r.id = t.relationship_id
       WHERE t.id = partner_messages.thread_id
         AND ((r.auth_user_id = auth.uid() AND r.door = 'partner' AND r.status = 'active')
              OR (t.organization_id = current_org_id()
                  AND (in_my_branch_scope(t.organization_id, t.branch_id)
                       OR is_org_admin_for(t.organization_id))))
    )
  );

CREATE OR REPLACE FUNCTION public.partner_messaging_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS partner_threads_touch ON public.partner_message_threads;
CREATE TRIGGER partner_threads_touch BEFORE UPDATE ON public.partner_message_threads
  FOR EACH ROW EXECUTE FUNCTION public.partner_messaging_touch();
DROP TRIGGER IF EXISTS partner_messages_touch ON public.partner_messages;
CREATE TRIGGER partner_messages_touch BEFORE UPDATE ON public.partner_messages
  FOR EACH ROW EXECUTE FUNCTION public.partner_messaging_touch();

CREATE OR REPLACE FUNCTION public.neo_partner_threads(_relationship uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.neo_access_relationships;
BEGIN
  SELECT * INTO r FROM public.neo_access_relationships
   WHERE id = _relationship
     AND ((auth_user_id = auth.uid() AND door = 'partner' AND status = 'active')
          OR (organization_id = current_org_id()));
  IF r.id IS NULL THEN RETURN jsonb_build_object('allowed', false); END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'threads', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', t.id,
               'subject', t.subject,
               'status', t.status,
               'last_message_at', t.last_message_at,
               'messages', COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                           'id', m.id,
                           'side', m.sender_side,
                           'sender_name', m.sender_name,
                           'body', m.body,
                           'at', m.created_at
                         ) ORDER BY m.created_at)
                    FROM public.partner_messages m WHERE m.thread_id = t.id
               ), '[]'::jsonb)
             ) ORDER BY t.last_message_at DESC)
        FROM public.partner_message_threads t
       WHERE t.relationship_id = r.id
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_partner_message_send(
  _relationship uuid,
  _body text,
  _thread uuid DEFAULT NULL,
  _subject text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.neo_access_relationships;
  _side text;
  _thread_id uuid := _thread;
  _name text;
  _msg uuid;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in'); END IF;
  IF COALESCE(btrim(_body), '') = '' THEN RETURN jsonb_build_object('ok', false, 'reason', 'empty_message'); END IF;

  SELECT * INTO r FROM public.neo_access_relationships WHERE id = _relationship;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_relationship'); END IF;

  IF r.auth_user_id = auth.uid() AND r.door = 'partner' AND r.status = 'active' THEN
    _side := 'partner';
  ELSIF r.organization_id = current_org_id()
    AND (in_my_branch_scope(r.organization_id, r.branch_id) OR is_org_admin_for(r.organization_id)) THEN
    _side := 'hotel';
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'not_permitted');
  END IF;

  SELECT full_name INTO _name FROM public.profiles WHERE id = auth.uid();

  IF _thread_id IS NULL THEN
    INSERT INTO public.partner_message_threads
      (organization_id, branch_id, relationship_id, subject, created_by)
    VALUES (r.organization_id, r.branch_id, r.id,
            COALESCE(NULLIF(btrim(_subject), ''), 'Message'), auth.uid())
    RETURNING id INTO _thread_id;
  ELSE
    PERFORM 1 FROM public.partner_message_threads
      WHERE id = _thread_id AND relationship_id = r.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_thread'); END IF;
  END IF;

  INSERT INTO public.partner_messages
    (organization_id, thread_id, sender_side, sender_user_id, sender_name, body)
  VALUES (r.organization_id, _thread_id, _side, auth.uid(), _name, btrim(_body))
  RETURNING id INTO _msg;

  UPDATE public.partner_message_threads
     SET last_message_at = now(), status = 'open'
   WHERE id = _thread_id;

  RETURN jsonb_build_object('ok', true, 'thread_id', _thread_id, 'message_id', _msg, 'side', _side);
END;
$$;

GRANT EXECUTE ON FUNCTION public.neo_folio_projection(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_payment_lifecycle(uuid, date, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_journal_detail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_payment_audit_trail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_partner_threads(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_partner_message_send(uuid, text, uuid, text) TO authenticated;
