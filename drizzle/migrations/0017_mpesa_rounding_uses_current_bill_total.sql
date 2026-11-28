CREATE OR REPLACE FUNCTION neo_private.patch_once(_def text, _old text, _new text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE n int;
BEGIN
  n := (length(_def) - length(replace(_def, _old, ''))) / greatest(length(_old), 1);
  IF n <> 1 THEN RAISE EXCEPTION 'Patch anchor found % times: %', n, left(_old, 90); END IF;
  RETURN replace(_def, _old, _new);
END $$;
REVOKE EXECUTE ON FUNCTION neo_private.patch_once(text, text, text) FROM PUBLIC, anon, authenticated;

DO $m$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.neo_mpesa_collection_start(text,uuid,text,numeric,text,uuid)'::regprocedure);
  d := neo_private.patch_once(d,
$p$    SELECT grand_total INTO _gt FROM public.pos_orders WHERE id = _source_record;$p$,
$p$    -- Bring the bill total up to date first, so rounding is worked out on the real balance.
    UPDATE public.pos_orders SET updated_at = now() WHERE id = _source_record;
    SELECT grand_total INTO _gt FROM public.pos_orders WHERE id = _source_record;$p$);
  EXECUTE d;
END $m$;

DROP FUNCTION neo_private.patch_once(text, text, text);