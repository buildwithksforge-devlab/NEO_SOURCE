-- A receipt can originate in payments, pos_payments, event_payments or an
-- external provider.  The old lifecycle projection only read `payments`, so a
-- posted POS receipt remained "Money received" in the Payment Register even
-- though its order/payment journal was already posted.
--
-- Keep the proof rule in one helper and make both public readers consume it.
-- This is a read-model correction: it creates no receipt or journal and does
-- not rewrite any historical financial transaction.

CREATE OR REPLACE FUNCTION public.neo_payment_posted_journal(
  _organization uuid,
  _payment_table text,
  _payment uuid,
  _source_module text,
  _source_record uuid,
  _explicit_journal uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT j.id
    FROM public.journal_entries j
   WHERE j.organization_id = _organization
     AND j.status = 'posted'
     AND (
       j.id = _explicit_journal
       OR (
         _payment_table = 'payments'
         AND j.id = (SELECT p.posted_journal_id FROM public.payments p WHERE p.id = _payment)
       )
       OR j.source_document_id = _payment
       OR (
         _payment_table = 'pos_payments'
         AND _source_record IS NOT NULL
         AND j.source_document_id = _source_record
         AND lower(coalesce(j.source_module, '')) IN ('pos', 'restaurant')
       )
     )
   ORDER BY
     CASE
       WHEN j.id = _explicit_journal THEN 0
       WHEN j.source_document_id = _payment THEN 1
       ELSE 2
     END,
     j.posted_at DESC NULLS LAST,
     j.created_at DESC
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.neo_payment_posted_journal(uuid,text,uuid,text,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_payment_posted_journal(uuid,text,uuid,text,uuid,uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.neo_payment_register(
  _branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL,
  _state text DEFAULT NULL, _limit integer DEFAULT 500)
RETURNS TABLE (
  id uuid, branch_id uuid, source_module text, source_record_id uuid, payment_table text, payment_id uuid,
  method text, provider_code text, environment text, amount numeric, currency text,
  tendered numeric, change_due numeric, reference text, state text, state_detail text,
  manual_tender boolean, verified_at timestamptz, posted_journal_id uuid,
  requested_at timestamptz, confirmed_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE org uuid;
BEGIN
  org := public.current_org_id();
  IF org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE = '42501'; END IF;
  IF NOT (public.is_org_admin_for(org) OR public.has_permission('finance','view')
          OR public.has_permission('finance','edit') OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT a.id, a.branch_id, a.source_module, a.source_record_id, a.payment_table, a.payment_id,
         a.method, a.provider_code, a.environment, a.amount, a.currency,
         a.tendered, a.change_due, a.reference,
         CASE
           WHEN proof.journal_id IS NOT NULL
                AND a.state IN ('requested','pending','confirmed','posted') THEN 'posted'
           ELSE a.state
         END,
         a.state_detail, a.manual_tender, a.verified_at, proof.journal_id,
         a.requested_at, a.confirmed_at
    FROM public.payment_attempts a
    LEFT JOIN LATERAL (
      SELECT public.neo_payment_posted_journal(
        a.organization_id, a.payment_table, a.payment_id,
        a.source_module, a.source_record_id, a.posted_journal_id
      ) AS journal_id
    ) proof ON true
   WHERE a.organization_id = org
     AND (_branch IS NULL OR a.branch_id = _branch)
     AND (_from IS NULL OR a.requested_at >= _from::timestamptz)
     AND (_to IS NULL OR a.requested_at < (_to + 1)::timestamptz)
     AND (_state IS NULL OR
       CASE
         WHEN proof.journal_id IS NOT NULL
              AND a.state IN ('requested','pending','confirmed','posted') THEN 'posted'
         ELSE a.state
       END = _state)
   ORDER BY a.requested_at DESC
   LIMIT greatest(1, least(coalesce(_limit,500), 2000));
END;
$$;

REVOKE ALL ON FUNCTION public.neo_payment_register(uuid,date,date,text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_payment_register(uuid,date,date,text,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_payment_lifecycle(
  _branch uuid DEFAULT NULL,
  _from date DEFAULT NULL,
  _to date DEFAULT NULL,
  _payment uuid DEFAULT NULL
)
RETURNS TABLE(
  payment_id uuid, receipt_number text, branch_id uuid, folio_id uuid,
  folio_number text, reservation_id uuid, customer_id uuid, guest_name text,
  amount numeric, currency text, method text, paid_at timestamptz,
  journal_id uuid, journal_number text, journal_status text, accounting_date date,
  stage text, stage_label text, actor_id uuid, actor_name text, gl_lines jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.payment_id,
         a.reference,
         a.branch_id,
         p.folio_id,
         f.folio_number,
         p.reservation_id,
         COALESCE(p.customer_id, pp.customer_id),
         c.full_name,
         a.amount,
         COALESCE(a.currency, p.currency, pp.currency, f.currency, 'KES'),
         a.method,
         COALESCE(p.paid_at, pp.paid_at, a.confirmed_at, a.requested_at),
         j.id,
         j.journal_number,
         j.status,
         j.accounting_date,
         CASE
           WHEN j.id IS NOT NULL THEN 'in_ledger'
           WHEN a.state IN ('confirmed', 'posted') THEN 'received'
           WHEN a.state IN ('failed', 'cancelled', 'voided', 'timed_out') THEN 'unsuccessful'
           ELSE 'pending'
         END,
         CASE
           WHEN j.id IS NOT NULL THEN 'In the ledger'
           WHEN a.state IN ('confirmed', 'posted') THEN 'Money received'
           WHEN a.state IN ('failed', 'cancelled', 'voided', 'timed_out') THEN 'Unsuccessful'
           ELSE 'Awaiting confirmation'
         END,
         a.created_by,
         pr.full_name,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'account_code', coa.code,
                    'account_name', coa.name,
                    'debit', l.debit,
                    'credit', l.credit,
                    'description', l.description
                  ) ORDER BY l.debit DESC, l.credit DESC)
             FROM public.journal_entry_lines l
             LEFT JOIN public.chart_of_accounts coa ON coa.id = l.account_id
            WHERE l.journal_id = j.id
         ), '[]'::jsonb)
    FROM public.payment_attempts a
    LEFT JOIN public.payments p
      ON a.payment_table = 'payments' AND p.id = a.payment_id
    LEFT JOIN public.pos_payments pp
      ON a.payment_table = 'pos_payments' AND pp.id = a.payment_id
    LEFT JOIN public.folios f ON f.id = p.folio_id
    LEFT JOIN public.customers c ON c.id = COALESCE(p.customer_id, pp.customer_id)
    LEFT JOIN public.profiles pr ON pr.id = a.created_by
    LEFT JOIN LATERAL (
      SELECT je.*
        FROM public.journal_entries je
       WHERE je.id = public.neo_payment_posted_journal(
         a.organization_id, a.payment_table, a.payment_id,
         a.source_module, a.source_record_id, a.posted_journal_id
       )
    ) j ON true
   WHERE a.organization_id = current_org_id()
     AND (in_my_branch_scope(a.organization_id, a.branch_id) OR is_org_admin_for(a.organization_id))
     AND (_branch IS NULL OR a.branch_id = _branch)
     AND (_payment IS NULL OR a.payment_id = _payment)
     AND (_from IS NULL OR a.requested_at >= _from::timestamptz)
     AND (_to IS NULL OR a.requested_at < (_to + 1)::timestamptz)
   ORDER BY a.requested_at DESC
   LIMIT 1000
$$;

REVOKE ALL ON FUNCTION public.neo_payment_lifecycle(uuid,date,date,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_payment_lifecycle(uuid,date,date,uuid) TO authenticated;

