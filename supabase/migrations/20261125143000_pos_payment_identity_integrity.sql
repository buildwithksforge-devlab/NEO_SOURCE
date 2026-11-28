-- NEØ: POS payment identity and immutable terminal evidence.
-- Preserve historical payments and existing settlement architecture.
-- Fail closed if installed function definitions differ from audited versions.

DO $migration$
DECLARE
    v_signature regprocedure;
    v_source text;
    v_updated text;
    v_anchor text;
    v_replacement text;
BEGIN
    v_signature :=
      'public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid)'::regprocedure;

    SELECT pg_get_functiondef(v_signature::oid)
      INTO v_source;

    IF md5(v_source) <> '915008ca2eb86bd57147bb54230b7817' THEN
        RAISE EXCEPTION
          'NEO_PAYMENT_SOURCE_DRIFT: Core payment function changed. Review before migration.';
    END IF;

    v_updated := v_source;

    -- Never generate a new identity for an unidentified payment request.
    -- Read the actual declaration from the verified installed source.
    -- Avoid mismatches caused by hard-coded SQL line breaks.
    v_anchor := '_key text :=' ||
      split_part(
        split_part(v_updated, '_key text :=', 2),
        E'\n',
        1
      );

    IF strpos(v_anchor, 'gen_random_uuid()') = 0 THEN
        RAISE EXCEPTION
          'Original payment-key declaration differs from the audited source';
    END IF;

    v_replacement :=
      '_key text := nullif(btrim(_idempotency_key), '''');';

    IF strpos(v_updated, v_anchor) = 0 THEN
        RAISE EXCEPTION 'Core payment-key anchor not found';
    END IF;

    v_updated := replace(v_updated, v_anchor, v_replacement);

    v_anchor := E'BEGIN\n  IF _method =';

    v_replacement := $insert$
BEGIN
  IF _key IS NULL THEN
    RAISE EXCEPTION
      'NEO_PAYMENT_IDENTITY_REQUIRED: A payment idempotency key is required'
      USING ERRCODE = '23514';
  END IF;

  IF _method =$insert$;

    IF strpos(v_updated, v_anchor) = 0 THEN
        RAISE EXCEPTION 'Core payment validation anchor not found';
    END IF;

    v_updated := replace(v_updated, v_anchor, v_replacement);

    -- Validate the original transaction before accepting an idempotent retry.
    v_anchor :=
      '    RETURN jsonb_build_object(''payment_id'', _existing.id,';

    v_replacement := $duplicate$
    IF _existing.amount IS DISTINCT FROM round(_amount, 2)
       OR _existing.method IS DISTINCT FROM _method
       OR _existing.external_reference IS DISTINCT FROM nullif(btrim(_reference), '')
       OR _existing.tendered IS DISTINCT FROM _tendered
       OR (_account IS NOT NULL
           AND _existing.destination_account_id IS DISTINCT FROM _account)
       OR (_shift_id IS NOT NULL
           AND _existing.shift_id IS DISTINCT FROM _shift_id)
    THEN
      RAISE EXCEPTION
        'NEO_PAYMENT_IDENTITY_CONFLICT: Retry details do not match the original payment'
        USING ERRCODE = '23514';
    END IF;

    RETURN jsonb_build_object('payment_id', _existing.id,$duplicate$;

    IF strpos(v_updated, v_anchor) = 0 THEN
        RAISE EXCEPTION 'Core duplicate-payment anchor not found';
    END IF;

    v_updated := replace(v_updated, v_anchor, v_replacement);

    EXECUTE v_updated;

    RAISE NOTICE 'NEO core payment identity protection installed';
END
$migration$;


DO $migration$
DECLARE
    v_signature regprocedure;
    v_source text;
    v_updated text;
    v_anchor text;
    v_replacement text;
BEGIN
    v_signature :=
      'public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid,jsonb)'::regprocedure;

    SELECT pg_get_functiondef(v_signature::oid)
      INTO v_source;

    IF md5(v_source) <> 'fe6d4802c4b7b16e939c53de4091ebf7' THEN
        RAISE EXCEPTION
          'NEO_PAYMENT_SOURCE_DRIFT: Card metadata function changed. Review before migration.';
    END IF;

    v_updated := v_source;

    -- On an idempotent retry, verify saved metadata; never update it.
    v_anchor :=
      E'  v_payment := nullif(v_result->>''payment_id'', '''')::uuid;';

    v_replacement := $card$
  v_payment := nullif(v_result->>'payment_id', '')::uuid;

  IF coalesce((v_result->>'duplicate')::boolean, false) THEN
    IF lower(coalesce(replace(_method, '-', '_'), '')) = 'card' THEN
      IF NOT EXISTS (
        SELECT 1
          FROM public.pos_payments p
         WHERE p.id = v_payment
           AND p.organization_id = public.current_org_id()
           AND jsonb_strip_nulls(
                 jsonb_build_object(
                   'terminal', p.provider_payload->>'terminal',
                   'network', p.provider_payload->>'network',
                   'last4', p.provider_payload->>'last4'
                 )
               ) =
               jsonb_strip_nulls(
                 jsonb_build_object(
                   'terminal', v_terminal,
                   'network',
                     CASE WHEN v_network IS NULL THEN NULL
                          ELSE initcap(lower(v_network)) END,
                   'last4', v_last4
                 )
               )
      ) THEN
        RAISE EXCEPTION
          'NEO_PAYMENT_METADATA_CONFLICT: Terminal evidence differs from original payment'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    RETURN v_result;
  END IF;$card$;

    IF strpos(v_updated, v_anchor) = 0 THEN
        RAISE EXCEPTION 'Card payment identity anchor not found';
    END IF;

    v_updated := replace(v_updated, v_anchor, v_replacement);

    EXECUTE v_updated;

    RAISE NOTICE 'NEO duplicate card metadata protection installed';
END
$migration$;