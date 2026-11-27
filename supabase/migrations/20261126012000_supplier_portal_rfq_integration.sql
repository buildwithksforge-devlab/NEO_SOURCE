BEGIN;

DO $migration$
DECLARE

    d text;

    anchor text;

    replacement text;

BEGIN

    -- ============================================
    -- 1. SUPPLIER PORTAL RFQ INBOX
    -- ============================================

    d := pg_get_functiondef(
      'public.neo_partner_supplier_rfqs(uuid,uuid)'
      ::regprocedure
    );

    anchor := $old$
       AND invited.dispatch_state IN ('marked-sent', 'sent')
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
       AND invited.dispatch_state IN (
         'prepared',
         'ready-to-send',
         'downloaded',
         'marked-sent',
         'sent'
       )
       AND EXISTS (
         SELECT 1
         FROM public.suppliers s
         WHERE s.id = _rel.supplier_id
           AND s.organization_id = _org
           AND s.active IS TRUE
           AND public.neo_record_operationally_enabled(
             to_jsonb(s)
           ) IS TRUE
       )
$new$;

    IF strpos(d,anchor) = 0 THEN

      RAISE EXCEPTION
        'Supplier RFQ inbox anchor missing';

    END IF;

    d := replace(d,anchor,replacement);

    EXECUTE d;


    -- ============================================
    -- 2. SUPPLIER PORTAL QUOTATION SUBMISSION
    -- ============================================

    d := pg_get_functiondef(
      'public.neo_partner_supplier_quote_submit(uuid,uuid,uuid,jsonb,text,uuid)'
      ::regprocedure
    );

    anchor := $old$
        AND dispatch_state IN ('marked-sent', 'sent'))
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
        AND dispatch_state IN (
          'prepared',
          'ready-to-send',
          'downloaded',
          'marked-sent',
          'sent'
        ))
$new$;

    IF strpos(d,anchor) = 0 THEN

      RAISE EXCEPTION
        'Supplier quotation invitation anchor missing';

    END IF;

    d := replace(d,anchor,replacement);

    anchor := $old$
    WHERE id = _rel.supplier_id AND organization_id = _org AND active IS TRUE;
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
    WHERE id = _rel.supplier_id
      AND organization_id = _org
      AND active IS TRUE
      AND public.neo_record_operationally_enabled(
        to_jsonb(suppliers)
      ) IS TRUE;
$new$;

    IF strpos(d,anchor) = 0 THEN

      RAISE EXCEPTION
        'Supplier operational eligibility anchor missing';

    END IF;

    d := replace(d,anchor,replacement);

    EXECUTE d;


    -- ============================================
    -- 3. RFQ CREATION ATTEMPT SERIALIZATION
    -- ============================================

    d := pg_get_functiondef(
      'public.neo_procurement_create_rfq(uuid,uuid[],date,uuid,text,text)'
      ::regprocedure
    );

    anchor := $old$
  SELECT result INTO _prior FROM public.procurement_attempts WHERE organization_id = _org
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      _org::text || ':rfq.create:' || _attempt::text,
      0
    )
  );

  SELECT result INTO _prior FROM public.procurement_attempts WHERE organization_id = _org
$new$;

    IF strpos(d,anchor) = 0 THEN

      RAISE EXCEPTION
        'RFQ retry serialization anchor missing';

    END IF;

    d := replace(d,anchor,replacement);

    EXECUTE d;


    -- ============================================
    -- 4. SUPPLIER QUOTATION ATTEMPT SERIALIZATION
    -- ============================================

    d := pg_get_functiondef(
      'public.neo_partner_supplier_quote_submit(uuid,uuid,uuid,jsonb,text,uuid)'
      ::regprocedure
    );

    anchor := $old$
  SELECT result INTO _prior FROM public.procurement_attempts WHERE organization_id = _org
$old$;

    anchor := btrim(anchor,E'\n\r');

    replacement := $new$
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      _org::text || ':partner.quote.submit:' || _attempt::text,
      0
    )
  );

  SELECT result INTO _prior FROM public.procurement_attempts WHERE organization_id = _org
$new$;

    IF strpos(d,anchor) = 0 THEN

      RAISE EXCEPTION
        'Supplier quotation retry serialization anchor missing';

    END IF;

    d := replace(d,anchor,replacement);

    EXECUTE d;

END;
$migration$;

NOTIFY pgrst,'reload schema';

COMMIT;