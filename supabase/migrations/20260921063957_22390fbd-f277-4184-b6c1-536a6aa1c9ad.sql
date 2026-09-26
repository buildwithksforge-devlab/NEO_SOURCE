CREATE OR REPLACE FUNCTION public.neo_laundry_posting_invariant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.posting_status = 'posted' AND (NEW.folio_line_id IS NULL OR NEW.folio_id IS NULL) THEN
    RAISE EXCEPTION 'Laundry order cannot be marked posted without a folio charge line';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS neo_laundry_posting_invariant_trg ON public.guest_laundry_orders;
CREATE TRIGGER neo_laundry_posting_invariant_trg
BEFORE INSERT OR UPDATE ON public.guest_laundry_orders
FOR EACH ROW EXECUTE FUNCTION public.neo_laundry_posting_invariant();

UPDATE public.guest_laundry_orders
SET posting_status = 'unposted', posted_at = NULL
WHERE posting_status = 'posted' AND (folio_line_id IS NULL OR folio_id IS NULL);