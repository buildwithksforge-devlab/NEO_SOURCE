CREATE OR REPLACE FUNCTION public.neo_folio_line_amount_invariant()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Reversals may be negative. Every saved monetary component must be finite.
  IF EXISTS (SELECT 1 FROM unnest(ARRAY[NEW.gross_amount, NEW.discount_amount,
       NEW.tax_amount, NEW.service_charge_amount, NEW.net_amount]) amount
       WHERE amount::text IN ('NaN','Infinity','-Infinity')) THEN
    RAISE EXCEPTION 'Folio line monetary amounts must be finite' USING ERRCODE='22003';
  END IF;
  IF abs(coalesce(NEW.gross_amount,0) - coalesce(NEW.discount_amount,0)
       + coalesce(NEW.tax_amount,0) + coalesce(NEW.service_charge_amount,0)
       - coalesce(NEW.net_amount,0)) > 0.01 THEN
    RAISE EXCEPTION 'Folio line total does not agree with its amount, discount, tax and service charge';
  END IF;
  RETURN NEW;
END;
$function$;
