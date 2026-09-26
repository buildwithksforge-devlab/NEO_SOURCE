CREATE OR REPLACE FUNCTION public.emit_domain_event(_org uuid, _branch uuid, _type text, _module text, _record uuid, _payload jsonb, _idem text DEFAULT NULL::text, _customer uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _id uuid; _key text;
BEGIN
  IF _org IS NULL THEN RETURN NULL; END IF;
  -- The events table requires an idempotency key. Callers that do not supply
  -- one still get a unique, non-deduplicating key instead of a hard failure.
  _key := COALESCE(_idem, 'evt:' || gen_random_uuid()::text);
  INSERT INTO public.domain_events (organization_id, branch_id, event_type, source_module,
    source_record_id, customer_id, payload, idempotency_key, created_by)
  VALUES (_org, _branch, _type, _module, _record, _customer, COALESCE(_payload,'{}'::jsonb), _key, auth.uid())
  ON CONFLICT (organization_id, idempotency_key) DO NOTHING
  RETURNING id INTO _id;
  IF _id IS NULL THEN
    SELECT id INTO _id FROM public.domain_events
    WHERE organization_id = _org AND idempotency_key = _key;
  END IF;
  RETURN _id;
END;
$function$;