CREATE OR REPLACE FUNCTION public.neo_record_posting_receipt(_org uuid, _branch uuid, _module text, _source uuid, _reference text, _status text, _amount numeric, _currency text, _folio_line uuid, _detail text, _error text, _occurred date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _mod text := _module;
        _key text := public.neo_canonical_posting_module(_module) || ':' || _source::text; _id uuid;
BEGIN
  INSERT INTO public.finance_posting_receipts AS r
    (organization_id, branch_id, source_module, source_id, source_reference, idempotency_key,
     status, amount, currency, folio_line_id, detail, attempts, last_error, requested_by,
     posted_at, occurred_on)
  VALUES (_org, _branch, _mod, _source, _reference, _key, _status, coalesce(_amount,0),
          coalesce(_currency,'KES'), _folio_line, _detail, 1, _error, auth.uid(),
          CASE WHEN _status = 'posted' THEN now() END, _occurred)
  ON CONFLICT (organization_id, idempotency_key) DO UPDATE
     SET status = CASE WHEN r.status = 'posted' THEN 'posted' ELSE excluded.status END,
         amount = excluded.amount,
         currency = excluded.currency,
         folio_line_id = coalesce(r.folio_line_id, excluded.folio_line_id),
         detail = excluded.detail,
         attempts = r.attempts + 1,
         last_error = excluded.last_error,
         requested_by = coalesce(excluded.requested_by, r.requested_by),
         posted_at = coalesce(r.posted_at, excluded.posted_at),
         occurred_on = coalesce(r.occurred_on, excluded.occurred_on)
  RETURNING r.id INTO _id;
  RETURN _id;
END $function$
