DO $do$
DECLARE
  _fn text;
  _src text;
  _new text;
  _changed boolean;
BEGIN
  -- 1) Quote: VAT is contained in the menu price, not added on top.
  SELECT pg_get_functiondef(p.oid) INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'delivery_quote_cart';

  IF position('sum(ci.quantity * mi.base_price * mi.tax_rate / 100)' in _src) = 0
     OR position('_sub + _tax + _svc + _fee' in _src) = 0 THEN
    RAISE EXCEPTION 'delivery_quote_cart no longer matches the expected tax arithmetic';
  END IF;

  _new := replace(_src,
    'sum(ci.quantity * mi.base_price * mi.tax_rate / 100)',
    'sum(ci.quantity * mi.base_price * mi.tax_rate / nullif(100 + mi.tax_rate, 0))');
  _new := replace(_new, '_sub + _tax + _svc + _fee', '_sub + _svc + _fee');
  EXECUTE _new;

  -- 2) Order lines: tax amount is the VAT contained in the charged line value.
  FOREACH _fn IN ARRAY ARRAY['delivery_place_order','neo_guest_place_room_service','neo_delivery_staff_place_order'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO _src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = _fn;
    IF _src IS NULL THEN CONTINUE; END IF;

    _new := replace(_src,
      '(_line->>''tax_rate'')::numeric / 100, 2)',
      '(_line->>''tax_rate'')::numeric / nullif(100 + (_line->>''tax_rate'')::numeric, 0), 2)');

    IF _new <> _src THEN EXECUTE _new; END IF;
  END LOOP;
END
$do$;