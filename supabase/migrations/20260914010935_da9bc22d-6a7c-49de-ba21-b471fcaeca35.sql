
-- 1) Blank optional address details must not break an order. These columns are
--    NOT NULL with '' defaults, so an explicit NULL was rejected.
CREATE OR REPLACE FUNCTION public.neo_customer_address_blank_text()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.label := coalesce(nullif(btrim(NEW.label), ''), 'home');
  NEW.address_line := coalesce(NEW.address_line, '');
  NEW.city := coalesce(NEW.city, '');
  NEW.county := coalesce(NEW.county, '');
  NEW.country := coalesce(NEW.country, '');
  NEW.postal_code := coalesce(NEW.postal_code, '');
  NEW.recipient_name := coalesce(NEW.recipient_name, '');
  NEW.phone := coalesce(NEW.phone, '');
  NEW.building := coalesce(NEW.building, '');
  NEW.house_number := coalesce(NEW.house_number, '');
  NEW.landmark := coalesce(NEW.landmark, '');
  NEW.delivery_instructions := coalesce(NEW.delivery_instructions, '');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_customer_address_blank_text ON public.customer_addresses;
CREATE TRIGGER trg_customer_address_blank_text
BEFORE INSERT OR UPDATE ON public.customer_addresses
FOR EACH ROW EXECUTE FUNCTION public.neo_customer_address_blank_text();

-- 2) Reservation money state must follow folio settlement.
CREATE OR REPLACE FUNCTION public.neo_reservation_sync_financial_state(_reservation uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _row public.canonical_transaction_states;
  _res public.reservations;
  _open_balance numeric;
BEGIN
  SELECT * INTO _res FROM public.reservations WHERE id = _reservation;
  IF _res.id IS NULL OR _res.status <> 'checked-out' THEN RETURN; END IF;

  SELECT * INTO _row FROM public.canonical_transaction_states
   WHERE source_module = 'reservation' AND source_id = _reservation;
  IF _row.id IS NULL OR _row.financial_state = 'posted' THEN RETURN; END IF;

  SELECT coalesce(sum(f.balance), 0) INTO _open_balance
    FROM public.folios f
   WHERE f.reservation_id = _reservation AND f.status <> 'cancelled';
  IF _open_balance > 0 THEN RETURN; END IF;

  UPDATE public.canonical_transaction_states
     SET financial_state = 'posted',
         next_action = NULL,
         blocking_reason = NULL,
         version = version + 1,
         updated_at = now()
   WHERE id = _row.id;

  INSERT INTO public.canonical_transaction_state_history (
    state_id, organization_id, branch_id, source_module, source_id, version,
    operational_state, financial_state, actor_id, next_action, snapshot
  ) VALUES (
    _row.id, _row.organization_id, _row.branch_id, _row.source_module, _row.source_id,
    _row.version + 1, _row.operational_state, 'posted', auth.uid(), NULL,
    jsonb_build_object(
      'reason', 'Reservation settled: folio closed with no outstanding balance',
      'previous_financial_state', _row.financial_state
    )
  );
END $$;

GRANT EXECUTE ON FUNCTION public.neo_reservation_sync_financial_state(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_folio_settlement_syncs_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.reservation_id IS NOT NULL THEN
    PERFORM public.neo_reservation_sync_financial_state(NEW.reservation_id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_folio_settlement_syncs_reservation ON public.folios;
CREATE TRIGGER trg_folio_settlement_syncs_reservation
AFTER UPDATE OF status, balance ON public.folios
FOR EACH ROW EXECUTE FUNCTION public.neo_folio_settlement_syncs_reservation();

-- Backfill derived state only, where the folio is genuinely settled.
DO $$
DECLARE _r record;
BEGIN
  FOR _r IN
    SELECT c.source_id AS reservation_id
      FROM public.canonical_transaction_states c
      JOIN public.reservations r ON r.id = c.source_id
     WHERE c.source_module = 'reservation'
       AND c.financial_state = 'pending'
       AND r.status = 'checked-out'
       AND coalesce((SELECT sum(f.balance) FROM public.folios f
                      WHERE f.reservation_id = r.id AND f.status <> 'cancelled'), 0) <= 0
  LOOP
    PERFORM public.neo_reservation_sync_financial_state(_r.reservation_id);
  END LOOP;
END $$;
