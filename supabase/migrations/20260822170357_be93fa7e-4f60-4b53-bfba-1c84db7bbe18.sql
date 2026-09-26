DROP FUNCTION IF EXISTS public.neo_gl_pos_settlement_code(uuid);

DO $do$
DECLARE _def text; _new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='neo_finance_post_txn';

  _new := replace(_def,
    'AND p.status IN (''paid'',''completed'',''captured'',''settled'')',
    'AND p.status IN (''confirmed'',''paid'',''completed'',''captured'',''settled'')');

  IF _new = _def THEN
    RAISE EXCEPTION 'settlement status filter not found in neo_finance_post_txn';
  END IF;

  EXECUTE _new;
END $do$;