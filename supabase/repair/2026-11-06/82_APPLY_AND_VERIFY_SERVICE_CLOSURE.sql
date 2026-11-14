-- Narrow code-only repair. Does not close existing orders or change payments on installation.
-- Uses the existing internal settlement engine and retains its permissions/signature.
BEGIN;
DO $guard$ DECLARE x record; BEGIN
 FOR x IN SELECT * FROM (VALUES ('public.neo_branch_in_scope(uuid)','073af6634a1614993b8a1c0061643270'),
('public.neo_cash_request_payment(uuid,numeric,text,text,text)','33a7c2397ac3e245cb9d883f0990ebda'),
('public.neo_cash_request_pos_payment(uuid,numeric,text,text,text)','ca4a6bcb4641691751f5de1c70761206'),
('public.neo_cash_settle_request(uuid)','8536b8f2fb47d499c37bb423cc5373b2'),
('public.neo_cash_till_context(uuid)','0056bf3ebc240af86eec6901d53680c2'),
('public.pos_reconcile_order_settlement(uuid)','39307e5eca40679a396faa1eff3efd33'),
('public.pos_reconcile_settlement_internal(uuid)','9ac8c027fd726fabefb5c9bffdc63ab5'),
('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid)','e3a09ce80f0bf557e4bfd9520c93b21c'),
('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid,jsonb)','fe6d4802c4b7b16e939c53de4091ebf7')) AS expected(signature,hash) LOOP
  IF md5(pg_get_functiondef(to_regprocedure(x.signature))) IS DISTINCT FROM x.hash THEN
   RAISE EXCEPTION 'Installed function changed: %. Stop and review.',x.signature;
  END IF;
 END LOOP;
END $guard$;
CREATE OR REPLACE FUNCTION public.pos_reconcile_settlement_internal(_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _o public.pos_orders;
  _paid numeric := 0;
  _pending numeric := 0;
  _balance numeric;
  _open_items int;
  _closed boolean := false;
  _pay_status text;
  _settleable boolean;
BEGIN
  SELECT * INTO _o FROM public.pos_orders WHERE id = _order_id FOR UPDATE;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;

  SELECT coalesce(sum(amount) FILTER (WHERE status = 'confirmed'), 0),
         coalesce(sum(amount) FILTER (WHERE status IN ('initiated','pending')), 0)
    INTO _paid, _pending
    FROM public.pos_payments WHERE order_id = _order_id;

  _balance := round(coalesce(_o.grand_total, 0) - _paid, 2);

  SELECT count(*) INTO _open_items
    FROM public.pos_order_items
   WHERE order_id = _order_id AND coalesce(status,'draft') NOT IN ('served','cancelled','voided');

  _pay_status := CASE
    WHEN _balance <= 0.005 AND coalesce(_o.grand_total,0) > 0 THEN 'paid'
    WHEN _paid > 0 THEN 'partial'
    WHEN _pending > 0 THEN 'pending'
    ELSE 'unpaid' END;

  _settleable := _balance <= 0.005 AND coalesce(_o.grand_total,0) > 0 AND _open_items = 0
                 AND _o.status NOT IN ('closed','cancelled','voided','charged-to-room','credit');

  IF _settleable THEN
    -- move the order out of the service states BEFORE marking it paid, so the
    -- lifecycle guard never sees a fully paid order sitting in 'served'.
    IF _o.status IN ('served','partially-served') THEN
      UPDATE public.pos_orders SET status = 'awaiting-payment' WHERE id = _order_id;
      _o.status := 'awaiting-payment';
    END IF;

    IF _o.status = 'awaiting-payment' THEN
      UPDATE public.pos_orders
         SET status = 'paid', paid_total = _paid, payment_status = _pay_status
       WHERE id = _order_id;
      UPDATE public.pos_orders SET status = 'closed', closed_at = now() WHERE id = _order_id;
      _closed := true;
    ELSIF _o.status = 'paid' THEN
      -- Older prepaid orders already have their receipt/payment/journal.
      -- Close only after every service item is terminal; never take payment again.
      UPDATE public.pos_orders SET status = 'closed', closed_at = now() WHERE id = _order_id;
      _closed := true;
    ELSE
      UPDATE public.pos_orders
         SET paid_total = _paid, payment_status = _pay_status
       WHERE id = _order_id
         AND (paid_total IS DISTINCT FROM _paid OR payment_status IS DISTINCT FROM _pay_status);
    END IF;
  ELSE
    UPDATE public.pos_orders
       SET paid_total = _paid, payment_status = _pay_status
     WHERE id = _order_id
       AND (paid_total IS DISTINCT FROM _paid OR payment_status IS DISTINCT FROM _pay_status);
  END IF;

  RETURN jsonb_build_object(
    'order_id', _order_id,
    'grand_total', coalesce(_o.grand_total,0),
    'paid_total', _paid,
    'pending_total', _pending,
    'balance', greatest(_balance, 0),
    'payment_status', _pay_status,
    'open_items', _open_items,
    'closed', _closed
  );
END $function$
;
NOTIFY pgrst,'reload schema';
COMMIT;

-- Read-only installation check. Does not reconcile/close any existing bill.
BEGIN READ ONLY;
WITH retained(signature,hash) AS (VALUES ('public.neo_branch_in_scope(uuid)','073af6634a1614993b8a1c0061643270'),
('public.neo_cash_request_payment(uuid,numeric,text,text,text)','33a7c2397ac3e245cb9d883f0990ebda'),
('public.neo_cash_request_pos_payment(uuid,numeric,text,text,text)','ca4a6bcb4641691751f5de1c70761206'),
('public.neo_cash_settle_request(uuid)','8536b8f2fb47d499c37bb423cc5373b2'),
('public.neo_cash_till_context(uuid)','0056bf3ebc240af86eec6901d53680c2'),
('public.pos_reconcile_order_settlement(uuid)','39307e5eca40679a396faa1eff3efd33'),
('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid)','e3a09ce80f0bf557e4bfd9520c93b21c'),
('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid,jsonb)','fe6d4802c4b7b16e939c53de4091ebf7')), proof AS (
 SELECT signature,md5(pg_get_functiondef(to_regprocedure(signature)))=hash AS unchanged FROM retained
)
SELECT jsonb_build_object('diagnostic_version','prepaid-service-closure-install-v1',
 'read_only',current_setting('transaction_read_only'),
 'engine_definition_matches',md5(pg_get_functiondef('public.pos_reconcile_settlement_internal(uuid)'::regprocedure))='872e20df354399ff6d9984bdee4246d9',
 'neighbors_unchanged',(SELECT bool_and(unchanged) FROM proof),
 'retained',(SELECT jsonb_agg(to_jsonb(p)) FROM proof p),
 'scope','Code installation only. No order was closed, payment recorded or historical till changed by this check. Full service-to-close regression remains separate.'
) AS diagnostic;
COMMIT;