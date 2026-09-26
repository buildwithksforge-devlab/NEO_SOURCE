
-- 1. Canonical posting module ---------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_canonical_posting_module(_module text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(coalesce(_module,''))
           WHEN 'pos_order' THEN 'pos'
           WHEN 'laundry_order' THEN 'laundry'
           WHEN 'delivery_order' THEN 'delivery'
           WHEN 'event_booking' THEN 'events'
           ELSE lower(coalesce(_module,''))
         END
$$;
REVOKE ALL ON FUNCTION public.neo_canonical_posting_module(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_canonical_posting_module(text) TO authenticated, service_role;

-- 2. Receipts are keyed on the canonical module ----------------------------
CREATE OR REPLACE FUNCTION public.neo_record_posting_receipt(_org uuid, _branch uuid, _module text, _source uuid, _reference text, _status text, _amount numeric, _currency text, _folio_line uuid, _detail text, _error text, _occurred date)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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
END $function$;

-- 3. Internal posting primitives are no longer directly callable -----------
REVOKE EXECUTE ON FUNCTION public.neo_gl_post(uuid, uuid, text, text, uuid, text, date, text, text, jsonb, uuid, uuid) FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.neo_record_posting_receipt(uuid, uuid, text, uuid, text, text, numeric, text, uuid, text, text, date) FROM authenticated, anon;

-- 4. Collapse historical duplicate receipts onto the canonical key ---------
WITH ranked AS (
  SELECT id, organization_id, source_id,
         public.neo_canonical_posting_module(source_module) AS canon,
         row_number() OVER (
           PARTITION BY organization_id, source_id, public.neo_canonical_posting_module(source_module)
           ORDER BY (status = 'posted') DESC, posted_at DESC NULLS LAST, created_at
         ) AS rn
    FROM public.finance_posting_receipts
)
UPDATE public.finance_posting_receipts f
   SET status = 'superseded',
       detail = 'Superseded: this record is recognised once under the canonical ' || r.canon || ' posting receipt.',
       idempotency_key = f.idempotency_key || ':superseded:' || left(f.id::text, 8),
       updated_at = now()
  FROM ranked r
 WHERE f.id = r.id AND r.rn > 1;

UPDATE public.finance_posting_receipts f
   SET idempotency_key = public.neo_canonical_posting_module(f.source_module) || ':' || f.source_id::text,
       updated_at = now()
 WHERE f.status <> 'superseded'
   AND f.idempotency_key IS DISTINCT FROM
       public.neo_canonical_posting_module(f.source_module) || ':' || f.source_id::text;

-- 5. Laundry orders cannot complete without a number and a chargeable value
CREATE OR REPLACE FUNCTION public.neo_laundry_completion_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF NEW.status IN ('delivered','completed','closed')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF coalesce(btrim(NEW.laundry_number), '') = '' THEN
      RAISE EXCEPTION 'This laundry order has no order number yet, so it cannot be completed.'
        USING ERRCODE = '23514';
    END IF;
    IF coalesce(NEW.total, 0) <= 0 THEN
      RAISE EXCEPTION 'This laundry order has no priced items, so it cannot be completed. Price the items first.'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
DROP TRIGGER IF EXISTS neo_laundry_completion_guard_trg ON public.guest_laundry_orders;
CREATE TRIGGER neo_laundry_completion_guard_trg
  BEFORE UPDATE ON public.guest_laundry_orders
  FOR EACH ROW EXECUTE FUNCTION public.neo_laundry_completion_guard();

-- 6. POS orders cannot hold an impossible lifecycle/payment combination ----
CREATE OR REPLACE FUNCTION public.neo_pos_lifecycle_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF current_setting('neo.payment_maintenance', true) = 'on' THEN RETURN NEW; END IF;

  IF NEW.status IN ('draft','cancelled','voided','void')
     AND coalesce(NEW.payment_status,'unpaid') IN ('paid','partial','partially_paid') THEN
    RAISE EXCEPTION 'A % order cannot be marked as %. Settle the order from the POS instead.',
      NEW.status, NEW.payment_status USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('closed','completed','settled')
     AND coalesce(NEW.payment_status,'unpaid') NOT IN ('paid','settled','complimentary','transferred','charged_to_room')
     AND coalesce(NEW.grand_total,0) > 0 THEN
    RAISE EXCEPTION 'This order cannot be closed while its payment is %.', NEW.payment_status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $function$;
DROP TRIGGER IF EXISTS neo_pos_lifecycle_guard_trg ON public.pos_orders;
CREATE TRIGGER neo_pos_lifecycle_guard_trg
  BEFORE UPDATE ON public.pos_orders
  FOR EACH ROW EXECUTE FUNCTION public.neo_pos_lifecycle_guard();

REVOKE ALL ON FUNCTION public.neo_laundry_completion_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_pos_lifecycle_guard() FROM PUBLIC, anon, authenticated;
