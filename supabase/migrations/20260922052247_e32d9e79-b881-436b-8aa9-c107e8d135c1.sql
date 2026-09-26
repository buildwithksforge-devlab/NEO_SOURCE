CREATE OR REPLACE FUNCTION public.tg_pos_order_totals_authoritative()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _sub numeric(14,2);
  _tax numeric(14,2);
  _net numeric(14,2);
  _pct numeric;
  _svc numeric(14,2);
BEGIN
  SELECT COALESCE(sum(line_total),0), COALESCE(sum(tax_amount),0)
    INTO _sub, _tax
  FROM public.pos_order_items
  WHERE order_id = NEW.id AND COALESCE(status,'draft') NOT IN ('cancelled','voided');

  IF EXISTS (SELECT 1 FROM public.pos_order_items WHERE order_id = NEW.id) THEN
    NEW.subtotal := _sub;
    NEW.tax_total := _tax;
    _net := GREATEST(0, _sub - COALESCE(NEW.discount_total,0));

    -- Service charge is a configured trading rule for this property. When no
    -- POS settings row exists, or no percentage is configured, it stays zero.
    SELECT COALESCE((s.settings->>'serviceChargePercent')::numeric, 0)
      INTO _pct
    FROM public.pos_settings s
    WHERE s.organization_id = NEW.organization_id
      AND (s.branch_id = NEW.branch_id OR s.branch_id IS NULL)
    ORDER BY (s.branch_id IS NULL)
    LIMIT 1;

    _svc := ROUND(_net * COALESCE(_pct,0) / 100.0, 2);
    NEW.service_charge_total := _svc;
    NEW.grand_total := _net + _svc;
  END IF;
  RETURN NEW;
END;
$function$;