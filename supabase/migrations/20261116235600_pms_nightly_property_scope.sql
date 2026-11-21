-- NEØ Cell 01-D2: Property isolation for nightly accommodation posting.
-- LOCAL CANDIDATE. Preserve existing pricing and posting behaviour.
BEGIN;

DO $repair$
DECLARE
    fn regprocedure :=
      to_regprocedure('public.pms_post_accommodation(date)');
    definition text;
    anchors text[];
    replacements text[];
    i integer;
BEGIN
    IF fn IS NULL THEN
      RAISE EXCEPTION 'Nightly accommodation function missing';
    END IF;

    SELECT pg_get_functiondef(fn) INTO definition;

    -- Requires the preceding pricing-parity migration.
    IF position('service_charge_amount' IN definition)=0
       OR position('service_charge_rate' IN definition)=0
       OR position('tax_treatment' IN definition)=0
       OR position('pkg_allocate_folio_line' IN definition)=0
    THEN
      RAISE EXCEPTION
        'Nightly pricing migration must be installed before property guard';
    END IF;

    anchors := ARRAY[
      $a1$JOIN public.reservations res ON res.id = s.reservation_id$a1$,
      $a2$JOIN public.folios f ON f.stay_id = s.id AND f.folio_type='guest' AND f.status='open'$a2$,
      $a3$LEFT JOIN public.rate_plans rp ON rp.id = res.rate_plan_id$a3$,
      $a4$LEFT JOIN public.rooms rm ON rm.id = s.room_id$a4$,
      $a5$WHERE s.organization_id=_org AND s.status='in-house'$a5$
    ];

    replacements := ARRAY[
      $b1$JOIN public.reservations res
        ON res.id = s.reservation_id
       AND res.organization_id = s.organization_id
       AND res.branch_id = s.branch_id$b1$,
      $b2$JOIN public.folios f
        ON f.stay_id = s.id
       AND f.organization_id = s.organization_id
       AND f.branch_id = s.branch_id
       AND f.reservation_id = res.id
       AND f.folio_type='guest'
       AND f.status='open'$b2$,
      $b3$LEFT JOIN public.rate_plans rp
        ON rp.id = res.rate_plan_id
       AND rp.organization_id = s.organization_id
       AND (rp.branch_id IS NULL OR rp.branch_id = s.branch_id)$b3$,
      $b4$JOIN public.rooms rm
        ON rm.id = s.room_id
       AND rm.organization_id = s.organization_id
       AND rm.branch_id = s.branch_id$b4$,
      $b5$WHERE s.organization_id=_org
        AND s.status='in-house'
        AND (res.rate_plan_id IS NULL OR rp.id IS NOT NULL)$b5$
    ];

    FOR i IN 1..array_length(anchors,1) LOOP
      IF length(definition) -
         length(replace(definition,anchors[i],''))
         <> length(anchors[i])
      THEN
        RAISE EXCEPTION
          'Nightly property guard anchor % differs; manual review required', i;
      END IF;
    END LOOP;

    FOR i IN 1..array_length(anchors,1) LOOP
      definition := replace(definition,anchors[i],replacements[i]);
    END LOOP;

    EXECUTE definition;

    SELECT pg_get_functiondef(fn) INTO definition;

    IF position('res.organization_id = s.organization_id' IN definition)=0
       OR position('f.branch_id = s.branch_id' IN definition)=0
       OR position('rm.organization_id = s.organization_id' IN definition)=0
       OR position('rp.branch_id IS NULL' IN definition)=0
       OR position('res.rate_plan_id IS NULL OR rp.id IS NOT NULL' IN definition)=0
       OR position('service_charge_amount' IN definition)=0
    THEN
      RAISE EXCEPTION
        'Nightly property guard installation verification failed';
    END IF;
END;
$repair$;

COMMIT;