-- NEØ Cell 01-D2: Later-night tax and service-charge parity.
-- Local candidate only. No historical charge adjustments.
BEGIN;

DO $repair$
DECLARE
  fn regprocedure := to_regprocedure('public.pms_post_accommodation(date)');
  definition text;
  anchors text[];
  replacements text[];
  i integer;
BEGIN
  IF fn IS NULL THEN
    RAISE EXCEPTION 'Nightly accommodation function missing';
  END IF;

  SELECT pg_get_functiondef(fn) INTO definition;

  IF position('pkg_allocate_folio_line' IN definition)=0
     OR position('EXCEPTION WHEN unique_violation' IN definition)=0
  THEN
    RAISE EXCEPTION 'Installed nightly function differs from reviewed version';
  END IF;

  anchors := ARRAY[
    $a1$DECLARE _org uuid := public.current_org_id(); _r record; _n integer := 0; _tax numeric; _line uuid;$a1$,
    $a2$COALESCE(rp.tax_rate,0) AS tax_rate, rm.room_number$a2$,
    $a3$_tax := round(_r.nightly_rate * _r.tax_rate / 100, 2);$a3$,
    $a4$gross_amount, tax_amount, net_amount, posted_by)$a4$,
    $a5$_r.nightly_rate, _tax, _r.nightly_rate + _tax, auth.uid())$a5$,
    $a6$total_taxes = total_taxes + _tax, balance = balance + _r.nightly_rate + _tax, updated_at=now()$a6$
  ];

  replacements := ARRAY[
    $b1$DECLARE _org uuid := public.current_org_id(); _r record; _n integer := 0; _tax numeric; _svc numeric; _line uuid;$b1$,
    $b2$COALESCE(rp.tax_rate,0) AS tax_rate,
            COALESCE(rp.service_charge_rate,0) AS service_charge_rate,
            COALESCE(rp.tax_treatment,'exclusive') AS tax_treatment,
            rm.room_number$b2$,
    $b3$IF _r.tax_treatment = 'exclusive' THEN
      _svc := round(_r.nightly_rate * _r.service_charge_rate / 100.0, 2);
      _tax := round((_r.nightly_rate + _svc) * _r.tax_rate / 100.0, 2);
    ELSE
      _svc := 0;
      _tax := 0;
    END IF;$b3$,
    $b4$gross_amount, tax_amount, service_charge_amount, net_amount, posted_by)$b4$,
    $b5$_r.nightly_rate, _tax, _svc,
        _r.nightly_rate + _tax + _svc, auth.uid())$b5$,
    $b6$total_taxes = total_taxes + _tax,
        balance = balance + _r.nightly_rate + _tax + _svc,
        updated_at=now()$b6$
  ];

  FOR i IN 1..array_length(anchors,1) LOOP
    IF length(definition) -
       length(replace(definition,anchors[i],''))
       <> length(anchors[i])
    THEN
      RAISE EXCEPTION
        'Nightly function anchor % differs; repair refused', i;
    END IF;
  END LOOP;

  FOR i IN 1..array_length(anchors,1) LOOP
    definition := replace(definition,anchors[i],replacements[i]);
  END LOOP;

  EXECUTE definition;

  SELECT pg_get_functiondef(fn) INTO definition;

  IF position('service_charge_amount' IN definition)=0
     OR position('service_charge_rate' IN definition)=0
     OR position('tax_treatment' IN definition)=0
     OR position('pkg_allocate_folio_line' IN definition)=0
  THEN
    RAISE EXCEPTION 'Nightly pricing repair verification failed';
  END IF;
END;
$repair$;

COMMIT;